// Invented job pages for the capture workflow (discoveryCapture.spec.ts): what the extension reads
// in a LinkedIn and an Indeed tab. Placeholder companies and text only, no tracking, no account
// text; the spec answers every request to the two sites with these, so neither is ever reached.
// Their shapes are those of packages/extension/test/fixtures (pages.ts, indeedPages.ts).

export type Site = 'linkedin' | 'indeed';

export interface MockPosting {
  site: Site;
  id: string;
  title: string;
  company: string;
  /** The job's own text, the description a capture has to bring. */
  description: string;
}

/** The address an alert card carries, in the two alert parsers' own form. */
export const postingAddress = (p: Pick<MockPosting, 'site' | 'id'>): string =>
  p.site === 'linkedin'
    ? `https://www.linkedin.com/jobs/view/${p.id}/`
    : `https://www.indeed.com/viewjob?jk=${p.id}`;

const escape = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function linkedInPage(p: MockPosting): string {
  const text = [
    p.company,
    p.title,
    'Springfield, ST · 2 days ago · 37 applicants',
    'Hybrid',
    'Full-time',
    'Easy Apply',
    'Save',
    '',
    'About the job',
    p.description,
    '',
    'About the company',
    p.company,
  ].join('\n');
  return `<!doctype html><html><head><title>${escape(`${p.title} | ${p.company} | LinkedIn`)}</title></head>
<body><main style="white-space: pre-wrap">${escape(text)}</main></body></html>`;
}

function indeedPage(p: MockPosting): string {
  return `<!doctype html><html><head><title>${escape(p.title)} - Indeed.com</title></head><body>
<div data-testid="viewjob-main-content">
  <div data-testid="company-info-title-row"><h5 data-testid="vj-job-title" role="heading">${escape(p.title)}</h5></div>
  <div data-testid="company-info-metadata"><a role="link">${escape(p.company)}</a><div>·</div><div>Springfield, ST</div></div>
  <div data-testid="viewjob-job-content"><div>
    <h4 data-testid="vj-job-description-heading" role="heading">Full job description</h4>
    <div>${escape(p.description).replaceAll('\n', '<br>')}</div>
  </div></div>
</div></body></html>`;
}

export const postingPage = (p: MockPosting): string =>
  p.site === 'linkedin' ? linkedInPage(p) : indeedPage(p);

export interface AlertCard {
  posting: MockPosting;
  location: string | null;
}

/** One alert email of `site`, in its digest's plain-text shape, as a mail batch message. */
export function alertMail(site: Site, cards: readonly AlertCard[], n: string) {
  const body =
    site === 'linkedin'
      ? `Your job alert for anything in Springfield\n${cards.length} new jobs match your preferences.\n\n${cards
          .map(({ posting: p, location }) =>
            [
              p.title,
              p.company,
              ...(location === null ? [] : [location]),
              `View job: https://www.linkedin.com/comm/jobs/view/${p.id}/?trackingId=a&refId=b`,
            ].join('\n'),
          )
          .join('\n\n---------------------------------------------------------\n\n')}\n`
      : `Jobs 1-${cards.length} of ${cards.length} new jobs\n\n${cards
          .map(({ posting: p, location }) =>
            [
              p.title,
              location === null ? p.company : `${p.company} - ${location}`,
              'Easily apply',
              `https://www.indeed.com/rc/clk/dl?jk=${p.id}&from=ja&qd=a&rd=1`,
            ].join('\n'),
          )
          .join('\n\n')}\n`;
  return {
    externalId: `apple-mail:${n}@example.com`,
    threadKey: n,
    from: site === 'linkedin' ? 'jobalerts-noreply@linkedin.com' : 'alert@indeed.com',
    to: ['jane@example.com'],
    subject: 'New jobs',
    snippet: 'New jobs',
    bodyText: body,
    sentAt: Date.now() - 1000,
  };
}
