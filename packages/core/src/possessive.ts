/**
 * A name's possessive, for a sentence that names a company ("Vandelay Industries' board"): an
 * apostrophe alone after a final s, "'s" otherwise. A name that is itself a possessive
 * ("McDonald's") stays as it is (https://github.com/bgoleno/opportun/issues/866).
 */
export function possessive(name: string): string {
  const n = name.trim();
  if (/['\u2019]s?$/i.test(n)) return n;
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}
