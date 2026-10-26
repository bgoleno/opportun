// End-to-end Google mock (OPPORTUN_GMAIL_MOCK=1, also used with OPPORTUN_DOCS_MOCK=1): a
// GoogleApi with no network. The OAuth code exchange grants every scope the app asks for, and
// Gmail is a read-only fixture mailbox. The browser half of the consent flow (the redirect to
// accounts.google.com) is answered by the e2e test itself, which sends it straight back to
// the callback.
import type { Credentials } from 'google-auth-library';
import {
  GMAIL_SCOPES,
  DOCS_SCOPES,
  type DriveSearchFile,
  type GmailMessage,
  type GoogleApi,
} from '../lib/google';
import type { safeFetch } from '../lib/safeFetch';

/** One message in the fixture mailbox. */
export interface MockMail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  /** Hours before the server started. */
  hoursAgo: number;
}

/**
 * The fixture mailbox. Classification answers for these subjects live in mockAi.ts: a targeted
 * solicitation (creates an opportunity), broadcast spam (Spam tab), an interview request about
 * a Contoso role the test tracks (proposes a stage move), and a personal note (other).
 */
export const MOCK_MAILBOX: readonly MockMail[] = [
  {
    id: 'mock-msg-1',
    threadId: 'mock-thread-1',
    from: 'Priya Shah <priya@northwind.example>',
    subject: 'Staff Platform Engineer at Northwind Labs',
    text: 'Hi Jane, I lead platform hiring at Northwind Labs. Your Go and Kubernetes work stood out. Would you be open to a call about our Staff Platform Engineer role?',
    hoursAgo: 30,
  },
  {
    id: 'mock-msg-2',
    threadId: 'mock-thread-2',
    from: 'Jobs Digest <digest@jobblast.example>',
    subject: '50 hot remote jobs this week',
    text: 'Dear candidate, thousands of companies are hiring now. Click to apply to all of them. Unsubscribe any time.',
    hoursAgo: 20,
  },
  {
    id: 'mock-msg-3',
    threadId: 'mock-thread-3',
    from: 'Sam Lee <sam@contoso.example>',
    subject: 'Interview availability for Senior Product Manager',
    text: 'Thanks for applying to Contoso. The team would like to schedule interviews next week. Please share a few times that work for you.',
    hoursAgo: 10,
  },
  {
    id: 'mock-msg-4',
    threadId: 'mock-thread-4',
    from: 'Alex Friend <alex@example.com>',
    subject: 'Coffee next week?',
    text: 'Want to grab coffee next Tuesday?',
    hoursAgo: 5,
  },
];

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

/** Fixture Drive contents for the search modal (#136): one folder, two docs inside it, one at
 *  the root, newest first so an empty query's "recently modified" default has something to show. */
const MOCK_DRIVE_FOLDER_ID = 'mock-folder-resumes';
const MOCK_DRIVE_FILES: readonly (DriveSearchFile & { isFolder?: boolean })[] = [
  { id: MOCK_DRIVE_FOLDER_ID, name: 'Resumes', modifiedTime: '', parentId: null, isFolder: true },
  {
    id: 'mock-drive-1',
    name: 'Jane Example - Platform Engineer Resume',
    modifiedTime: '2026-10-18T12:00:00.000Z',
    parentId: MOCK_DRIVE_FOLDER_ID,
  },
  {
    id: 'mock-drive-2',
    name: 'Jane Example - Resume (2025)',
    modifiedTime: '2025-01-05T09:00:00.000Z',
    parentId: MOCK_DRIVE_FOLDER_ID,
  },
  {
    id: 'mock-drive-3',
    name: 'Cover Letter Draft',
    modifiedTime: '2026-09-01T08:00:00.000Z',
    parentId: null,
  },
];

export function createMockGoogleApi(now: number = Date.now()): GoogleApi {
  const history = 2000;
  const messages = MOCK_MAILBOX.map((m, i) => ({
    ...m,
    sentAt: now - m.hoursAgo * 3_600_000,
    historyId: history - MOCK_MAILBOX.length + i + 1,
  }));
  const toMessage = (m: (typeof messages)[number]): GmailMessage => ({
    id: m.id,
    threadId: m.threadId,
    labelIds: ['INBOX'],
    snippet: m.text.slice(0, 100),
    historyId: String(m.historyId),
    internalDate: String(m.sentAt),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: m.from },
        { name: 'To', value: 'jane@example.com' },
        { name: 'Subject', value: m.subject },
        { name: 'Date', value: new Date(m.sentAt).toUTCString() },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64url(m.text) } }],
    },
  });
  const notFound = (): Error => Object.assign(new Error('mock google 404'), { status: 404 });

  return {
    async gmailListLabels(): Promise<{ id: string; name: string }[]> {
      return [];
    },
    async exchangeCode(): Promise<Credentials> {
      return {
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expiry_date: Date.now() + 7 * 24 * 3_600_000,
        scope: [...DOCS_SCOPES, ...GMAIL_SCOPES].join(' '),
        token_type: 'Bearer',
      };
    },
    async revokeToken() {},
    async accountEmail() {
      return 'jane@example.com';
    },
    // Resume documents come from the Docs mock (mockDocs.ts), not from here.
    async getDocument() {
      throw notFound();
    },
    async batchUpdateDocument() {
      throw notFound();
    },
    async copyFile() {
      throw notFound();
    },
    async getFile(_client, fileId) {
      const file = MOCK_DRIVE_FILES.find((f) => f.id === fileId);
      if (file === undefined) throw notFound();
      return { id: file.id, name: file.name };
    },
    async searchDriveFiles(_client, { q, pageToken, pageSize }) {
      const term = q?.trim().toLowerCase();
      const all = MOCK_DRIVE_FILES.filter((f) => !f.isFolder)
        .filter((f) => term === undefined || term === '' || f.name.toLowerCase().includes(term))
        .sort((x, y) => y.modifiedTime.localeCompare(x.modifiedTime));
      const start = pageToken === undefined ? 0 : Number(pageToken);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        files: page.map((f) => ({
          id: f.id,
          name: f.name,
          modifiedTime: f.modifiedTime,
          parentId: f.parentId,
        })),
        nextPageToken: next < all.length ? String(next) : undefined,
      };
    },
    async gmailProfile() {
      return { historyId: String(history), emailAddress: 'mailbox@gmail.test' };
    },
    async gmailListMessages() {
      const newestFirst = [...messages].sort((x, y) => y.sentAt - x.sentAt);
      return { messages: newestFirst.map((m) => ({ id: m.id, threadId: m.threadId })) };
    },
    async gmailGetMessage(_client, id) {
      const m = messages.find((x) => x.id === id);
      if (m === undefined) throw notFound();
      return toMessage(m);
    },
    // The fixture mailbox never has a part too large to inline.
    async gmailGetAttachment() {
      throw notFound();
    },
    async gmailListHistory() {
      // The fixture mailbox never changes after the initial sync.
      return { added: [], historyId: String(history) };
    },
  };
}

/**
 * The Google OAuth client probe with no network: the token endpoint refuses the probe code
 * with invalid_grant, which is how Google answers a live client (so the client is "valid").
 */
export const mockGoogleTokenFetch: typeof safeFetch = async (url) => ({
  status: 400,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: Buffer.from(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' })),
  url,
});
