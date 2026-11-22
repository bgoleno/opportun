// The device token's shape, as the server makes it (apps/server/src/lib/deviceTokens.ts: 'odt_'
// and 32 random bytes as base64url, 43 characters). A module of its own, with no imports, so the
// server's parity test (apps/server/test/deviceTokenShape.test.ts, #655) can compare the two.
export const TOKEN_SHAPE = /^odt_[A-Za-z0-9_-]{43}$/;
