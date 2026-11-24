// How long a server test waits for something that has to come
// (https://github.com/bgoleno/opportun/issues/948). It ends a test in which the thing never comes,
// inside Vitest's own 30 s, so the failure names what was missing. Nothing is inferred from it: a
// test that passes does not wait for it, and one on a busy host that is slow to get there does not
// fail for that.
export const PATIENCE_MS = 20_000;
