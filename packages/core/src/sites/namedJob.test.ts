import { describe, expect, it } from 'vitest';
import { jobNamedByLink, namedAgainst } from './namedJob';

const PINNED = { atsKind: 'ats_greenhouse', atsRef: 'examplecorp', atsExternalId: '1002' };
const REF = { kind: 'ats_greenhouse', org: 'examplecorp', externalId: '1002' };
const LEVER = '6b1f6a0e-7a0b-4a53-9c7d-2f6a8f1f0c11';

describe('jobNamedByLink (#1057)', () => {
  it.each([
    ['https://boards.greenhouse.io/examplecorp/jobs/1002', REF],
    ['https://job-boards.greenhouse.io/ExampleCorp/jobs/1002?gh_src=x', REF],
    [
      'https://www.examplecorp.example/careers?gh_jid=1002',
      { kind: 'ats_greenhouse', org: null, externalId: '1002' },
    ],
    [
      `https://jobs.lever.co/examplecorp/${LEVER}/apply`,
      { kind: 'ats_lever', org: 'examplecorp', externalId: LEVER },
    ],
    [
      'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Engineer_JR-1',
      { kind: 'ats_workday', org: 'acme/External', externalId: 'JR-1' },
    ],
  ])('%s', (link, job) => {
    expect(jobNamedByLink(link)).toMatchObject(job);
  });

  it.each([
    '',
    'not a link',
    'https://www.examplecorp.example/careers/1002',
    'https://boards.greenhouse.io/examplecorp',
    'https://www.linkedin.com/jobs/view/1002',
  ])('none: %s', (link) => {
    expect(jobNamedByLink(link)).toBeNull();
  });
});

describe('namedAgainst: the job an opportunity names beside the one an application is for (#1057)', () => {
  it.each([
    ['its identity', REF, null, 'same'],
    ['its identity, the company in another case', { ...REF, org: 'ExampleCorp' }, null, 'same'],
    [
      'its identity, before a link of another',
      REF,
      'https://boards.greenhouse.io/x/jobs/9',
      'same',
    ],
    ['another job', { ...REF, externalId: '1003' }, null, 'another'],
    ['another company', { ...REF, org: 'othercorp' }, null, 'another'],
    ['an identity with no company', { ...REF, org: null }, null, 'another'],
    ['another site', { ...REF, kind: 'ats_lever' }, null, 'another'],
    ['only its link', null, 'https://boards.greenhouse.io/examplecorp/jobs/1002', 'same'],
    [
      'only a link of another',
      null,
      'https://boards.greenhouse.io/examplecorp/jobs/1003',
      'another',
    ],
    ['only a link of another company', null, 'https://boards.greenhouse.io/o/jobs/1002', 'another'],
    ['a careers page with its id', null, 'https://a.example/jobs?gh_jid=1002', 'same'],
    ['a careers page with another', null, 'https://a.example/jobs?gh_jid=1003', 'another'],
    ['a link no site reads', null, 'https://a.example/jobs/1002', 'none'],
    ['nothing', null, null, 'none'],
  ])('%s: %s', (_, atsJobRef, postingUrl, expected) => {
    expect(namedAgainst({ atsJobRef, postingUrl }, PINNED)).toBe(expected);
  });
});
