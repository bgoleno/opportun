// The stored export settings (design.md 14.10 rules 1 and 5;
// https://github.com/bgoleno/opportun/issues/342).
//
// One instance row, like registration_open and an OAuth provider's credentials: a settings row
// with no user, holding whether export is on, the destination's fields, and the credential sealed
// with the vault key (lib/secretBox.ts encryptSecret), never in clear and never in the secrets
// table, whose rows belong to a user. A missing row, or one that does not parse, reads as off.
//
// The credential is cleared whenever the type, scheme, host or port changes (rule 5): a new scheme
// could send it in clear, and a new port to another service. What it is sent as depends on the
// type: OTLP, in the one header the admin names; Prometheus, as the Authorization header's value
// (for a Prometheus behind an authenticating proxy, or with basic auth); InfluxDB, as its API
// token. The Datadog Agent takes none: it holds the API key itself.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Exec } from '../../db/client';
import { settings } from '../../db/schema';
import { decryptSecret } from '../../lib/secretBox';
import { parseDestination, type Destination } from './destination';

export const OBS_EXPORT_KEY = 'obs_export';

export interface StoredExport {
  enabled: boolean;
  destination: Destination | null;
  /** encryptSecret's envelope; null when there is no credential. */
  sealedCredential: string | null;
}

export const OFF: StoredExport = Object.freeze({
  enabled: false,
  destination: null,
  sealedCredential: null,
});

const StoredRow = z.object({
  enabled: z.boolean(),
  destination: z.unknown(),
  sealedCredential: z.string().nullable(),
});

/** The stored settings; off when there is no row or the row does not parse. */
export async function readExport(db: Pick<Exec, 'select'>): Promise<StoredExport> {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, OBS_EXPORT_KEY))
    .get();
  const parsed = StoredRow.safeParse(row?.value);
  if (!parsed.success) return OFF;
  if (parsed.data.destination === null) {
    return { enabled: false, destination: null, sealedCredential: null };
  }
  const destination = parseDestination(parsed.data.destination);
  if (!destination.ok) return OFF;
  return {
    enabled: parsed.data.enabled,
    destination: destination.value,
    sealedCredential: parsed.data.sealedCredential,
  };
}

export async function writeExport(db: Db, value: StoredExport): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key: OBS_EXPORT_KEY, userId: null, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

/** Turns export off and keeps the destination (Collect turned off, design 14.1). */
export async function disableExport(db: Db): Promise<void> {
  const stored = await readExport(db);
  if (!stored.enabled) return;
  await writeExport(db, { ...stored, enabled: false });
}

/** The credential in clear, for the sender's header only; undefined when there is none. */
export function credentialOf(db: Db, stored: StoredExport): string | undefined {
  return stored.sealedCredential === null ? undefined : decryptSecret(db, stored.sealedCredential);
}

export interface ExportChange {
  enabled: boolean;
  /** Undefined keeps the stored destination. */
  destination?: Destination;
  /** Undefined keeps the stored one (unless the endpoint changed); null clears it. */
  credential?: string | null;
}

export type ExportChangeError =
  'destination_required' | 'credential_not_allowed' | 'header_name_required' | 'invalid_credential';

/** One line of printable characters: it goes in a header, so no CR, LF or NUL can reach one. */
const CREDENTIAL = /^[\x20-\x7e]{1,4096}$/;

function sameEndpoint(a: Destination | null, b: Destination | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.type === b.type &&
    a.scheme === b.scheme &&
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port
  );
}

/** The settings after a change, by the rules above; `seal` is encryptSecret for this database. */
export function nextExport(
  prev: StoredExport,
  change: ExportChange,
  seal: (plaintext: string) => string,
): { ok: true; value: StoredExport } | { ok: false; error: ExportChangeError } {
  const destination = change.destination ?? prev.destination;
  let sealedCredential = sameEndpoint(prev.destination, destination) ? prev.sealedCredential : null;
  if (change.credential === null) sealedCredential = null;
  if (typeof change.credential === 'string') {
    if (!CREDENTIAL.test(change.credential)) return { ok: false, error: 'invalid_credential' };
    sealedCredential = seal(change.credential);
  }
  if (change.enabled && destination === null) return { ok: false, error: 'destination_required' };
  if (sealedCredential !== null && destination !== null) {
    if (destination.type === 'datadog') return { ok: false, error: 'credential_not_allowed' };
    if (destination.type === 'otlp' && destination.headerName === undefined) {
      return { ok: false, error: 'header_name_required' };
    }
  }
  return { ok: true, value: { enabled: change.enabled, destination, sealedCredential } };
}

/** The header the credential goes in, by type (see the top of this file). */
export function credentialHeaders(
  destination: Destination,
  credential: string | undefined,
): Record<string, string> {
  if (credential === undefined) return {};
  if (destination.type === 'otlp' && destination.headerName !== undefined) {
    return { [destination.headerName.toLowerCase()]: credential };
  }
  if (destination.type === 'prometheus') return { authorization: credential };
  if (destination.type === 'influxdb') return { authorization: `Token ${credential}` };
  return {};
}
