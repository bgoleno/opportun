// ATS job references in free text (Task 1): the links recruiters and the user send each other,
// turned into the board plus job id that identifies one posting. LinkedIn links are not ATS
// references and must never be treated as one (constraint C-1).
import { describe, expect, it } from 'vitest';
import { extractAtsJobRefs } from '../src/lib/atsJobRef';

describe('extractAtsJobRefs', () => {
  it('reads a hosted Greenhouse board link', () => {
    const refs = extractAtsJobRefs(
      'see https://job-boards.greenhouse.io/northwind/jobs/5550001001 for the role',
    );
    expect(refs).toEqual([
      {
        kind: 'ats_greenhouse',
        org: 'northwind',
        externalId: '5550001001',
        url: 'https://job-boards.greenhouse.io/northwind/jobs/5550001001',
      },
    ]);
  });

  it('reads a gh_jid query link on the company domain', () => {
    const [ref] = extractAtsJobRefs(
      'https://www.brightforge.example/careers/job?gh_jid=5550002002&board=brightforge',
    );
    expect(ref).toMatchObject({
      kind: 'ats_greenhouse',
      org: 'brightforge',
      externalId: '5550002002',
    });
  });

  it('reads a gh_jid link with no board parameter', () => {
    const [ref] = extractAtsJobRefs(
      'https://jobs.vantagedata.example/jobs/engineering/united-states/principal-product-manager/5550004004?gh_jid=5550004004',
    );
    expect(ref).toMatchObject({ kind: 'ats_greenhouse', org: null, externalId: '5550004004' });
  });

  it('reads the Greenhouse board API form', () => {
    const [ref] = extractAtsJobRefs('https://boards-api.greenhouse.io/v1/boards/acme/jobs/42');
    expect(ref).toMatchObject({ kind: 'ats_greenhouse', org: 'acme', externalId: '42' });
  });

  it('reads Lever and Ashby posting links', () => {
    const refs = extractAtsJobRefs(
      'https://jobs.lever.co/initech/0f1e2d3c https://jobs.ashbyhq.com/acme/9a8b7c6d',
    );
    expect(refs.map((r) => [r.kind, r.org, r.externalId])).toEqual([
      ['ats_lever', 'initech', '0f1e2d3c'],
      ['ats_ashby', 'acme', '9a8b7c6d'],
    ]);
  });

  it('ignores LinkedIn job links and other hosts', () => {
    expect(
      extractAtsJobRefs(
        'https://www.linkedin.com/jobs/view/5550005005/ and https://example.com/jobs/1',
      ),
    ).toEqual([]);
  });

  it('ignores lookalike hosts', () => {
    expect(extractAtsJobRefs('https://jobs.lever.co.evil.example/initech/abc')).toEqual([]);
  });

  it('keeps a board link that carries no job id out of the results', () => {
    expect(extractAtsJobRefs('https://jobs.ashbyhq.com/acme')).toEqual([]);
  });

  it('deduplicates repeats and caps the count', () => {
    const url = 'https://job-boards.greenhouse.io/acme/jobs/7';
    expect(extractAtsJobRefs(`${url} and again ${url}`)).toHaveLength(1);
    const many = Array.from(
      { length: 30 },
      (_, i) => `https://job-boards.greenhouse.io/acme/jobs/${i}`,
    ).join(' ');
    expect(extractAtsJobRefs(many)).toHaveLength(20);
    expect(extractAtsJobRefs(many, 5)).toHaveLength(5);
  });

  it('finds references inside quoted HTML mail with escaped ampersands', () => {
    const html =
      '<a href="https://www.brightforge.example/careers/job?gh_jid=5550002002&amp;board=brightforge">job</a>';
    expect(extractAtsJobRefs(html)).toMatchObject([
      { kind: 'ats_greenhouse', org: 'brightforge', externalId: '5550002002' },
    ]);
  });

  describe('Workday posting links (FR-D10)', () => {
    const PAN =
      'https://globexnetworks.wd5.myworkdayjobs.com/globexexternalcareers/job/Santa-Clara-CA/Principal-Product-Manager---AURL---Web-Protection--CDSS-_JR-000001';
    const INITECH =
      'https://initech.wd5.myworkdayjobs.com/Initech_Careers/job/Milpitas-California-US/Product-Manager--AI-Security--Hybrid-_1000001/apply';

    it.each([
      // [link, org (tenant/site), host, requisition id]
      [
        PAN,
        'globexnetworks/globexexternalcareers',
        'globexnetworks.wd5.myworkdayjobs.com',
        'JR-000001',
      ],
      [INITECH, 'initech/Initech_Careers', 'initech.wd5.myworkdayjobs.com', '1000001'],
      [
        'https://initech.wd5.myworkdayjobs.com/Initech_Careers/job/San-Jose-California-US/Senior-PM_1000002-1',
        'initech/Initech_Careers',
        'initech.wd5.myworkdayjobs.com',
        '1000002-1',
      ],
      // A locale prefix before the site, and no location segment.
      [
        'https://vandelay.wd5.myworkdayjobs.com/en-US/VANDELAYExternalCareerSite/job/Senior-Architect_JR1990001',
        'vandelay/VANDELAYExternalCareerSite',
        'vandelay.wd5.myworkdayjobs.com',
        'JR1990001',
      ],
      // Another datacenter, and a deeper trailing segment.
      [
        'https://acme.wd1.myworkdayjobs.com/External/job/Remote-USA/Staff-Engineer_R-12345/apply/autofillWithResume',
        'acme/External',
        'acme.wd1.myworkdayjobs.com',
        'R-12345',
      ],
    ])('reads %s', (link, org, host, externalId) => {
      // The posting's CXS path: `/job/` up to and including the `<title>_<reqId>` segment.
      const path = new URL(link).pathname;
      const externalPath =
        path.slice(path.indexOf('/job/'), path.indexOf(`_${externalId}`)) + `_${externalId}`;
      expect(extractAtsJobRefs(`see ${link}.`)).toEqual([
        { kind: 'ats_workday', org, host, externalPath, externalId, url: link },
      ]);
    });

    // Issue #20: some tenants' public posting pages use /details/ instead of /job/.
    it('reads a /details/ posting link the same as /job/, normalized to /job/ for the CXS fetch', () => {
      const refs = extractAtsJobRefs(
        'see https://initech.wd5.myworkdayjobs.com/Initech_Careers/details/Product-Manager_1000001 today',
      );
      expect(refs).toEqual([
        {
          kind: 'ats_workday',
          org: 'initech/Initech_Careers',
          host: 'initech.wd5.myworkdayjobs.com',
          externalPath: '/job/Product-Manager_1000001',
          externalId: '1000001',
          url: 'https://initech.wd5.myworkdayjobs.com/Initech_Careers/details/Product-Manager_1000001',
        },
      ]);
    });

    it('reads a /details/ link with a location segment the same way /job/ does', () => {
      const refs = extractAtsJobRefs(
        'https://initech.wd5.myworkdayjobs.com/Initech_Careers/details/Milpitas-California-US/Product-Manager_1000001',
      );
      expect(refs[0]).toMatchObject({
        externalPath: '/job/Milpitas-California-US/Product-Manager_1000001',
        externalId: '1000001',
      });
    });

    // Issue #20: myworkdaysite.com puts the datacenter in the host and the tenant in the path,
    // the reverse of myworkdayjobs.com's own <tenant>.<dc>.myworkdayjobs.com.
    it('reads a myworkdaysite.com link, normalized to the canonical myworkdayjobs.com host', () => {
      const refs = extractAtsJobRefs(
        'see https://wd5.myworkdaysite.com/recruiting/initech/Initech_Careers/job/Milpitas-California-US/Product-Manager_1000001 today',
      );
      expect(refs).toEqual([
        {
          kind: 'ats_workday',
          org: 'initech/Initech_Careers',
          host: 'initech.wd5.myworkdayjobs.com',
          externalPath: '/job/Milpitas-California-US/Product-Manager_1000001',
          externalId: '1000001',
          url: 'https://wd5.myworkdaysite.com/recruiting/initech/Initech_Careers/job/Milpitas-California-US/Product-Manager_1000001',
        },
      ]);
    });

    it('carries the posting path so the detail can be fetched without a listing read', () => {
      const [ref] = extractAtsJobRefs(INITECH);
      expect(ref?.externalPath).toBe(
        '/job/Milpitas-California-US/Product-Manager--AI-Security--Hybrid-_1000001',
      );
    });

    it('reads the requisition id as the tail after the LAST underscore, not as digits', () => {
      const [ref] = extractAtsJobRefs(
        'https://acme.wd5.myworkdayjobs.com/Ext_Site/job/US_Remote/Data_Engineer_II_JR-77',
      );
      expect(ref).toMatchObject({ org: 'acme/Ext_Site', externalId: 'JR-77' });
    });

    it('deduplicates a repost of the same requisition (the /apply form and a new slug)', () => {
      const refs = extractAtsJobRefs(
        `${INITECH} and https://initech.wd5.myworkdayjobs.com/Initech_Careers/job/Remote/Renamed-Title_1000001`,
      );
      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatchObject({ externalId: '1000001' });
    });

    it('needs no network: a board root, a search page or a lookalike host is no reference', () => {
      expect(
        extractAtsJobRefs(
          [
            'https://initech.wd5.myworkdayjobs.com/Initech_Careers',
            'https://initech.wd5.myworkdayjobs.com/Initech_Careers/job/Milpitas-California-US',
            'https://initech.wd5.myworkdayjobs.com/Initech_Careers/job/Milpitas/No-Requisition-Here',
            'https://initech.wd5.myworkdayjobs.com.evil.example/Initech_Careers/job/X/Y_123',
            'https://initech.myworkdayjobs.com/Initech_Careers/job/X/Y_123',
            'https://initech.wd5.myworkdayjobs.com/',
          ].join(' '),
        ),
      ).toEqual([]);
    });
  });
});
