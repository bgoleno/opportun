// How much captured page or pasted text the model sees
// (https://github.com/bgoleno/opportun/issues/763): in lib/ so the posting-reconcile job reads it
// without importing the capture route.

/** Characters of page or pasted text the model sees. */
export const CAPTURE_MAX_TEXT = 50_000;
