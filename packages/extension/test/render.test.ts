import { describe, expect, it } from 'vitest';
import type { Outcome } from '../src/api';
import { renderOutcome } from '../src/render';

describe('renderOutcome', () => {
  it('a created and an updated contact', () => {
    expect(
      renderOutcome({ kind: 'profile', contactId: 'c1', created: true, refined: false }),
    ).toEqual({ tone: 'success', text: 'Contact added to Opportun.' });
    expect(
      renderOutcome({ kind: 'profile', contactId: 'c1', created: false, refined: true }),
    ).toEqual({ tone: 'success', text: 'Contact updated in Opportun (details refined by AI).' });
  });

  it('says where the job actually went, which is the pipeline', () => {
    // Final review, Important 2. A job capture is an act of interest: the server resolves it
    // to an opportunity at Interested and never to a review-queue card. Saying "review queue"
    // was the only place the user was told what happened, and it was wrong.
    expect(
      renderOutcome({
        kind: 'job',
        resultId: 'r1',
        duplicate: false,
        refined: false,
        opportunityId: 'o1',
        stage: 'interested',
      }),
    ).toEqual({ tone: 'success', text: 'Added to your pipeline as Interested.' });
  });

  it('says it was added to an opportunity already further along, without moving it', () => {
    expect(
      renderOutcome({
        kind: 'job',
        resultId: 'r1',
        duplicate: false,
        refined: false,
        opportunityId: 'o1',
        stage: null,
      }),
    ).toEqual({ tone: 'success', text: 'Added to an opportunity you already track.' });
  });

  it('still reads a response from a server older than these fields', () => {
    // The contract is frozen in both directions: an extension newer than its server must not
    // fall over when opportunityId and stage are absent.
    expect(
      renderOutcome({ kind: 'job', resultId: 'r1', duplicate: false, refined: false }),
    ).toEqual({ tone: 'success', text: 'Captured to Opportun.' });
  });

  it.each([
    [
      'unsupported_path',
      /profile \(linkedin\.com\/in\/…\) or a job \(linkedin\.com\/jobs\/view\/…\)/,
    ],
    ['login_wall', /signed in/],
    ['not_linkedin', /not a LinkedIn page/],
    ['no_name', /finished loading/],
    ['no_headline', /finished loading/],
    ['not_a_profile', /single person’s profile/],
    ['no_title_company', /finished loading/],
    ['no_description', /finished loading/],
  ])('a %s refusal explains what to do', (reason, pattern) => {
    const r = renderOutcome({ kind: 'refused', reason });
    expect(r.tone).toBe('error');
    expect(r.text).toMatch(/^Not captured: /);
    expect(r.text).toMatch(pattern);
  });

  it('an unknown refusal reason is shown as the server sent it', () => {
    expect(renderOutcome({ kind: 'refused', reason: 'something_new' })).toEqual({
      tone: 'error',
      text: 'Not captured: the server did not recognize this page (something_new).',
    });
  });

  it('bounds server-supplied strings to 200 characters', () => {
    const long = 'x'.repeat(5000);
    const refused = renderOutcome({ kind: 'refused', reason: long }).text;
    expect(refused).toBe(
      `Not captured: the server did not recognize this page (${'x'.repeat(200)}).`,
    );
    const invalid = renderOutcome({ kind: 'invalid', status: 400, code: long }).text;
    expect(invalid).toContain(`(400 ${'x'.repeat(200)})`);
    expect(invalid).not.toContain('x'.repeat(201));
  });

  it('token problems point at Settings > Integrations > Extensions and Connectors', () => {
    expect(renderOutcome({ kind: 'unauthorized' }).text).toBe(
      'The server rejected the token: it may be revoked or mistyped. Create a new one in Opportun under Settings > Integrations > Extensions and Connectors.',
    );
    expect(renderOutcome({ kind: 'forbidden' }).text).toMatch(/browser capture permission/);
  });

  it('the capture budget, with and without a retry time', () => {
    expect(renderOutcome({ kind: 'rate_limited', retryAfterSec: 125 })).toEqual({
      tone: 'error',
      text: 'Capture limit reached (30 captures per 15 minutes). Try again in about 3 minutes.',
    });
    expect(renderOutcome({ kind: 'rate_limited', retryAfterSec: 30 }).text).toMatch(
      /about 1 minute\.$/,
    );
    expect(renderOutcome({ kind: 'rate_limited', retryAfterSec: null }).text).toMatch(
      /Try again in a few minutes\.$/,
    );
  });

  it('connection test, local and transport errors', () => {
    const cases: [Outcome, RegExp][] = [
      [{ kind: 'connected' }, /^Connected: the server accepted the token\.$/],
      [{ kind: 'network' }, /Could not reach the server/],
      [{ kind: 'server_error', status: 502 }, /server error \(502\)/],
      [
        { kind: 'invalid', status: 400, code: 'validation' },
        /refused the request \(400 validation\)/,
      ],
      [{ kind: 'too_large' }, /too large/],
      [{ kind: 'empty_page' }, /no text yet/],
      [{ kind: 'not_linkedin' }, /Open a LinkedIn profile or job page/],
      [{ kind: 'no_settings' }, /Save your server address and token first/],
      [{ kind: 'permission_denied' }, /permission to contact your server/],
      [{ kind: 'inject_failed' }, /could not read this tab/],
    ];
    for (const [outcome, pattern] of cases) expect(renderOutcome(outcome).text).toMatch(pattern);
    expect(renderOutcome({ kind: 'connected' }).tone).toBe('success');
  });
});
