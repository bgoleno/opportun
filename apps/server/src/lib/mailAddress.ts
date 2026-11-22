// The sender's address of a From header (https://github.com/bgoleno/opportun/issues/763). Pure, so
// the reject and confirmation repos read it without importing the alert-mail adapter, which
// imports the communications repo, which imports the reject repo back.

/** The longest From header considered; a header holding one mailbox is far shorter. */
export const MAX_FROM_HEADER_CHARS = 2000;

/**
 * True when the header can hold one mailbox only: no comma outside a quoted display name
 * (`attacker@evil.example, <alerts@board.example>` lists two), and no unterminated quoted
 * string, where whether a comma separates mailboxes cannot be told.
 */
function singleMailbox(header: string): boolean {
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header.charAt(i);
    if (!quoted) {
      if (ch === ',') return false;
      if (ch === '"') quoted = true;
    } else if (ch === '\\') i += 1;
    else if (ch === '"') quoted = false;
  }
  return !quoted;
}

/**
 * The mailbox address of a From header, lowercased, or '' when there is none. The address is
 * the angle-addr that ENDS the header (`Name <addr>`); anything before it is display name, which
 * the sender controls freely (`"<alerts@board.example>" <attacker@evil.example>` is the
 * attacker's address). Without an angle-addr the header must be a bare addr-spec.
 *
 * A header listing several mailboxes has no single sender, so it never yields an address: the
 * trusted mailbox could sit last behind an attacker's own. For the same reason an over-long
 * header is refused rather than cut to the cap, which would make its last mailbox the ending
 * angle-addr.
 */
export function senderAddress(from: string): string {
  const header = from.trim();
  if (header.length > MAX_FROM_HEADER_CHARS || !singleMailbox(header)) return '';
  const lt = header.lastIndexOf('<');
  if (lt !== -1) {
    const angle = /^<([^<>\s"@]{1,64}@[^<>\s"@]{1,255})>$/.exec(header.slice(lt));
    return angle === null ? '' : (angle[1] as string).toLowerCase();
  }
  return /^[^<>\s"@]{1,64}@[^<>\s"@]{1,255}$/.test(header) ? header.toLowerCase() : '';
}
