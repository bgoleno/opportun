import { describe, expect, it } from 'vitest';
import {
  googleErrorReason,
  googleHttpError,
  isGoogleRateLimit,
  withRateLimitRetry,
} from '../src/lib/google';

/** A gaxios-shaped error: status on response, human text in message. */
function gaxios(status: number, message: string): Error {
  const e = new Error(message) as Error & { response: { status: number } };
  e.response = { status };
  return e;
}

describe('googleHttpError', () => {
  it('maps accessNotConfigured to google_api_disabled, naming the API to enable', () => {
    const err = googleHttpError(
      gaxios(
        403,
        'Google Drive API has not been used in project 738885634221 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview then retry.',
      ),
    );
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('google_api_disabled');
    expect(err.message).toContain('Google Drive API is not enabled');
    expect(err.message).toContain('Enable APIs step');
  });

  it('keeps a plain 403 or 404 as google_doc_unavailable', () => {
    expect(googleHttpError(gaxios(403, 'The caller does not have permission')).code).toBe(
      'google_doc_unavailable',
    );
    expect(googleHttpError(gaxios(404, 'File not found')).code).toBe('google_doc_unavailable');
  });

  it('recognizes rate limits: 429, and the Gmail 403 flavor naming the quota', () => {
    expect(isGoogleRateLimit(gaxios(429, 'Too many requests'))).toBe(true);
    expect(isGoogleRateLimit(gaxios(403, 'User-rate limit exceeded.  Retry after 10s'))).toBe(true);
    expect(isGoogleRateLimit(gaxios(403, "Quota exceeded for quota metric 'Queries'"))).toBe(true);
    expect(isGoogleRateLimit(gaxios(403, 'The caller does not have permission'))).toBe(false);
    expect(isGoogleRateLimit(gaxios(403, 'Gmail API has not been used in project 1 before'))).toBe(
      false,
    );
  });

  it('prefers the structured reason over message text when one is present', () => {
    const limited = Object.assign(gaxios(403, 'Forbidden'), {
      errors: [{ reason: 'rateLimitExceeded' }],
    });
    expect(isGoogleRateLimit(limited)).toBe(true);
    expect(googleErrorReason(limited)).toBe('rateLimitExceeded');
    const denied = Object.assign(gaxios(403, 'rate limit words in message'), {
      errors: [{ reason: 'domainPolicy' }],
    });
    // A structured non-limit reason wins over coincidental message text.
    expect(isGoogleRateLimit(denied)).toBe(false);
    expect(googleErrorReason(gaxios(403, 'Forbidden'))).toBeUndefined();
  });

  it('maps 401 and invalid_grant to google_reauth_required', () => {
    expect(googleHttpError(gaxios(401, 'Invalid Credentials')).code).toBe('google_reauth_required');
    expect(googleHttpError(gaxios(400, 'invalid_grant: Token has been revoked')).code).toBe(
      'google_reauth_required',
    );
  });
});

describe('withRateLimitRetry', () => {
  it('waits out rate limits and returns the eventual result', async () => {
    let calls = 0;
    const result = await withRateLimitRetry(
      () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('User-rate limit exceeded'), { status: 403 });
        return Promise.resolve('ok');
      },
      { baseMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rethrows the rate-limit error once attempts run out', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        () => {
          calls += 1;
          throw Object.assign(new Error('rateLimitExceeded'), { status: 429 });
        },
        { attempts: 3, baseMs: 1 },
      ),
    ).rejects.toThrow('rateLimitExceeded');
    expect(calls).toBe(3);
  });

  it('rethrows any other error immediately', async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(() => {
        calls += 1;
        throw Object.assign(new Error('The caller does not have permission'), { status: 403 });
      }),
    ).rejects.toThrow('permission');
    expect(calls).toBe(1);
  });
});
