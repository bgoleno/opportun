// Reactive Resume document store (FR-R7, ADR-11, design 6.2): resumes kept in the user's own
// Reactive Resume instance instead of Google Docs, so Opportun works without a Google account.
//
// TARGETED VERSION: Reactive Resume v6.0.x (OpenAPI document `info.version` 6.0.3, read from
// https://docs.rxresu.me/spec.json on 2026-10-17). Earlier majors are NOT supported: v4 had
// no API keys (cookie JWT only) and v5 used other routes. No live instance was available, so
// the contract is the recorded fake in test/fakeReactiveResume.ts, whose header lists every
// assumption (A1-A9). The subset used here:
//   GET   <origin>/api/health                      version probe, no credential
//   GET   <origin>/api/openapi/resumes?limit=1     key probe (no "me" endpoint for API keys)
//   GET   <origin>/api/openapi/resumes/{id}        name, updatedAt, data (the resume JSON)
//   POST  <origin>/api/openapi/resumes/{id}/copies { name } -> new id (JSON string)
//   PATCH <origin>/api/openapi/resumes/{id}        { operations: JSON Patch, expectedUpdatedAt }
// Auth: `x-api-key: <key>`, on /api/openapi calls only (never on the health probe). Every call
// goes through safeFetch with allowHosts = the configured host, and a credentialed request
// never follows a redirect, so the key only reaches the configured origin. safeFetch also
// requires https and a public address: an instance reachable only on a LAN or localhost is
// refused.
//
// Lossy compared with Google Docs, by design and documented on the Settings card:
//   - the text Opportun reads is the visible text fields of the resume JSON (basics, summary,
//     section titles and items, custom sections), one line per field or rich-text paragraph;
//     hidden items, dates, links, icons and layout are left out;
//   - an edit replaces text inside ONE field and, for rich text, inside one text node: text
//     that crosses bold/italic/link formatting is refused (edit_spans_formatting), and a
//     changed rich-text node is re-encoded (a non-breaking space becomes a plain space);
//   - the tailored copy is a duplicate in Reactive Resume; Opportun never renders or exports
//     the PDF itself.
import { z } from 'zod';
import { and, desc, eq, ne } from 'drizzle-orm';
import { withTransaction, type Db } from '../db/client';
import { secrets, settings } from '../db/schema';
import { HttpError } from '../lib/errors';
import { FetchBlockedError, type safeFetch } from '../lib/safeFetch';
import { racePoint } from '../lib/racePoints';
import { getSecretValue, putSecretIn } from '../lib/secretBox';
import type { Exec, UserCtx } from '../repos/base';
import { readUserSetting, userSettingKey, writeUserSetting } from '../repos/userSettings';
import type { DocumentStore, ResumeDocMeta, ResumeEdit, ResumeEditResult } from './documentStore';

/** The Reactive Resume releases this adapter was written against (shown on the card). */
export const RR_TARGET_VERSIONS: readonly string[] = ['6.0'];

export const RR_SECRET_KIND = 'oauth_token' as const;
export const RR_SECRET_LABEL = 'reactive_resume';
export const RR_URL_SETTING = 'reactive_resume_url';
export const DOCUMENT_STORE_SETTING = 'document_store';
export const DOCUMENT_STORE_PREFS = ['google', 'reactive_resume'] as const;
export type DocumentStorePref = (typeof DOCUMENT_STORE_PREFS)[number];

export interface RrConfig {
  /** An https origin without a trailing slash. */
  baseUrl: string;
  apiKey: string;
}

export type RrFetch = typeof safeFetch;

// ---------------------------------------------------------------------------
// URLs and references

/** The instance origin from a user-entered URL: https only, no credentials, path ignored. */
export function parseRrBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(
      400,
      'invalid_base_url',
      'Enter the https address of your Reactive Resume.',
    );
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(400, 'invalid_base_url', 'Reactive Resume must be reached over https.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new HttpError(400, 'invalid_base_url', 'The address must not contain credentials.');
  }
  return url.origin;
}

const RR_ID = /^[A-Za-z0-9_-]{8,100}$/;

/** A resume id from an id or a `<origin>/builder/<id>` link on the configured origin. */
export function parseRrRef(ref: string, baseUrl: string): string {
  const trimmed = ref.trim();
  if (RR_ID.test(trimmed)) return trimmed;
  let url: URL | undefined;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }
  if (url !== undefined && url.origin === baseUrl) {
    const m = /^\/builder\/([A-Za-z0-9_-]{8,100})\/?$/.exec(url.pathname);
    if (m?.[1] !== undefined) return m[1];
  }
  throw new HttpError(400, 'invalid_doc_ref');
}

export function rrResumeUrl(baseUrl: string, id: string): string {
  return `${baseUrl}/builder/${id}`;
}

// ---------------------------------------------------------------------------
// The resume JSON as text

/** One editable text field of the resume JSON. */
export interface RrSlot {
  /** JSON Pointer into `data`. */
  path: string;
  html: boolean;
  value: string;
}

const PLAIN_FIELDS: ReadonlySet<string> = new Set([
  'company',
  'position',
  'location',
  'school',
  'degree',
  'area',
  'grade',
  'name',
  'network',
  'username',
  'language',
  'fluency',
  'proficiency',
  'title',
  'awarder',
  'issuer',
  'publisher',
  'organization',
  'phone',
]);
const HTML_FIELDS: ReadonlySet<string> = new Set(['description', 'content', 'recipient']);
const BASICS_FIELDS = ['name', 'headline', 'email', 'phone', 'location'] as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const ptr = (...parts: (string | number)[]): string =>
  parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

function itemSlots(item: Json, base: (string | number)[], out: RrSlot[]): void {
  for (const [key, value] of Object.entries(item)) {
    if (typeof value === 'string') {
      if (PLAIN_FIELDS.has(key)) out.push({ path: ptr(...base, key), html: false, value });
      else if (HTML_FIELDS.has(key)) out.push({ path: ptr(...base, key), html: true, value });
    } else if (key === 'keywords' && Array.isArray(value)) {
      value.forEach((k, i) => {
        if (typeof k === 'string') out.push({ path: ptr(...base, key, i), html: false, value: k });
      });
    } else if (key === 'roles' && Array.isArray(value)) {
      value.forEach((role, i) => {
        if (isObj(role)) itemSlots(role, [...base, key, i], out);
      });
    }
  }
}

function sectionSlots(section: unknown, base: (string | number)[], out: RrSlot[]): void {
  if (!isObj(section) || section.hidden === true || !Array.isArray(section.items)) return;
  const visible = section.items
    .map((item, i) => ({ item, i }))
    .filter((x): x is { item: Json; i: number } => isObj(x.item) && x.item.hidden !== true);
  if (visible.length === 0) return;
  if (typeof section.title === 'string') {
    out.push({ path: ptr(...base, 'title'), html: false, value: section.title });
  }
  for (const { item, i } of visible) itemSlots(item, [...base, 'items', i], out);
}

/** The visible text fields of a resume's `data`, in reading order. */
export function rrSlots(data: unknown): RrSlot[] {
  const out: RrSlot[] = [];
  if (!isObj(data)) return out;
  const basics = data.basics;
  if (isObj(basics)) {
    for (const key of BASICS_FIELDS) {
      // eslint-disable-next-line security/detect-object-injection -- key is a fixed field name
      const v = basics[key];
      if (typeof v === 'string') out.push({ path: ptr('basics', key), html: false, value: v });
    }
  }
  const summary = data.summary;
  if (isObj(summary) && summary.hidden !== true && typeof summary.content === 'string') {
    if (htmlLines(summary.content).length > 0) {
      if (typeof summary.title === 'string') {
        out.push({ path: ptr('summary', 'title'), html: false, value: summary.title });
      }
      out.push({ path: ptr('summary', 'content'), html: true, value: summary.content });
    }
  }
  if (isObj(data.sections)) {
    for (const [key, section] of Object.entries(data.sections)) {
      sectionSlots(section, ['sections', key], out);
    }
  }
  if (Array.isArray(data.customSections)) {
    data.customSections.forEach((section, i) => sectionSlots(section, ['customSections', i], out));
  }
  return out;
}

// Rich text (A8): TipTap HTML. Block tags break lines; inline tags are dropped.
type Token = { tag: true; raw: string; block: boolean } | { tag: false; raw: string };
const BLOCK_TAGS = /^<\/?\s*(p|li|ul|ol|h[1-6]|div|br|blockquote|pre|tr|table|hr)\b/i;

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<[^>]*>/g;
  let last = 0;
  for (const m of html.matchAll(re)) {
    const at = m.index;
    if (at > last) tokens.push({ tag: false, raw: html.slice(last, at) });
    tokens.push({ tag: true, raw: m[0], block: BLOCK_TAGS.test(m[0]) });
    last = at + m[0].length;
  }
  if (last < html.length) tokens.push({ tag: false, raw: html.slice(last) });
  return tokens;
}

const NAMED: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const cp = parseInt(name.slice(2), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (name.startsWith('#')) {
      const cp = parseInt(name.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED.get(name.toLowerCase()) ?? whole;
  });
}

const encodeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The non-blank lines of a rich-text field. */
export function htmlLines(html: string): string[] {
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    if (line.trim() !== '') lines.push(...line.split('\n').filter((l) => l.trim() !== ''));
    line = '';
  };
  for (const t of tokenize(html)) {
    if (t.tag) {
      if (t.block) flush();
    } else {
      line += decodeEntities(t.raw).replace(/\u00a0/g, ' ');
    }
  }
  flush();
  return lines;
}

function slotLines(slot: RrSlot): string[] {
  if (slot.html) return htmlLines(slot.value);
  return slot.value.split('\n').filter((l) => l.trim() !== '');
}

const slotsText = (slots: RrSlot[]): string => slots.flatMap(slotLines).join('\n');

/** The resume as plain text (one line per field or paragraph) and its editable fields. */
export function flattenRrResume(data: unknown): { text: string; slots: RrSlot[] } {
  const slots = rrSlots(data);
  return { text: slotsText(slots), slots };
}

/** Non-overlapping occurrences of `find` (the same count split/join replaces). */
const occurrences = (text: string, find: string): number => text.split(find).length - 1;

/**
 * Replaces every occurrence of `find` that lies inside one plain field or one rich-text
 * node; returns how many it replaced. An occurrence crossing a tag is not replaced here.
 */
function replaceInSlot(slot: RrSlot, find: string, replace: string): number {
  if (!slot.html) {
    const n = occurrences(slot.value, find);
    if (n > 0) slot.value = slot.value.split(find).join(replace);
    return n;
  }
  let replaced = 0;
  const rebuilt = tokenize(slot.value).map((t) => {
    if (t.tag) return t.raw;
    const text = decodeEntities(t.raw).replace(/\u00a0/g, ' ');
    const n = occurrences(text, find);
    if (n === 0) return t.raw;
    replaced += n;
    return encodeText(text.split(find).join(replace));
  });
  if (replaced > 0) slot.value = rebuilt.join('');
  return replaced;
}

// ---------------------------------------------------------------------------
// HTTP

const ErrorBody = z.object({ code: z.string() }).loose();

function rrHttpError(status: number, body: Buffer): HttpError {
  let code: string | undefined;
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(body.toString('utf8')));
    code = parsed.success ? parsed.data.code : undefined;
  } catch {
    code = undefined;
  }
  if (status === 401) {
    return new HttpError(
      409,
      'reactive_resume_unauthorized',
      'Reactive Resume rejected the API key. Create a new API key in Reactive Resume and save it in Settings > Integrations.',
    );
  }
  if (status === 403 && code === 'RESUME_LOCKED') {
    return new HttpError(
      409,
      'reactive_resume_locked',
      'The resume is locked in Reactive Resume. Unlock it there, then try again.',
    );
  }
  if (status === 409) {
    return new HttpError(
      409,
      'reactive_resume_conflict',
      'The resume changed in Reactive Resume while the edit was being applied. Try again.',
    );
  }
  if (status === 403 || status === 404) return new HttpError(422, 'reactive_resume_unavailable');
  if (status === 400) return new HttpError(422, 'reactive_resume_rejected');
  return new HttpError(502, 'reactive_resume_error', undefined, { status });
}

interface CallOpts {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /**
   * Path under the origin instead of /api/openapi, sent WITHOUT the key: only the
   * credential-free health probe uses it, so a mistyped host never receives the key.
   */
  raw?: boolean;
}

/** One API call; the key goes in a header to the configured origin, for /api/openapi only. */
async function rrCall(
  fetch: RrFetch,
  cfg: RrConfig,
  path: string,
  opts: CallOpts = {},
): Promise<{ status: number; json: unknown; body: Buffer }> {
  const url = `${cfg.baseUrl}${opts.raw === true ? '' : '/api/openapi'}${path}`;
  const host = new URL(cfg.baseUrl).hostname;
  const method = opts.method ?? 'GET';
  let res;
  try {
    res = await fetch(url, {
      allowHosts: [host],
      ...(opts.raw === true ? {} : { headers: { 'x-api-key': cfg.apiKey } }),
      ...(method === 'GET'
        ? {}
        : {
            post: {
              method,
              contentType: 'application/json',
              body: JSON.stringify(opts.body ?? {}),
            },
          }),
    });
  } catch (err) {
    const reason = err instanceof FetchBlockedError ? err.reason : 'network';
    throw new HttpError(
      502,
      'reactive_resume_unreachable',
      'Reactive Resume could not be reached at the configured address.',
      { reason },
    );
  }
  let json: unknown;
  try {
    json = res.body.length === 0 ? undefined : (JSON.parse(res.body.toString('utf8')) as unknown);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, body: res.body };
}

async function rrJson(
  fetch: RrFetch,
  cfg: RrConfig,
  path: string,
  opts: CallOpts = {},
): Promise<unknown> {
  const res = await rrCall(fetch, cfg, path, opts);
  if (res.status < 200 || res.status >= 300) throw rrHttpError(res.status, res.body);
  if (res.json === undefined) throw new HttpError(502, 'reactive_resume_error');
  return res.json;
}

const ResumeBody = z
  .object({ id: z.string(), name: z.string(), updatedAt: z.string(), data: z.unknown() })
  .loose();

async function getResume(fetch: RrFetch, cfg: RrConfig, id: string) {
  const parsed = ResumeBody.safeParse(
    await rrJson(fetch, cfg, `/resumes/${encodeURIComponent(id)}`),
  );
  if (!parsed.success) throw new HttpError(502, 'reactive_resume_error');
  return parsed.data;
}

export interface RrValidation {
  ok: boolean;
  version: string | null;
  error: 'unreachable' | 'not_reactive_resume' | 'unhealthy' | 'unauthorized' | 'error' | null;
}

/** Health (version) then a one-item resume list (the key). Never throws. */
export async function validateReactiveResume(fetch: RrFetch, cfg: RrConfig): Promise<RrValidation> {
  let version: string | null = null;
  try {
    const health = await rrCall(fetch, cfg, '/api/health', { raw: true });
    const h = z
      .object({ service: z.literal('reactive-resume'), version: z.string(), status: z.string() })
      .safeParse(health.json);
    if (!h.success) return { ok: false, version: null, error: 'not_reactive_resume' };
    version = h.data.version;
    if (health.status !== 200 || h.data.status !== 'healthy') {
      return { ok: false, version, error: 'unhealthy' };
    }
    const list = await rrCall(fetch, cfg, '/resumes?limit=1');
    if (list.status === 401 || list.status === 403) {
      return { ok: false, version, error: 'unauthorized' };
    }
    if (list.status !== 200 || !Array.isArray(list.json))
      return { ok: false, version, error: 'error' };
    return { ok: true, version, error: null };
  } catch {
    return { ok: false, version, error: 'unreachable' };
  }
}

// ---------------------------------------------------------------------------
// The store

export interface ReactiveResumeDeps {
  fetch: RrFetch;
  /** The caller's configuration, or undefined when not connected. */
  config(ctx: UserCtx): Promise<RrConfig | undefined>;
}

export function createReactiveResumeStore(deps: ReactiveResumeDeps): DocumentStore {
  async function cfgFor(ctx: UserCtx): Promise<RrConfig> {
    const cfg = await deps.config(ctx);
    if (cfg === undefined) {
      throw new HttpError(
        409,
        'reactive_resume_not_connected',
        'Connect Reactive Resume in Settings > Integrations first.',
      );
    }
    return cfg;
  }

  return {
    async registerExisting(ctx, ref): Promise<ResumeDocMeta> {
      const cfg = await cfgFor(ctx);
      const id = parseRrRef(ref, cfg.baseUrl);
      const resume = await getResume(deps.fetch, cfg, id);
      return { docRef: id, title: resume.name, url: rrResumeUrl(cfg.baseUrl, id) };
    },

    async copyFrom(ctx, baseRef, name): Promise<ResumeDocMeta> {
      const cfg = await cfgFor(ctx);
      const baseId = parseRrRef(baseRef, cfg.baseUrl);
      const created = await rrJson(
        deps.fetch,
        cfg,
        `/resumes/${encodeURIComponent(baseId)}/copies`,
        { method: 'POST', body: { name } },
      );
      if (typeof created !== 'string' || !RR_ID.test(created)) {
        throw new HttpError(502, 'reactive_resume_error');
      }
      return { docRef: created, title: name, url: rrResumeUrl(cfg.baseUrl, created) };
    },

    async readText(ctx, ref) {
      const cfg = await cfgFor(ctx);
      const resume = await getResume(deps.fetch, cfg, parseRrRef(ref, cfg.baseUrl));
      return flattenRrResume(resume.data).text;
    },

    async applyEdits(ctx, ref, edits: ResumeEdit[]) {
      if (edits.some((e) => e.find.includes('\n'))) {
        throw new HttpError(422, 'edit_spans_paragraphs');
      }
      const cfg = await cfgFor(ctx);
      const id = parseRrRef(ref, cfg.baseUrl);
      const resume = await getResume(deps.fetch, cfg, id);
      const { text, slots } = flattenRrResume(resume.data);
      const missing = edits.findIndex((e) => !text.includes(e.find));
      if (missing !== -1) {
        throw new HttpError(409, 'edit_target_missing', undefined, { index: missing });
      }
      const original = new Map(slots.map((s) => [s.path, s.value]));
      const results: ResumeEditResult[] = edits.map((edit, index) => {
        // Every occurrence in the text must be replaceable: one that crosses formatting would
        // otherwise be skipped silently while the rest change. Counting before replacing
        // keeps text the replacement itself introduces out of the comparison.
        const before = occurrences(slotsText(slots), edit.find);
        if (before === 0) {
          // Present in the pre-batch snapshot above (the missing check already passed), but
          // nothing left by this edit's turn: an earlier edit in this same batch already
          // replaced every occurrence (issue #146). The earlier edit's change still stands;
          // this one did nothing, and the caller must be told which.
          return { index, outcome: 'already_consumed' };
        }
        let replaced = 0;
        for (const slot of slots) replaced += replaceInSlot(slot, edit.find, edit.replace);
        if (replaced < before) {
          throw new HttpError(
            422,
            'edit_spans_formatting',
            'This edit crosses formatting (bold, italic or a link) in Reactive Resume; apply it by hand there.',
            { index },
          );
        }
        return { index, outcome: 'applied' };
      });
      const operations = slots
        .filter((s) => original.get(s.path) !== s.value)
        .map((s) => ({ op: 'replace' as const, path: s.path, value: s.value }));
      if (operations.length > 0) {
        await rrJson(deps.fetch, cfg, `/resumes/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { operations, expectedUpdatedAt: resume.updatedAt },
        });
      }
      // Mutated in place: the same Reactive Resume resume id, same ref, as before.
      return { docRef: ref, results };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-user configuration: the origin is a user setting, the key a vault secret.

async function keyRowId(db: Exec, ctx: UserCtx): Promise<string | undefined> {
  return (
    await db
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.userId, ctx.userId),
          eq(secrets.kind, RR_SECRET_KIND),
          eq(secrets.label, RR_SECRET_LABEL),
        ),
      )
      .orderBy(desc(secrets.createdAt), desc(secrets.id))
      .get()
  )?.id;
}

export async function readRrBaseUrl(db: Exec, ctx: UserCtx): Promise<string | null> {
  return await readUserSetting(db, ctx, RR_URL_SETTING, z.string().min(1).nullable(), null);
}

export async function rrKeySet(db: Exec, ctx: UserCtx): Promise<boolean> {
  return (await keyRowId(db, ctx)) !== undefined;
}

export async function readRrConfig(db: Db, ctx: UserCtx): Promise<RrConfig | undefined> {
  const baseUrl = await readRrBaseUrl(db, ctx);
  const id = await keyRowId(db, ctx);
  if (baseUrl === null || id === undefined) return undefined;
  return { baseUrl, apiKey: await getSecretValue(db, ctx, id) };
}

/**
 * Saves the origin and (when given) a new key, dropping older key rows, in ONE transaction:
 * a key must never end up stored against an origin it was not saved with. Moving the
 * stored key to a different origin is refused for the same reason.
 */
export async function writeRrConfig(
  db: Db,
  ctx: UserCtx,
  baseUrl: string,
  apiKey: string | undefined,
): Promise<void> {
  await racePoint('rr.config');
  // The user's scope: the key row and the address commit together, and a second save cannot
  // interleave its put-then-delete-the-others with this one (two key rows left behind).
  await withTransaction(
    db,
    async (tx) => {
      // eslint-disable-next-line security/detect-possible-timing-attacks -- a presence check, not a compare
      if (apiKey === undefined) {
        if (!(await rrKeySet(tx, ctx)) || (await readRrBaseUrl(tx, ctx)) !== baseUrl) {
          throw new HttpError(
            422,
            'api_key_required',
            'Enter the API key again when setting or changing the Reactive Resume address.',
          );
        }
      } else {
        const { id } = await putSecretIn(tx, db, ctx, RR_SECRET_KIND, RR_SECRET_LABEL, apiKey);
        await racePoint('rr.config.locked');
        await tx
          .delete(secrets)
          .where(
            and(
              eq(secrets.userId, ctx.userId),
              eq(secrets.kind, RR_SECRET_KIND),
              eq(secrets.label, RR_SECRET_LABEL),
              ne(secrets.id, id),
            ),
          )
          .run();
      }
      await writeUserSetting(tx, ctx, RR_URL_SETTING, baseUrl);
    },
    { scope: `user:${ctx.userId}` },
  );
}

/** Removes the key and origin; a store preference of reactive_resume falls back to google. */
export async function clearRrConfig(db: Db, ctx: UserCtx): Promise<void> {
  await withTransaction(db, async (tx) => await clearRrConfigIn(tx, ctx), {
    scope: `user:${ctx.userId}`,
  });
}

async function clearRrConfigIn(db: Exec, ctx: UserCtx): Promise<void> {
  await db
    .delete(secrets)
    .where(
      and(
        eq(secrets.userId, ctx.userId),
        eq(secrets.kind, RR_SECRET_KIND),
        eq(secrets.label, RR_SECRET_LABEL),
      ),
    )
    .run();
  await db
    .delete(settings)
    .where(
      and(
        eq(settings.key, userSettingKey(RR_URL_SETTING, ctx.userId)),
        eq(settings.userId, ctx.userId),
      ),
    )
    .run();
  if ((await readDocumentStorePref(db, ctx)) === 'reactive_resume') {
    await writeUserSetting(db, ctx, DOCUMENT_STORE_SETTING, 'google');
  }
}

export async function readDocumentStorePref(db: Exec, ctx: UserCtx): Promise<DocumentStorePref> {
  return await readUserSetting(
    db,
    ctx,
    DOCUMENT_STORE_SETTING,
    z.enum(DOCUMENT_STORE_PREFS),
    'google',
  );
}
