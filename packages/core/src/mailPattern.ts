// Sender patterns for the mail filter rules (spec D1). A pattern is matched against the
// envelope address only: display names are attacker-controlled, so the caller passes the
// address it extracted, never the raw From header.
//
// Syntax, with the shorthands the settings UI accepts:
//
//   user@domain.com      that exact address
//   *@domain.com         any local part at exactly that domain
//   *@*.domain.com       any local part at any subdomain, but not the domain itself
//   domain.com           shorthand for *@domain.com
//   *.domain.com         shorthand for *@*.domain.com
//
// `*` matches within one component and never crosses the `@`, so `*@enterprise.com` cannot be
// talked into matching `hr@enterprise.com.evil.test`.

export interface MailPattern {
  /** Local part, possibly containing `*`. `*` alone means any. */
  local: string;
  /** Domain with no wildcard; `subdomains` carries the `*.` prefix instead. */
  domain: string;
  /** True when only subdomains of `domain` match, never `domain` itself. */
  subdomains: boolean;
}

/**
 * A domain that could actually exist: at least two labels of `[a-z0-9-]`, none empty, none
 * starting or ending with a hyphen.
 *
 * Strict on purpose, in both directions. A rule that matches nothing is a privacy failure when
 * the user believed they had denied a sender, and these strings are also interpolated into the
 * Gmail query as `-from:` terms, where a quote or a backslash makes the query malformed and
 * Gmail rejects it, stopping the sync entirely rather than degrading.
 */
/**
 * Checked by scanning rather than by regex. The natural pattern for a label,
 * `[a-z0-9]([a-z0-9-]*[a-z0-9])?`, is ambiguous (the inner class overlaps the trailing one),
 * so a long non-matching label backtracks. A scan is linear and reads more plainly besides.
 */
function validLabel(label: string): boolean {
  if (label.length === 0 || label.length > 63) return false;
  if (label.startsWith('-') || label.endsWith('-')) return false;
  for (const ch of label) {
    const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-';
    if (!ok) return false;
  }
  return true;
}

function validDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 255) return false;
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(validLabel);
}

/** Parses a pattern as the settings UI accepts it, or null when it cannot be one. */
export function parseMailPattern(input: string): MailPattern | null {
  const text = input.trim().toLowerCase();
  if (text.length === 0 || text.length > 320) return null;

  const at = text.indexOf('@');
  if (at !== text.lastIndexOf('@')) return null;

  if (at === -1) {
    // Domain-only forms: `domain.com` and `*.domain.com`.
    const subdomains = text.startsWith('*.');
    const domain = subdomains ? text.slice(2) : text;
    if (!validDomain(domain)) return null;
    return { local: '*', domain, subdomains };
  }

  const local = text.slice(0, at);
  const rest = text.slice(at + 1);
  if (local.length === 0 || /\s/.test(local)) return null;
  const subdomains = rest.startsWith('*.');
  const domain = subdomains ? rest.slice(2) : rest;
  if (!validDomain(domain)) return null;
  return { local, domain, subdomains };
}

/**
 * A `*`-wildcard glob over one component, anchored at both ends.
 *
 * Matched by two pointers rather than a built RegExp. The pattern is user input, and `*` would
 * expand to an unbounded quantifier, so `***...*` next to a long local part is a backtracking
 * blowup waiting to happen. This greedy scan backs up to the last `*` instead, which is linear
 * in practice and has no catastrophic case.
 */
/* eslint-disable security/detect-object-injection --
   g and v are loop counters bounded by the string lengths, and both operands are strings, so
   indexing them reads a character and cannot reach a prototype member. */
function globMatches(glob: string, value: string): boolean {
  if (glob === '*') return true;
  if (!glob.includes('*')) return glob === value;
  let g = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (g < glob.length && (glob[g] === '*' || glob[g] === value[v])) {
      if (glob[g] === '*') {
        star = g;
        mark = v;
        g += 1;
      } else {
        g += 1;
        v += 1;
      }
    } else if (star !== -1) {
      g = star + 1;
      mark += 1;
      v = mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g += 1;
  return g === glob.length;
}
/* eslint-enable security/detect-object-injection */

/** True when `address` (an envelope address) satisfies `pattern`. */
export function matchesMailPattern(address: string, pattern: MailPattern): boolean {
  const text = address.trim().toLowerCase();
  const at = text.indexOf('@');
  if (at === -1 || at !== text.lastIndexOf('@')) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;

  const domainOk = pattern.subdomains
    ? domain.endsWith(`.${pattern.domain}`)
    : domain === pattern.domain;
  return domainOk && globMatches(pattern.local, local);
}

/** Renders a parsed pattern back to its canonical text. */
function render(p: MailPattern): string {
  return `${p.local}@${p.subdomains ? '*.' : ''}${p.domain}`;
}

/**
 * Near-miss corrections for a pattern the user probably did not mean, most likely first.
 * The caller decides which to offer: a suggestion is only useful when it matches real senders
 * and the original does not (spec D1, the `*.gmail.com` case). Never returns the input itself.
 */
export function suggestMailPattern(input: string): string[] {
  const text = input.trim().toLowerCase();
  const parsed = parseMailPattern(text);
  const out: string[] = [];
  const add = (candidate: string | null) => {
    if (candidate === null) return;
    if (candidate !== text && !out.includes(candidate)) out.push(candidate);
  };

  if (parsed !== null) {
    // Only the domain-only shorthands (`d`, `*.d`) are ambiguous about what they cover, so
    // only they get alternatives. A pattern written with an `@` has already said what it
    // means, and offering `*@*.gmail.com` to someone who deliberately typed `*@gmail.com`
    // is noise, not help.
    if (!text.includes('@')) {
      add(render({ ...parsed, subdomains: false }));
      add(render({ ...parsed, subdomains: true }));
    }
  } else if (text.startsWith('@')) {
    // `@domain.com` is a near-miss for `*@domain.com`.
    const retry = parseMailPattern(`*${text}`);
    if (retry !== null) add(render(retry));
  }
  return out;
}
