// The image's base images are pinned by digest, with the tag they were read from beside them
// (https://github.com/bgoleno/opportun/issues/619, from sec's audit): a tag is a mutable reference,
// so a build from the same commit could start from different bytes on another day. Read from the
// file as text: no image is built here (CI's docker legs build it).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const DOCKERFILE = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');

/** Every FROM line, with the image it names and the stage names defined before it. */
function froms(text: string) {
  const stages = new Set<string>();
  const out: { line: string; image: string }[] = [];
  for (const raw of text.split('\n')) {
    const words = raw.trim().split(/\s+/);
    if (words[0]?.toUpperCase() !== 'FROM') continue;
    const args = words.slice(1).filter((w) => !w.startsWith('--'));
    out.push({ line: raw.trim(), image: args[0]! });
    if (args[1]?.toUpperCase() === 'AS' && args[2] !== undefined) stages.add(args[2].toLowerCase());
  }
  return out.filter((f) => !stages.has(f.image.toLowerCase()));
}

describe('the Dockerfile base images (#619)', () => {
  it('names at least one base image', () => {
    expect(froms(DOCKERFILE).length).toBeGreaterThan(0);
  });

  it.each(froms(DOCKERFILE).map((f) => [f.line, f.image]))(
    '%s is pinned to a sha256 digest, with its tag',
    (_line, image) => {
      // name:tag@sha256:<64 hex>: the tag says what was pinned, the digest is what is pulled.
      expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    },
  );

  it('every stage starts from the same pinned image', () => {
    expect(new Set(froms(DOCKERFILE).map((f) => f.image)).size).toBe(1);
  });
});
