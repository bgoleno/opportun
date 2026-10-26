// Settings > Integrations > Extensions and Connectors (FR-M5, FR-C5): device tokens for the Apple Mail connector
// and the browser capture extension. Creating one needs the current password; the token is
// shown exactly once (the server keeps only its hash). Revoking takes effect on the device's
// next request. The Apple Mail line reflects the last batch the connector pushed.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { meQuery } from '@/lib/auth';
import { ek, ExtensionSetupDialog, type ArtifactList } from './-extensionSetup';

const SCOPES = [
  { scope: 'mail:push', label: 'Apple Mail connector' },
  { scope: 'capture:push', label: 'Browser capture' },
] as const;
type Scope = (typeof SCOPES)[number]['scope'];

interface DeviceToken {
  id: string;
  name: string;
  scopes: Scope[];
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}
interface AppleMailStatus {
  connected: boolean;
  lastSyncAt: number | null;
  status: string | null;
  count: number;
  /** Set by the server when connected but silent for over a day. */
  staleHint: string | null;
}

const dk = {
  tokens: ['device-tokens'] as const,
  appleMail: ['integrations', 'apple-mail'] as const,
};

const scopeLabel = (s: Scope): string => {
  const label = SCOPES.find((x) => x.scope === s)?.label;
  return label === undefined ? s : `${label} (${s})`;
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "5 minutes ago", "yesterday", "3 days ago"; under a minute is "just now". */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  if (Math.abs(seconds) < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, 'day');
  return new Date(ms).toLocaleDateString();
}

export function DevicesCard() {
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: dk.tokens,
    queryFn: () => api<{ items: DeviceToken[] }>('/device-tokens'),
  });
  const appleMail = useQuery({
    queryKey: dk.appleMail,
    queryFn: () => api<AppleMailStatus>('/integrations/apple-mail'),
  });
  const me = useQuery(meQuery);
  // Asked here, not only inside the dialog: D15 wants the card itself to say when this server
  // has nothing to hand over, before anyone confirms a password and is handed a token.
  const artifacts = useQuery({
    queryKey: ek.artifacts,
    queryFn: () => api<ArtifactList>('/artifacts/extension'),
  });
  const [settingUp, setSettingUp] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DeviceToken | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: dk.tokens });
  const revoke = useMutation({
    mutationFn: (id: string) => api<void>(`/device-tokens/${id}`, { method: 'DELETE' }),
    // Revoking the last mail:push token disconnects Apple Mail.
    onSettled: () => Promise.all([refresh(), qc.invalidateQueries({ queryKey: dk.appleMail })]),
  });

  const items = tokens.data?.items ?? [];
  return (
    <Card data-tour="devices-card">
      <CardHeader>
        <CardTitle>Extensions and Connectors</CardTitle>
        <CardDescription>
          Tokens for programs on your own devices: the Apple Mail connector on your Mac and the
          Opportun browser extension. A token can only send data in for the permissions you give it;
          it cannot read anything back. Revoke one and the device is cut off at once.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <ul className="grid gap-2" aria-label="Connectable things">
          <ExtensionRow
            tokens={items}
            artifacts={artifacts.data}
            onSetUp={() => setSettingUp(true)}
          />
        </ul>
        <AppleMailLine status={appleMail.data} />
        {tokens.isError ? <FormError message={errorMessage(tokens.error)} /> : null}
        {tokens.isPending ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground">No device tokens yet.</p>
        ) : (
          <ul aria-label="Device tokens" className="grid gap-2">
            {items.map((t) => (
              <TokenRow key={t.id} token={t} onRevoke={() => setRevoking(t)} />
            ))}
          </ul>
        )}
        {revoke.error ? <FormError message={errorMessage(revoke.error)} /> : null}
        <div>
          <Button onClick={() => setCreating(true)}>Create token</Button>
        </div>
      </CardContent>
      <ExtensionSetupDialog
        open={settingUp}
        onOpenChange={setSettingUp}
        displayName={me.data?.displayName ?? 'this browser'}
      />
      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(token) => {
          setCreating(false);
          setCreated(token);
          void refresh();
        }}
      />
      {created === null ? null : <ShowOnceDialog token={created} onDone={() => setCreated(null)} />}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.name ?? 'token'}?`}
        description="The device using this token is refused from its next request on. This cannot be undone: create a new token to reconnect it."
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (revoking !== null) await revoke.mutateAsync(revoking.id);
        }}
      />
    </Card>
  );
}

/**
 * What the browser extension row says (design D23), derived from the token list rather than
 * from new server state: a live token that has been used means it is set up, one that has not
 * means the install is half done, and a revoked one means nothing at all. Set up stays offered
 * either way, because a second browser is a normal thing to add.
 */
function ExtensionRow({
  tokens,
  artifacts,
  onSetUp,
}: {
  tokens: DeviceToken[];
  artifacts: ArtifactList | undefined;
  onSetUp: () => void;
}) {
  const live = tokens.filter((t) => t.revokedAt === null && t.scopes.includes('capture:push'));
  const lastUsed = live.reduce<number | null>(
    (acc, t) =>
      t.lastUsedAt !== null && (acc === null || t.lastUsedAt > acc) ? t.lastUsedAt : acc,
    null,
  );
  const status =
    lastUsed !== null
      ? `last capture ${relativeTime(lastUsed)}`
      : live.length > 0
        ? 'waiting for its first capture'
        : 'not set up';
  // Undefined while the listing is in flight or if it failed: assume a download exists rather
  // than accuse a healthy server of having none.
  const nothingToDownload = artifacts !== undefined && !artifacts.targets.some((t) => t.available);
  return (
    <li aria-label="Browser extension" className="grid gap-1 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Browser extension</span>
        <span className="text-muted-foreground">{status}</span>
        <Button
          size="sm"
          variant={lastUsed === null ? 'default' : 'outline'}
          className="ml-auto"
          disabled={nothingToDownload}
          onClick={onSetUp}
        >
          Set up
        </Button>
      </div>
      {nothingToDownload ? (
        <p className="text-xs text-muted-foreground">
          This server has no built extension to hand over. Build it from a checkout with{' '}
          <code>{artifacts.buildCommand}</code>, then reload this page.
        </p>
      ) : null}
    </li>
  );
}

function AppleMailLine({ status }: { status: AppleMailStatus | undefined }) {
  if (status === undefined) return null;
  if (!status.connected || status.lastSyncAt === null) {
    return (
      <p className="text-muted-foreground">
        {status.lastSyncAt === null
          ? 'Apple Mail: not connected.'
          : `Apple Mail: not connected (no active token; last batch ${relativeTime(status.lastSyncAt)}).`}{' '}
        Create a token with the Apple Mail connector permission and run the connector on your Mac.
      </p>
    );
  }
  const n = status.count;
  return (
    <div className="grid gap-1">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
        <span>
          {`Apple Mail: connected, last batch ${relativeTime(status.lastSyncAt)} (${n} ${n === 1 ? 'message' : 'messages'}).`}
          {status.status === 'error' ? ' The last batch failed; the connector retries it.' : ''}
        </span>
      </p>
      {status.staleHint === null ? null : (
        <p className="rounded-md bg-warning px-3 py-2 text-xs text-warning-foreground">
          {status.staleHint}
        </p>
      )}
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: DeviceToken; onRevoke: () => void }) {
  const revoked = token.revokedAt !== null;
  return (
    <li aria-label={token.name} className="grid gap-1 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{token.name}</span>
        {revoked ? <Badge variant="secondary">Revoked</Badge> : null}
        {!revoked ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={onRevoke}>
            Revoke
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-wrap gap-1" aria-label="Permissions">
        {token.scopes.map((s) => (
          <li key={s}>
            <Badge variant="outline">{scopeLabel(s)}</Badge>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Created {relativeTime(token.createdAt)}.{' '}
        {token.lastUsedAt === null ? 'Never used.' : `Last used ${relativeTime(token.lastUsedAt)}.`}
        {revoked ? ` Revoked ${relativeTime(token.revokedAt!)}.` : ''}
      </p>
    </li>
  );
}

interface FieldErrors {
  name?: string;
  scopes?: string;
  password?: string;
}

function CreateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (token: string) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['mail:push']);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setName('');
    setScopes(['mail:push']);
    setPassword('');
    setErrors({});
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: FieldErrors = {};
    if (name.trim().length === 0) next.name = 'Give the token a name.';
    if (scopes.length === 0) next.scopes = 'Pick at least one permission.';
    if (password.length === 0) next.password = 'Enter your current password.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<DeviceToken & { token: string }>('/device-tokens', {
        method: 'POST',
        body: { name: name.trim(), scopes, password },
      });
      reset();
      props.onCreated(res.token);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid_password'
          ? 'That is not your current password.'
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) reset();
        props.onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-md">
        <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create a device token</DialogTitle>
            <DialogDescription>
              Name it after the device it goes on, so you know which one to revoke later.
            </DialogDescription>
          </DialogHeader>
          <FormError message={error} />
          <FormField label="Name" error={errors.name}>
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={100}
                placeholder="Work MacBook"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Permissions</legend>
            {SCOPES.map(({ scope, label }) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setScopes((cur) =>
                      SCOPES.map((s) => s.scope).filter((s) =>
                        s === scope ? on : cur.includes(s),
                      ),
                    );
                  }}
                  className="size-4 accent-primary"
                />
                {label} <span className="text-muted-foreground">({scope})</span>
              </label>
            ))}
            {errors.scopes ? (
              <p role="alert" className="text-sm text-destructive">
                {errors.scopes}
              </p>
            ) : null}
          </fieldset>
          <FormField label="Current password" error={errors.password}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The new token, shown this one time: closing is only through "I saved it". */
function ShowOnceDialog({ token, onDone }: { token: string; onDone: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      toast({ title: 'Token copied', variant: 'success' });
    } catch {
      toast({ title: 'Copy failed', description: 'Select the token and copy it instead.' });
    }
  }
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="max-w-md" showClose={false}>
        <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Copy your device token</DialogTitle>
            <DialogDescription>
              Paste it into the connector or extension now. It will not be shown again: Opportun
              stores only a fingerprint of it. If you lose it, revoke it and create a new one.
            </DialogDescription>
          </DialogHeader>
          <FormField label="Device token">
            {(p) => (
              <Input
                {...p}
                readOnly
                value={token}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => void copy()}>
              <Copy className="size-4" aria-hidden="true" />
              Copy token
            </Button>
            <Button type="button" onClick={onDone}>
              I saved it
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
