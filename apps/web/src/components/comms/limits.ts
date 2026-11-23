// The server's limit on an Inbox keyword or sender filter (apps/server/src/routes/communications.ts),
// with no imports, so apps/server/test/inboxFilterLimit.test.ts can pin the two equal.
export const INBOX_FILTER_MAX = 200;

/** Counted in characters, as the server counts them (#896): `length` counts most emoji as two. */
export const filterTooLong = (text: string): boolean => [...text].length > INBOX_FILTER_MAX;
