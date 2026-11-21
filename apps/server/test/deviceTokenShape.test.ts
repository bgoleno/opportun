// One shape for a device token (#655, sec): the server's, and the copies the browser extension and
// the Apple Mail connector check a pasted token against before they ever send it. A copy looser
// than the server's would store, and send, something the server can never accept.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOKEN_SHAPE as CONNECTOR } from '../../connector/src/config';
import { TOKEN_SHAPE as EXTENSION } from '../../../packages/extension/src/tokenShape';
import { DEVICE_TOKEN_PREFIX, DEVICE_TOKEN_SHAPE } from '../src/lib/deviceTokens';

describe('the device token shape is the same everywhere it is checked', () => {
  it('the extension and the connector use the server’s pattern exactly', () => {
    expect(EXTENSION.source).toBe(DEVICE_TOKEN_SHAPE.source);
    expect(EXTENSION.flags).toBe(DEVICE_TOKEN_SHAPE.flags);
    expect(CONNECTOR.source).toBe(DEVICE_TOKEN_SHAPE.source);
    expect(CONNECTOR.flags).toBe(DEVICE_TOKEN_SHAPE.flags);
  });

  it('and agree on real tokens and near misses', () => {
    const real = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const cases = [
      real,
      real.slice(0, -1),
      `${real}A`,
      `odt_${'A'.repeat(16)}`,
      `odt_${'A'.repeat(200)}`,
      real.replace('odt_', 'odx_'),
      `odt_${'A'.repeat(42)}=`,
    ];
    for (const token of cases) {
      const server = DEVICE_TOKEN_SHAPE.test(token);
      expect(EXTENSION.test(token), token).toBe(server);
      expect(CONNECTOR.test(token), token).toBe(server);
    }
    expect(DEVICE_TOKEN_SHAPE.test(real)).toBe(true);
  });
});
