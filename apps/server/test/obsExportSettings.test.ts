// The stored export settings (design.md 14.10 rules 1 and 5;
// https://github.com/bgoleno/opportun/issues/342): off unless an admin turns it on; one
// destination, as fields; the credential sealed with the vault key in the instance's settings
// row, never stored or returned in clear, and cleared whenever the type, scheme, host or port
// changes.
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { settings } from '../src/db/schema';
import { encryptSecret } from '../src/lib/secretBox';
import type { Destination } from '../src/obs/export/destination';
import {
  credentialOf,
  disableExport,
  nextExport,
  OBS_EXPORT_KEY,
  OFF,
  readExport,
  writeExport,
} from '../src/obs/export/settings';
import { useApi } from './api';

const boot = useApi();
const SECRET = 'tok-3f9a1c0d2b';

const otlp: Destination = {
  type: 'otlp',
  scheme: 'https',
  host: 'otel.example.com',
  port: 4318,
  headerName: 'x-api-key',
};
const seal = (s: string) => `sealed(${s})`;

describe('nextExport: the change rules', () => {
  it('a credential is kept while the endpoint stays the same', () => {
    const prev = { enabled: true, destination: otlp, sealedCredential: seal(SECRET) };
    const r = nextExport(prev, { enabled: true, destination: { ...otlp, basePath: '/x' } }, seal);
    expect(r).toEqual({
      ok: true,
      value: {
        enabled: true,
        destination: { ...otlp, basePath: '/x' },
        sealedCredential: seal(SECRET),
      },
    });
  });

  it.each([
    ['type', { type: 'datadog' as const, headerName: undefined }],
    ['scheme', { scheme: 'http' as const }],
    ['host', { host: 'other.example.com' }],
    ['port', { port: 4319 }],
  ])('a new %s clears the stored credential', (_what, over) => {
    const prev = { enabled: true, destination: otlp, sealedCredential: seal(SECRET) };
    const destination = { ...otlp, ...over } as Destination;
    const r = nextExport(prev, { enabled: false, destination }, seal);
    expect(r.ok && r.value.sealedCredential).toBe(null);
  });

  it('a new credential with a new endpoint is sealed for the new one', () => {
    const prev = { enabled: false, destination: otlp, sealedCredential: seal(SECRET) };
    const r = nextExport(
      prev,
      { enabled: false, destination: { ...otlp, host: 'b.example.com' }, credential: 'new' },
      seal,
    );
    expect(r.ok && r.value.sealedCredential).toBe(seal('new'));
  });

  it('null clears the credential; leaving it out keeps it', () => {
    const prev = { enabled: false, destination: otlp, sealedCredential: seal(SECRET) };
    expect(nextExport(prev, { enabled: false, credential: null }, seal)).toEqual({
      ok: true,
      value: { ...prev, sealedCredential: null },
    });
    expect(nextExport(prev, { enabled: false }, seal)).toEqual({ ok: true, value: prev });
  });

  it('turning export on needs a destination', () => {
    expect(nextExport(OFF, { enabled: true }, seal)).toEqual({
      ok: false,
      error: 'destination_required',
    });
  });

  it('the Datadog Agent takes no credential: it holds the API key itself', () => {
    const dd: Destination = { type: 'datadog', scheme: 'http', host: 'agent', port: 4318 };
    expect(nextExport(OFF, { enabled: false, destination: dd, credential: 'k' }, seal)).toEqual({
      ok: false,
      error: 'credential_not_allowed',
    });
  });

  it('an OTLP credential needs the header it goes in', () => {
    const { headerName: _h, ...bare } = otlp;
    expect(nextExport(OFF, { enabled: false, destination: bare, credential: 'k' }, seal)).toEqual({
      ok: false,
      error: 'header_name_required',
    });
  });

  it('a credential is one line of printable characters, at most 4096', () => {
    for (const credential of ['', 'a\r\nb', 'a\nb', 'a\u0000b', 'x'.repeat(4097)]) {
      expect(nextExport(OFF, { enabled: false, destination: otlp, credential }, seal)).toEqual({
        ok: false,
        error: 'invalid_credential',
      });
    }
  });
});

describe('the stored row', () => {
  it('reads as off when there is no row', async () => {
    const { app } = await boot();
    expect(await readExport(app.db)).toEqual(OFF);
  });

  it('holds the credential sealed, and gives it back only through credentialOf', async () => {
    const { app } = await boot();
    const r = nextExport(OFF, { enabled: true, destination: otlp, credential: SECRET }, (s) =>
      encryptSecret(app.db, s),
    );
    if (!r.ok) throw new Error(r.error);
    await writeExport(app.db, r.value);
    const row = await app.db
      .select({ value: settings.value, userId: settings.userId })
      .from(settings)
      .where(eq(settings.key, OBS_EXPORT_KEY))
      .get();
    expect(row?.userId).toBeNull();
    expect(JSON.stringify(row?.value)).not.toContain(SECRET);
    const stored = await readExport(app.db);
    expect(stored.enabled).toBe(true);
    expect(stored.destination).toEqual(otlp);
    expect(credentialOf(app.db, stored)).toBe(SECRET);
  });

  it('a row that does not parse reads as off, never as a half-set destination', async () => {
    const { app } = await boot();
    await app.db
      .insert(settings)
      .values({
        key: OBS_EXPORT_KEY,
        userId: null,
        value: { enabled: true, destination: { type: 'otlp', host: 'x/y' } },
        updatedAt: Date.now(),
      })
      .run();
    expect(await readExport(app.db)).toEqual(OFF);
  });

  it('disableExport turns it off and keeps the destination', async () => {
    const { app } = await boot();
    await writeExport(app.db, { enabled: true, destination: otlp, sealedCredential: null });
    await disableExport(app.db);
    expect(await readExport(app.db)).toEqual({
      enabled: false,
      destination: otlp,
      sealedCredential: null,
    });
  });
});
