// End-to-end Docs mock (OPPORTUN_DOCS_MOCK=1): an in-memory DocumentStore. Registering any
// reference yields the fixture resume; copies and accepted edits behave like Google Docs
// (find/replace of every occurrence). Per user, process lifetime only.
import type {
  DocumentStore,
  ResumeDocMeta,
  ResumeEdit,
  ResumeEditResult,
} from '../adapters/documentStore';
import type { UserCtx } from '../repos/base';

export const MOCK_RESUME_TITLE = 'Jane Example Base Resume';
export const MOCK_RESUME_TEXT = [
  'Jane Example',
  'Senior Software Engineer',
  'Built the billing platform in Go',
  'Led a team of five engineers through two product launches',
  'Cut p99 checkout latency by 40 percent',
].join('\n');

interface MockDoc {
  title: string;
  text: string;
}

const DOC_URL = /\/document\/d\/([A-Za-z0-9_-]+)/;

function docId(ref: string): string {
  const fromUrl = DOC_URL.exec(ref)?.[1];
  const id = (fromUrl ?? ref).trim().replace(/[^A-Za-z0-9_-]/g, '');
  return id.length > 0 ? id.slice(0, 100) : 'mock-doc';
}

const meta = (id: string, title: string): ResumeDocMeta => ({
  docRef: id,
  title,
  url: `https://docs.google.com/document/d/${id}/edit`,
});

export function createMockDocumentStore(): DocumentStore {
  const docs = new Map<string, MockDoc>();
  let copies = 0;
  const key = (ctx: UserCtx, id: string) => `${ctx.userId}:${id}`;
  const get = (ctx: UserCtx, id: string): MockDoc => {
    const doc = docs.get(key(ctx, id));
    if (doc === undefined) throw new Error(`mock document not found: ${id}`);
    return doc;
  };

  return {
    async registerExisting(ctx, ref) {
      const id = docId(ref);
      if (!docs.has(key(ctx, id))) {
        docs.set(key(ctx, id), { title: MOCK_RESUME_TITLE, text: MOCK_RESUME_TEXT });
      }
      return meta(id, get(ctx, id).title);
    },
    async copyFrom(ctx, baseRef, name) {
      const base = get(ctx, docId(baseRef));
      copies += 1;
      const id = `mock-copy-${copies}`;
      docs.set(key(ctx, id), { title: name, text: base.text });
      return meta(id, name);
    },
    async readText(ctx, ref) {
      return get(ctx, docId(ref)).text;
    },
    async applyEdits(ctx, ref, edits: ResumeEdit[]) {
      const doc = get(ctx, docId(ref));
      // Same ordering as the real stores: applied in sequence, so an edit whose find text an
      // earlier one in this batch already consumed reports that, not a silent success
      // (issue #146).
      const results: ResumeEditResult[] = edits.map((e, index) => {
        if (!doc.text.includes(e.find)) return { index, outcome: 'already_consumed' };
        doc.text = doc.text.split(e.find).join(e.replace);
        return { index, outcome: 'applied' };
      });
      // Mutated in place: the same mock doc id, same ref, as before.
      return { docRef: ref, results };
    },
  };
}
