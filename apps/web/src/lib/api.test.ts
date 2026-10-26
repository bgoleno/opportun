// api()'s keepalive scoping (issue #124): a plain fetch can be silently dropped by the browser
// when the page navigates away mid-flight. keepalive is the documented fix (MDN: a keepalive
// fetch outlives the page), but its own budget is a combined 64KB across every in-flight
// keepalive request on the page, so it is only safe for small bodies. These are deliberately
// unit tests of what api() asks fetch to do, not an attempt to reproduce the browser's own
// navigation-time request handling: that was tried against a real browser (Playwright) and
// found not to be reliably observable either way (see the PR for #124), so the claim this
// suite backs is narrower and fully verifiable: small JSON mutations get keepalive, nothing
// else does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api() keepalive', () => {
  it('sets keepalive on a small JSON mutation body', async () => {
    await api('/opportunities/abc/stage', { method: 'POST', body: { to: 'dismissed' } });
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(init).toMatchObject({ keepalive: true });
  });

  it('does not set keepalive on a GET (no body to protect)', async () => {
    await api('/dashboard');
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(init).toMatchObject({ keepalive: false });
  });

  it('does not set keepalive once the JSON body is too large for the shared keepalive budget', async () => {
    await api('/opportunities/abc', {
      method: 'PATCH',
      body: { descriptionMd: 'x'.repeat(20_000) },
    });
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(init).toMatchObject({ keepalive: false });
  });

  it('does not set keepalive on a multipart (FormData) body, whatever its size', async () => {
    const form = new FormData();
    form.set('file', new Blob(['small']), 'pack.zip');
    await api('/imports', { method: 'POST', body: form });
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(init).toMatchObject({ keepalive: false });
  });
});
