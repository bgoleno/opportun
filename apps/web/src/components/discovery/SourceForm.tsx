// Create or edit a discovery source. The fields depend on the kind: an ATS board takes its org
// slug (a Workday board its career site URL, FR-D10); an MCP source takes a JSON config (transport and command or URL, tool, mapping) checked
// against a zod schema as you type. Schedule and role target are shared.
import type { DiscoverySourceKind } from '@opportun/core';
import { ShieldAlert } from 'lucide-react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useRoleTargets } from '@/routes/settings/-api';
import {
  AtsConfigSchema,
  CREATABLE_KINDS,
  isAtsKind,
  parseMcpConfig,
  sourceKindLabel,
  workdayConfigFromUrl,
  type DiscoverySource,
  type SourceInput,
} from './api';

const CURSOR_KEY = 'cursor';

/** The engine keeps an adapter's paging cursor inside config; the form never shows or sends it. */
export function editableConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([k]) => k !== CURSOR_KEY));
}

export const MCP_TEMPLATE = JSON.stringify(
  {
    transport: 'stdio',
    command: '',
    args: [],
    tool: '',
    queryArgs: {},
    itemsPath: '',
    mapping: { company: '', title: '' },
  },
  null,
  2,
);

const ATS_HINTS = new Map<string, string>([
  ['ats_greenhouse', 'The slug in boards.greenhouse.io/<slug>.'],
  ['ats_lever', 'The slug in jobs.lever.co/<slug>.'],
  ['ats_ashby', 'The slug in jobs.ashbyhq.com/<slug>.'],
]);

export function SourceForm(props: {
  /** Absent: create. */
  source?: DiscoverySource;
  busy: boolean;
  serverError: string | null;
  onSubmit: (input: SourceInput) => void;
  onCancel: () => void;
}) {
  const editing = props.source;
  const initialConfig = editing === undefined ? {} : editableConfig(editing.config);
  const [kind, setKind] = useState<DiscoverySourceKind>(editing?.kind ?? 'ats_greenhouse');
  const [org, setOrg] = useState(typeof initialConfig.org === 'string' ? initialConfig.org : '');
  const [siteUrl, setSiteUrl] = useState(
    typeof initialConfig.host === 'string' && typeof initialConfig.site === 'string'
      ? `https://${initialConfig.host}/${initialConfig.site}`
      : '',
  );
  const [mcpText, setMcpText] = useState(
    editing?.kind === 'mcp' ? JSON.stringify(initialConfig, null, 2) : MCP_TEMPLATE,
  );
  const [cron, setCron] = useState(editing?.scheduleCron ?? '');
  const [roleTargetId, setRoleTargetId] = useState(editing?.roleTargetId ?? '');
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [submitted, setSubmitted] = useState(false);
  const roleTargets = useRoleTargets();
  const noteId = useId();
  const issuesId = useId();

  const atsCheck = useMemo(() => AtsConfigSchema.safeParse({ org }), [org]);
  const mcpCheck = useMemo(() => parseMcpConfig(mcpText), [mcpText]);
  const atsError = atsCheck.success ? undefined : atsCheck.error.issues[0]?.message;
  const workday = useMemo(() => workdayConfigFromUrl(siteUrl), [siteUrl]);
  const workdayError =
    workday === null
      ? 'Paste the career site link: https://<company>.<wd1, wd5, ...>.myworkdayjobs.com/<site>'
      : undefined;
  const cronTrim = cron.trim();
  const cronError = cronTrim.length > 100 ? 'Use at most 100 characters' : undefined;

  function configFor(): Record<string, unknown> | null {
    if (kind === 'ats_workday') return workday === null ? null : { ...workday };
    if (isAtsKind(kind)) return atsCheck.success ? atsCheck.data : null;
    if (kind === 'mcp') return mcpCheck.ok ? mcpCheck.config : null;
    return {};
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitted(true);
    const config = configFor();
    if (config === null || cronError !== undefined) return;
    const shared: SourceInput = {
      enabled,
      scheduleCron: cronTrim === '' ? null : cronTrim,
      roleTargetId: roleTargetId === '' ? null : roleTargetId,
    };
    if (editing === undefined) {
      props.onSubmit({ kind, config, ...shared });
      return;
    }
    // Send config only when it changed: a stored paging cursor stays put otherwise.
    const changed = JSON.stringify(config) !== JSON.stringify(initialConfig);
    props.onSubmit({ ...shared, ...(changed ? { config } : {}) });
  }

  const showMcpIssues = !mcpCheck.ok && (submitted || mcpText !== MCP_TEMPLATE);

  return (
    <form className="grid gap-4" noValidate onSubmit={submit}>
      <FormError message={props.serverError} />
      {editing === undefined ? (
        <FormField label="Kind">
          {(c) => (
            <Select
              {...c}
              value={kind}
              onChange={(e) => {
                const next = CREATABLE_KINDS.find((k) => k === e.currentTarget.value);
                if (next !== undefined) setKind(next);
              }}
            >
              {CREATABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {sourceKindLabel(k)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      ) : (
        <p className="text-sm">
          <span className="text-muted-foreground">Kind: </span>
          {sourceKindLabel(editing.kind)}
        </p>
      )}

      {kind === 'ats_workday' ? (
        <FormField
          label="Career site URL"
          hint="The Workday site or any posting on it; the wd1/wd5 part of the host is kept."
          error={submitted || siteUrl !== '' ? workdayError : undefined}
        >
          {(c) => (
            <Input
              {...c}
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.currentTarget.value)}
            />
          )}
        </FormField>
      ) : isAtsKind(kind) ? (
        <FormField
          label="Board slug"
          hint={ATS_HINTS.get(kind) ?? ''}
          error={submitted || org !== '' ? atsError : undefined}
        >
          {(c) => (
            <Input
              {...c}
              autoComplete="off"
              spellCheck={false}
              value={org}
              onChange={(e) => setOrg(e.currentTarget.value)}
            />
          )}
        </FormField>
      ) : null}

      {kind === 'mcp' ? (
        <div className="grid gap-2">
          <div
            id={noteId}
            role="note"
            className="flex gap-2 rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm text-accent-foreground"
          >
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              You supply this MCP command and you are trusting it. Opportun never suggests or ships
              one: it runs exactly the command you enter here (or calls the https URL), with a
              minimal environment, and treats everything the tool returns as untrusted text.
            </p>
          </div>
          <Label htmlFor={`${noteId}-config`}>MCP config (JSON)</Label>
          <Textarea
            id={`${noteId}-config`}
            className="min-h-64 font-mono text-xs"
            spellCheck={false}
            value={mcpText}
            onChange={(e) => setMcpText(e.currentTarget.value)}
            aria-invalid={showMcpIssues}
            aria-describedby={`${noteId} ${issuesId}`}
          />
          <p className="text-xs text-muted-foreground">
            transport is stdio (command, args) or http (url, https only, no command or args). tool
            is the MCP tool to call with queryArgs. itemsPath is the dot path to the result list
            (empty when the output is the list). mapping gives a dot path per field: company and
            title are required; descriptionMd, postingUrl, location and externalId are optional.
          </p>
          <div id={issuesId}>
            {showMcpIssues && !mcpCheck.ok ? (
              <ul role="alert" className="grid gap-0.5 text-sm text-destructive">
                {mcpCheck.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : mcpCheck.ok ? (
              <p role="status" className="text-sm text-muted-foreground">
                Config looks valid.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Schedule (cron, optional)"
          hint="For example 0 7 * * * runs daily at 07:00. Empty: run now only."
          error={cronError}
        >
          {(c) => (
            <Input
              {...c}
              autoComplete="off"
              spellCheck={false}
              value={cron}
              onChange={(e) => setCron(e.currentTarget.value)}
            />
          )}
        </FormField>
        <FormField label="Role target (optional)">
          {(c) => (
            <Select
              {...c}
              value={roleTargetId}
              onChange={(e) => setRoleTargetId(e.currentTarget.value)}
            >
              <option value="">All role targets</option>
              {(roleTargets.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
          className="size-4 accent-primary"
        />
        Enabled
      </label>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={props.busy}>
          {editing === undefined ? 'Add source' : 'Save changes'}
        </Button>
      </DialogFooter>
    </form>
  );
}
