// The capture route's limits (apps/server/src/routes/connectorCapture.ts CaptureBody), as the
// extension cuts a page to them. A module of its own, with no imports, so the server's parity test
// (apps/server/test/clientLimitsParity.test.ts, #649) can read them without the extension's DOM
// types.

/** The server's text cap (CAPTURE_TEXT_MAX). */
export const MAX_TEXT = 200_000;
/** The server's title cap. */
export const MAX_TITLE = 500;
