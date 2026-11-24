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

  it.each([
    ['interested', 'Added to your pipeline as Interested.'],
    [null, 'Added to an opportunity you already track.'],
  ])('says when its details were not added, at stage %s (#914)', (stage, said) => {
    const job = {
      kind: 'job' as const,
      resultId: 'r1',
      duplicate: false,
      refined: false,
      opportunityId: 'o1',
      stage,
    };
    expect(renderOutcome({ ...job, filled: false })).toEqual({
      tone: 'success',
      text: `${said} Its details could not be added just now. Add them on the opportunity's page.`,
    });
    expect(renderOutcome(job)).toEqual({ tone: 'success', text: said });
  });

  // https://github.com/bgoleno/opportun/issues/967, section 4 of tl's design: one sentence for each
  // thing that can have happened, true in each.
  describe('a server that says what happened', () => {
    const job = {
      kind: 'job' as const,
      resultId: 'r1',
      duplicate: false,
      refined: false,
      opportunityId: 'o1',
    };
    const text = (over: Partial<Extract<Outcome, { kind: 'job' }>>) => {
      const { tone, text: said } = renderOutcome({ ...job, ...over });
      expect(tone).toBe('success');
      return said;
    };

    it.each([
      [true, 'interested', 'interested', 'Added to your pipeline as Interested.'],
      [false, 'interested', 'interested', 'Already in your pipeline: moved to Interested.'],
      [
        false,
        null,
        'interested',
        'Already in your pipeline, at Interested. This page was added to its timeline.',
      ],
      [
        false,
        null,
        'preparing',
        'Already in your pipeline, at Preparing. This page was added to its timeline.',
      ],
      [
        false,
        null,
        'applied',
        'Already in your pipeline, at Applied. This page was added to its timeline.',
      ],
      [
        false,
        null,
        'in_process',
        'Already in your pipeline, at In process. This page was added to its timeline.',
      ],
      [
        false,
        null,
        'offer',
        'Already in your pipeline, at Offer. This page was added to its timeline.',
      ],
      [
        false,
        null,
        'closed',
        'Already in your pipeline, at Closed. This page was added to its timeline.',
      ],
      [
        false,
        null,
        'discovered',
        'Already in your pipeline, at New. It could not be moved to Interested just now: move it on its page.',
      ],
      [
        false,
        null,
        'dismissed',
        'Already in your pipeline, at Dismissed. It could not be moved to Interested just now: move it on its page.',
      ],
    ])('created %s, moved to %s, now at %s', (created, stage, currentStage, said) => {
      expect(text({ created, stage, currentStage })).toBe(said);
    });

    const moved = { created: false, stage: 'interested', currentStage: 'interested' } as const;
    const there = { created: false, stage: null, currentStage: 'applied' } as const;
    const made = { created: true, stage: 'interested', currentStage: 'interested' } as const;

    it('then what became of the description', () => {
      expect(text({ ...moved, description: 'added' })).toBe(
        'Already in your pipeline: moved to Interested. Its description was added.',
      );
      expect(text({ ...made, description: 'kept' })).toBe(
        'Added to your pipeline as Interested. Its own description was kept; this page is on its timeline.',
      );
      // The timeline is not said twice.
      expect(text({ ...there, description: 'kept' })).toBe(
        'Already in your pipeline, at Applied. This page was added to its timeline. Its own description was kept.',
      );
      expect(text({ ...there, filled: false })).toBe(
        "Already in your pipeline, at Applied. This page was added to its timeline. Its details could not be added just now. Add them on the opportunity's page.",
      );
    });

    it('then the rest of its card', () => {
      expect(text({ ...made, linked: 1 })).toBe(
        'Added to your pipeline as Interested. The other posting on its card was linked to it.',
      );
      expect(text({ ...made, linked: 2 })).toBe(
        'Added to your pipeline as Interested. The 2 other postings on its card were linked to it.',
      );
      expect(text({ ...moved, description: 'added', linked: 2 })).toBe(
        'Already in your pipeline: moved to Interested. Its description was added. The 2 other postings on its card were linked to it.',
      );
    });

    it('a stage this build does not know is written out, bounded', () => {
      expect(text({ created: false, stage: null, currentStage: 'on_hold' })).toContain(
        'at On hold.',
      );
      expect(
        text({ created: false, stage: null, currentStage: 'x'.repeat(900) }).length,
      ).toBeLessThan(300);
    });
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

  // https://github.com/bgoleno/opportun/issues/74: the same reasons, worded for the site of the tab.
  it.each([
    ['unsupported_path', /open a single Indeed job/],
    ['verification_wall', /Indeed is showing a sign-in or verification page/],
    ['unsupported_site', /not a site Opportun captures from/],
    ['not_linkedin', /not a site Opportun captures from/],
    ['no_title_company', /finished loading/],
    ['no_description', /finished loading/],
  ])('an Indeed %s refusal names Indeed, never LinkedIn', (reason, pattern) => {
    const r = renderOutcome({ kind: 'refused', reason }, 'indeed');
    expect(r.tone).toBe('error');
    expect(r.text).toMatch(/^Not captured: /);
    expect(r.text).toMatch(pattern);
    expect(r.text).not.toMatch(/LinkedIn/);
  });

  // https://github.com/bgoleno/opportun/issues/92: a title too long to store is not a page
  // that "had not finished loading". It says so, for both sites, and the other reasons keep
  // their words (the tables above).
  it.each([
    ['LinkedIn', 'linkedin'],
    ['Indeed', 'indeed'],
  ] as const)(
    '%s: a title_too_long refusal says the title is too long, in plain words',
    (_name, site) => {
      const r = renderOutcome({ kind: 'refused', reason: 'title_too_long' }, site);
      expect(r.tone).toBe('error');
      expect(r.text).toMatch(/^Not captured: /);
      expect(r.text).toMatch(/job title is longer than 300 characters/);
      expect(r.text).toMatch(/nothing was saved/i);
      expect(r.text).not.toMatch(/finished loading/);
      expect(r.text).not.toMatch(/title_too_long/);
    },
  );

  it('a LinkedIn tab still gets the LinkedIn wording, and understands the new reasons', () => {
    expect(renderOutcome({ kind: 'refused', reason: 'not_linkedin' }, 'linkedin').text).toMatch(
      /not a LinkedIn page/,
    );
    expect(renderOutcome({ kind: 'refused', reason: 'unsupported_site' }).text).toMatch(
      /not a site Opportun captures from/,
    );
    expect(renderOutcome({ kind: 'refused', reason: 'verification_wall' }).text).toMatch(
      /LinkedIn is showing a sign-in or verification page/,
    );
  });

  it('the Indeed refusals made in the popup, before anything is sent', () => {
    expect(renderOutcome({ kind: 'layout_unrecognized' }, 'indeed')).toEqual({
      tone: 'error',
      text: 'Not captured: Indeed’s layout was not recognized, so nothing was sent. Reload the job and try again; if it keeps happening, the extension needs an update.',
    });
    expect(renderOutcome({ kind: 'not_a_posting' }, 'indeed').text).toMatch(
      /^Open a single Indeed job/,
    );
    // The home page shows a job as it loads, with nothing in its URL naming it (#156).
    expect(renderOutcome({ kind: 'not_a_posting' }, 'indeed').text).toContain(
      'on the home page, click the job first',
    );
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

  it("the account's capture budget says it counts every browser and the web app (#272)", () => {
    expect(
      renderOutcome({
        kind: 'rate_limited',
        retryAfterSec: 15,
        limit: { per: 'user', max: 60, windowMinutes: 15 },
      }),
    ).toEqual({
      tone: 'error',
      text: 'Capture limit for your account reached (60 captures per 15 minutes, counting every browser and the Opportun web app). Try again in about 1 minute.',
    });
    // The token's limit, as the server sizes it.
    expect(
      renderOutcome({
        kind: 'rate_limited',
        retryAfterSec: 125,
        limit: { per: 'token', max: 30, windowMinutes: 15 },
      }).text,
    ).toBe('Capture limit reached (30 captures per 15 minutes). Try again in about 3 minutes.');
  });

  it('a busy server says to try again shortly, not that something is broken (#309)', () => {
    expect(renderOutcome({ kind: 'busy', retryAfterSec: 5 })).toEqual({
      tone: 'error',
      text: 'Opportun is busy saving something else of yours, so this capture is not finished. Try again in a few seconds.',
    });
    expect(renderOutcome({ kind: 'busy', retryAfterSec: null }).text).toMatch(
      /Try again in a few seconds\.$/,
    );
    expect(renderOutcome({ kind: 'busy', retryAfterSec: 125 }).text).toMatch(
      /Try again in about 3 minutes\.$/,
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
      [{ kind: 'unsupported_tab' }, /Open a LinkedIn profile or job page, or an Indeed job/],
      [{ kind: 'no_settings' }, /Save your server address and token first/],
      [{ kind: 'permission_denied' }, /permission to contact your server/],
      [{ kind: 'inject_failed' }, /could not read this tab/],
    ];
    for (const [outcome, pattern] of cases) expect(renderOutcome(outcome).text).toMatch(pattern);
    expect(renderOutcome({ kind: 'connected' }).tone).toBe('success');
  });
});
