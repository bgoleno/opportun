// An in-memory stand-in for every Google call (GoogleApi). Tests never reach the network.
import type { docs_v1 } from '@googleapis/docs';
import type { Credentials } from 'google-auth-library';
import type { DriveSearchFile, GmailMessage, GoogleApi } from '../src/lib/google';
import type { TestClient } from './isolation';

export interface FakeDoc {
  title: string;
  text: string;
}

/** One Drive file the fake's searchDriveFiles/getFile can find (issue #136). */
export interface FakeDriveFile extends DriveSearchFile {
  /** True for a folder (so it can serve as a parentId target but never match the doc search). */
  isFolder?: boolean;
}

/** One message in the fake mailbox. */
export interface FakeMail {
  id: string;
  threadId?: string;
  from: string;
  to?: string[];
  subject: string;
  /** text/plain body; omit and set html for an HTML-only message. */
  text?: string;
  html?: string;
  /**
   * A text/plain body too large for Gmail to inline: the real shape is body.attachmentId with no
   * body.data, read back separately through gmailGetAttachment. Takes the text/plain slot in
   * place of `text` when set.
   */
  largeText?: string;
  sentAt: number;
  labelIds?: string[];
}

/** An in-memory Gmail: messages, a history log of additions, and a history id counter. */
export interface FakeGmail {
  messages: Map<string, FakeMail & { historyId: number }>;
  historyId: number;
  /** The synced mailbox's address, as users.getProfile reports it. */
  address: string | null;
  /** When set, history.list answers 404 (an expired startHistoryId). */
  historyExpired: boolean;
  /** The q of every messages.list call. */
  queries: string[];
  /** Every Gmail method called, in order (proves no write call exists). */
  calls: string[];
  /** Adds a message (and a history record). */
  add(mail: FakeMail): void;
}

export interface FakeGoogle extends GoogleApi {
  gmail: FakeGmail;
  docs: Map<string, FakeDoc>;
  /** The token response the next exchangeCode returns. */
  nextTokens: Credentials;
  email: string | undefined;
  exchanged: string[];
  revoked: string[];
  copies: { fileId: string; name: string; newId: string }[];
  batchUpdates: { documentId: string; requests: docs_v1.Schema$Request[] }[];
  /** Drive files searchDriveFiles/getFile answer from (issue #136); id -> file. */
  drive: Map<string, FakeDriveFile>;
  /** Every `q` searchDriveFiles was called with, in order. */
  driveQueries: string[];
}

class FakeHttpError extends Error {
  constructor(readonly status: number) {
    super(`fake google ${status}`);
  }
}

/** Builds a docs.get response: one paragraph per line, each ending with a newline. */
export function toDocument(id: string, doc: FakeDoc): docs_v1.Schema$Document {
  let index = 1;
  const lines = doc.text.split('\n');
  const content: docs_v1.Schema$StructuralElement[] = [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
  ];
  for (const line of lines) {
    const run = `${line}\n`;
    content.push({
      startIndex: index,
      endIndex: index + run.length,
      paragraph: {
        elements: [{ startIndex: index, endIndex: index + run.length, textRun: { content: run } }],
      },
    });
    index += run.length;
  }
  return { documentId: id, title: doc.title, body: { content } };
}

let counter = 0;

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

function toGmailMessage(m: FakeMail & { historyId: number }): GmailMessage {
  const headers = [
    { name: 'From', value: m.from },
    { name: 'To', value: (m.to ?? ['me@example.com']).join(', ') },
    { name: 'Subject', value: m.subject },
    { name: 'Date', value: new Date(m.sentAt).toUTCString() },
  ];
  const parts = [];
  if (m.html !== undefined) {
    parts.push({ mimeType: 'text/html', body: { data: b64url(m.html) } });
  }
  if (m.largeText !== undefined) {
    parts.push({
      mimeType: 'text/plain',
      body: { attachmentId: `${m.id}:large`, size: m.largeText.length },
    });
  } else if (m.text !== undefined) {
    parts.push({ mimeType: 'text/plain', body: { data: b64url(m.text) } });
  }
  const snippet = (m.text ?? m.largeText ?? m.html ?? '').replace(/<[^>]*>/g, '').slice(0, 100);
  return {
    id: m.id,
    threadId: m.threadId ?? m.id,
    labelIds: m.labelIds ?? ['INBOX'],
    snippet,
    historyId: String(m.historyId),
    internalDate: String(m.sentAt),
    payload: { mimeType: 'multipart/alternative', headers, parts },
  };
}

function newFakeGmail(): FakeGmail {
  const gmail: FakeGmail = {
    messages: new Map(),
    historyId: 1000,
    address: 'mailbox@gmail.test',
    historyExpired: false,
    queries: [],
    calls: [],
    add(mail) {
      gmail.historyId += 1;
      gmail.messages.set(mail.id, { ...mail, historyId: gmail.historyId });
    },
  };
  return gmail;
}

/** Page size of the fake's list calls (small, so pagination is exercised). */
export const FAKE_GMAIL_PAGE = 2;
/** Page size the fake's searchDriveFiles honors when the caller asks for more (#136). */
export const FAKE_DRIVE_PAGE = 2;

export function fakeGoogle(seed: Record<string, FakeDoc> = {}): FakeGoogle {
  const fake: FakeGoogle = {
    gmail: newFakeGmail(),
    docs: new Map(Object.entries(seed)),
    nextTokens: {
      access_token: 'ya29.FAKE-ACCESS-TOKEN-do-not-leak',
      refresh_token: '1//FAKE-REFRESH-TOKEN-do-not-leak',
      expiry_date: Date.now() + 3_600_000,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents',
      token_type: 'Bearer',
    },
    email: 'connected@example.com',
    exchanged: [],
    revoked: [],
    copies: [],
    batchUpdates: [],
    drive: new Map(),
    driveQueries: [],
    async exchangeCode(_client, code) {
      fake.exchanged.push(code);
      return { ...fake.nextTokens };
    },
    async revokeToken(_client, token) {
      fake.revoked.push(token);
    },
    async accountEmail() {
      return fake.email;
    },
    async getDocument(_client, documentId) {
      const doc = fake.docs.get(documentId);
      if (doc === undefined) throw new FakeHttpError(404);
      return toDocument(documentId, doc);
    },
    async batchUpdateDocument(_client, documentId, requests) {
      const doc = fake.docs.get(documentId);
      if (doc === undefined) throw new FakeHttpError(404);
      fake.batchUpdates.push({ documentId, requests });
      // Requests apply in array order against doc.text as it stands after the previous ones,
      // same as the real API, so a later request whose find text an earlier one already
      // consumed in full reports occurrencesChanged 0 here too (issue #146).
      const replies: docs_v1.Schema$Response[] = requests.map((r) => {
        const find = r.replaceAllText?.containsText?.text;
        if (typeof find !== 'string' || find === '') {
          return { replaceAllText: { occurrencesChanged: 0 } };
        }
        const occurrencesChanged = doc.text.split(find).length - 1;
        doc.text = doc.text.split(find).join(r.replaceAllText?.replaceText ?? '');
        return { replaceAllText: { occurrencesChanged } };
      });
      return { documentId, replies };
    },
    async copyFile(_client, fileId, name) {
      const doc = fake.docs.get(fileId);
      if (doc === undefined) throw new FakeHttpError(404);
      counter += 1;
      const newId = `CopyDoc_${String(counter).padStart(6, '0')}_abcdef`;
      fake.docs.set(newId, { title: name, text: doc.text });
      fake.copies.push({ fileId, name, newId });
      return { id: newId, name };
    },
    async getFile(_client, fileId) {
      const file = fake.drive.get(fileId);
      if (file === undefined) throw new FakeHttpError(404);
      return { id: file.id, name: file.name };
    },
    async searchDriveFiles(_client, { q, pageToken, pageSize }) {
      fake.driveQueries.push(q ?? '');
      const term = q?.trim().toLowerCase();
      const all = [...fake.drive.values()]
        .filter((f) => !f.isFolder)
        .filter((f) => term === undefined || term === '' || f.name.toLowerCase().includes(term))
        .sort((x, y) => y.modifiedTime.localeCompare(x.modifiedTime));
      const start = pageToken === undefined ? 0 : Number(pageToken);
      const size = Math.min(pageSize, FAKE_DRIVE_PAGE);
      const page = all.slice(start, start + size);
      const next = start + size;
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
      fake.gmail.calls.push('profile');
      return { historyId: String(fake.gmail.historyId), emailAddress: fake.gmail.address };
    },
    async gmailListMessages(_client, { q, pageToken }) {
      fake.gmail.calls.push('messages.list');
      fake.gmail.queries.push(q);
      // Newest first, like Gmail; spam and trash never match the default query.
      const all = [...fake.gmail.messages.values()]
        .filter((m) => !(m.labelIds ?? []).some((l) => l === 'SPAM' || l === 'TRASH'))
        .sort((x, y) => y.sentAt - x.sentAt);
      const start = pageToken === undefined ? 0 : Number(pageToken);
      const page = all.slice(start, start + FAKE_GMAIL_PAGE);
      const next = start + FAKE_GMAIL_PAGE;
      return {
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })),
        nextPageToken: next < all.length ? String(next) : undefined,
      };
    },
    async gmailGetMessage(_client, id) {
      fake.gmail.calls.push('messages.get');
      const m = fake.gmail.messages.get(id);
      if (m === undefined) throw new FakeHttpError(404);
      return toGmailMessage(m);
    },
    async gmailGetAttachment(_client, messageId, attachmentId) {
      fake.gmail.calls.push('messages.attachments.get');
      const m = fake.gmail.messages.get(messageId);
      if (m?.largeText === undefined || attachmentId !== `${messageId}:large`) {
        throw new FakeHttpError(404);
      }
      return { data: b64url(m.largeText) };
    },
    async gmailListLabels() {
      // The fake uses label names as their own ids, which is enough to exercise resolution.
      const names = new Set<string>();
      for (const m of fake.gmail.messages.values()) {
        for (const l of m.labelIds ?? []) names.add(l);
      }
      return [...names].map((n) => ({ id: n, name: n }));
    },
    async gmailListHistory(_client, { startHistoryId, pageToken }) {
      fake.gmail.calls.push('history.list');
      if (fake.gmail.historyExpired) throw new FakeHttpError(404);
      const since = Number(startHistoryId);
      const added = [...fake.gmail.messages.values()]
        .filter((m) => m.historyId > since)
        .sort((x, y) => x.historyId - y.historyId);
      const start = pageToken === undefined ? 0 : Number(pageToken);
      const page = added.slice(start, start + FAKE_GMAIL_PAGE);
      const next = start + FAKE_GMAIL_PAGE;
      return {
        added: page.map((m) => ({
          id: m.id,
          threadId: m.threadId ?? m.id,
          labelIds: m.labelIds ?? ['INBOX'],
        })),
        historyId: String(fake.gmail.historyId),
        nextPageToken: next < added.length ? String(next) : undefined,
      };
    },
  };
  return fake;
}

/** Saves client credentials and completes the consent flow for `c` (fake token exchange). */
export async function connectGoogle(
  c: TestClient,
  scopes: 'docs' | 'gmail' = 'docs',
  google?: FakeGoogle,
): Promise<void> {
  if (google !== undefined && scopes === 'gmail') {
    google.nextTokens = {
      ...google.nextTokens,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    };
  }
  const creds = await c.request({
    method: 'POST',
    url: '/api/v1/integrations/google/client',
    payload: {
      clientId: 'client-id.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-client-secret-value',
    },
  });
  if (creds.statusCode !== 200) throw new Error(`client creds: ${creds.statusCode} ${creds.body}`);
  const connect = await c.request({
    method: 'GET',
    url: `/api/v1/integrations/google/connect?scopes=${scopes}`,
  });
  if (connect.statusCode !== 200) throw new Error(`connect: ${connect.statusCode} ${connect.body}`);
  const state = new URL(connect.json().authUrl as string).searchParams.get('state') ?? '';
  const cb = await c.request({
    method: 'GET',
    url: `/api/v1/integrations/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
  });
  if (cb.statusCode !== 302) throw new Error(`callback: ${cb.statusCode} ${cb.body}`);
}
