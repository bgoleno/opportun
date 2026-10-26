// A recorded fake of the Reactive Resume REST API (FR-R7). It plugs in BELOW safeFetch (as
// its DNS + transport), so every call the adapter makes still goes through the real
// allowlist, redirect and pinning rules.
//
// This file IS the contract Opportun codes against. Every assumption about Reactive Resume
// lives here, checked against the v6.0.3 OpenAPI document (https://docs.rxresu.me/spec.json,
// read 2026-10-17); a live instance was not available to verify against:
//   A1. The REST API is served under `<origin>/api/openapi`; health is `GET <origin>/api/health`
//       and answers `{ service: 'reactive-resume', version, status }` without a credential.
//   A2. An API key authenticates with the `x-api-key` header (no Bearer prefix). A missing,
//       revoked or expired key answers 401 with `{ code: 'UNAUTHORIZED', status: 401 }`.
//   A3. Errors are JSON `{ defined, code, status, message }`; we branch on status and code only.
//   A4. `GET /resumes?limit=1` lists summaries (a JSON array) and needs the key: the
//       validate probe. There is no "who am I" endpoint for API keys in v6.
//   A5. `GET /resumes/{id}` answers the resume with `name`, `isLocked`, `updatedAt` (ISO) and
//       `data` (the resume JSON: basics, summary, sections.<key>.items[], customSections[]).
//       Another account's resume, or an unknown id, answers 404 NOT_FOUND.
//   A6. `POST /resumes/{id}/copies` with `{ name }` duplicates a resume and answers the new id
//       as a bare JSON string.
//   A7. `PATCH /resumes/{id}` takes `{ operations: JSON Patch[], expectedUpdatedAt }` with
//       pointers into `data`; 409 RESUME_VERSION_CONFLICT when updatedAt moved, 403
//       RESUME_LOCKED for a locked resume, 400 INVALID_PATCH_OPERATIONS for a bad path.
//   A8. Rich-text fields (summary.content, item description, cover-letter content) are HTML
//       strings; text nodes escape &, < and >.
//   A9. The builder opens a resume at `<origin>/builder/{id}` (not in the spec; from the UI).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createSafeFetch,
  type FetchTarget,
  type RawResponse,
  type SafeFetchDeps,
} from '../src/lib/safeFetch';

export const RR_HOST = 'rr.example.com';
export const RR_ORIGIN = `https://${RR_HOST}`;
export const RR_VERSION = '6.0.3';
const PUBLIC_IP = '93.184.216.34';

/** The fixture resume (a GET /resumes/{id} body). */
export const RR_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/reactiveResume/resume.json', import.meta.url), 'utf8'),
) as RrResume;
export const RR_BASE_ID = RR_FIXTURE.id;

export interface RrResume {
  id: string;
  name: string;
  isLocked: boolean;
  updatedAt: string;
  data: Record<string, unknown>;
  [k: string]: unknown;
}

export interface RecordedCall {
  method: string;
  host: string;
  path: string;
  apiKey: string | undefined;
  body: unknown;
}

export interface FakeRr {
  /** api key -> the account it belongs to. */
  keys: Map<string, string>;
  /** resume id -> { owner account, resume }. */
  resumes: Map<string, { owner: string; resume: RrResume }>;
  calls: RecordedCall[];
  /** path (no query) -> Location: answer a 302 there instead. */
  redirects: Map<string, string>;
  /** When true, /api/health answers 503. */
  unhealthy: boolean;
  deps: SafeFetchDeps;
  fetch: ReturnType<typeof createSafeFetch>;
  /** Seeds a copy of the fixture (or `resume`) for `owner`; returns its id. */
  seed(owner: string, resume?: Partial<RrResume>): string;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RawResponse {
  const text = JSON.stringify(value);
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: (async function* () {
      yield Buffer.from(text);
    })(),
  };
}

const err = (status: number, code: string): RawResponse =>
  json(status, { defined: true, code, status, message: code.toLowerCase() });

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function unescapePointer(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Applies a `replace` to an existing location; false when the path does not exist. */
function replaceAt(root: Record<string, unknown>, pointer: string, value: unknown): boolean {
  if (!pointer.startsWith('/')) return false;
  const parts = pointer.slice(1).split('/').map(unescapePointer);
  let node: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return false;
    // eslint-disable-next-line security/detect-object-injection -- test fake walking a pointer
    node = (node as Record<string, unknown>)[part];
  }
  const last = parts[parts.length - 1] as string;
  if (node === null || typeof node !== 'object' || !(last in (node as object))) return false;
  // eslint-disable-next-line security/detect-object-injection -- test fake walking a pointer
  (node as Record<string, unknown>)[last] = value;
  return true;
}

export function fakeReactiveResume(opts: { host?: string } = {}): FakeRr {
  const host = opts.host ?? RR_HOST;
  let tick = Date.parse('2026-10-01T12:00:00.000Z');

  const rr: FakeRr = {
    keys: new Map(),
    resumes: new Map(),
    calls: [],
    redirects: new Map(),
    unhealthy: false,
    deps: undefined as unknown as SafeFetchDeps,
    fetch: undefined as unknown as ReturnType<typeof createSafeFetch>,
    seed(owner, resume = {}) {
      const id = resume.id ?? randomUUID();
      rr.resumes.set(id, { owner, resume: { ...clone(RR_FIXTURE), ...clone(resume), id } });
      return id;
    },
  };

  function handle(target: FetchTarget): RawResponse {
    const url = target.url;
    const method = target.post === undefined ? 'GET' : (target.post.method ?? 'POST');
    const apiKey = target.headers?.['x-api-key'];
    const body = target.post === undefined ? undefined : (JSON.parse(target.post.body) as unknown);
    rr.calls.push({ method, host: url.hostname, path: url.pathname, apiKey, body });

    if (url.hostname !== host) return json(200, { stolen: true });
    const location = rr.redirects.get(url.pathname);
    if (location !== undefined) return { ...json(302, {}), headers: { location } };

    if (method === 'GET' && url.pathname === '/api/health') {
      return json(rr.unhealthy ? 503 : 200, {
        service: 'reactive-resume',
        version: RR_VERSION,
        status: rr.unhealthy ? 'unhealthy' : 'healthy',
        timestamp: new Date(tick).toISOString(),
        uptime: '1h',
        database: { status: 'healthy', latencyMs: 1 },
        storage: { status: 'healthy', latencyMs: 1 },
      });
    }
    if (!url.pathname.startsWith('/api/openapi/')) return err(404, 'NOT_FOUND');
    const account = apiKey === undefined ? undefined : rr.keys.get(apiKey);
    if (account === undefined) return err(401, 'UNAUTHORIZED');

    const path = url.pathname.slice('/api/openapi'.length);
    const owned = (id: string) => {
      const hit = rr.resumes.get(id);
      return hit !== undefined && hit.owner === account ? hit.resume : undefined;
    };

    if (method === 'GET' && path === '/resumes') {
      return json(
        200,
        [...rr.resumes.values()]
          .filter((r) => r.owner === account)
          .map(({ resume }) => ({ id: resume.id, name: resume.name, updatedAt: resume.updatedAt })),
      );
    }
    const one = /^\/resumes\/([^/]+)$/.exec(path);
    const copies = /^\/resumes\/([^/]+)\/copies$/.exec(path);
    if (one !== null && method === 'GET') {
      const resume = owned(one[1] as string);
      return resume === undefined ? err(404, 'NOT_FOUND') : json(200, resume);
    }
    if (copies !== null && method === 'POST') {
      const source = owned(copies[1] as string);
      if (source === undefined) return err(404, 'NOT_FOUND');
      const name = (body as { name?: string } | undefined)?.name ?? `${source.name} (copy)`;
      tick += 1000;
      const id = rr.seed(account, {
        ...clone(source),
        id: randomUUID(),
        name,
        isLocked: false,
        updatedAt: new Date(tick).toISOString(),
      });
      return json(200, id);
    }
    if (one !== null && method === 'PATCH') {
      const resume = owned(one[1] as string);
      if (resume === undefined) return err(404, 'NOT_FOUND');
      if (resume.isLocked) return err(403, 'RESUME_LOCKED');
      const req = body as {
        operations?: { op: string; path: string; value?: unknown }[];
        expectedUpdatedAt?: string;
      };
      if (!Array.isArray(req.operations) || req.operations.length === 0) {
        return err(400, 'BAD_REQUEST');
      }
      if (req.expectedUpdatedAt !== undefined && req.expectedUpdatedAt !== resume.updatedAt) {
        return err(409, 'RESUME_VERSION_CONFLICT');
      }
      const data = clone(resume.data);
      for (const op of req.operations) {
        if (op.op !== 'replace' || !replaceAt(data, op.path, op.value)) {
          return err(400, 'INVALID_PATCH_OPERATIONS');
        }
      }
      tick += 1000;
      resume.data = data;
      resume.updatedAt = new Date(tick).toISOString();
      return json(200, resume);
    }
    return err(404, 'NOT_FOUND');
  }

  rr.deps = {
    now: () => 0,
    sleep: async () => undefined,
    // Every name resolves publicly, so a blocked hop is the allowlist's doing, not DNS.
    resolve: async () => [PUBLIC_IP],
    request: async (target) => handle(target),
  };
  rr.fetch = createSafeFetch(rr.deps);
  return rr;
}
