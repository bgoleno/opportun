import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RoleTarget } from '@opportun/core';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { RoleTargetForm, type RoleTargetPayload } from './-roleTargetForm';
import { RoleTargetsSettings } from './role-targets';

const TARGET: RoleTarget = {
  id: 't1',
  userId: 'u1',
  name: 'Staff Platform Engineer',
  titleFamily: 'Platform Engineering',
  seniorityMin: null,
  seniorityMax: null,
  industries: [],
  keywords: [],
  titleVariants: [],
  locations: [],
  remotePref: 'any',
  compMin: null,
  compMax: null,
  currency: null,
  active: true,
  discoveryPromptId: null,
  createdAt: 0,
  updatedAt: 0,
};

describe('RoleTargetsSettings delete (issue #74)', () => {
  it('deletes only after confirmation, and closes the dialog once the server has actually removed it', async () => {
    const user = userEvent.setup();
    let items = [TARGET];
    mockApi({
      'GET /role-targets': () => ({ items, total: items.length }),
      'DELETE /role-targets/t1': () => {
        items = [];
        return { status: 204 };
      },
    });
    renderWithProviders(<RoleTargetsSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete Staff Platform Engineer' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this role target?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await screen.findByText(/No role targets yet\./);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows the error when the delete fails, instead of closing as if it had succeeded', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /role-targets': { items: [TARGET], total: 1 },
      'DELETE /role-targets/t1': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });
    renderWithProviders(<RoleTargetsSettings />);

    await user.click(await screen.findByRole('button', { name: 'Delete Staff Platform Engineer' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this role target?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    // The inline alert ConfirmDialog itself now renders on a rejection (#84), not just the toast.
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/server_error/);
    expect(await screen.findByText('Role target not deleted')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Delete this role target?' })).toBeInTheDocument();
    expect(screen.getByText('Staff Platform Engineer')).toBeInTheDocument();
  });
});

describe('RoleTargetsSettings icon buttons (issue #138)', () => {
  it('carries the accessible name through to the rendered link, not just the wrapping button', async () => {
    mockApi({ 'GET /role-targets': { items: [TARGET], total: 1 } });
    renderWithProviders(<RoleTargetsSettings />);
    // IconButton's asChild path chains two Radix Slot merges (TooltipTrigger onto Button,
    // Button onto Link); this pins that the label still lands on the <a> at the end of it.
    const link = await screen.findByRole('link', {
      name: 'Edit discovery prompt for Staff Platform Engineer',
    });
    expect(link).toHaveAttribute('href', expect.stringContaining('/discovery/prompts'));
  });

  it('shows the edit and delete icon tooltips on hover, matching their aria-labels', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /role-targets': { items: [TARGET], total: 1 } });
    renderWithProviders(<RoleTargetsSettings />);
    const edit = await screen.findByRole('button', { name: 'Edit Staff Platform Engineer' });
    await user.hover(edit);
    expect(await screen.findByText('Edit Staff Platform Engineer')).toBeInTheDocument();
  });
});

const BASE_PAYLOAD: RoleTargetPayload = {
  name: TARGET.name,
  titleFamily: TARGET.titleFamily,
  seniorityMin: null,
  seniorityMax: null,
  industries: [],
  keywords: [],
  locations: [],
  remotePref: 'any',
  compMin: null,
  compMax: null,
  currency: null,
  active: true,
};

describe('RoleTargetsSettings title variants (#217)', () => {
  const VARIANTS = ['Platform Engineer', 'Engineer, Platform'];
  const EDIT = 'Edit Staff Platform Engineer';
  const SAVE = 'Save changes';

  function setup() {
    const api = mockApi({
      'GET /role-targets': { items: [{ ...TARGET, titleVariants: VARIANTS }], total: 1 },
      'PATCH /role-targets/t1': (call: ApiCall) => ({
        status: 200,
        body: { ...TARGET, ...(call.body as object) },
      }),
    });
    renderWithProviders(<RoleTargetsSettings />);
    return { api, user: userEvent.setup() };
  }
  const patchBody = (calls: ApiCall[]) =>
    calls.find((c) => c.method === 'PATCH' && c.path === '/role-targets/t1')?.body as Record<
      string,
      unknown
    >;

  it('shows the list one title per line, commas and all', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('button', { name: EDIT }));
    expect(await screen.findByLabelText(/Title variants/)).toHaveValue(
      'Platform Engineer\nEngineer, Platform',
    );
  });

  it('a save that leaves the list alone does not send it, so a new name gets a new list', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: EDIT }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(patchBody(api.calls)).toBeDefined());
    expect(patchBody(api.calls)).toMatchObject({ name: 'Renamed' });
    expect(patchBody(api.calls)).not.toHaveProperty('titleVariants');
  });

  it('an edited list is sent, one entry per line, blank lines dropped', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: EDIT }));
    const box = await screen.findByLabelText(/Title variants/);
    await user.clear(box);
    await user.type(box, 'Build Engineer{enter}{enter}  Tooling Engineer  ');
    await user.click(screen.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(patchBody(api.calls)).toBeDefined());
    expect(patchBody(api.calls).titleVariants).toEqual(['Build Engineer', 'Tooling Engineer']);
  });

  it('Edit shows a list made after the page loaded (the AI answers in the background)', async () => {
    const user = userEvent.setup();
    let titleVariants: string[] = [];
    mockApi({ 'GET /role-targets': () => ({ items: [{ ...TARGET, titleVariants }], total: 1 }) });
    renderWithProviders(<RoleTargetsSettings />);
    await screen.findByText('Staff Platform Engineer');
    titleVariants = ['Site Reliability Engineer', 'Infrastructure Engineer'];
    await user.click(screen.getByRole('button', { name: 'Edit Staff Platform Engineer' }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Title variants/)).toHaveValue(
        'Site Reliability Engineer\nInfrastructure Engineer',
      ),
    );
  });

  it('a list that arrived while the form was open is shown, and is not sent as the user’s', async () => {
    const user = userEvent.setup();
    let titleVariants: string[] = [];
    const api = mockApi({
      'GET /role-targets': () => ({ items: [{ ...TARGET, titleVariants }], total: 1 }),
      'PATCH /role-targets/t1': (call: ApiCall) => ({
        status: 200,
        body: { ...TARGET, ...(call.body as object) },
      }),
    });
    renderWithProviders(<RoleTargetsSettings />);
    await screen.findByText('Staff Platform Engineer');
    titleVariants = ['From The AI'];
    await user.click(screen.getByRole('button', { name: EDIT }));
    await waitFor(() => expect(screen.getByLabelText(/Title variants/)).toHaveValue('From The AI'));
    await user.click(screen.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(patchBody(api.calls)).toBeDefined());
    expect(patchBody(api.calls)).not.toHaveProperty('titleVariants');
  });

  it('what the user typed stays when a list arrives', async () => {
    const user = userEvent.setup();
    const form = (titleVariants: string[]) => (
      <RoleTargetForm
        initial={{ ...BASE_PAYLOAD, titleVariants }}
        submitLabel="Save"
        onSubmit={() => undefined}
      />
    );
    const { rerender } = render(form([]));
    const box = screen.getByLabelText(/Title variants/);
    await user.type(box, 'My Own Title');
    rerender(form(['From The AI']));
    expect(box).toHaveValue('My Own Title');
  });

  it('clearing the list sends it empty, so it stays cleared', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: EDIT }));
    await user.clear(await screen.findByLabelText(/Title variants/));
    await user.click(screen.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(patchBody(api.calls)).toBeDefined());
    expect(patchBody(api.calls)).toMatchObject({ titleVariants: [] });
  });

  it('refuses more than 40 titles, saying so', async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole('button', { name: EDIT }));
    const box = await screen.findByLabelText(/Title variants/);
    fireEvent.change(box, {
      target: { value: Array.from({ length: 41 }, (_, i) => `Title ${i}`).join('\n') },
    });
    await user.click(screen.getByRole('button', { name: SAVE }));
    expect(await screen.findByText('Keep the list to 40 titles or fewer')).toBeInTheDocument();
    expect(patchBody(api.calls)).toBeUndefined();
  });
});
