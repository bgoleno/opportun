// Two pins on the image's PostgreSQL apt key (PGDG), sec's suggestions on #450
// (https://github.com/bgoleno/opportun/issues/459):
// 1. The runtime image's keyring is the file the checked `pgdg-key` stage verified, brought by
//    `COPY --from=pgdg-key`. BuildKit builds only the stages the target needs, so a runtime stage
//    that took the key from anywhere else would never run the check at all.
// 2. The committed key file holds exactly one key, so apt trusts one key through `signed-by`; and
//    the check stage still refuses a file with more than one.
// Both are read from the files as text: no image is built here (CI's docker legs build it).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const DOCKERFILE = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
const KEY_FILE = readFileSync(join(ROOT, 'deploy', 'pgdg-ACCC4CF8.asc'), 'utf8');

const KEYRING = '/usr/share/keyrings/pgdg.asc';
const FROM_CHECK_STAGE = `COPY --from=pgdg-key /pgdg.asc ${KEYRING}`;

/** The Dockerfile's instructions, comments dropped and continuation lines joined. */
function instructions(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l !== '');
}

/** The instructions of one build stage, from its FROM to the next. */
function stage(text: string, name: string): string[] {
  const all = instructions(text);
  const start = all.findIndex(
    (l) => /^FROM /i.test(l) && l.toLowerCase().endsWith(` as ${name.toLowerCase()}`),
  );
  if (start === -1) throw new Error(`no stage ${name}`);
  const end = all.findIndex((l, i) => i > start && /^FROM /i.test(l));
  return all.slice(start, end === -1 ? undefined : end);
}

/** Where apt reads trusted keys from: a keyring a source names, or the global trusted set. */
const KEY_PLACE =
  /\/usr\/share\/keyrings\/|\/etc\/apt\/trusted\.gpg|\/etc\/apt\/keyrings\/|apt-key/;

/**
 * What in the runtime stage can put a key where apt trusts it, other than the one allowed COPY:
 * every other instruction, or shell command of a RUN, that names a key place. The apt source line
 * that names the keyring (`signed-by=`) only reads it, and is allowed.
 */
function otherKeySources(text: string): string[] {
  const found: string[] = [];
  for (const line of stage(text, 'runtime')) {
    if (line === FROM_CHECK_STAGE) continue;
    const commands = /^RUN /i.test(line) ? line.slice(4).split(/&&|\|\||;|\|/) : [line];
    for (const command of commands) {
      if (!KEY_PLACE.test(command)) continue;
      const readsOnly = /^\s*echo "deb \[signed-by=\/usr\/share\/keyrings\/pgdg\.asc\]/.test(
        command,
      );
      if (!readsOnly) found.push(command.trim());
    }
  }
  return found;
}

/** The ASCII-armored blocks' binary contents, every block in the file. */
function dearmor(armored: string): Buffer[] {
  const blocks = [
    ...armored.matchAll(
      /-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/g,
    ),
  ];
  return blocks.map((m) => {
    // Armor headers end at the first blank line; the CRC line starts with '='.
    const body = (m[1] ?? '').split(/\r?\n\r?\n/).slice(-1)[0] ?? '';
    const base64 = body
      .split(/\r?\n/)
      .filter((l) => l !== '' && !l.startsWith('='))
      .join('');
    return Buffer.from(base64, 'base64');
  });
}

/** The OpenPGP packet tags in a binary key, in order (RFC 9580 section 4.2). */
function packetTags(data: Buffer): number[] {
  const tags: number[] = [];
  let at = 0;
  while (at < data.length) {
    const header = data.readUInt8(at);
    if ((header & 0x80) === 0) throw new Error(`not a packet header at ${at}`);
    let tag: number;
    let length: number;
    if ((header & 0x40) !== 0) {
      tag = header & 0x3f;
      const first = data.readUInt8(at + 1);
      if (first < 192) [length, at] = [first, at + 2];
      else if (first < 224)
        [length, at] = [((first - 192) << 8) + data.readUInt8(at + 2) + 192, at + 3];
      else if (first === 255) [length, at] = [data.readUInt32BE(at + 2), at + 6];
      else throw new Error('a partial-length packet, which a key file does not use');
    } else {
      tag = (header >> 2) & 0x0f;
      const kind = header & 0x03;
      if (kind === 0) [length, at] = [data.readUInt8(at + 1), at + 2];
      else if (kind === 1) [length, at] = [data.readUInt16BE(at + 1), at + 3];
      else if (kind === 2) [length, at] = [data.readUInt32BE(at + 1), at + 5];
      else throw new Error('an indeterminate-length packet, which a key file does not use');
    }
    tags.push(tag);
    at += length;
  }
  if (at !== data.length) throw new Error('a packet runs past the end of the key');
  return tags;
}

/** How many primary public keys (tag 6) the file holds, across every armored block. */
function primaryKeys(armored: string): number {
  return dearmor(armored)
    .flatMap(packetTags)
    .filter((t) => t === 6).length;
}

describe('the runtime keyring comes only from the checked pgdg-key stage (#459)', () => {
  it('has exactly one COPY of it, from the pgdg-key stage, and nothing else puts a key where apt trusts it', () => {
    expect(stage(DOCKERFILE, 'runtime').filter((l) => l === FROM_CHECK_STAGE)).toHaveLength(1);
    expect(otherKeySources(DOCKERFILE)).toEqual([]);
  });

  it('would refuse a key taken from anywhere else', () => {
    const swaps = [
      // sec's A3 on #450: straight from the repository, so the check stage never runs.
      [FROM_CHECK_STAGE, `COPY deploy/pgdg-ACCC4CF8.asc ${KEYRING}`],
      // Fetched, or dearmored into the global trusted set, in the runtime stage.
      [FROM_CHECK_STAGE, `RUN curl -fsSL https://example.org/k.asc -o ${KEYRING}`],
      [
        FROM_CHECK_STAGE,
        `${FROM_CHECK_STAGE}\nCOPY deploy/other.asc /etc/apt/trusted.gpg.d/other.asc`,
      ],
      [FROM_CHECK_STAGE, `${FROM_CHECK_STAGE}\nRUN apt-key add /tmp/other.asc`],
    ] as const;
    for (const [from, to] of swaps) {
      const mutated = DOCKERFILE.replace(from, to);
      expect(mutated, to).not.toBe(DOCKERFILE);
      const single = stage(mutated, 'runtime').filter((l) => l === FROM_CHECK_STAGE).length === 1;
      expect(single && otherKeySources(mutated).length === 0, to).toBe(false);
    }
  });
});

describe('the committed PGDG key file holds exactly one key (#459)', () => {
  it('has one primary public key', () => {
    expect(dearmor(KEY_FILE)).toHaveLength(1);
    expect(primaryKeys(KEY_FILE)).toBe(1);
  });

  it('counts a second key, in the same block or a second one', () => {
    const [block] = dearmor(KEY_FILE);
    if (block === undefined) throw new Error('no key block');
    const armor = (data: Buffer) =>
      `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${data.toString('base64')}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
    expect(primaryKeys(armor(Buffer.concat([block, block])))).toBe(2);
    expect(primaryKeys(`${KEY_FILE}\n${armor(block)}`)).toBe(2);
  });

  it('the check stage still refuses a file with more than one key', () => {
    const run = stage(DOCKERFILE, 'pgdg-key').filter((l) => /^RUN /.test(l));
    expect(run).toHaveLength(1);
    expect(run[0]).toContain(`keys="$(gpg --show-keys --with-colons /pgdg.asc | grep -c '^pub:')"`);
    expect(run[0]).toContain('[ "$keys" != 1 ]');
  });
});
