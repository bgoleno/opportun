// Build-time only: imported by vite.config.ts, never bundled into the extension itself.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Identifies exactly the bytes of one build, independent of where it ran. This is the one
 * comparison #79 had to do by hand (rebuild dist/chrome from main, diff bundle bytes): sorted
 * by name first so it does not depend on bundle iteration order.
 */
export function hashContents(files: ReadonlyMap<string, Uint8Array | string>): string {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    hash.update(name);
    const content = files.get(name) ?? '';
    hash.update(typeof content === 'string' ? content : Buffer.from(content));
  }
  return hash.digest('hex').slice(0, 8);
}

/**
 * Best-effort: succeeds for any build with `git` and a `.git` to ask (a normal checkout,
 * `pnpm dev`, CI). Fails inside the Docker image build on purpose: `.dockerignore` excludes
 * `.git` from that build's context so a new commit does not invalidate every layer after
 * `COPY . .`, and the build stage's base image carries no `git` binary either way.
 * `undefined` here is not a defect to work around; `hashContents` is what actually survives
 * that path, and this is best-effort enrichment on top of it.
 */
export function resolveCommit(cwd: string = process.cwd()): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha === '' ? undefined : sha;
  } catch {
    return undefined;
  }
}
