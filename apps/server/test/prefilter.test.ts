// The discovery pre-filter's rules (https://github.com/bgoleno/opportun/issues/217), as a pure
// function. Built for recall: a rule filters only on what the posting states.
import type { NormalizedPosting } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { prefilter, titleScore, titleWords, type PrefilterTarget } from '../src/lib/prefilter';

const target = (over: Partial<PrefilterTarget> = {}): PrefilterTarget => ({
  name: 'Platform',
  titleFamily: 'Platform Engineering',
  titleVariants: ['Platform Engineer', 'Site Reliability Engineer', 'SRE'],
  locations: [],
  remotePref: 'any',
  ...over,
});
const posting = (over: Partial<NormalizedPosting> = {}): NormalizedPosting => ({
  company: 'Initech',
  title: 'Senior Platform Engineer',
  ...over,
});

describe('the title rule', () => {
  it('passes a title matching a variant, seniority aside, and scores the best match', () => {
    expect(prefilter(posting(), [target()])).toEqual({ outcome: 'pass', rule: null, score: 1 });
    expect(prefilter(posting({ title: 'Staff SRE' }), [target()])).toMatchObject({
      outcome: 'pass',
      score: 1,
    });
  });

  it('filters a title matching nothing, with its score', () => {
    expect(prefilter(posting({ title: 'Office Coordinator' }), [target()])).toEqual({
      outcome: 'filtered',
      rule: 'title',
      score: 0,
    });
  });

  it('passes at exactly half of a variant’s words, and filters below', () => {
    const t = target({ name: 'x', titleFamily: 'x', titleVariants: ['Data Platform'] });
    expect(prefilter(posting({ title: 'Data Analyst' }), [t])).toMatchObject({
      outcome: 'pass',
      score: 0.5,
    });
    const three = target({ name: 'x', titleFamily: 'x', titleVariants: ['Data Platform Owner'] });
    expect(prefilter(posting({ title: 'Data Analyst' }), [three])).toMatchObject({
      outcome: 'filtered',
      rule: 'title',
      score: 0.33,
    });
  });

  it('with no variants yet, the target’s name and title family still count', () => {
    const t = target({ titleVariants: [] });
    expect(prefilter(posting({ title: 'Platform Engineering Manager' }), [t])?.outcome).toBe(
      'pass',
    );
  });

  it('ignores case, accents, punctuation and seniority words', () => {
    expect(titleWords('Sr. Développeur (Back-End), Level II')).toEqual([
      'developpeur',
      'back',
      'end',
    ]);
    expect(titleScore('BACK-END Developpeur', ['Développeur back end'])).toBe(1);
  });

  it('a phrase of only ignored words matches nothing', () => {
    expect(titleScore('Senior Lead', ['Senior'])).toBe(0);
  });
});

describe('the remote rule', () => {
  it('a remote-only target filters a posting stated as not remote', () => {
    expect(prefilter(posting({ remote: false }), [target({ remotePref: 'remote' })])).toEqual({
      outcome: 'filtered',
      rule: 'remote',
      score: 1,
    });
  });

  it('an on-site target filters a posting stated as remote', () => {
    expect(prefilter(posting({ remote: true }), [target({ remotePref: 'onsite' })])).toMatchObject({
      outcome: 'filtered',
      rule: 'remote',
    });
  });

  it('a posting that does not say is kept, and any or hybrid never filter', () => {
    expect(prefilter(posting(), [target({ remotePref: 'remote' })])?.outcome).toBe('pass');
    expect(prefilter(posting({ remote: null }), [target({ remotePref: 'onsite' })])?.outcome).toBe(
      'pass',
    );
    for (const remotePref of ['any', 'hybrid'] as const) {
      for (const remote of [true, false]) {
        expect(prefilter(posting({ remote }), [target({ remotePref })])?.outcome).toBe('pass');
      }
    }
  });
});

describe('the location rule', () => {
  const austin = target({ locations: ['Austin, TX', 'New York'] });

  it('filters a stated location that is none of the target’s places', () => {
    expect(prefilter(posting({ location: 'Berlin, Germany' }), [austin])).toEqual({
      outcome: 'filtered',
      rule: 'location',
      score: 1,
    });
  });

  it('passes a place named before its comma, whatever the case', () => {
    expect(prefilter(posting({ location: 'AUSTIN, Texas' }), [austin])?.outcome).toBe('pass');
    expect(prefilter(posting({ location: 'New York City' }), [austin])?.outcome).toBe('pass');
  });

  it('keeps a posting with no location, and a target with no places filters none', () => {
    expect(prefilter(posting(), [austin])?.outcome).toBe('pass');
    expect(prefilter(posting({ location: '  ' }), [austin])?.outcome).toBe('pass');
    expect(prefilter(posting({ location: 'Berlin' }), [target()])?.outcome).toBe('pass');
  });

  it('a remote posting passes, by its flag or its location, unless the target is on-site', () => {
    expect(prefilter(posting({ location: 'Berlin', remote: true }), [austin])?.outcome).toBe(
      'pass',
    );
    expect(prefilter(posting({ location: 'Remote, Europe' }), [austin])?.outcome).toBe('pass');
    const onsite = target({ locations: ['Austin'], remotePref: 'onsite' });
    expect(prefilter(posting({ location: 'Remote, Europe' }), [onsite])).toMatchObject({
      outcome: 'filtered',
      rule: 'location',
    });
  });
});

describe('over several targets', () => {
  const sales = target({
    name: 'Sales',
    titleFamily: 'Sales',
    titleVariants: ['Account Executive'],
  });

  it('passes when any target passes, with the best score', () => {
    expect(prefilter(posting(), [sales, target()])).toEqual({
      outcome: 'pass',
      rule: null,
      score: 1,
    });
  });

  it('filtered, it takes the rule of the target the title matches best', () => {
    // The title fits the platform target, which refuses it for remote; sales refuses its title.
    expect(
      prefilter(posting({ remote: false }), [sales, target({ remotePref: 'remote' })]),
    ).toEqual({ outcome: 'filtered', rule: 'remote', score: 1 });
  });

  it('with no target to judge against, nothing is said', () => {
    expect(prefilter(posting(), [])).toBeNull();
  });
});
