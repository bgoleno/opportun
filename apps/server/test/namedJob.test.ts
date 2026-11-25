// The screens and the server read the job a posting link names the same
// (https://github.com/bgoleno/opportun/issues/1057): core's jobNamedByLink beside atsJobRefOfUrl.
import { ATS_SITES, jobNamedByLink } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { atsJobRefOfUrl } from '../src/lib/atsJobRef';

const named = (link: string) => {
  const ref = atsJobRefOfUrl(link);
  return ref === null ? null : { kind: ref.kind, org: ref.org, externalId: ref.externalId };
};
const samples = ATS_SITES.flatMap((s) => [...s.samples.jobUrls, ...s.samples.boardUrls]);
const around = (link: string): string[] => [
  link,
  `${link}/`,
  `${link}?gh_jid=77`,
  `${link}?gh_src=x&lever-source=y#z`,
  link.replace('https:', 'http:'),
  link.toUpperCase().replace('HTTPS:', 'https:'),
  link.replace('https://', 'https://x.'),
];

describe('the job a posting link names, on the screens as on the server (#1057)', () => {
  it.each([
    ...samples.flatMap(around),
    'https://www.examplecorp.example/careers?gh_jid=1002',
    'https://www.examplecorp.example/careers?gh_jid=abc',
    'https://www.examplecorp.example/careers/1002',
    'https://boards.greenhouse.io/embed/job_app?for=examplecorp&token=1002',
    'https://www.linkedin.com/jobs/view/1002',
    'not a link',
    '',
  ])('%s', (link) => {
    expect(jobNamedByLink(link)).toEqual(named(link));
  });
});
