// Links as they are pasted out of sentences (https://github.com/bgoleno/opportun/issues/549).

/**
 * `address` without the punctuation a sentence leaves after a pasted URL: trailing `.,;:!?` and a
 * `)` that closes no `(`. Exported for the handoff's own check (#620): a destination this would
 * change is refused, so the address checked is the address opened.
 */
export function withoutTrailingPunctuation(address: string): string {
  // Dropped by loops, not a regular expression, so it stays linear whatever the address holds.
  // A `)` is trailing punctuation only when it closes no `(` (#549): a URL pasted out of "(...)"
  // keeps its job id, and a Workday ".../San-Jose-CA-(Remote)/..." or a balanced "(...)" at the
  // end stays as written. Matched left to right (#562), so a stray `)` earlier in the query is not
  // counted against a balanced `(d)` at the end.
  const strayClose = new Set<number>();
  let open = 0;
  for (let i = 0; i < address.length; i++) {
    const c = address.charAt(i);
    if (c === '(') open += 1;
    else if (c === ')') {
      if (open > 0) open -= 1;
      else strayClose.add(i);
    }
  }
  let end = address.length;
  while (end > 0) {
    const last = address.charAt(end - 1);
    if ('.,;:!?'.includes(last) || (last === ')' && strayClose.has(end - 1))) end -= 1;
    else break;
  }
  return address.slice(0, end);
}
