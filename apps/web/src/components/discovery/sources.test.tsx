import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { parseMcpConfig, sourceKindLabel, workdayConfigFromUrl, type DiscoverySource } from './api';
import { SourcesManager, sourceSummary } from './SourcesManager';

const NOW = Date.now();

function source(over: Partial<DiscoverySource> & { id: string }): DiscoverySource {
  return {
    kind: 'ats_greenhouse',
    config: { org: 'initech' },
    enabled: true,
    scheduleCron: '0 7 * * *',
    roleTargetId: null,
    companyId: null,
    lastRunAt: NOW,
    status: 'ok',
    statusDetail: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const GH = source({ id: 's-gh', config: { org: 'initech', cursor: 'abc' } });
const ALERT = source({
  id: 's-alert',
  kind: 'alert_email',
  config: {},
  scheduleCron: null,
  lastRunAt: null,
  status: 'error',
  statusDetail: 'Gmail is not connected',
});

const VALID_MCP = {
  transport: 'stdio',
  command: '/usr/local/bin/my-jobs-mcp',
  args: ['--stdio'],
  tool: 'search_jobs',
  queryArgs: { q: 'staff engineer' },
  itemsPath: 'results',
  mapping: { company: 'company.name', title: 'title' },
};

const VALID_HTTP_MCP = {
  transport: 'http',
  url: 'https://example.com/mcp',
  tool: 'search_jobs',
  queryArgs: { q: 'staff engineer' },
  itemsPath: 'results',
  mapping: { company: 'company.name', title: 'title' },
};

const base = {
  'GET /discovery/sources': { items: [GH, ALERT], total: 2 },
  'GET /role-targets': { items: [], total: 0 },
};

describe('parseMcpConfig', () => {
  it('accepts a stdio config and rejects bad ones with readable issues', () => {
    expect(parseMcpConfig(JSON.stringify(VALID_MCP)).ok).toBe(true);
    const notJson = parseMcpConfig('{oops');
    expect(notJson.ok).toBe(false);
    expect(parseMcpConfig(JSON.stringify(VALID_HTTP_MCP)).ok).toBe(true);
    const http = parseMcpConfig(
      JSON.stringify({ ...VALID_HTTP_MCP, url: 'http://example.com/mcp' }),
    );
    expect(http).toEqual({
      ok: false,
      issues: expect.arrayContaining(['url: MCP server URL must be https']),
    });
    const noMapping = parseMcpConfig(JSON.stringify({ ...VALID_MCP, mapping: { title: 't' } }));
    expect(noMapping.ok).toBe(false);
  });

  it('matches the server schema: required keys, strict per transport, dot paths', () => {
    // The server requires args, queryArgs and itemsPath (itemsPath may be empty).
    for (const key of ['args', 'queryArgs', 'itemsPath']) {
      const rest = Object.fromEntries(Object.entries(VALID_MCP).filter(([k]) => k !== key));
      expect(parseMcpConfig(JSON.stringify(rest)).ok, key).toBe(false);
    }
    expect(parseMcpConfig(JSON.stringify({ ...VALID_MCP, itemsPath: '' })).ok).toBe(true);
    // http takes no command or args; stdio takes no url.
    const withCommand = { ...VALID_HTTP_MCP, command: 'x' };
    expect(parseMcpConfig(JSON.stringify(withCommand)).ok).toBe(false);
    expect(parseMcpConfig(JSON.stringify({ ...VALID_MCP, url: 'https://x.example' })).ok).toBe(
      false,
    );
    // Mapping values and itemsPath are dot paths; an empty optional mapping path is refused.
    const badPath = { ...VALID_MCP, mapping: { ...VALID_MCP.mapping, location: '' } };
    expect(parseMcpConfig(JSON.stringify(badPath))).toEqual({
      ok: false,
      issues: ['mapping.location: not a dot path'],
    });
    expect(parseMcpConfig(JSON.stringify({ ...VALID_MCP, itemsPath: 'a b' })).ok).toBe(false);
    expect(parseMcpConfig(JSON.stringify({ ...VALID_MCP, command: 'x'.repeat(501) })).ok).toBe(
      false,
    );
  });
});

describe('SourcesManager', () => {
  it('lists sources with status, last run and schedule; alert email is display only', async () => {
    mockApi(base);
    renderWithProviders(<SourcesManager />);
    const table = await screen.findByRole('table', { name: 'Discovery sources' });
    expect(within(table).getByText('initech')).toBeInTheDocument();
    expect(within(table).getByText('On schedule: 0 7 * * *')).toBeInTheDocument();
    expect(within(table).getByText('Gmail is not connected')).toBeInTheDocument();
    expect(within(table).getByText('Never')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Greenhouse initech' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit Job alert email/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /^Run history for Job alert email/ }),
    ).toBeInTheDocument();
  });

  it('validates the ATS slug before sending, then creates with the org config', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...base,
      'POST /discovery/sources': () => ({ status: 201, body: source({ id: 's-new' }) }),
    });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: 'New source' }));
    const dialog = await screen.findByRole('dialog', { name: 'New source' });
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'ats_lever');
    await user.type(within(dialog).getByLabelText('Board slug'), 'Bad Slug!');
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    expect(within(dialog).getByText(/Use the board slug/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.clear(within(dialog).getByLabelText('Board slug'));
    await user.type(within(dialog).getByLabelText('Board slug'), 'acme-co');
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toEqual({
        kind: 'ats_lever',
        config: { org: 'acme-co' },
        enabled: true,
        scheduleCron: null,
        roleTargetId: null,
      });
    });
  });

  it('Workday form: takes the career site URL and sends {host, tenant, site}', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...base,
      'POST /discovery/sources': () => ({ status: 201, body: source({ id: 's-wd' }) }),
    });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: 'New source' }));
    const dialog = await screen.findByRole('dialog', { name: 'New source' });
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'ats_workday');
    const field = within(dialog).getByLabelText('Career site URL');
    await user.type(field, 'https://initech.myworkdayjobs.com/Initech_Careers');
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    expect(within(dialog).getByText(/myworkdayjobs\.com/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.clear(field);
    await user.type(
      field,
      'https://initech.wd5.myworkdayjobs.com/en-US/Initech_Careers/job/Milpitas-California-US/PM_1000001/apply',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toEqual({
        kind: 'ats_workday',
        config: {
          host: 'initech.wd5.myworkdayjobs.com',
          tenant: 'initech',
          site: 'Initech_Careers',
        },
        enabled: true,
        scheduleCron: null,
        roleTargetId: null,
      });
    });
  });

  it('MCP form: shows the trust note and zod feedback, and sends the parsed config', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...base,
      'POST /discovery/sources': () => ({
        status: 201,
        body: source({ id: 's-mcp', kind: 'mcp', config: VALID_MCP }),
      }),
    });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: 'New source' }));
    const dialog = await screen.findByRole('dialog', { name: 'New source' });
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'mcp');
    expect(within(dialog).getByRole('note')).toHaveTextContent(
      /You supply this MCP command and you are trusting it/,
    );
    const area = within(dialog).getByLabelText('MCP config (JSON)');
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    // The empty template fails: no command, no tool, no mapping paths.
    const issues = within(dialog).getByRole('alert');
    expect(issues).toHaveTextContent('command: stdio needs a command');
    expect(area).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.clear(area);
    await user.click(area);
    await user.paste(JSON.stringify(VALID_MCP));
    expect(within(dialog).getByRole('status')).toHaveTextContent('Config looks valid.');
    await user.click(within(dialog).getByRole('button', { name: 'Add source' }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toMatchObject({ kind: 'mcp', config: VALID_MCP });
    });
  });

  it('editing never sends the stored cursor back, and omits unchanged config', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...base,
      'PATCH /discovery/sources/s-gh': { ...GH, scheduleCron: null },
    });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('button', { name: 'Edit Greenhouse initech' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit source' });
    expect(within(dialog).getByLabelText('Board slug')).toHaveValue('initech');
    await user.clear(within(dialog).getByLabelText('Schedule (cron, optional)'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.body).toEqual({ enabled: true, scheduleCron: null, roleTargetId: null });
    });
  });

  it('enable toggle patches enabled; run now enqueues; history lists runs', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...base,
      'PATCH /discovery/sources/s-gh': { ...GH, enabled: false },
      'POST /discovery/sources/s-gh/run': () => ({ status: 202, body: { jobId: 'j-1' } }),
      'GET /discovery/sources/s-gh/runs': {
        items: [
          {
            id: 'run-2',
            sourceId: 's-gh',
            roleTargetId: null,
            startedAt: NOW,
            finishedAt: NOW + 1000,
            stats: { fetched: 12, inserted: 3 },
            error: null,
          },
          {
            id: 'run-1',
            sourceId: 's-gh',
            roleTargetId: null,
            startedAt: NOW - 86_400_000,
            finishedAt: NOW - 86_000_000,
            stats: null,
            error: 'board returned 503 <script>x</script>',
          },
        ],
        total: 2,
      },
    });
    renderWithProviders(<SourcesManager />);
    await user.click(await screen.findByRole('checkbox', { name: 'Greenhouse initech enabled' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false }),
    );

    await user.click(screen.getByRole('button', { name: 'Run Greenhouse initech now' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/discovery/sources/s-gh/run'),
      ).toBe(true),
    );
    expect(await screen.findByText('Run queued')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Run history for Greenhouse initech' }));
    const drawer = await screen.findByRole('dialog', { name: 'Run history' });
    expect(await within(drawer).findByText('fetched: 12, inserted: 3')).toBeInTheDocument();
    expect(within(drawer).getByText('board returned 503 <script>x</script>')).toBeInTheDocument();
    expect(drawer.querySelector('script')).toBeNull();
    const runsCall = calls.find((c) => c.path === '/discovery/sources/s-gh/runs');
    expect(new URLSearchParams(runsCall?.search).get('sort')).toBe('-startedAt');
  });
  it('run now is offered only for runnable kinds, and a 422 source_not_runnable reads clearly', async () => {
    const user = userEvent.setup();
    mockApi({
      ...base,
      'POST /discovery/sources/s-gh/run': () => ({
        status: 422,
        body: { error: { code: 'source_not_runnable' } },
      }),
    });
    renderWithProviders(<SourcesManager />);
    const alertName = 'Job alert email Job alert digests from the configured sender list';
    expect(
      await screen.findByRole('button', { name: `Run history for ${alertName}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Run ${alertName} now` })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Run Greenhouse initech now' }));
    expect(await screen.findByText('Run not started')).toBeInTheDocument();
    expect(
      screen.getByText('This source cannot be run on demand: its postings arrive on their own.'),
    ).toBeInTheDocument();
  });
});

describe('Workday sources', () => {
  it('labels the kind and summarizes the board as tenant/site on its host', () => {
    expect(sourceKindLabel('ats_workday')).toBe('Workday');
    expect(
      sourceSummary(
        source({
          id: 's-wd',
          kind: 'ats_workday',
          config: {
            host: 'initech.wd5.myworkdayjobs.com',
            tenant: 'initech',
            site: 'Initech_Careers',
          },
        }),
      ),
    ).toBe('initech/Initech_Careers (initech.wd5.myworkdayjobs.com)');
  });

  it('reads a board from a site URL, keeping the datacenter from the host', () => {
    expect(workdayConfigFromUrl('https://acme.wd12.myworkdayjobs.com/External')).toEqual({
      host: 'acme.wd12.myworkdayjobs.com',
      tenant: 'acme',
      site: 'External',
    });
    for (const bad of [
      'https://acme.wd12.myworkdayjobs.com/',
      'https://acme.myworkdayjobs.com/External',
      'https://acme.wd12.myworkdayjobs.com.evil.example/External',
      'not a url',
    ]) {
      expect(workdayConfigFromUrl(bad)).toBeNull();
    }
  });
});
