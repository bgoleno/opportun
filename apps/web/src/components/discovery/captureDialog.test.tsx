import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { DiscoveryResult } from './api';
import { CaptureDialog } from './CaptureDialog';
import { ReviewQueue } from './ReviewQueue';

const NOW = Date.now();
const PASTE_HINT =
  'This site cannot be fetched. Open the posting in your browser and paste the description text instead.';
const MANUAL_HINT =
  'AI extraction is unavailable. Add the posting with New Opportunity (manual entry) instead.';

const CAPTURED = {
  posting: { company: 'Initech', title: 'Staff Platform Engineer', descriptionMd: 'Own it.' },
  resultId: 'r-new',
};

const LEAD: DiscoveryResult = {
  id: 'r-lead',
  runId: 'run-1',
  sourceId: 'src-1',
  sourceKind: 'alert_email',
  roleTargetId: null,
  posting: {
    company: 'Initech',
    title: 'Staff Platform Engineer',
    postingUrl: 'https://careers.initech.example/jobs/42',
  },
  dedupeKey: null,
  aiScore: null,
  aiRationale: null,
  resolution: 'needs_capture',
  resolvedSourceRef: null,
  disposition: 'pending',
  opportunityId: null,
  sourceMailChannel: null,
  sourceMailExternalId: null,
  dismissReason: null,
  dismissNote: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function renderDialog(lead: DiscoveryResult | null = null) {
  const onClose = vi.fn();
  const onManualEntry = vi.fn();
  renderWithProviders(
    <CaptureDialog lead={lead} onClose={onClose} onManualEntry={onManualEntry} />,
  );
  return { onClose, onManualEntry };
}

describe('CaptureDialog', () => {
  it('URL mode posts exactly {url}, toasts and closes', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ 'POST /capture': () => ({ status: 201, body: CAPTURED }) });
    const { onClose } = renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Capture posting' });
    await user.type(
      within(dialog).getByLabelText('Posting link'),
      'https://careers.initech.example/jobs/42',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { url: 'https://careers.initech.example/jobs/42' },
    ]);
    expect(await screen.findByText('Posting captured')).toBeInTheDocument();
  });

  it('text mode posts exactly {text}; an http link is refused before any request', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ 'POST /capture': () => ({ status: 201, body: CAPTURED }) });
    const { onClose } = renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Capture posting' });
    await user.type(within(dialog).getByLabelText('Posting link'), 'http://example.com/job');
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    expect(await within(dialog).findByText('Enter an https link')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.click(within(dialog).getByLabelText('Pasted text'));
    await user.type(
      within(dialog).getByLabelText('Posting description'),
      'Staff Platform Engineer at Initech',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { text: 'Staff Platform Engineer at Initech' },
    ]);
  });

  it('a 422 prohibited host shows the server hint and offers pasting the text', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /capture': () => ({
        status: 422,
        body: { error: { code: 'prohibited_host', hint: PASTE_HINT } },
      }),
    });
    const { onClose } = renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Capture posting' });
    await user.type(
      within(dialog).getByLabelText('Posting link'),
      'https://www.linkedin.com/jobs/view/1/',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    expect(await within(dialog).findByText(PASTE_HINT)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Paste the text instead' }));
    expect(within(dialog).getByLabelText('Posting description')).toBeInTheDocument();
    expect(within(dialog).queryByText(PASTE_HINT)).toBeNull();
  });

  it('a 503 ai_unavailable offers the New Opportunity dialog', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /capture': () => ({
        status: 503,
        body: { error: { code: 'ai_unavailable', reason: 'no_key', hint: MANUAL_HINT } },
      }),
    });
    const { onManualEntry } = renderDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Capture posting' });
    await user.click(within(dialog).getByLabelText('Pasted text'));
    await user.type(within(dialog).getByLabelText('Posting description'), 'Some posting');
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    expect(await within(dialog).findByText(MANUAL_HINT)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'New opportunity' }));
    expect(onManualEntry).toHaveBeenCalled();
  });

  it('renders hostile server and posting text inert', async () => {
    const user = userEvent.setup();
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    mockApi({
      'POST /capture': () => ({
        status: 422,
        body: { error: { code: 'prohibited_host', hint: hostile } },
      }),
    });
    renderDialog({ ...LEAD, posting: { ...LEAD.posting, company: `Evil ${hostile}` } });
    const dialog = await screen.findByRole('dialog', { name: 'Capture description' });
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    expect(await within(dialog).findByText(hostile)).toBeInTheDocument();
    expect(dialog.querySelector('script, img')).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});

describe('ReviewQueue capture', () => {
  it('Capture posting opens the dialog; a 503 falls back to the New Opportunity dialog', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /discovery/results': { items: [], total: 0 },
      'POST /capture': () => ({
        status: 503,
        body: { error: { code: 'ai_unavailable', hint: MANUAL_HINT } },
      }),
    });
    renderWithProviders(<ReviewQueue />);
    await user.click(await screen.findByRole('button', { name: 'Capture posting' }));
    const dialog = await screen.findByRole('dialog', { name: 'Capture posting' });
    await user.type(within(dialog).getByLabelText('Posting link'), 'https://example.com/job/1');
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    await user.click(await within(dialog).findByRole('button', { name: 'New opportunity' }));
    expect(await screen.findByRole('dialog', { name: 'New opportunity' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Capture posting' })).toBeNull();
  });

  it('a needs_capture lead is captured with its link pre-filled and its resultId', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /discovery/results': { items: [LEAD], total: 1 },
      'POST /capture': { posting: CAPTURED.posting, resultId: LEAD.id },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Staff Platform Engineer');
    await user.keyboard('j{Enter}');
    const detail = await screen.findByRole('dialog', { name: 'Staff Platform Engineer' });
    await user.click(within(detail).getByRole('button', { name: 'Capture description' }));
    const dialog = await screen.findByRole('dialog', { name: 'Capture description' });
    expect(within(dialog).getByLabelText('Posting link')).toHaveValue(
      'https://careers.initech.example/jobs/42',
    );
    const queueLoads = calls.filter((c) => c.path === '/discovery/results').length;
    await user.click(within(dialog).getByRole('button', { name: 'Capture' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
        { url: 'https://careers.initech.example/jobs/42', resultId: 'r-lead' },
      ]),
    );
    // The queue is refetched so the completed lead shows its description.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/discovery/results').length).toBeGreaterThan(
        queueLoads,
      ),
    );
    expect(await screen.findByText('Description captured')).toBeInTheDocument();
  });
});
