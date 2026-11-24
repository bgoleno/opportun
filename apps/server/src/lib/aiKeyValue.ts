// What an AI provider key may be, checked before it is kept and before it is used, so that no message
// echoes the AI key or any part of it (https://github.com/bgoleno/opportun/issues/896).

/** The key without the white space around it, or undefined when it is not one that can be sent. */
export function usableAiKey(value: string): string | undefined {
  const key = value.trim();
  if (key === '') return undefined;
  for (const char of key) {
    const code = char.codePointAt(0) ?? 0;
    // What a request header carries: no control character, nothing past Latin-1.
    if (code < 0x20 || code === 0x7f || code > 0xff) return undefined;
  }
  return key;
}
