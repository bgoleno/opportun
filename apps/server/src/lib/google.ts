// Google account connection (C-3, NFR-SEC10). The OAuth client id and secret are supplied by
// the user (self-hosted: each instance registers its own Google Cloud OAuth client) and kept
// in the secrets vault, as are the tokens from the consent flow. Every network call to Google
// goes through GoogleApi, so tests swap in a fake and nothing here touches the network.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { docs as docsClient, type docs_v1 } from '@googleapis/docs';
import { drive as driveClient } from '@googleapis/drive';
import { OAuth2Client, type Credentials } from 'google-auth-library';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { lockScope, withTransaction, type Db, type Exec } from '../db/client';
import { secrets } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { HttpError } from './errors';
import { racePoint } from './racePoints';
import { getSecretValueIn, putSecretIn } from './secretBox';

// ---------------------------------------------------------------------------
// Scopes: incremental. Each set is a separate grant (include_granted_scopes keeps the others).
// Gmail is read-only (FR-M7): the app never labels, modifies or sends mail.

export const GOOGLE_SCOPE_SETS = {
  // Full drive (not drive.file): copying a base resume the user created outside the app
  // needs it, and the CSP rules out the Google Picker that drive.file would require.
  docs: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
} as const satisfies Record<string, readonly string[]>;

export type GoogleScopeSet = keyof typeof GOOGLE_SCOPE_SETS;
export const GOOGLE_SCOPE_SET_NAMES = Object.keys(GOOGLE_SCOPE_SETS) as [
  GoogleScopeSet,
  ...GoogleScopeSet[],
];
export const DOCS_SCOPES: readonly string[] = GOOGLE_SCOPE_SETS.docs;
export const GMAIL_SCOPES: readonly string[] = GOOGLE_SCOPE_SETS.gmail;

/** The callback path, relative to OPPORTUN_BASE_URL (registered in the Google Cloud console). */
export const GOOGLE_CALLBACK_PATH = '/api/v1/integrations/google/callback';

// ---------------------------------------------------------------------------
// Vault labels. All three are kind 'oauth_token'; the kinds enum is unchanged.

export const GOOGLE_CLIENT_ID_LABEL = 'google_oauth_client_id';
export const GOOGLE_CLIENT_SECRET_LABEL = 'google_oauth_client_secret';
export const GOOGLE_TOKENS_LABEL = 'google_tokens';
export const GOOGLE_SECRET_LABELS = [
  GOOGLE_CLIENT_ID_LABEL,
  GOOGLE_CLIENT_SECRET_LABEL,
  GOOGLE_TOKENS_LABEL,
] as const;
const GOOGLE_SECRET_KIND = 'oauth_token';

// ---------------------------------------------------------------------------
// The network boundary

export interface DriveFileMeta {
  id: string;
  name: string;
}

/** One Google Doc found by a Drive search (lib/driveDocs.ts). */
export interface DriveSearchFile {
  id: string;
  name: string;
  /** RFC 3339, as Drive reports it. */
  modifiedTime: string;
  /** The first parent folder id Drive lists, when the file has one. */
  parentId: string | null;
}

export interface DriveSearchPage {
  files: DriveSearchFile[];
  nextPageToken: string | undefined;
}

/** The subset of a Gmail message resource (format=full) this app reads. */
export interface GmailMessagePart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  /**
   * `data` is absent and `attachmentId` is set instead once Gmail decides a part is too large to
   * inline (observed on real messages, not just file attachments): `gmailGetAttachment` reads it
   * separately via `attachments.get`.
   */
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null;
  parts?: GmailMessagePart[] | null;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[] | null;
  snippet?: string | null;
  historyId?: string | null;
  /** Epoch ms as a decimal string. */
  internalDate?: string | null;
  payload?: GmailMessagePart | null;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailMessageList {
  messages: GmailMessageRef[];
  nextPageToken?: string | undefined;
}

export interface GmailHistoryPage {
  /** Messages added since startHistoryId (history type messageAdded only). */
  added: (GmailMessageRef & { labelIds?: string[] | null })[];
  /** The mailbox's current history id. */
  historyId: string;
  nextPageToken?: string | undefined;
}

/** Every call this app makes to Google. The real one wraps googleapis; tests inject a fake. */
export interface GoogleApi {
  /** Trades an authorization code for tokens (oauth2 token endpoint). */
  exchangeCode(client: OAuth2Client, code: string): Promise<Credentials>;
  /** Revokes a refresh or access token. */
  revokeToken(client: OAuth2Client, token: string): Promise<void>;
  /** The connected account's address, when Drive reports it. Best effort. */
  accountEmail(client: OAuth2Client): Promise<string | undefined>;
  getDocument(client: OAuth2Client, documentId: string): Promise<docs_v1.Schema$Document>;
  /**
   * replies[i] maps 1:1 to requests[i] (Google's own guarantee); applyEdits (googleDocs.ts)
   * reads replies[i].replaceAllText.occurrencesChanged to report what each edit actually did,
   * rather than re-deriving it from a separate text read (issue #146).
   */
  batchUpdateDocument(
    client: OAuth2Client,
    documentId: string,
    requests: docs_v1.Schema$Request[],
  ): Promise<docs_v1.Schema$BatchUpdateDocumentResponse>;
  copyFile(client: OAuth2Client, fileId: string, name: string): Promise<DriveFileMeta>;
  /** A file's id and name (files.get, minimal fields). Used to resolve a search result's
   *  parent folder name; also fit for any other "just the name" lookup. */
  getFile(client: OAuth2Client, fileId: string): Promise<DriveFileMeta>;
  /**
   * files.list restricted by `opts.q` (issue #136): Google Docs only, not trashed, newest
   * first. `opts.q` undefined or empty omits the name filter, so recently modified documents
   * come back (the common case: a resume being attached was usually edited this week).
   */
  searchDriveFiles(
    client: OAuth2Client,
    opts: { q: string | undefined; pageToken: string | undefined; pageSize: number },
  ): Promise<DriveSearchPage>;
  // Gmail, read-only (gmail.readonly). There is deliberately no call that modifies mail.
  /** users.getProfile: the mailbox's current historyId. */
  /** `emailAddress` is the synced mailbox, which the deep link needs for `authuser`. */
  gmailProfile(client: OAuth2Client): Promise<{ historyId: string; emailAddress: string | null }>;
  /** users.messages.list with a search query, one page. */
  gmailListMessages(
    client: OAuth2Client,
    opts: { q: string; pageToken?: string | undefined },
  ): Promise<GmailMessageList>;
  /** users.messages.get, format=full. */
  gmailGetMessage(client: OAuth2Client, id: string): Promise<GmailMessage>;
  /**
   * users.messages.attachments.get: the body of a part Gmail would not inline (body.attachmentId
   * set, body.data absent). Covered by gmail.readonly; no extra scope.
   */
  gmailGetAttachment(
    client: OAuth2Client,
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string }>;
  /** users.history.list (messageAdded), one page. Rejects with status 404 for an expired id. */
  gmailListHistory(
    client: OAuth2Client,
    opts: { startHistoryId: string; pageToken?: string | undefined },
  ): Promise<GmailHistoryPage>;
  /** users.labels.list. Needed to resolve a label NAME to the id history records carry. */
  gmailListLabels(client: OAuth2Client): Promise<{ id: string; name: string }[]>;
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_PAGE_SIZE = 100;

/** A GET against the Gmail REST API; only reads are ever issued (FR-M7). */
async function gmailGet<T>(
  client: OAuth2Client,
  path: string,
  params: Record<string, string | number | string[] | undefined>,
): Promise<T> {
  const res = await client.request<T>({ url: `${GMAIL_API}${path}`, method: 'GET', params });
  return res.data;
}

interface RawHistory {
  history?: {
    messagesAdded?: { message?: { id?: string; threadId?: string; labelIds?: string[] } }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

/**
 * Escapes a string for use inside a single-quoted literal in a Drive `files.list` query (`q`),
 * per Drive's query syntax: a backslash becomes `\\`, a single quote becomes `\'`. Without this,
 * a search term containing a quote could close the literal early and append clauses of its own
 * to the query this app builds, rather than just fail to match anything.
 */
export function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export const realGoogleApi: GoogleApi = {
  async exchangeCode(client, code) {
    const { tokens } = await client.getToken(code);
    return tokens;
  },
  async revokeToken(client, token) {
    await client.revokeToken(token);
  },
  async accountEmail(client) {
    const res = await driveClient({ version: 'v3', auth: client }).about.get({
      fields: 'user(emailAddress)',
    });
    return res.data.user?.emailAddress ?? undefined;
  },
  async getDocument(client, documentId) {
    const res = await docsClient({ version: 'v1', auth: client }).documents.get({ documentId });
    return res.data;
  },
  async batchUpdateDocument(client, documentId, requests) {
    const res = await docsClient({ version: 'v1', auth: client }).documents.batchUpdate({
      documentId,
      requestBody: { requests },
    });
    return res.data;
  },
  async copyFile(client, fileId, name) {
    const res = await driveClient({ version: 'v3', auth: client }).files.copy({
      fileId,
      fields: 'id,name',
      requestBody: { name },
    });
    if (typeof res.data.id !== 'string') throw new Error('drive copy returned no id');
    return { id: res.data.id, name: res.data.name ?? name };
  },
  async getFile(client, fileId) {
    const res = await driveClient({ version: 'v3', auth: client }).files.get({
      fileId,
      fields: 'id, name',
    });
    if (typeof res.data.id !== 'string' || typeof res.data.name !== 'string') {
      throw new Error('drive file missing id or name');
    }
    return { id: res.data.id, name: res.data.name };
  },
  async searchDriveFiles(client, opts) {
    const clauses = ["mimeType = 'application/vnd.google-apps.document'", 'trashed = false'];
    const term = opts.q?.trim();
    if (term !== undefined && term !== '') {
      clauses.push(`name contains '${escapeDriveQueryLiteral(term)}'`);
    }
    const res = await driveClient({ version: 'v3', auth: client }).files.list({
      q: clauses.join(' and '),
      orderBy: 'modifiedTime desc',
      pageSize: opts.pageSize,
      pageToken: opts.pageToken,
      fields: 'nextPageToken, files(id, name, modifiedTime, parents)',
    });
    const files = (res.data.files ?? []).flatMap((f) =>
      typeof f.id === 'string' && typeof f.name === 'string'
        ? [
            {
              id: f.id,
              name: f.name,
              modifiedTime: f.modifiedTime ?? '',
              parentId: f.parents?.[0] ?? null,
            },
          ]
        : [],
    );
    return { files, nextPageToken: res.data.nextPageToken ?? undefined };
  },
  async gmailProfile(client) {
    const data = await gmailGet<{ historyId?: string; emailAddress?: string }>(
      client,
      '/profile',
      {},
    );
    if (typeof data.historyId !== 'string') throw new Error('gmail profile returned no historyId');
    return {
      historyId: data.historyId,
      emailAddress: typeof data.emailAddress === 'string' ? data.emailAddress : null,
    };
  },
  async gmailListMessages(client, opts) {
    const data = await gmailGet<{
      messages?: { id?: string; threadId?: string }[];
      nextPageToken?: string;
    }>(client, '/messages', { q: opts.q, maxResults: GMAIL_PAGE_SIZE, pageToken: opts.pageToken });
    return {
      messages: (data.messages ?? []).flatMap((m) =>
        typeof m.id === 'string' ? [{ id: m.id, threadId: m.threadId ?? m.id }] : [],
      ),
      nextPageToken: data.nextPageToken,
    };
  },
  async gmailGetMessage(client, id) {
    return gmailGet<GmailMessage>(client, `/messages/${encodeURIComponent(id)}`, {
      format: 'full',
    });
  },
  async gmailGetAttachment(client, messageId, attachmentId) {
    const data = await gmailGet<{ data?: string }>(
      client,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      {},
    );
    return { data: data.data ?? '' };
  },
  async gmailListLabels(client) {
    const data = await gmailGet<{ labels?: { id?: string; name?: string }[] }>(
      client,
      '/labels',
      {},
    );
    return (data.labels ?? [])
      .filter((l): l is { id: string; name: string } => !!l.id && !!l.name)
      .map((l) => ({ id: l.id, name: l.name }));
  },
  async gmailListHistory(client, opts) {
    const data = await gmailGet<RawHistory>(client, '/history', {
      startHistoryId: opts.startHistoryId,
      historyTypes: 'messageAdded',
      maxResults: GMAIL_PAGE_SIZE,
      pageToken: opts.pageToken,
    });
    const added: GmailHistoryPage['added'] = [];
    for (const h of data.history ?? []) {
      for (const a of h.messagesAdded ?? []) {
        const m = a.message;
        if (typeof m?.id === 'string') {
          added.push({ id: m.id, threadId: m.threadId ?? m.id, labelIds: m.labelIds ?? null });
        }
      }
    }
    return {
      added,
      historyId: data.historyId ?? opts.startHistoryId,
      nextPageToken: data.nextPageToken,
    };
  },
};

/** The HTTP status carried by a Google client error, when there is one. */
export function googleErrorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  if (typeof e?.response?.status === 'number') return e.response.status;
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  return undefined;
}

/** A per-user quota trip: 429, or Gmail's 403 flavor named by reason or message text. */
export function isGoogleRateLimit(err: unknown): boolean {
  const status = googleErrorStatus(err);
  if (status === 429) return true;
  if (status !== 403) return false;
  const reason = googleErrorReason(err);
  if (reason !== undefined) return /ratelimit|quota/i.test(reason);
  const message = err instanceof Error ? err.message : '';
  return /rate ?limit|quota exceeded/i.test(message);
}

/** The API error reason (e.g. rateLimitExceeded), a safe enum-like string, when present. */
export function googleErrorReason(err: unknown): string | undefined {
  const e = err as {
    errors?: { reason?: unknown }[];
    response?: { data?: { error?: { errors?: { reason?: unknown }[] } } };
  };
  const reason = e?.errors?.[0]?.reason ?? e?.response?.data?.error?.errors?.[0]?.reason;
  return typeof reason === 'string' && /^[a-zA-Z]{1,60}$/.test(reason) ? reason : undefined;
}

/**
 * Runs a Google call, waiting out per-user rate limits with exponential backoff. Gmail's
 * per-user quota is per MINUTE (observed: 6,000 units/min, 5 per message get), so the waits
 * must be able to outlive the window that was just exhausted: 8 attempts with a 60s cap wait
 * up to ~3 minutes in all. Any other error, and the last rate-limit error once retries run
 * out, is rethrown untouched. `onRateLimit` fires once per trip (callers slow themselves).
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; onRateLimit?: () => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 8;
  const baseMs = opts.baseMs ?? 1000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isGoogleRateLimit(err) || attempt >= attempts - 1) throw err;
      opts.onRateLimit?.();
      const delay = Math.min(baseMs * 2 ** attempt, 60_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Maps a Google client error to a client-facing HttpError. The error object itself is never
 * logged or returned: a gaxios error carries the request, which can include tokens.
 */
export function googleHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const status = googleErrorStatus(err);
  const message = err instanceof Error ? err.message : '';
  if (status === 401 || /invalid_grant/i.test(message)) {
    return new HttpError(409, 'google_reauth_required');
  }
  // accessNotConfigured: the project that owns the OAuth client has not enabled the API.
  // Without this case the error reads as a missing document, which sends the user hunting
  // through Drive sharing instead of the console's Enable APIs page (observed live).
  if (
    status === 403 &&
    /has not been used in project|it is disabled|accessNotConfigured/i.test(message)
  ) {
    const api = /([A-Za-z][A-Za-z ]*? API) has not been used/.exec(message)?.[1];
    return new HttpError(
      422,
      'google_api_disabled',
      `${api ?? 'A required Google API'} is not enabled in the Google Cloud project that owns your OAuth client. Enable it (guided setup, Enable APIs step), wait a few minutes, and try again.`,
    );
  }
  if (status === 403 || status === 404) return new HttpError(422, 'google_doc_unavailable');
  return new HttpError(502, 'google_error');
}

// ---------------------------------------------------------------------------
// Vault access

async function findSecretId(exec: Exec, ctx: UserCtx, label: string): Promise<string | undefined> {
  return (
    await exec
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, ctx.userId),
          eq(secrets.kind, GOOGLE_SECRET_KIND),
          eq(secrets.label, label),
        ),
      )
      .orderBy(desc(secrets.createdAt), desc(secrets.id))
      .get()
  )?.id;
}

/** `exec` reads (the database or a transaction on it), `db` supplies the vault key. */
async function readSecret(
  exec: Exec,
  db: Db,
  ctx: UserCtx,
  label: string,
): Promise<string | undefined> {
  const id = await findSecretId(exec, ctx, label);
  return id === undefined ? undefined : await getSecretValueIn(exec, db, ctx, id);
}

/**
 * Stores the value under the label, then drops the caller's older rows with that label: one
 * transaction under the user's scope, so two concurrent writes cannot each delete the other's
 * row (leaving none).
 */
async function replaceSecret(db: Db, ctx: UserCtx, label: string, value: string): Promise<void> {
  await racePoint('google.replaceSecret');
  await withTransaction(db, (tx) => replaceSecretIn(tx, db, ctx, label, value));
}

async function replaceSecretIn(
  tx: Exec,
  db: Db,
  ctx: UserCtx,
  label: string,
  value: string,
): Promise<void> {
  await lockScope(tx, `user:${ctx.userId}`);
  const { id } = await putSecretIn(tx, db, ctx, GOOGLE_SECRET_KIND, label, value);
  await racePoint('google.replaceSecret.locked');
  await tx
    .delete(secrets)
    .where(
      and(
        eq(secrets.userId, ctx.userId),
        eq(secrets.kind, GOOGLE_SECRET_KIND),
        eq(secrets.label, label),
        ne(secrets.id, id),
      ),
    )
    .run();
}

export interface GoogleClientCreds {
  clientId: string;
  clientSecret: string;
}

export async function writeClientCreds(
  db: Db,
  ctx: UserCtx,
  creds: GoogleClientCreds,
): Promise<void> {
  await replaceSecret(db, ctx, GOOGLE_CLIENT_ID_LABEL, creds.clientId);
  await replaceSecret(db, ctx, GOOGLE_CLIENT_SECRET_LABEL, creds.clientSecret);
}

/**
 * The client id alone. An id is not a secret (it travels in every consent URL), and reading it
 * on its own keeps the sealed secret out of memory when all a caller needs is to name the
 * client already on file.
 */
export async function readClientId(db: Db, ctx: UserCtx): Promise<string | undefined> {
  return await readSecret(db, db, ctx, GOOGLE_CLIENT_ID_LABEL);
}

export async function readClientCreds(
  db: Db,
  ctx: UserCtx,
): Promise<GoogleClientCreds | undefined> {
  const clientId = await readSecret(db, db, ctx, GOOGLE_CLIENT_ID_LABEL);
  const clientSecret = await readSecret(db, db, ctx, GOOGLE_CLIENT_SECRET_LABEL);
  return clientId === undefined || clientSecret === undefined
    ? undefined
    : { clientId, clientSecret };
}

/** The token record kept (encrypted) under google_tokens. */
export const StoredTokensSchema = z.object({
  accessToken: z.string().nullable(),
  refreshToken: z.string().nullable(),
  expiryDate: z.number().nullable(),
  scopes: z.array(z.string()),
  email: z.string().optional(),
});
export type StoredTokens = z.infer<typeof StoredTokensSchema>;

export async function readTokens(db: Db, ctx: UserCtx): Promise<StoredTokens | undefined> {
  return await readTokensIn(db, db, ctx);
}

async function readTokensIn(exec: Exec, db: Db, ctx: UserCtx): Promise<StoredTokens | undefined> {
  const raw = await readSecret(exec, db, ctx, GOOGLE_TOKENS_LABEL);
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = StoredTokensSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export async function writeTokens(db: Db, ctx: UserCtx, tokens: StoredTokens): Promise<void> {
  await replaceSecret(db, ctx, GOOGLE_TOKENS_LABEL, JSON.stringify(tokens));
}

/**
 * Persists a token refresh: read, merge (mergeTokens) and replace in one transaction under the
 * user's scope, so a concurrent refresh that omitted the refresh token cannot write back the
 * old one over a rotated one.
 */
export async function storeRefreshedTokens(
  db: Db,
  ctx: UserCtx,
  fresh: Credentials,
): Promise<void> {
  await racePoint('google.refresh');
  await withTransaction(db, async (tx) => {
    await lockScope(tx, `user:${ctx.userId}`);
    const prev = await readTokensIn(tx, db, ctx);
    const merged = JSON.stringify(mergeTokens(prev, fresh));
    await replaceSecretIn(tx, db, ctx, GOOGLE_TOKENS_LABEL, merged);
  });
}

export function scopesOf(scope: string | undefined | null): string[] {
  return (scope ?? '').split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Folds a token response into the stored record. Google may omit the refresh token on a
 * refresh, so an absent one keeps the old value; a rotated one replaces it. Scopes from an
 * incremental grant are the union of what was granted before and now.
 */
export function mergeTokens(prev: StoredTokens | undefined, next: Credentials): StoredTokens {
  const scopes = new Set([...(prev?.scopes ?? []), ...scopesOf(next.scope)]);
  return {
    accessToken: next.access_token ?? prev?.accessToken ?? null,
    refreshToken: next.refresh_token ?? prev?.refreshToken ?? null,
    expiryDate: next.expiry_date ?? prev?.expiryDate ?? null,
    scopes: [...scopes].sort(),
    ...(prev?.email === undefined ? {} : { email: prev.email }),
  };
}

/** Removes every Google secret the caller holds (tokens and client credentials). */
export async function deleteGoogleSecrets(db: Db, ctx: UserCtx): Promise<void> {
  for (const label of GOOGLE_SECRET_LABELS) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.userId, ctx.userId),
          eq(secrets.kind, GOOGLE_SECRET_KIND),
          eq(secrets.label, label),
        ),
      )
      .run();
  }
}

// ---------------------------------------------------------------------------
// OAuth state: an HMAC-signed nonce bound to the session and user, valid for 10 minutes and
// good once (the callback spends the nonce through spendNonce, which remembers a spent one
// for the same 10 minutes, so a state can never outlive its record).

const STATE_TTL_MS = 10 * 60 * 1000;

const StatePayload = z.object({
  n: z.string().min(16),
  e: z.number().int(),
  s: z.enum(GOOGLE_SCOPE_SET_NAMES),
});

/** The session's stable id (what the sessions table stores): SHA-256 hex of the cookie. */
export function sessionIdOf(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

/** A purpose-bound key: the master key is never used directly as an HMAC key. */
function stateKey(masterKey: Buffer): Buffer {
  return createHmac('sha256', masterKey).update('opportun:google-oauth-state:v1').digest();
}

function stateMac(masterKey: Buffer, body: string, sessionId: string, userId: string): Buffer {
  return createHmac('sha256', stateKey(masterKey))
    .update(`${body}|${sessionId}|${userId}`)
    .digest();
}

export function signState(
  masterKey: Buffer,
  sessionId: string,
  userId: string,
  scopeSet: GoogleScopeSet,
  now = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({
      n: randomBytes(16).toString('base64url'),
      e: now + STATE_TTL_MS,
      s: scopeSet,
    }),
  ).toString('base64url');
  return `${body}.${stateMac(masterKey, body, sessionId, userId).toString('base64url')}`;
}

export interface VerifiedState {
  scopeSet: GoogleScopeSet;
  /** The nonce for the caller to spend (spendNonce), so the state is good only once. */
  nonce: string;
}

/**
 * The scope set and nonce the state was issued for, or null when forged, foreign, or expired.
 * Spending the nonce is the caller's step, as in the sign-in flow: the signature proves the
 * state was issued to this session and user, not that it has never been presented before.
 */
export function verifyState(
  masterKey: Buffer,
  state: string,
  sessionId: string,
  userId: string,
  now = Date.now(),
): VerifiedState | null {
  const dot = state.indexOf('.');
  if (dot <= 0 || state.length > 1024) return null;
  const body = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1), 'base64url');
  const expected = stateMac(masterKey, body, sessionId, userId);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = StatePayload.safeParse(payload);
  if (!parsed.success || parsed.data.e < now) return null;
  return { scopeSet: parsed.data.s, nonce: parsed.data.n };
}

// ---------------------------------------------------------------------------
// Authorized clients

export function newOAuthClient(creds: GoogleClientCreds, redirectUri: string): OAuth2Client {
  return new OAuth2Client({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri,
  });
}

/** The consent URL: offline access, forced consent, incremental grant. */
export function buildAuthUrl(client: OAuth2Client, scopes: readonly string[], state: string) {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...scopes],
    state,
  });
}

export interface GoogleConn {
  /**
   * An OAuth2Client carrying the caller's tokens. 409 when the client is not configured, the
   * account is not connected, or a requested scope was never granted. Token refreshes are
   * persisted (encrypted), including a rotated refresh token.
   */
  getClient(db: Db, ctx: UserCtx, scopes: readonly string[]): Promise<OAuth2Client>;
}

export function createGoogleConn(opts: {
  redirectUri: string;
  log: FastifyBaseLogger;
}): GoogleConn {
  return {
    async getClient(db, ctx, scopes) {
      const creds = await readClientCreds(db, ctx);
      if (creds === undefined) throw new HttpError(409, 'google_not_configured');
      const tokens = await readTokens(db, ctx);
      if (tokens === undefined || (tokens.refreshToken === null && tokens.accessToken === null)) {
        throw new HttpError(409, 'google_not_connected');
      }
      const granted = new Set(tokens.scopes);
      const missing = scopes.filter((s) => !granted.has(s));
      if (missing.length > 0) throw new HttpError(409, 'google_scope_missing');

      const client = newOAuthClient(creds, opts.redirectUri);
      client.setCredentials({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_date: tokens.expiryDate,
        scope: tokens.scopes.join(' '),
      });
      client.on('tokens', (fresh: Credentials) => {
        // Runs inside the library's refresh, synchronously from its own point of view: the
        // event is emitted whether or not anything is listening, so there is nothing to await
        // here that would make the refresh itself wait on the write (#147). What matters is
        // that a failed write is no longer indistinguishable from a successful one: logged
        // here, with the user it belongs to, rather than discarded. The in-memory client still
        // has the fresh token for this request either way, which is why a write failure still
        // must not throw and break the request that triggered the refresh; only the DB falls
        // behind, silently until now, surfacing later as an unexplained google_reauth_required
        // with nothing connecting it back to this.
        storeRefreshedTokens(db, ctx, fresh).catch((err: unknown) => {
          opts.log.error({ err, userId: ctx.userId }, 'failed to persist a refreshed Google token');
        });
      });
      return client;
    },
  };
}
