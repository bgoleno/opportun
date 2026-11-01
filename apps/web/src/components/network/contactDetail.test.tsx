// https://github.com/bgoleno/opportun/issues/34: a contact's page is main plus the one rail width,
// and its notes wrap at reading width. jsdom does no layout, so these pin the structure and the
// classes; e2e/desktop.spec.ts measures real line lengths in a browser.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { ContactDetail as ContactDetailData } from './api';
import { ContactDetail } from './ContactDetail';

const CONTACT: ContactDetailData = {
  id: 'c-sam',
  name: 'Sam Lee',
  emails: ['sam@hooli.example'],
  linkedinUrl: null,
  currentCompanyId: 'co-hooli',
  currentCompanyName: 'Hooli',
  history: [{ company: 'Initech', title: 'Engineering Manager', from: '2019', to: '2023' }],
  strength: 2,
  notes: 'Met at the platform meetup. Happy to talk about the infrastructure team.',
  source: 'manual',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  referrals: [],
};

describe('ContactDetail', () => {
  it('puts referral asks and history in the one rail width', async () => {
    mockApi({ 'GET /network/c-sam': CONTACT });
    renderWithProviders(<ContactDetail id="c-sam" />, { path: '/network/c-sam' });
    const history = await screen.findByRole('list', { name: 'Company history' });
    expect(history.closest('[data-slot="main-with-rail"]')).not.toBeNull();
  });

  it('wraps the notes at reading width', async () => {
    mockApi({ 'GET /network/c-sam': CONTACT });
    renderWithProviders(<ContactDetail id="c-sam" />, { path: '/network/c-sam' });
    expect(await screen.findByLabelText('Notes')).toHaveClass('max-w-prose');
  });
});
