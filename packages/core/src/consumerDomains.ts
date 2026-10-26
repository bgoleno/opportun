// Consumer email providers, for the mail filter's rule 2 veto (spec D1).
//
// Owner decision, 2026-10-19: "relevant job mail should not come from personal accounts." The mailbox
// agrees emphatically: of 88 messages classified job-related (solicitation, scheduling,
// follow_up, rejection, offer), ZERO came from a domain in this list, and zero of 20
// solicitations. The top job-mail senders are all corporate or ATS.
//
// This is a built-in list behind one per-user toggle rather than sixty seeded deny rules,
// because the spec models the consumer veto as a rule in its own right (rule 2, below the
// user's own deny list at rule 1), and D7 asks it to read as a single toggleable item. Keeping
// it in code also means a later release can add a provider without clobbering anyone's edits:
// a user who disagrees about one domain writes an allow rule, and rule 0 beats rule 2.
//
// ISP addresses are included deliberately: nobody recruits from a Comcast account, so they are
// among the strongest personal-correspondence signals available.
export const CONSUMER_EMAIL_DOMAINS: readonly string[] = [
  // Mainstream webmail
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.ca',
  'yahoo.com.au',
  'ymail.com',
  'rocketmail.com',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Privacy-oriented
  'proton.me',
  'protonmail.com',
  'pm.me',
  'tutanota.com',
  'tuta.io',
  'hey.com',
  'fastmail.com',
  'mailfence.com',
  'posteo.de',
  'hushmail.com',
  'duck.com',
  // Other webmail
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'inbox.com',
  // US ISP accounts
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'bellsouth.net',
  'rr.com',
  'roadrunner.com',
  'optonline.net',
  'juno.com',
  'mindspring.com',
  // Non-US ISP and webmail
  'shaw.ca',
  'rogers.com',
  'sympatico.ca',
  'telus.net',
  'btinternet.com',
  'virginmedia.com',
  'sky.com',
  'orange.fr',
  'free.fr',
  'web.de',
  't-online.de',
  'libero.it',
  'seznam.cz',
  'naver.com',
  'hanmail.net',
  'daum.net',
  'qq.com',
  '163.com',
  '126.com',
  'sina.com',
  'rediffmail.com',
];

const CONSUMER_SET = new Set(CONSUMER_EMAIL_DOMAINS);

/** True when an envelope address sits at a known consumer provider (exact domain, no subdomains). */
export function isConsumerAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at === -1) return false;
  return CONSUMER_SET.has(
    address
      .slice(at + 1)
      .trim()
      .toLowerCase(),
  );
}
