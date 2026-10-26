// Drive search for the "attach a resume by searching, not pasting" picker (issue #136).
import type { OAuth2Client } from 'google-auth-library';
import { describe, expect, it } from 'vitest';
import { searchDriveDocuments } from '../src/adapters/googleDocs';
import type { Db } from '../src/db/client';
import { HttpError } from '../src/lib/errors';
import { escapeDriveQueryLiteral, type GoogleConn } from '../src/lib/google';
import type { UserCtx } from '../src/repos/base';
import { fakeGoogle } from './fakeGoogle';

const ctx: UserCtx = { userId: 'u1', isAdmin: false };

/** A GoogleConn that always hands back the same stand-in client (fakeGoogle ignores it). */
function stubConn(opts: { throws?: HttpError } = {}): GoogleConn {
  return {
    async getClient() {
      if (opts.throws !== undefined) throw opts.throws;
      return {} as OAuth2Client;
    },
  };
}

const FOLDER = 'folder-1';
const DOC_1 = {
  id: 'doc-1',
  name: 'Platform Engineer Resume',
  modifiedTime: '2026-10-18T00:00:00.000Z',
  parentId: FOLDER,
};
const DOC_2 = {
  id: 'doc-2',
  name: 'Cover Letter',
  modifiedTime: '2026-09-01T00:00:00.000Z',
  parentId: null,
};

describe('searchDriveDocuments', () => {
  it('returns each match with its immediate parent folder name resolved', async () => {
    const google = fakeGoogle();
    google.drive.set(FOLDER, {
      id: FOLDER,
      name: 'Resumes',
      modifiedTime: '',
      parentId: null,
      isFolder: true,
    });
    google.drive.set(DOC_1.id, DOC_1);
    google.drive.set(DOC_2.id, DOC_2);

    const result = await searchDriveDocuments(undefined as unknown as Db, stubConn(), google, ctx, {
      q: undefined,
      pageToken: undefined,
      limit: 20,
    });

    expect(result.files).toEqual([
      { id: DOC_1.id, name: DOC_1.name, modifiedTime: DOC_1.modifiedTime, folderName: 'Resumes' },
      { id: DOC_2.id, name: DOC_2.name, modifiedTime: DOC_2.modifiedTime, folderName: null },
    ]);
    expect(result.nextPageToken).toBeUndefined();
  });

  it('passes the trimmed query and the page token through to the Drive call unchanged', async () => {
    const google = fakeGoogle();
    await searchDriveDocuments(undefined as unknown as Db, stubConn(), google, ctx, {
      q: '  platform  ',
      pageToken: '2',
      limit: 5,
    });
    expect(google.driveQueries).toEqual(['  platform  ']);
  });

  it('looks up each distinct parent folder once, not once per file in it', async () => {
    const google = fakeGoogle();
    google.drive.set(FOLDER, {
      id: FOLDER,
      name: 'Resumes',
      modifiedTime: '',
      parentId: null,
      isFolder: true,
    });
    google.drive.set(DOC_1.id, DOC_1);
    google.drive.set('doc-1b', { ...DOC_1, id: 'doc-1b', name: 'Another Resume' });
    let getFileCalls = 0;
    const realGetFile = google.getFile.bind(google);
    google.getFile = async (...args) => {
      getFileCalls += 1;
      return realGetFile(...args);
    };

    await searchDriveDocuments(undefined as unknown as Db, stubConn(), google, ctx, {
      q: undefined,
      pageToken: undefined,
      limit: 20,
    });

    expect(getFileCalls).toBe(1);
  });

  it('leaves a file unnamed rather than fail the whole search when its folder cannot be read', async () => {
    const google = fakeGoogle();
    // DOC_1's parent (FOLDER) is never added to google.drive, so getFile 404s for it.
    google.drive.set(DOC_1.id, DOC_1);

    const result = await searchDriveDocuments(undefined as unknown as Db, stubConn(), google, ctx, {
      q: undefined,
      pageToken: undefined,
      limit: 20,
    });

    expect(result.files).toEqual([
      { id: DOC_1.id, name: DOC_1.name, modifiedTime: DOC_1.modifiedTime, folderName: null },
    ]);
  });

  it('propagates a not-connected GoogleConn error as-is, distinct from any Drive API error', async () => {
    const notConnected = new HttpError(409, 'google_not_connected');
    await expect(
      searchDriveDocuments(
        undefined as unknown as Db,
        stubConn({ throws: notConnected }),
        fakeGoogle(),
        ctx,
        {
          q: undefined,
          pageToken: undefined,
          limit: 20,
        },
      ),
    ).rejects.toBe(notConnected);
  });

  it('maps a revoked or expired token Drive API error to google_reauth_required, distinct from not-connected', async () => {
    const google = fakeGoogle();
    google.searchDriveFiles = async () => {
      const err = new Error('invalid_grant') as Error & { response: { status: number } };
      err.response = { status: 401 };
      throw err;
    };
    await expect(
      searchDriveDocuments(undefined as unknown as Db, stubConn(), google, ctx, {
        q: undefined,
        pageToken: undefined,
        limit: 20,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'google_reauth_required' });
  });
});

describe('escapeDriveQueryLiteral', () => {
  it('leaves an ordinary search term unchanged', () => {
    expect(escapeDriveQueryLiteral('Platform Engineer Resume')).toBe('Platform Engineer Resume');
  });

  it('escapes a single quote, so it cannot close the query literal early', () => {
    expect(escapeDriveQueryLiteral("Jane's Resume")).toBe("Jane\\'s Resume");
  });

  it('escapes a backslash first, so an escaped quote cannot be forged from it', () => {
    // A naive quote-only escaper turns `\'` (backslash, quote) into `\\'`, which Drive reads as
    // an escaped backslash followed by an unescaped quote: the literal closes anyway. Escaping
    // backslashes first defeats that.
    expect(escapeDriveQueryLiteral("\\' or trashed = false or name contains '")).toBe(
      "\\\\\\' or trashed = false or name contains \\'",
    );
  });
});
