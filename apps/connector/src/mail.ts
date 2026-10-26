// The Apple Mail bridge: an embedded JXA (JavaScript for Automation) script run through
// `osascript -l JavaScript`. It only reads (FR-M7): it never changes read status, flags,
// moves, deletes or sends, and the unit tests hold it to that. It prints one JSON object
// per message, oldest first, received after `since`, in pages of `limit`.
import type { RawMail } from './normalize';
import { ConnectorError, EXIT, type ConnectorIo } from './types';

export interface ListParams {
  /** "Inbox" (every account's inbox), a mailbox name, or "Account/Mailbox". */
  mailboxes: string[];
  /** Epoch ms; messages received strictly after it. */
  since: number;
  /** Page size. A page runs over it only to keep messages with the same date together. */
  limit: number;
  maxBodyChars?: number;
}

/**
 * Runs as `osascript -l JavaScript -e <script> <params JSON>`. Dates are filtered by Mail
 * itself (`whose`), ids and dates are fetched in bulk, and only the page's messages are read
 * in full. A message that cannot be read (Mail busy, a timeout) is reported as
 * `{"skipped": <received date>, "error": ...}` so the sync holds its cursor before it.
 */
export const JXA_SCRIPT = String.raw`function run(argv) {
  var p = JSON.parse(argv[0]);
  var Mail = Application('Mail');
  var since = new Date(p.since);
  var boxes = [];
  p.mailboxes.forEach(function (spec) {
    var slash = spec.indexOf('/');
    if (spec.toLowerCase() === 'inbox') {
      boxes.push(Mail.inbox);
    } else if (slash > 0) {
      var box = Mail.accounts.byName(spec.slice(0, slash)).mailboxes.byName(spec.slice(slash + 1));
      if (!box.exists()) throw new Error('No mailbox "' + spec + '" in Mail.');
      boxes.push(box);
    } else {
      var found = Mail.mailboxes.whose({ name: spec })();
      Mail.accounts().forEach(function (account) {
        found = found.concat(account.mailboxes.whose({ name: spec })());
      });
      if (found.length === 0) throw new Error('No mailbox named "' + spec + '" in Mail.');
      found.forEach(function (b) { boxes.push(b); });
    }
  });

  var cands = [];
  boxes.forEach(function (box) {
    var q = box.messages.whose({ dateReceived: { _greaterThan: since } });
    var ids = q.id();
    var dates = q.dateReceived();
    for (var i = 0; i < ids.length; i++) {
      cands.push({ box: box, id: ids[i], t: dates[i].getTime() });
    }
  });
  cands.sort(function (a, b) { return a.t - b.t; });
  var end = Math.min(cands.length, p.limit);
  while (end > 0 && end < cands.length && cands[end].t === cands[end - 1].t) end++;

  var lines = [];
  cands.slice(0, end).forEach(function (c) {
    try {
      var m = c.box.messages.byId(c.id);
      var recipients = [];
      m.toRecipients().concat(m.ccRecipients()).forEach(function (r) {
        recipients.push({ name: r.name() || '', address: r.address() || '' });
      });
      var sent = m.dateSent();
      lines.push(JSON.stringify({
        id: m.messageId() || 'mail-' + c.id,
        subject: m.subject() || '',
        sender: m.sender() || '',
        recipients: recipients,
        dateReceived: new Date(c.t).toISOString(),
        dateSent: sent ? sent.toISOString() : '',
        body: (m.content() || '').slice(0, p.maxBodyChars)
      }));
    } catch (e) {
      lines.push(JSON.stringify({ skipped: new Date(c.t).toISOString(), error: String(e) }));
    }
  });
  return lines.join('\n');
}
`;

export const DEFAULT_MAX_BODY_CHARS = 500_000;

export function osascriptArgs(params: ListParams): string[] {
  const full = { ...params, maxBodyChars: params.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS };
  return ['-l', 'JavaScript', '-e', JXA_SCRIPT, JSON.stringify(full)];
}

function mailFailure(stderr: string): ConnectorError {
  const detail = stderr.trim().slice(0, 2000);
  if (/-1743|not authori[sz]ed|not allowed/i.test(detail)) {
    return new ConnectorError(
      'macOS did not let the connector read Mail. Allow it in System Settings > ' +
        'Privacy & Security > Automation (the app running the connector, e.g. Terminal, ' +
        'needs "Mail"), then try again.',
      EXIT.MAIL,
    );
  }
  return new ConnectorError(
    `Reading Apple Mail failed: ${detail || 'osascript failed'}`,
    EXIT.MAIL,
  );
}

/** A message in the page that Mail failed to return, by its received date. */
export interface SkippedMail {
  date: number;
  error: string;
}

export interface MailPage {
  messages: RawMail[];
  skipped: SkippedMail[];
}

/** One page of messages from Mail. */
export async function listMail(io: ConnectorIo, params: ListParams): Promise<MailPage> {
  let res;
  try {
    res = await io.osascript(osascriptArgs(params));
  } catch (err) {
    throw new ConnectorError(
      `Could not run osascript (the connector needs macOS): ${(err as Error).message}`,
      EXIT.MAIL,
    );
  }
  if (res.code !== 0) throw mailFailure(res.stderr);
  // Anything the script logged is passed on.
  for (const line of res.stderr.split('\n')) if (line.trim() !== '') io.stderr(line.trim());

  const out: MailPage = { messages: [], skipped: [] };
  for (const line of res.stdout.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConnectorError(
        'Reading Apple Mail failed: unexpected output from osascript.',
        EXIT.MAIL,
      );
    }
    const skipped = (parsed as { skipped?: unknown }).skipped;
    if (typeof skipped === 'string') {
      const error = (parsed as { error?: unknown }).error;
      const date = Date.parse(skipped);
      if (Number.isFinite(date)) {
        out.skipped.push({ date, error: typeof error === 'string' ? error.slice(0, 500) : '' });
      }
      continue;
    }
    out.messages.push(parsed as RawMail);
  }
  return out;
}
