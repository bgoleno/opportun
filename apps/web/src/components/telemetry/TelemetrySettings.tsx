// Settings > Telemetry (design.md 14.1, 14.10; https://github.com/bgoleno/opportun/issues/342).
//
// Two instance-wide switches. Collect records this instance's own metrics and traces locally;
// Export sends them, less what identifies a user, to one destination an admin names. Every user
// sees whether each is on, and export's type and signals, because export covers everyone's
// telemetry; only an admin sees where it goes and can change it. Saving a destination, and
// sending a test, re-ask for the admin's own password (a stolen session cookie alone is not
// enough), and a stored credential is never shown again.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { relativeTime } from '@/routes/settings/-devices';
import { PasswordDialog, passwordError } from '@/routes/settings/-twoFactor';

type ExportType = 'otlp' | 'datadog' | 'prometheus' | 'influxdb';
type Signal = 'metrics' | 'spans' | 'logs';

export interface Destination {
  type: ExportType;
  scheme: 'http' | 'https';
  host: string;
  port: number;
  basePath?: string;
  org?: string;
  bucket?: string;
  headerName?: string;
}

export interface ExportView {
  enabled: boolean;
  type: ExportType | null;
  signals: Signal[];
  admin?: {
    destination: Destination | null;
    hasCredential: boolean;
    allowPrivate: boolean;
    lastSuccessAt: number | null;
    lastFailure: { outcome: string; at: number } | null;
    dropped: { signal: string; reason: string; count: number }[];
  };
}

const settingsQuery = {
  queryKey: ['obs', 'settings'] as const,
  queryFn: () => api<{ collect: boolean }>('/obs/settings'),
};
const exportQuery = {
  queryKey: ['obs', 'export'] as const,
  queryFn: () => api<ExportView>('/obs/export'),
};

// Maps, so a lookup by a value from the server or the form is a plain get.
const TYPES: readonly ExportType[] = ['otlp', 'datadog', 'prometheus', 'influxdb'];
const TYPE_LABELS = new Map<ExportType, string>([
  ['otlp', 'OTLP'],
  ['datadog', 'Datadog Agent'],
  ['prometheus', 'Prometheus'],
  ['influxdb', 'InfluxDB'],
]);
const DEFAULT_PORTS = new Map<ExportType, number>([
  ['otlp', 4318],
  ['datadog', 4318],
  ['prometheus', 9090],
  ['influxdb', 8086],
]);
const SIGNAL_LABELS = new Map<Signal, string>([
  ['metrics', 'metrics'],
  ['spans', 'traces'],
  ['logs', 'logs'],
]);
const typeLabel = (t: ExportType): string => TYPE_LABELS.get(t) ?? t;
const defaultPort = (t: ExportType): number => DEFAULT_PORTS.get(t) ?? 4318;

/** A list in words: "a", "a and b", "a, b and c". */
function inWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** What each send outcome means (14.10: a class, never the destination's own answer). */
export const OUTCOME_TEXT: Record<string, string> = {
  ok: 'The destination accepted the request.',
  refused: 'Nothing is listening at that address and port.',
  timeout: 'The destination did not answer within 10 seconds.',
  tls: 'The TLS connection failed: check the scheme and the certificate.',
  auth: 'The destination refused the credential.',
  http_3xx: 'The destination answered with a redirect, which export never follows.',
  http_4xx: 'The destination refused the request.',
  http_5xx: 'The destination had an error.',
  network: 'The connection failed.',
  blocked: 'This destination is not allowed: see where export may send.',
  no_destination: 'Save a destination first.',
};

const REASON_TEXT: Record<string, string> = {
  private_not_allowed:
    'That address is loopback or on a private network. The operator must set OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1 on the server to allow it.',
  refused_address:
    'That address is never allowed: link-local, reserved, or a cloud metadata service.',
  plain_http_public: 'A public destination must use https.',
  unresolvable: 'That host name does not resolve.',
  prohibited_host: 'That host is not allowed.',
};

const CHANGE_ERRORS: Record<string, string> = {
  collect_off: 'Turn collection on first: export can be on only while collection is.',
  destination_required: 'Set a destination first.',
  credential_not_allowed: 'The Datadog Agent takes no credential: it holds the API key itself.',
  header_name_required: 'Name the header the credential goes in.',
  invalid_credential: 'The credential must be one line of printable characters.',
  unavailable_on_demo: 'Export is not available on the demo.',
};

/** The message for a failed save or test: the password, the rule, or the server's code. */
function saveError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'destination_refused') {
      return REASON_TEXT[String(err.details['reason'])] ?? 'That destination is not allowed.';
    }
    if (err.code === 'invalid_destination') {
      return `Check the ${String(err.details['field'] ?? 'destination')} field.`;
    }
    const known = CHANGE_ERRORS[err.code];
    if (known !== undefined) return known;
  }
  return passwordError(err);
}

export function TelemetrySettings({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-6">
      <CollectCard isAdmin={isAdmin} />
      <ExportCard isAdmin={isAdmin} />
    </div>
  );
}

function CollectCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const state = useQuery(settingsQuery);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  async function set(collect: boolean) {
    setError(null);
    try {
      const res = await api<{ collect: boolean }>('/obs/settings', {
        method: 'PUT',
        body: { collect },
      });
      qc.setQueryData(settingsQuery.queryKey, res);
      // Turning collection off turns export off too (14.1).
      void qc.invalidateQueries({ queryKey: exportQuery.queryKey });
    } catch (err) {
      setError(saveError(err));
    }
  }

  const collect = state.data?.collect;
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId}>Collection</CardTitle>
        <CardDescription>
          Records this instance's request, job, database and AI call metrics and traces in its own
          database, for the Metrics and Traces pages. It records no content: no prompts, no replies,
          no text you typed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <FormError message={error ?? (state.isError ? errorMessage(state.error) : null)} />
        {collect === undefined ? null : (
          <>
            <p role="status" className="text-sm text-muted-foreground">
              Collection is {collect ? 'on' : 'off'}.
            </p>
            {isAdmin ? (
              <Button variant="outline" onClick={() => void set(!collect)}>
                {collect ? 'Turn collection off' : 'Turn collection on'}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface Draft {
  enabled: boolean;
  type: ExportType;
  scheme: 'http' | 'https';
  host: string;
  port: string;
  basePath: string;
  org: string;
  bucket: string;
  headerName: string;
  credential: string;
  removeCredential: boolean;
}

function draftOf(d: Destination | null, enabled: boolean): Draft {
  return {
    enabled,
    type: d?.type ?? 'otlp',
    scheme: d?.scheme ?? 'https',
    host: d?.host ?? '',
    port: String(d?.port ?? defaultPort(d?.type ?? 'otlp')),
    basePath: d?.basePath ?? '',
    org: d?.org ?? '',
    bucket: d?.bucket ?? '',
    headerName: d?.headerName ?? '',
    credential: '',
    removeCredential: false,
  };
}

/** The destination as fields, only those its type takes. The server builds the URL. */
function destinationOf(d: Draft): Destination {
  const out: Destination = {
    type: d.type,
    scheme: d.scheme,
    host: d.host.trim(),
    port: Number(d.port),
  };
  if (d.type === 'otlp' && d.basePath.trim() !== '') out.basePath = d.basePath.trim();
  if (d.type === 'otlp' && d.headerName.trim() !== '') out.headerName = d.headerName.trim();
  if (d.type === 'influxdb') {
    out.org = d.org;
    out.bucket = d.bucket;
  }
  return out;
}

function ExportCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery(settingsQuery);
  const view = useQuery(exportQuery);
  const titleId = useId();
  const data = view.data;
  const signals = (data?.signals ?? []).map((s) => SIGNAL_LABELS.get(s) ?? s);
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId}>Export</CardTitle>
        <CardDescription>
          Sends this instance's telemetry to one destination an admin names: Prometheus, a Datadog
          Agent, InfluxDB or any OTLP endpoint. It covers every user's telemetry, without saying
          whose: no user ids, no content, only the catalogued names and numbers.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {view.isError ? <FormError message={errorMessage(view.error)} /> : null}
        {data === undefined ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {data.enabled && data.type !== null
              ? `Export is on: ${typeLabel(data.type)}, sending ${inWords(signals)}.`
              : 'Export is off.'}
          </p>
        )}
        {isAdmin && data?.admin !== undefined ? (
          <ExportAdmin
            view={data}
            admin={data.admin}
            collect={settings.data?.collect === true}
            onSaved={(next) => qc.setQueryData(exportQuery.queryKey, next)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ExportAdmin(props: {
  view: ExportView;
  admin: NonNullable<ExportView['admin']>;
  collect: boolean;
  onSaved: (next: ExportView) => void;
}) {
  const { admin } = props;
  const [draft, setDraft] = useState<Draft>(() => draftOf(admin.destination, props.view.enabled));
  const [asking, setAsking] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const enabledId = useId();
  const removeId = useId();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function save(password: string): Promise<string | null> {
    try {
      const credential = draft.removeCredential
        ? { credential: null }
        : draft.credential !== ''
          ? { credential: draft.credential }
          : {};
      const next = await api<ExportView>('/obs/export', {
        method: 'PUT',
        body: {
          password,
          enabled: draft.enabled,
          destination: destinationOf(draft),
          ...credential,
        },
      });
      props.onSaved(next);
      setDraft((d) => ({ ...d, credential: '', removeCredential: false }));
      setAsking(null);
      setError(null);
      toast({ title: next.enabled ? 'Export is on' : 'Export settings saved', variant: 'success' });
      return null;
    } catch (err) {
      const message = saveError(err);
      if (err instanceof ApiError && err.code === 'invalid_password') return message;
      setAsking(null);
      setError(message);
      return null;
    }
  }

  async function test(password: string): Promise<string | null> {
    try {
      const res = await api<{ outcome: string }>('/obs/export/test', {
        method: 'POST',
        body: { password },
      });
      setAsking(null);
      setError(null);
      setTestResult(OUTCOME_TEXT[res.outcome] ?? res.outcome);
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_password') return saveError(err);
      setAsking(null);
      setError(saveError(err));
      return null;
    }
  }
  const credentialLabel =
    draft.type === 'otlp'
      ? 'Header value'
      : draft.type === 'influxdb'
        ? 'API token'
        : 'Authorization header value';
  return (
    // Not a <form>: inside one, Radix's checkbox adds a hidden input it measures with
    // ResizeObserver, and Save goes through the password dialog anyway, not a submit.
    <div className="grid gap-4">
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Destination type">
          {(p) => (
            <Select
              {...p}
              value={draft.type}
              onChange={(e) => {
                const type = e.target.value as ExportType;
                setDraft((d) => ({ ...d, type, port: String(defaultPort(type)) }));
              }}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Scheme">
          {(p) => (
            <Select
              {...p}
              value={draft.scheme}
              onChange={(e) => set('scheme', e.target.value as 'http' | 'https')}
            >
              <option value="https">https</option>
              <option value="http">http</option>
            </Select>
          )}
        </FormField>
        <FormField
          label="Host"
          hint={
            admin.allowPrivate
              ? 'A name or an address. This server allows loopback and private networks.'
              : 'A name or an address. Loopback and private networks need OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1 on the server.'
          }
        >
          {(p) => (
            <Input
              {...p}
              value={draft.host}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set('host', e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Port">
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              value={draft.port}
              onChange={(e) => set('port', e.target.value)}
            />
          )}
        </FormField>
        {draft.type === 'otlp' ? (
          <FormField label="Base path" hint="Optional: the path before /v1/metrics, such as /otlp.">
            {(p) => (
              <Input
                {...p}
                value={draft.basePath}
                onChange={(e) => set('basePath', e.target.value)}
              />
            )}
          </FormField>
        ) : null}
        {draft.type === 'influxdb' ? (
          <>
            <FormField label="Organisation">
              {(p) => (
                <Input {...p} value={draft.org} onChange={(e) => set('org', e.target.value)} />
              )}
            </FormField>
            <FormField label="Bucket">
              {(p) => (
                <Input
                  {...p}
                  value={draft.bucket}
                  onChange={(e) => set('bucket', e.target.value)}
                />
              )}
            </FormField>
          </>
        ) : null}
        {draft.type === 'otlp' ? (
          <FormField
            label="Header name"
            hint="Optional: the header your endpoint reads a key from."
          >
            {(p) => (
              <Input
                {...p}
                value={draft.headerName}
                spellCheck={false}
                onChange={(e) => set('headerName', e.target.value)}
              />
            )}
          </FormField>
        ) : null}
        {draft.type === 'datadog' ? null : (
          <FormField label={credentialLabel}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={draft.credential}
                placeholder={admin.hasCredential ? 'Stored. Leave blank to keep it.' : 'Optional'}
                onChange={(e) => set('credential', e.target.value)}
              />
            )}
          </FormField>
        )}
      </div>
      {admin.hasCredential && draft.type !== 'datadog' ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={removeId}
            checked={draft.removeCredential}
            onCheckedChange={(c) => set('removeCredential', c === true)}
          />
          <Label htmlFor={removeId}>Remove the stored credential</Label>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Checkbox
          id={enabledId}
          checked={draft.enabled}
          disabled={!props.collect && !draft.enabled}
          onCheckedChange={(c) => set('enabled', c === true)}
        />
        <Label htmlFor={enabledId}>Send telemetry to this destination</Label>
      </div>
      {props.collect ? null : (
        <p className="text-sm text-muted-foreground">
          Turn collection on first: export can be on only while collection is.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Changing the type, scheme, host or port clears a stored credential.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => setAsking('save')}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={() => setAsking('test')}>
          Send a test
        </Button>
      </div>
      {testResult === null ? null : (
        <p role="status" className="text-sm">
          {testResult}
        </p>
      )}
      <ExportStatusView admin={admin} />
      <PasswordDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        description={
          asking === 'test'
            ? 'Sending a test makes one request to the saved destination. Enter your password to continue.'
            : 'Export sends every user’s telemetry off this instance. Enter your password to save.'
        }
        onConfirm={async (password) =>
          asking === 'test' ? await test(password) : await save(password)
        }
      />
    </div>
  );
}

function ExportStatusView({ admin }: { admin: NonNullable<ExportView['admin']> }) {
  return (
    <div className="grid gap-2 text-sm">
      <p>
        Last success:{' '}
        {admin.lastSuccessAt === null ? 'none yet' : relativeTime(admin.lastSuccessAt)}
      </p>
      {admin.lastFailure === null ? null : (
        <p>
          Last failure {relativeTime(admin.lastFailure.at)}:{' '}
          {OUTCOME_TEXT[admin.lastFailure.outcome] ?? admin.lastFailure.outcome}
        </p>
      )}
      {admin.dropped.length === 0 ? null : (
        <Table aria-label="Dropped in the last 24 hours">
          <TableHeader>
            <TableRow>
              <TableHead>Signal</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead className="text-right">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admin.dropped.map((d) => (
              <TableRow key={`${d.signal} ${d.reason}`}>
                <TableCell>{d.signal}</TableCell>
                <TableCell>{d.reason.replace('_', ' ')}</TableCell>
                <TableCell className="text-right">{d.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
