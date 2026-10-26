// Google Docs document store. Reads go through docs.get (documents scope), copies through
// drive.files.copy (drive scope), and edits through a replaceAllText batchUpdate.
import type { docs_v1 } from '@googleapis/docs';
import type { Db } from '../db/client';
import { HttpError } from '../lib/errors';
import { DOCS_SCOPES, googleHttpError, type GoogleApi, type GoogleConn } from '../lib/google';
import type { UserCtx } from '../repos/base';
import type { DocumentStore, ResumeDocMeta, ResumeEdit, ResumeEditResult } from './documentStore';

/** One Google Doc found by the Drive search picker (issue #136). */
export interface DriveSearchHit {
  id: string;
  name: string;
  modifiedTime: string;
  /** The immediate parent folder's name, or null when it has none or could not be read. */
  folderName: string | null;
}

export interface DriveSearchResult {
  files: DriveSearchHit[];
  nextPageToken: string | undefined;
}

const DOC_ID = /^[A-Za-z0-9_-]{10,200}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- one optional group, no nested repetition
const DOC_URL = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,200})/;

/** A Google Doc id from an id or a docs.google.com URL; 400 for anything else. */
export function parseDocRef(ref: string): string {
  const trimmed = ref.trim();
  if (DOC_ID.test(trimmed)) return trimmed;
  const m = DOC_URL.exec(trimmed);
  if (m?.[1] !== undefined) return m[1];
  throw new HttpError(400, 'invalid_doc_ref');
}

export function docUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

export interface FlatParagraph {
  /** Position of the paragraph in reading order. */
  index: number;
  /** Document index where the paragraph starts (for later targeted edits). */
  startIndex: number;
  text: string;
}

function collect(
  elements: docs_v1.Schema$StructuralElement[] | undefined,
  out: FlatParagraph[],
): void {
  for (const el of elements ?? []) {
    if (el.paragraph !== undefined && el.paragraph !== null) {
      const text = (el.paragraph.elements ?? [])
        .map((pe) => pe.textRun?.content ?? '')
        .join('')
        .replace(/\n$/, '');
      out.push({ index: out.length, startIndex: el.startIndex ?? 0, text });
    } else if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells ?? []) collect(cell.content, out);
      }
    } else if (el.tableOfContents?.content) {
      collect(el.tableOfContents.content, out);
    }
  }
}

/** The document's paragraphs in reading order, tables included. */
export function flattenDocument(doc: docs_v1.Schema$Document): {
  text: string;
  paragraphs: FlatParagraph[];
} {
  const paragraphs: FlatParagraph[] = [];
  collect(doc.body?.content, paragraphs);
  return { text: paragraphs.map((p) => p.text).join('\n'), paragraphs };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw googleHttpError(err);
  }
}

/**
 * Searches the caller's own Drive for Google Docs by name (issue #136): read-only, scoped to
 * `mimeType = application/vnd.google-apps.document`, newest first, one page per call via
 * Drive's own opaque pageToken (files.list has no offset to page by). An empty/omitted query
 * returns the most recently modified documents, which is the common case for attaching a
 * resume someone was just editing.
 *
 * Each result's immediate parent folder name is resolved for display (one getFile lookup per
 * distinct folder across the page, not per file); a folder the account can no longer read
 * (removed, unshared) leaves that result's folderName null rather than failing the search.
 */
export async function searchDriveDocuments(
  db: Db,
  conn: GoogleConn,
  api: GoogleApi,
  ctx: UserCtx,
  opts: { q?: string; pageToken?: string; limit: number },
): Promise<DriveSearchResult> {
  const client = await conn.getClient(db, ctx, DOCS_SCOPES);
  const { files, nextPageToken } = await guarded(() =>
    api.searchDriveFiles(client, { q: opts.q, pageToken: opts.pageToken, pageSize: opts.limit }),
  );
  const parentIds = [...new Set(files.flatMap((f) => (f.parentId === null ? [] : [f.parentId])))];
  const folderNames = new Map<string, string>();
  await Promise.all(
    parentIds.map(async (id) => {
      try {
        const folder = await guarded(() => api.getFile(client, id));
        folderNames.set(id, folder.name);
      } catch {
        // Left unresolved: the result still shows, just without a folder name.
      }
    }),
  );
  return {
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      modifiedTime: f.modifiedTime,
      folderName: f.parentId === null ? null : (folderNames.get(f.parentId) ?? null),
    })),
    nextPageToken,
  };
}

export function createGoogleDocsStore(db: Db, conn: GoogleConn, api: GoogleApi): DocumentStore {
  const client = (ctx: UserCtx) => conn.getClient(db, ctx, DOCS_SCOPES);

  async function meta(ctx: UserCtx, id: string): Promise<ResumeDocMeta> {
    const c = await client(ctx);
    const doc = await guarded(() => api.getDocument(c, id));
    return { docRef: id, title: doc.title ?? 'Untitled', url: docUrl(id) };
  }

  return {
    registerExisting: (ctx, ref) => meta(ctx, parseDocRef(ref)),

    async copyFrom(ctx, baseRef, name) {
      const c = await client(ctx);
      const copy = await guarded(() => api.copyFile(c, parseDocRef(baseRef), name));
      return { docRef: copy.id, title: copy.name, url: docUrl(copy.id) };
    },

    async readText(ctx, ref) {
      const c = await client(ctx);
      const doc = await guarded(() => api.getDocument(c, parseDocRef(ref)));
      return flattenDocument(doc).text;
    },

    async applyEdits(ctx, ref, edits: ResumeEdit[]) {
      const id = parseDocRef(ref);
      if (edits.some((e) => e.find.includes('\n'))) {
        // replaceAllText matches within one paragraph only.
        throw new HttpError(422, 'edit_spans_paragraphs');
      }
      const c = await client(ctx);
      const { text } = flattenDocument(await guarded(() => api.getDocument(c, id)));
      const missing = edits.findIndex((e) => !text.includes(e.find));
      if (missing !== -1)
        throw new HttpError(409, 'edit_target_missing', undefined, { index: missing });
      const requests: docs_v1.Schema$Request[] = edits.map((e) => ({
        replaceAllText: { containsText: { text: e.find, matchCase: true }, replaceText: e.replace },
      }));
      const response = await guarded(() => api.batchUpdateDocument(c, id, requests));
      // requests apply sequentially against the evolving document (Google's own behavior, not
      // this adapter's), so an edit whose find text was already consumed by an earlier one in
      // this same batch reports occurrencesChanged 0 here -- Google's own count of what each
      // request changed, immune to the ordering problem a separate before/after text read
      // would have (issue #146).
      const results: ResumeEditResult[] = edits.map((_edit, index) => ({
        index,
        outcome:
          (response.replies?.[index]?.replaceAllText?.occurrencesChanged ?? 0) > 0
            ? ('applied' as const)
            : ('already_consumed' as const),
      }));
      // Mutated in place: the same Google Doc, same ref, as before.
      return { docRef: ref, results };
    },
  };
}
