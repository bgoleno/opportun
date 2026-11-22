// The companies screen over more network companies than one page, and a board check that polls
// only its own row (https://github.com/bgoleno/opportun/issues/748, gap 5 of qa's survey; shipped
// by #624). GET /discovery/network-companies is paged (200 a page at most) and the screen walks
// the pages; while a board probe is pending it reads just that row (?ids=) every 3 s. Contacts
// at 250 companies come in through a LinkedIn export; one is at QA Slow Board, whose fixture board
// (OPPORTUN_SOURCE_MOCK) the probe finds. Runs in both CI legs.
import { expect, test, type Request } from '@playwright/test';
import { registerUser } from './helpers';
import { storedZip } from './zip';

const OTHERS = 249;
const companyName = (i: number) => `QA Network Co ${String(i).padStart(3, '0')}`;

const CONNECTIONS = [
  '﻿First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  ...Array.from(
    { length: OTHERS },
    (_, k) =>
      `Contact,Number${k + 1},https://www.linkedin.com/in/qa-748-contact-${k + 1},,${companyName(k + 1)},Engineer,01 Jan 2024`,
  ),
  'Erlich,Bachman,https://www.linkedin.com/in/qa-748-erlich,,QA Slow Board,Advisor,01 Jan 2024',
  '',
].join('\r\n');

const networkReads = (reqs: Request[]) =>
  reqs
    .map((r) => new URL(r.url()))
    .filter((u) => u.pathname === '/api/v1/discovery/network-companies');

test('the companies screen lists every network company across pages, and a board check polls only its own row', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await registerUser(page);
  await page.goto('/settings/data');
  await page.getByLabel('LinkedIn export zip').setInputFiles({
    name: 'Basic_LinkedInDataExport_11-21-2026.zip',
    mimeType: 'application/zip',
    buffer: storedZip({ 'Connections.csv': CONNECTIONS }),
  });
  await page.getByRole('button', { name: 'Import LinkedIn export' }).click();
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 60_000 });

  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  await page.goto('/discovery/companies');
  const list = page.getByRole('list', { name: 'Recommended companies' });
  await expect(page.getByRole('status', { name: 'Companies shown' })).toHaveText(
    `${OTHERS + 1} companies`,
  );

  // Every company once, read in pages of 200.
  const names = await list
    .locator(':scope > li')
    .evaluateAll((els) =>
      els.map((e) => document.getElementById(e.getAttribute('aria-labelledby') ?? '')?.textContent),
    );
  expect(names).toHaveLength(OTHERS + 1);
  expect(new Set(names).size).toBe(OTHERS + 1);
  for (let i = 1; i <= OTHERS; i++) expect(names).toContain(companyName(i));
  expect(names).toContain('QA Slow Board');
  const walk = networkReads(requests).filter((u) => !u.searchParams.has('ids'));
  expect(walk.map((u) => u.searchParams.get('offset') ?? '0')).toEqual(
    expect.arrayContaining(['0', '200']),
  );
  expect(walk.every((u) => Number(u.searchParams.get('limit')) <= 200)).toBe(true);

  // A board check: the row shows its result with no reload, and the poll reads only that row. The
  // board answers its probe after 5 s (mockSources SLOW_BOARD_MS), so the check is still pending
  // when its own refetch lands and at least one 3 s poll runs (#809: an instant probe could finish
  // before any poll, and the count below read 0).
  const row = list.locator(':scope > li').filter({ hasText: 'QA Slow Board' });
  const id = await row.getAttribute('data-company-id');
  const clicked = requests.length;
  await row.getByRole('button', { name: 'Check board for QA Slow Board' }).click();
  await expect(
    row.getByRole('link', { name: /^Board for QA Slow Board: .*qaslowboard/ }),
  ).toBeVisible({
    timeout: 30_000,
  });
  const after = networkReads(requests.slice(clicked));
  const polls = after.filter((u) => u.searchParams.has('ids'));
  expect(polls.length).toBeGreaterThan(0);
  expect(polls.every((u) => u.searchParams.get('ids') === id)).toBe(true);
  // The check's own refetch reads the network once (one walk of two pages); the poll never does.
  expect(after.filter((u) => !u.searchParams.has('ids')).length).toBeLessThanOrEqual(2);
});
