// A candidate company's industry (https://github.com/bgoleno/opportun/issues/220): the tag shows on
// its row, and the user can correct it. All names are made up.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { CompaniesManager } from './CompaniesManager';
import type { CompanyView, NetworkCompany } from './companiesApi';
import { CompanyIndustry } from './CompanyIndustry';

const company = (over: Partial<CompanyView> = {}): CompanyView => ({
  id: 'c1',
  userId: 'u1',
  name: 'Initech',
  status: 'suggested',
  atsDetectPending: false,
  needsCareersUrl: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const URL = '/companies/c1/industry';

describe('CompanyIndustry (#220)', () => {
  it('shows the title of the tag, and that it is a suggestion to check', async () => {
    mockApi({});
    renderWithProviders(
      <CompanyIndustry company={company({ naicsCode: '5132', industrySource: 'ai' })} />,
    );
    expect(await screen.findByText('Industry: Software Publishers')).toBeInTheDocument();
    expect(screen.queryByText(/set by you/)).toBeNull();
  });

  it('says when the user set it', async () => {
    mockApi({});
    renderWithProviders(
      <CompanyIndustry company={company({ naicsCode: '5132', industrySource: 'user' })} />,
    );
    expect(await screen.findByText(/^Industry: Software Publishers/)).toHaveTextContent(
      '(set by you)',
    );
  });

  it('with none it says not tagged yet, and with one the model could not place it says so', async () => {
    mockApi({});
    const { unmount } = renderWithProviders(<CompanyIndustry company={company()} />);
    expect(await screen.findByText('Industry: not tagged yet')).toBeInTheDocument();
    unmount();
    renderWithProviders(<CompanyIndustry company={company({ industryAt: 1 })} />);
    expect(await screen.findByText('Industry: could not be placed')).toBeInTheDocument();
  });

  it('correcting sends the code chosen, from the whole table, and needs a choice', async () => {
    const { calls } = mockApi({
      [`PUT ${URL}`]: company({ naicsCode: '5415', industrySource: 'user' }),
    });
    const user = userEvent.setup();
    renderWithProviders(
      <CompanyIndustry company={company({ naicsCode: '5132', industrySource: 'ai' })} />,
    );
    await user.click(await screen.findByText('Industry: Software Publishers'));
    const picker = screen.getByLabelText('Industry of Initech') as HTMLSelectElement;
    expect(picker.options).toHaveLength(308); // The 308, less the current one, and the prompt.
    const save = screen.getByRole('button', { name: 'Save industry of Initech' });
    expect(save).toBeDisabled();

    await user.selectOptions(picker, '5415');
    await user.click(save);

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ code: '5415' }),
    );
    expect(calls.find((c) => c.method === 'PUT')?.path).toBe(URL);
  });

  it('a closed row builds no picker, and opening it does, so a long list stays light', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderWithProviders(<CompanyIndustry company={company()} />);
    const summary = await screen.findByText('Industry: not tagged yet');
    expect(document.querySelector('select')).toBeNull();
    await user.click(summary);
    expect(document.querySelectorAll('select')).toHaveLength(1);
    await user.click(summary);
    expect(document.querySelector('select')).toBeNull();
  });

  it.each(['followed', 'denied'] as const)(
    'a %s company with no tag does not promise one: only candidates are tagged',
    async (status) => {
      mockApi({});
      renderWithProviders(<CompanyIndustry company={company({ status })} />);
      expect(await screen.findByText('Industry: not set')).toBeInTheDocument();
      expect(screen.queryByText(/not tagged yet/)).toBeNull();
    },
  );

  it('a followed company that was tagged keeps showing its tag', async () => {
    mockApi({});
    renderWithProviders(
      <CompanyIndustry company={company({ status: 'followed', naicsCode: '5132' })} />,
    );
    expect(await screen.findByText('Industry: Software Publishers')).toBeInTheDocument();
  });

  it('a failed save says so', async () => {
    mockApi({
      [`PUT ${URL}`]: () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });
    const user = userEvent.setup();
    renderWithProviders(<CompanyIndustry company={company()} />);
    await user.click(await screen.findByText('Industry: not tagged yet'));
    await user.selectOptions(screen.getByLabelText('Industry of Initech'), '5415');
    await user.click(screen.getByRole('button', { name: 'Save industry of Initech' }));
    expect(await screen.findByText('Industry not saved')).toBeInTheDocument();
  });

  it('a name with markup labels the control as plain text', async () => {
    mockApi({});
    const user = userEvent.setup();
    renderWithProviders(<CompanyIndustry company={company({ name: '<b>Bold</b>' })} />);
    await user.click(await screen.findByText('Industry: not tagged yet'));
    expect(await screen.findByLabelText('Industry of <b>Bold</b>')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('on the Companies tab (#220)', () => {
  const network = (over: Partial<CompanyView>): NetworkCompany => ({
    company: company({ id: 'n1', name: 'Globex', status: 'none', ...over }),
    board: 'not_checked',
    contactCount: 1,
    strongestStrength: null,
    contacts: [{ id: 'p1', name: 'Sam Contact', strength: null }],
  });

  it('shows on a suggestion and on a company in your network, and not on a followed one', async () => {
    mockApi({
      'GET /companies/suggestions': {
        items: [company({ naicsCode: '5132', industrySource: 'ai' })],
        total: 1,
      },
      'GET /discovery/network-companies': {
        items: [network({ naicsCode: '5415', industrySource: 'ai' })],
      },
      'GET /companies': {
        items: [company({ id: 'f1', name: 'Followed Co', status: 'followed', naicsCode: '2211' })],
        total: 1,
      },
      'GET /discovery/industry-profile': { items: [] },
    });
    renderWithProviders(<CompaniesManager />);
    const suggestions = await screen.findByRole('list', { name: 'Suggested companies' });
    expect(
      await within(suggestions).findByText('Industry: Software Publishers'),
    ).toBeInTheDocument();
    const known = await screen.findByRole('list', { name: 'Companies in your network' });
    expect(
      await within(known).findByText('Industry: Computer Systems Design and Related Services'),
    ).toBeInTheDocument();
    const followed = await screen.findByRole('list', { name: 'Followed companies' });
    await within(followed).findByText('Followed Co');
    expect(within(followed).queryByText(/^Industry:/)).toBeNull();
  });
});
