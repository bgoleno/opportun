// The server uses only the MCP SDK's client side (https://github.com/bgoleno/opportun/issues/466).
// hono and @hono/node-server come into the lockfile through @modelcontextprotocol/sdk, and only
// its server modules load them. This test keeps every import of the SDK in apps/server/src to
// the client, shared and types modules, so a server import is a decision someone makes on purpose.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
// The package root and every subpath: anything not allowed below is refused.
const SDK = /['"](@modelcontextprotocol\/sdk[^'"]*)['"]/g;
const ALLOWED = /^@modelcontextprotocol\/sdk\/(client\/|shared\/|types\.js$)/;

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
    .map((f) => join(SRC, f));
}

describe('the MCP SDK is used as a client only (issue 466)', () => {
  it('imports nothing from the SDK but its client, shared and types modules', () => {
    const found: string[] = [];
    const refused: string[] = [];
    for (const file of sourceFiles()) {
      for (const m of readFileSync(file, 'utf8').matchAll(SDK)) {
        const specifier = m[1] ?? '';
        found.push(specifier);
        if (!ALLOWED.test(specifier)) refused.push(`${file}: ${specifier}`);
      }
    }
    // A scan that found nothing would pass for the wrong reason.
    expect(found).toContain('@modelcontextprotocol/sdk/client/index.js');
    expect(refused).toEqual([]);
  });
});
