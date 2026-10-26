// Deep links back to the original message in the user's own mail client (spec D2).
//
// This is what makes aggressive filtering safe: Opportun can refuse to store a blocked
// message's subject, snippet and body precisely because the original is always one click away
// where it already lives. The link is derived at render time from identifiers the row already
// carries, so no URL is stored.

export interface MailLinkSource {
  channel: string;
  externalId: string;
}

/**
 * Gmail's `#all/<id>` opens the message by its own id, which is exactly what `externalId`
 * holds for the gmail channel. `authuser` rather than the usual hardcoded `/u/0`, because
 * `u/0` means "the browser's first Google account", which need not be the synced mailbox.
 */
export function mailLink(source: MailLinkSource, accountEmail?: string | null): string | null {
  if (source.channel === 'gmail') {
    const who =
      accountEmail === null || accountEmail === undefined || accountEmail.length === 0
        ? ''
        : `?authuser=${encodeURIComponent(accountEmail)}`;
    return `https://mail.google.com/mail/u/0/${who}#all/${encodeURIComponent(source.externalId)}`;
  }
  if (source.channel === 'apple_mail') {
    // The connector prefixes its ids; only a real RFC822 Message-ID yields a usable link, and
    // its documented fallbacks (apple-mail:mail-<rowid>, apple-mail:sha256:<hex>) do not.
    const rest = source.externalId.startsWith('apple-mail:')
      ? source.externalId.slice('apple-mail:'.length)
      : source.externalId;
    if (rest.startsWith('mail-') || rest.startsWith('sha256:') || !rest.includes('@')) return null;
    return `message://%3C${encodeURIComponent(rest)}%3E`;
  }
  return null;
}

/**
 * Why `mailLink` came back null, for the one case worth saying out loud: a dialog the person
 * opened on purpose to read one specific message (#137), not a row in a list where most links
 * exist and a sentence of explanation on every one would be noise. Checks `mailLink` itself
 * first rather than re-deriving "is there a link" from the channel, so the two can never
 * disagree about which messages have one.
 */
export function mailLinkMissingReason(source: MailLinkSource): string | null {
  if (mailLink(source) !== null) return null;
  if (source.channel === 'linkedin') {
    return 'This came from your LinkedIn export, so there is no mailbox copy to open.';
  }
  if (source.channel === 'apple_mail') {
    return 'This message has no identifier the Mail app can open.';
  }
  // A future channel with no addressable original: honest about not knowing why, rather than
  // guessing at a reason that might be wrong for it.
  return 'There is no way to open the original for this message.';
}
