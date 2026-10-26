import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';
import { queryOne } from './db';

const boot = useApi();
const MB = 1024 * 1024;

/** A multipart/form-data body with one file part. */
function multipart(filename: string, content: Buffer, mime = 'application/pdf') {
  const boundary = `----opportun${randomBytes(8).toString('hex')}`;
  // Names a browser could not send raw (quotes, non-ASCII) go as RFC 5987 filename*.
  const plain = /^[\x20-\x7e]*$/.test(filename) && !filename.includes('"');
  const param = plain
    ? `filename="${filename}"`
    : `filename*=UTF-8''${encodeURIComponent(filename)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; ${param}\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function createOpp(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/opportunities',
    payload: { companyName: 'Initech', title: 'Principal PM', sourceKind: 'manual' },
  });
  return res.json().id as string;
}

function upload(c: TestClient, oppId: string, filename: string, content: Buffer, mime?: string) {
  return c.request({
    method: 'POST',
    url: `/api/v1/opportunities/${oppId}/attachments`,
    ...multipart(filename, content, mime),
  });
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

describe('attachments', () => {
  it('round-trips bytes and lists metadata without the stored path', async () => {
    const { a } = await boot();
    const oppId = await createOpp(a);
    const content = randomBytes(256 * 1024);
    const res = await upload(a, oppId, 'Offer letter.pdf', content);
    expect(res.statusCode, res.body).toBe(201);
    const meta = res.json();
    expect(meta).toMatchObject({
      opportunityId: oppId,
      userId: a.userId,
      filename: 'Offer letter.pdf',
      mime: 'application/pdf',
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    expect(meta.storedPath).toBeUndefined();

    const dl = await a.request({ method: 'GET', url: `/api/v1/attachments/${meta.id}` });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(content)).toBe(true);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(dl.headers['content-length']).toBe(String(content.length));
    expect(dl.headers['content-disposition']).toBe(
      `attachment; filename="Offer letter.pdf"; filename*=UTF-8''Offer%20letter.pdf`,
    );
    expect(dl.headers['x-content-type-options']).toBe('nosniff');

    const list = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${oppId}/attachments`,
    });
    expect(list.json().total).toBe(1);
    expect(list.json().items[0]).toEqual(meta);
  });

  it('rejects a file over 20 MB with 413 and keeps nothing', async () => {
    const { app, a, dataDir } = await boot();
    const oppId = await createOpp(a);
    const res = await upload(a, oppId, 'big.bin', Buffer.alloc(20 * MB + 1, 7));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
    const rows = (await queryOne(app, 'SELECT count(*) AS n FROM attachments')) as {
      n: number;
    };
    expect(rows.n).toBe(0);
    const files = await walk(join(dataDir, 'attachments')).catch(() => []);
    expect(files).toEqual([]);

    // Exactly 20 MB is accepted.
    const ok = await upload(a, oppId, 'edge.bin', Buffer.alloc(20 * MB, 7));
    expect(ok.statusCode).toBe(201);
    expect(ok.json().bytes).toBe(20 * MB);
  });

  it('stores a traversal filename as metadata only and serves a sanitized name', async () => {
    const { app, a, dataDir } = await boot();
    const oppId = await createOpp(a);
    const content = Buffer.from('#!/bin/sh\necho pwned\n');
    const res = await upload(a, oppId, '../../evil.sh', content, 'text/x-shellscript');
    expect(res.statusCode).toBe(201);
    expect(res.json().filename).toBe('../../evil.sh');

    const row = (await queryOne(
      app,
      'SELECT stored_path FROM attachments WHERE id = ?',
      res.json().id,
    )) as { stored_path: string };
    const sha = createHash('sha256').update(content).digest('hex');
    expect(row.stored_path).toBe(`attachments/${sha.slice(0, 2)}/${sha}`);
    const files = await walk(dataDir);
    expect(files.some((f) => f.endsWith('evil.sh'))).toBe(false);
    expect(await walk(join(dataDir, 'attachments'))).toEqual([join(dataDir, row.stored_path)]);

    const dl = await a.request({ method: 'GET', url: `/api/v1/attachments/${res.json().id}` });
    expect(dl.headers['content-disposition']).toBe(
      `attachment; filename="evil.sh"; filename*=UTF-8''evil.sh`,
    );
    expect(dl.body).toBe(content.toString());
  });

  it('sanitizes header-breaking names and untrusted mime types', async () => {
    const { a } = await boot();
    const oppId = await createOpp(a);
    const res = await upload(a, oppId, '.hidden"; x=1.txt', Buffer.from('x'), 'text/html; x=y');
    expect(res.statusCode).toBe(201);
    const dl = await a.request({ method: 'GET', url: `/api/v1/attachments/${res.json().id}` });
    const disposition = String(dl.headers['content-disposition']);
    expect(disposition.startsWith('attachment; filename="hidden_ x_1.txt"')).toBe(true);
    expect(disposition).not.toMatch(/filename="[^"]*"[^;]*"/);
    // Active content (HTML, SVG, script) is stored as declared but served as opaque bytes.
    expect(res.json().mime).toBe('text/html');
    expect(dl.headers['content-type']).toBe('application/octet-stream');

    const junk = await upload(a, oppId, 'j.bin', Buffer.from('z'), 'not a mime type');
    expect(junk.json().mime).toBe('application/octet-stream');

    const unicode = await upload(a, oppId, 'Résumé 履歴.pdf', Buffer.from('y'));
    const dl2 = await a.request({ method: 'GET', url: `/api/v1/attachments/${unicode.json().id}` });
    expect(dl2.headers['content-disposition']).toBe(
      `attachment; filename="R_sum_ _.pdf"; filename*=UTF-8''${encodeURIComponent('Résumé 履歴.pdf')}`,
    );
  });

  it('rejects a request without a file and another user opportunity', async () => {
    const { a, b } = await boot();
    const oppId = await createOpp(a);
    const empty = await a.request({
      method: 'POST',
      url: `/api/v1/opportunities/${oppId}/attachments`,
      payload: { not: 'multipart' },
    });
    expect([400, 406, 415]).toContain(empty.statusCode);
    const foreign = await upload(b, oppId, 'x.txt', Buffer.from('x'));
    expect(foreign.statusCode).toBe(404);
  });

  it('deletes the metadata row', async () => {
    const { a } = await boot();
    const oppId = await createOpp(a);
    const id = (await upload(a, oppId, 'a.txt', Buffer.from('a'))).json().id;
    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/attachments/${id}` })).statusCode,
    ).toBe(204);
    expect((await a.request({ method: 'GET', url: `/api/v1/attachments/${id}` })).statusCode).toBe(
      404,
    );
  });

  const createAttachment = async (c: TestClient) => {
    const oppId = await createOpp(c);
    return (await upload(c, oppId, 'note.txt', Buffer.from(`for ${c.userId}`))).json().id as string;
  };
  assertIsolated({
    name: 'attachments (GET)',
    create: createAttachment,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/attachments/${id}` }),
  });
  assertIsolated({
    name: 'attachments (DELETE)',
    create: createAttachment,
    read: (c, id) => c.request({ method: 'DELETE', url: `/api/v1/attachments/${id}` }),
  });
  assertIsolated({
    name: 'opportunity attachment list',
    create: createOpp,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/opportunities/${id}/attachments` }),
  });
});
