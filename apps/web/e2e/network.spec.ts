// Network flow (FR-C2, C3, C4) against the real server: a synthetic LinkedIn data export becomes
// contacts, the AI mock ranks referral candidates, and an ask lands on the timeline.
import { expect, test } from '@playwright/test';
import { card, createOpportunity, registerUser, toasts } from './helpers';
import { storedZip } from './zip';

// Synthetic export files (every person, company and URL is made up), in LinkedIn's layout: a
// BOM, a notes preamble before the Connections header, and CRLF line endings.
const CONNECTIONS = [
  '﻿Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Jane,Doe,https://www.linkedin.com/in/jane-doe-synthetic-0a1b,jane.doe@initech.example,Initech,"Director, Platform Engineering",12 Mar 2024',
  'Bob,Porter,https://www.linkedin.com/in/bob-porter-synthetic-1c2d,,Initech,Engineering Manager,03 Jan 2023',
  'Ana,Ruiz,https://www.linkedin.com/in/ana-ruiz-synthetic-6a7b,ana.ruiz@globex.example,Globex,Product Lead,09 Sep 2021',
  '',
].join('\r\n');

const MESSAGES = [
  '﻿CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER',
  '2-ZTJlLWNvbnZvLTE=,,Jane Doe,https://www.linkedin.com/in/jane-doe-synthetic-0a1b,Alex Tester,https://www.linkedin.com/in/alex-tester-synthetic-9z9z,2026-09-14 16:02:11 UTC,,"Hi Alex, Initech is hiring. Happy to refer you.",INBOX',
  '',
].join('\r\n');

test('network: import a LinkedIn export, rank referrers, ask one, and see it on the timeline', async ({
  page,
}) => {
  await registerUser(page);

  await page.goto('/settings/data');
  await page.getByLabel('LinkedIn export zip').setInputFiles({
    name: 'Basic_LinkedInDataExport_10-16-2026.zip',
    mimeType: 'application/zip',
    buffer: storedZip({ 'Connections.csv': CONNECTIONS, 'messages.csv': MESSAGES }),
  });
  await page.getByRole('button', { name: 'Import LinkedIn export' }).click();
  await expect(page.getByText('Import finished')).toBeVisible({ timeout: 30_000 });

  await page.goto('/contacts');
  const contacts = page.getByRole('table', { name: 'Contacts' });
  for (const name of ['Jane Doe', 'Bob Porter', 'Ana Ruiz']) {
    await expect(contacts).toContainText(name);
  }
  await expect(contacts).toContainText('Initech');

  const opp = { company: 'Initech', title: 'Staff Platform Engineer' };
  await createOpportunity(page, opp);
  await card(page, opp.company, opp.title).getByRole('link', { name: opp.title }).click();
  await page.getByRole('tab', { name: 'Referrals' }).click();

  // Both Initech contacts are candidates, ranked by the AI mock; the Globex contact is not.
  const candidates = page.getByRole('list', { name: 'Referral candidates' }).getByRole('listitem');
  await expect(candidates).toHaveCount(2);
  await expect(candidates.nth(0)).toContainText('#1');
  await expect(candidates.nth(1)).toContainText('#2');
  await expect(candidates.filter({ hasText: 'Jane Doe' })).toContainText('Mock answer.');
  await expect(page.getByRole('list', { name: 'Referral candidates' })).not.toContainText(
    'Ana Ruiz',
  );

  await page.getByRole('button', { name: 'Ask Jane Doe for a referral' }).click();
  await expect(toasts(page).getByText('Referral ask recorded')).toBeVisible();
  const asks = page.getByRole('list', { name: 'Referral asks' });
  await expect(asks).toContainText('Jane Doe');
  await expect(asks.getByRole('button', { name: 'Asked' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByRole('list', { name: 'Timeline' })).toContainText(
    'Referral ask: Jane Doe',
  );
});
