// DocumentStore.exportFile (https://github.com/bgoleno/opportun/issues/125, part of #115 and
// #79): a resume store exports the resume as a PDF, or says plainly that it cannot. The Google
// store exports through Drive files.export and never modifies the document; the local-file and
// Reactive Resume stores answer `export_unsupported` (owner decision 2: those stay manual) and
// never hand back text in place of a PDF. Drive failures come back classified, so the later
// snapshot job can retry the transient ones and give up on the rest. No live Google call: the
// Drive API is the fake in fakeGoogle.ts.
import type { OAuth2Client } from 'google-auth-library';
import { describe, expect, it } from 'vitest';
import {
  DocumentExportError,
  MAX_EXPORT_BYTES,
  type DocumentStore,
} from '../src/adapters/documentStore';
import { createGoogleDocsStore } from '../src/adapters/googleDocs';
import { createLocalFileStore } from '../src/adapters/localFile';
import { createReactiveResumeStore } from '../src/adapters/reactiveResume';
import type { Db } from '../src/db/client';
import { HttpError } from '../src/lib/errors';
import type { GoogleApi, GoogleConn } from '../src/lib/google';
import type { Storage } from '../src/lib/storage';
import { fakeGoogle, type FakeGoogle } from './fakeGoogle';

const ctx = { userId: 'u1', isAdmin: false };
const DOC = 'ResumeDoc_000001_abcdef';
const TEXT = 'Jane Example\nSenior Software Engineer';
/** What a real export starts with: the PDF header. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]);

const conn = {
  getClient: async () => ({}) as OAuth2Client,
} as unknown as GoogleConn;

/** Every GoogleApi method the store calls, in order: proves which calls were made. */
function recording(api: GoogleApi): { api: GoogleApi; calls: string[] } {
  const calls: string[] = [];
  const proxied = new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { api: proxied, calls };
}

/** The Drive file for DOC: its name is the title the export is named after. */
const driveFile = (name: string) => ({ id: DOC, name, modifiedTime: '', parentId: null });

function googleStore(over: (fake: FakeGoogle) => void = () => {}) {
  const fake = fakeGoogle({ [DOC]: { title: 'Jane Example Resume', text: TEXT } });
  fake.drive.set(DOC, driveFile('Jane Example Resume'));
  fake.exportBytes.set(DOC, PDF);
  over(fake);
  const { api, calls } = recording(fake);
  const store = createGoogleDocsStore({} as Db, conn, api);
  return { fake, calls, store };
}

/** The error exportFile rejected with, so each case can assert its classification. */
async function failure(store: DocumentStore, ref = DOC): Promise<DocumentExportError> {
  const err = await store.exportFile(ctx, ref).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DocumentExportError);
  return err as DocumentExportError;
}

describe('Google Docs store: exportFile', () => {
  it('returns the PDF bytes Drive exports, asking for application/pdf', async () => {
    const { fake, store } = googleStore();

    const out = await store.exportFile(ctx, DOC);

    expect(out).toEqual({
      ok: true,
      bytes: PDF,
      mime: 'application/pdf',
      filename: 'Jane Example Resume.pdf',
    });
    expect(fake.exports).toEqual([{ fileId: DOC, mimeType: 'application/pdf' }]);
  });

  it('accepts a docs.google.com URL as the ref, like the other store calls', async () => {
    const { fake, store } = googleStore();
    const out = await store.exportFile(ctx, `https://docs.google.com/document/d/${DOC}/edit`);
    expect(out.ok).toBe(true);
    expect(fake.exports.map((e) => e.fileId)).toEqual([DOC]);
  });

  it('never modifies the document: only reads are made, and the text is unchanged', async () => {
    const { fake, calls, store } = googleStore();

    await store.exportFile(ctx, DOC);

    // files.get for the name (tl on #127: not a whole docs.get), files.export for the bytes.
    expect(calls).toEqual(['getFile', 'exportFile']);
    expect(fake.copies).toEqual([]);
    expect(fake.batchUpdates).toEqual([]);
    expect(fake.docs.get(DOC)).toEqual({ title: 'Jane Example Resume', text: TEXT });
  });

  it('makes the title safe as a filename', async () => {
    const { store } = googleStore((fake) => {
      fake.drive.set(DOC, driveFile(' ../Resume: Jane / v2\n\u0000 '));
    });
    const out = await store.exportFile(ctx, DOC);
    expect(out).toMatchObject({ ok: true, filename: '.._Resume_ Jane _ v2.pdf' });
  });

  it('names an untitled document "Resume.pdf"', async () => {
    const { store } = googleStore((fake) => {
      fake.drive.set(DOC, driveFile(''));
    });
    expect(await store.exportFile(ctx, DOC)).toMatchObject({ filename: 'Resume.pdf' });
  });

  it('refuses an export over the byte cap, permanently', async () => {
    const { store } = googleStore((fake) => {
      fake.exportBytes.set(DOC, Buffer.concat([PDF, Buffer.alloc(MAX_EXPORT_BYTES)]));
    });
    const err = await failure(store);
    expect(err).toMatchObject({ retryable: false, code: 'too_large' });
  });

  it('accepts an export of exactly the byte cap', async () => {
    const { store } = googleStore((fake) => {
      fake.exportBytes.set(DOC, Buffer.concat([PDF, Buffer.alloc(MAX_EXPORT_BYTES - PDF.length)]));
    });
    expect((await store.exportFile(ctx, DOC)).ok).toBe(true);
  });

  it('refuses bytes that are not a PDF, permanently, rather than pass them on', async () => {
    const { store } = googleStore((fake) => {
      fake.exportBytes.set(DOC, Buffer.from(TEXT));
    });
    const err = await failure(store);
    expect(err).toMatchObject({ retryable: false, code: 'not_pdf' });
  });
});

describe('Google Docs store: exportFile errors are classified', () => {
  /** A Google client error as gaxios shapes it: a status, and the API's own reason. */
  const googleError = (status: number | undefined, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`google ${status ?? 'network'}`), { status, ...extra });

  it.each([
    ['500', googleError(500), 'unavailable'],
    ['503', googleError(503), 'unavailable'],
    ['429', googleError(429), 'rate_limited'],
    [
      '403 rateLimitExceeded',
      googleError(403, { errors: [{ reason: 'rateLimitExceeded' }] }),
      'rate_limited',
    ],
    ['a timeout', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'unavailable'],
    [
      'a dropped connection',
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      'unavailable',
    ],
  ])('%s is transient: retryable', async (_name, thrown, code) => {
    const { store } = googleStore((fake) => {
      fake.exportFailure = thrown;
    });
    const err = await failure(store);
    expect(err).toMatchObject({ retryable: true, code });
  });

  it.each([
    ['404', googleError(404), 'not_found'],
    ['403', googleError(403), 'no_access'],
    ['401', googleError(401), 'reauth_required'],
    ['invalid_grant', new Error('invalid_grant'), 'reauth_required'],
    ['400', googleError(400), 'rejected'],
  ])('%s is permanent: not retryable', async (_name, thrown, code) => {
    const { store } = googleStore((fake) => {
      fake.exportFailure = thrown;
    });
    const err = await failure(store);
    expect(err).toMatchObject({ retryable: false, code });
  });

  it('a document the account cannot read at all is permanent (files.get 404)', async () => {
    const { store } = googleStore();
    const err = await failure(store, 'MissingDoc_00000001');
    expect(err).toMatchObject({ retryable: false, code: 'not_found' });
  });

  it('a client error with no status (gaxios-shaped: no answer came back) is transient', async () => {
    const { store } = googleStore((fake) => {
      fake.exportFailure = Object.assign(new Error('request aborted'), {
        name: 'GaxiosError',
        config: { url: 'https://www.googleapis.com/drive/v3/files/x/export' },
      });
    });
    const err = await failure(store);
    expect(err).toMatchObject({ retryable: true, code: 'unavailable' });
  });

  it('a bug of our own (a TypeError) is not retried', async () => {
    // tl on #127: the no-status fallback is for Google client errors only, so a programming
    // error is not retried as if Google were down.
    const { store } = googleStore((fake) => {
      fake.exportFailure = new TypeError('cannot read properties of undefined');
    });
    const err = await failure(store);
    expect(err).toMatchObject({ retryable: false, code: 'rejected' });
  });

  it('no Google connection is permanent, and makes no Drive call', async () => {
    const fake = fakeGoogle();
    const { api, calls } = recording(fake);
    const notConnected = {
      getClient: async () => {
        throw new HttpError(409, 'google_not_connected');
      },
    } as unknown as GoogleConn;
    const store = createGoogleDocsStore({} as Db, notConnected, api);
    const err = await failure(store);
    expect(err).toMatchObject({ retryable: false, code: 'no_access' });
    expect(calls).toEqual([]);
  });

  it('never carries the Google error itself, which can hold tokens', async () => {
    const { store } = googleStore((fake) => {
      fake.exportFailure = Object.assign(new Error('boom ya29.SECRET'), {
        status: 500,
        config: { headers: { Authorization: 'Bearer ya29.SECRET' } },
      });
    });
    const err = await failure(store);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('ya29.SECRET');
    expect(err.cause).toBeUndefined();
  });
});

describe('stores that cannot export: export_unsupported', () => {
  /** Any use of a dependency fails the test: these stores must not touch the network or disk. */
  const untouchable = <T extends object>(name: string): T =>
    new Proxy({} as T, {
      get(_t, prop) {
        throw new Error(`${name}.${String(prop)} was used`);
      },
    });

  it('a local file answers export_unsupported, and reads nothing', async () => {
    const store = createLocalFileStore({
      db: untouchable<Db>('db'),
      storage: untouchable<Storage>('storage'),
    });
    expect(await store.exportFile(ctx, 'att_1')).toStrictEqual({
      ok: false,
      reason: 'export_unsupported',
    });
  });

  it('Reactive Resume answers export_unsupported, and makes no network call', async () => {
    const fetched: string[] = [];
    const store = createReactiveResumeStore({
      fetch: (async (url: string) => {
        fetched.push(url);
        throw new Error('no network in this test');
      }) as never,
      config: async () => {
        throw new Error('config was read');
      },
    });
    expect(await store.exportFile(ctx, 'rr-resume-1')).toStrictEqual({
      ok: false,
      reason: 'export_unsupported',
    });
    expect(fetched).toEqual([]);
  });
});
