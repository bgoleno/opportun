// What is said of a setting that takes a file, when the file can't be read.

/**
 * The setting and the system's code, never the setting's value or the system's message, which
 * quotes it.
 */
export function fileSettingProblem(setting: string, holds: string, err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const named = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(code) ? code : 'unknown';
  return `${setting} could not be read (${named}): it takes the path of a file holding ${holds}, not the value itself (value not shown)`;
}
