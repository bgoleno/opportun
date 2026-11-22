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
import { api, ApiError, errorMessage } from './api';

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

describe('errorMessage', () => {
  // The discovery source form shows this when the server refuses a source kind only the
  // instance's administrator may add (#563: a shared demo admin, like any other user).
  it('says in words that a command source is for the administrator', () => {
    const err = new ApiError(403, 'mcp_stdio_admin_only', 'mcp_stdio_admin_only');
    expect(errorMessage(err)).toBe(
      "Only this instance's administrator can add a source that runs a command on the server.",
    );
  });

  // https://github.com/bgoleno/opportun/issues/750: the client's own wording first, then the
  // sentence the server marked for users, then the generic text.
  it("prefers its own wording for a code over the server's sentence", () => {
    expect(errorMessage(new ApiError(409, 'duplicate', 'A row with that name exists.'))).toBe(
      'That already exists.',
    );
  });

  it("uses the server's sentence for a code it has no wording for", () => {
    expect(errorMessage(new ApiError(422, 'invalid_cron', 'must be a valid cron expression'))).toBe(
      'must be a valid cron expression',
    );
  });

  it('falls back to the generic text when the server sent no sentence', () => {
    expect(errorMessage(new ApiError(422, 'invalid_cron'))).toBe('Request failed (invalid_cron).');
  });

  it("reads the server's sentence from the envelope, as text", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { code: 'invalid_pattern', message: 'Not a sender pattern: <b>x</b>' } },
          { status: 422 },
        ),
      ),
    );
    const err = await api('/mail-filters', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(errorMessage(err)).toBe('Not a sender pattern: <b>x</b>');
  });
});
