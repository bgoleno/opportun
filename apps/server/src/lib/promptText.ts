// Sanitizing for values that go into a prompt as context. Shared by every task that renders
// one, so there is one definition of what "one line of context" means.

/** One line of context data: no newlines, no tags, bounded. */
export function line(value: string, max = 160): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[<>{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
