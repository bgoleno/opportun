// Greenhouse jobs embedded on a company's own careers page (https://github.com/bgoleno/opportun/issues/398).
// Such a page links its jobs as `<any host>/<path>?gh_jid=<id>`: the id is Greenhouse's job id,
// but the host is the company's, and nothing about the link says which Greenhouse board holds
// the job. The server proves that with Greenhouse's own API before the link gives an opportunity
// a Greenhouse identity, and the handoff then goes to the board's page, never to the link. The
// web app reads the same id to say what it is looking at. Both use this one rule.

// core compiles without DOM or node types; WHATWG URL is a global in every runtime it serves
// (as in mailText.ts). Only what this file reads is declared.
interface ParsedUrl {
  readonly protocol: string;
  readonly searchParams: { getAll(name: string): string[] };
}
declare const URL: new (input: string) => ParsedUrl;

/** Greenhouse job ids are numbers; anything longer than this is not one. */
const JID = /^[0-9]{1,20}$/;
/** A Greenhouse board token (the board's slug). */
const TOKEN = /^[a-z0-9-]{1,100}$/;

/**
 * The numeric `gh_jid` a link carries: digits only, at most 20. Null when the link is not an
 * http(s) URL, carries no `gh_jid`, carries one that is not a number, or carries two that differ.
 */
export function greenhouseJidOf(link: string | null | undefined): string | null {
  if (link == null) return null;
  let url: ParsedUrl;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const values = new Set(url.searchParams.getAll('gh_jid'));
  if (values.size !== 1) return null;
  const [jid] = [...values];
  return typeof jid === 'string' && JID.test(jid) ? jid : null;
}

/**
 * The job's page on Greenhouse's own board host, built from the board token and the job id: the
 * only destination an embedded job is handed off to. Throws on a token or id of the wrong shape,
 * so a value from anywhere else can never become part of the address.
 */
export function greenhouseBoardJobUrl(token: string, id: string): string {
  if (!TOKEN.test(token)) throw new Error('not a Greenhouse board token');
  if (!JID.test(id)) throw new Error('not a Greenhouse job id');
  return `https://job-boards.greenhouse.io/${token}/jobs/${id}`;
}
