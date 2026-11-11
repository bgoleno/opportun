// Settings > Profile > Application details (#401): the details a new application starts with
// that have no column of their own, seen and changed outside an application. Every name and
// address here is made up.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { ProfileSettings } from './profile';

const PROFILE = {
  userId: 'u1',
  fullName: 'Jane Doe',
  headline: 'Platform engineer',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'Springfield',
  workAuth: null,
  links: [{ label: 'GitHub', url: 'https://github.com/jane-example' }],
  applicationDetails: { firstName: 'Jane' },
  updatedAt: 1,
};

function setup() {
  let profile = { ...PROFILE };
  const api = mockApi({
    'GET /profile': () => profile,
    'PUT /profile': (c: ApiCall) => {
      profile = { ...profile, ...(c.body as object) };
      return profile;
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<ProfileSettings />);
  return { api, user };
}

const card = async () =>
  (await screen.findByRole('heading', { name: 'Application details' })).closest(
    '[data-slot="card"]',
  ) as HTMLElement;

describe('Settings > Profile > Application details (#401)', () => {
  it('shows the saved details, the ones with no column of their own', async () => {
    setup();
    const c = await card();
    expect(within(c).getByLabelText('First name')).toHaveValue('Jane');
    expect(within(c).getByLabelText('Last name')).toHaveValue('');
    expect(within(c).getByLabelText('LinkedIn profile')).toBeInTheDocument();
    expect(within(c).getByLabelText('Website')).toBeInTheDocument();
    expect(within(c).getByLabelText('Links')).toBeInTheDocument();
    // The columns stay on the profile card above: not repeated here.
    expect(within(c).queryByLabelText('Phone')).toBeNull();
  });

  // #435 (slice 1 of #402).
  it('asks for country, school, degree and how you heard, each written as the list shows it', async () => {
    setup();
    const c = await card();
    for (const [label, hint] of [
      ['Country', /as the form's list shows it, for example United States/],
      ['School', /as the form's list shows it, for example University of/],
      ['Degree', /as the form's list shows it, for example Bachelor's Degree/],
      ['How did you hear about this role?', /as the form's list shows it, for example LinkedIn/],
    ] as const) {
      expect(within(c).getByLabelText(label)).toHaveAccessibleDescription(hint);
    }
    // The city is the profile's own Location column, on the profile card above.
    expect(screen.getByLabelText('Location (city)')).toHaveAccessibleDescription(
      /as the form's list shows it, for example Seattle, Washington/,
    );
    // Its placeholder shows the same wording as its hint (tl on #437).
    expect(screen.getByLabelText('Location (city)')).toHaveAttribute(
      'placeholder',
      'Seattle, Washington, United States',
    );
  });

  it('saves the details with the profile as stored, and only the details change', async () => {
    const { api, user } = setup();
    const c = await card();
    await user.type(within(c).getByLabelText('Last name'), 'Doe');
    await user.type(
      within(c).getByLabelText('LinkedIn profile'),
      'https://www.linkedin.com/in/jane-example',
    );
    await user.click(within(c).getByRole('button', { name: 'Save application details' }));
    await waitFor(() =>
      expect(api.calls.filter((x) => x.method === 'PUT' && x.path === '/profile')).toHaveLength(1),
    );
    const put = api.calls.find((x) => x.method === 'PUT' && x.path === '/profile');
    expect(put?.body).toEqual({
      fullName: 'Jane Doe',
      headline: 'Platform engineer',
      email: 'jane@example.com',
      phone: '+1 555 0100',
      location: 'Springfield',
      workAuth: null,
      links: [{ label: 'GitHub', url: 'https://github.com/jane-example' }],
      applicationDetails: {
        firstName: 'Jane',
        lastName: 'Doe',
        linkedinUrl: 'https://www.linkedin.com/in/jane-example',
      },
    });
    expect(await screen.findByText('Application details saved')).toBeInTheDocument();
  });

  it('says what is wrong with a value before sending anything', async () => {
    const { api, user } = setup();
    const c = await card();
    await user.type(within(c).getByLabelText('Website'), 'jane.example');
    await user.click(within(c).getByRole('button', { name: 'Save application details' }));
    expect(
      await within(c).findByText(
        'Enter the whole web address, starting with https:// (or http://).',
      ),
    ).toBeInTheDocument();
    expect(api.calls.filter((x) => x.method === 'PUT')).toHaveLength(0);
  });

  it('a cleared detail is removed', async () => {
    const { api, user } = setup();
    const c = await card();
    await user.clear(within(c).getByLabelText('First name'));
    await user.click(within(c).getByRole('button', { name: 'Save application details' }));
    await waitFor(() => expect(api.calls.filter((x) => x.method === 'PUT')).toHaveLength(1));
    expect(
      (api.calls.find((x) => x.method === 'PUT')?.body as { applicationDetails: object })
        .applicationDetails,
    ).toEqual({});
  });

  it("the profile card's own save leaves the details out, so the server keeps them", async () => {
    const { api, user } = setup();
    await screen.findByRole('heading', { name: 'Application details' });
    const name = screen.getAllByLabelText('Full name')[0]!;
    await user.clear(name);
    await user.type(name, 'Jane Q. Doe');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.calls.filter((x) => x.method === 'PUT')).toHaveLength(1));
    expect(api.calls.find((x) => x.method === 'PUT')?.body).not.toHaveProperty(
      'applicationDetails',
    );
  });
});
