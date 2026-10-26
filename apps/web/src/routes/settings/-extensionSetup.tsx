// Settings > Integrations > Extensions and Connectors: guided setup for the browser extension
// (design D2, the Home Assistant pattern). One dialog mints the scoped token, hands over the
// matching download and keeps both on screen for as long as the install takes, because the
// token is shown exactly once and the install happens in another window.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Download } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { BROWSER_EXTENSION_GUIDE_URL } from '@/lib/externalLinks';

interface ArtifactTarget {
  id: string;
  label: string;
  filename: string;
  available: boolean;
  /** The same version_name chrome://extensions/about:debugging show for an installed copy
   * (#92, #118): null when this server has no build to read it from. */
  buildStamp: string | null;
}
export interface ArtifactList {
  targets: ArtifactTarget[];
  buildCommand: string;
  baseUrl: string;
}
interface MintedToken {
  id: string;
  name: string;
  token: string;
}
interface DeviceTokenRow {
  id: string;
  lastUsedAt: number | null;
}

export const ek = {
  artifacts: ['artifacts', 'extension'] as const,
  tokens: ['device-tokens'] as const,
  password: ['auth', '2fa'] as const,
};

/** Chrome and Firefox need genuinely different instructions, not different wording. */
const INSTALL_STEPS: Record<string, string[]> = {
  chrome: [
    'Unzip the file to get the opportun-chrome folder.',
    'Open a new tab at chrome://extensions',
    'Turn on Developer mode, top right.',
    'Click Load unpacked and choose that folder, not a file in it.',
    'Pin Opportun Capture to your toolbar.',
  ],
  firefox: [
    'Open a new tab at about:debugging',
    'Choose This Firefox, then Load Temporary Add-on.',
    'Pick the zip you just downloaded; no unzipping needed.',
    'Pin Opportun Capture to your toolbar.',
  ],
};

/** Said before the install, not discovered at the next restart. */
const TARGET_CAVEAT: Record<string, string> = {
  chrome:
    'It stays installed. After a server upgrade, download again and press reload on its card.',
  firefox: 'Firefox removes a temporary add-on when it restarts, so this needs redoing each time.',
};

export function ExtensionSetupDialog({
  open,
  onOpenChange,
  displayName,
  pollMs = 2000,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  /** How often to look for this token's first use; small in tests. */
  pollMs?: number;
}) {
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState('chrome');
  const [password, setPassword] = useState('');
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const artifacts = useQuery({
    queryKey: ek.artifacts,
    queryFn: () => api<ArtifactList>('/artifacts/extension'),
  });
  const account = useQuery({
    queryKey: ek.password,
    queryFn: () => api<{ hasPassword?: boolean }>('/auth/2fa'),
  });

  // Step 6 watches THIS token's first use, not any token's: a second browser checking in says
  // nothing about the one being set up here.
  const checkIn = useQuery({
    queryKey: [...ek.tokens, 'check-in', minted?.id ?? ''] as const,
    enabled: minted !== null,
    // Nothing left to learn once it has checked in.
    refetchInterval: (q) => (typeof q.state.data === 'number' ? false : pollMs),
    queryFn: async () => {
      const { items } = await api<{ items: DeviceTokenRow[] }>('/device-tokens');
      return items.find((t) => t.id === minted?.id)?.lastUsedAt ?? null;
    },
  });

  const targets = artifacts.data?.targets ?? [];
  const target = targets.find((t) => t.id === targetId);
  // Assuming a password exists while the answer is unknown ends in "that is not your current
  // password" for an account that never had one.
  const hasPassword = account.data?.hasPassword === true;
  const connected = typeof checkIn.data === 'number';

  /** The name nobody should have to invent (D5, D6): the browser and who you are. */
  const proposedName = `${target?.label.split(',')[0] ?? 'Browser'} · ${displayName}`;

  const rename = useMutation({
    mutationFn: (next: string) =>
      api<{ name: string }>(`/device-tokens/${minted?.id ?? ''}`, {
        method: 'PATCH',
        body: { name: next.trim() },
      }),
    onSuccess: () => {
      toast({ title: 'Name saved.' });
      void qc.invalidateQueries({ queryKey: ek.tokens });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function close(): void {
    setTargetId('chrome');
    setPassword('');
    setMinted(null);
    setName('');
    setError(null);
    setConfirmClose(false);
    onOpenChange(false);
  }

  function requestClose(): void {
    // The server keeps only a hash, so leaving now means minting another one (D8). Keyed on
    // `connected`, not on whether the copy below succeeded: a confirmed copy only means the
    // value reached the clipboard, not that it ever made it into the extension, and a bad
    // paste or a failed "Test connection" would leave `connected` false regardless of a clean
    // copy. `connected` is the one signal that is actually true once the token is safely in
    // use; copy success is not a substitute for it (#150).
    if (minted !== null && !connected) setConfirmClose(true);
    else close();
  }

  async function copyToken(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(token);
      toast({ title: 'Token copied', variant: 'success' });
    } catch {
      toast({ title: 'Copy failed', description: 'Select the token and copy it instead.' });
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<MintedToken>('/device-tokens', {
        method: 'POST',
        body: { name: proposedName, scopes: ['capture:push'], password },
      });
      setMinted(res);
      setName(res.name);
      setPassword('');
      void qc.invalidateQueries({ queryKey: ek.tokens });
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
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Set up the browser extension</DialogTitle>
            <DialogDescription>
              <a
                className="underline"
                href={BROWSER_EXTENSION_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                What it does and how to use it
              </a>
            </DialogDescription>
          </DialogHeader>

          <Tabs value={targetId} onValueChange={setTargetId}>
            <TabsList>
              {targets.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <FormError message={error} />
          {artifacts.isError ? (
            <FormError message="Could not load the downloads this server offers. Reload the page, or check the server log." />
          ) : null}

          {minted === null ? (
            <form onSubmit={(e) => void submit(e)} noValidate className="grid gap-4">
              <Step n={1} title="Confirm your password">
                {account.isPending ? (
                  <p className="text-sm text-muted-foreground">Checking your account...</p>
                ) : account.isError ? (
                  <p className="rounded-md bg-warning px-3 py-2 text-sm text-warning-foreground">
                    Could not check whether this account has a password. Reload the page and try
                    again.
                  </p>
                ) : hasPassword ? (
                  <FormField label="Password">
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
                ) : (
                  <p className="rounded-md bg-warning px-3 py-2 text-sm text-warning-foreground">
                    You signed in with Google, GitHub or LinkedIn, so this account has no password
                    yet. Set a password under Settings &gt; Account first, then come back.
                  </p>
                )}
              </Step>
              <div>
                <Button type="submit" disabled={busy || !hasPassword || password.length === 0}>
                  {busy ? 'Working...' : 'Continue'}
                </Button>
              </div>
            </form>
          ) : (
            <div className="grid gap-4">
              <Step n={2} title="Your token" done>
                <div className="grid gap-2 rounded-md border border-success px-3 py-2">
                  <FormField label="Token name">
                    {(p) => (
                      <div className="flex gap-2">
                        <Input
                          {...p}
                          value={name}
                          maxLength={100}
                          onChange={(e) => setName(e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={rename.isPending || name.trim().length === 0}
                          onClick={() => rename.mutate(name)}
                        >
                          Save name
                        </Button>
                      </div>
                    )}
                  </FormField>
                  <div className="flex items-center gap-2">
                    <code className="break-all text-xs">{minted.token}</code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto shrink-0"
                      onClick={() => void copyToken(minted.token)}
                    >
                      <Copy aria-hidden="true" /> Copy
                    </Button>
                  </div>
                  <p className="text-xs">
                    <strong>Copy this and store it somewhere safe.</strong> It is shown only here,
                    only once.
                  </p>
                </div>
              </Step>

              <Step n={3} title="Download the extension">
                {target?.available === true ? (
                  <>
                    <Button asChild>
                      <a href={`/api/v1/artifacts/extension/${target.id}`} download>
                        <Download aria-hidden="true" /> Download {target.filename}
                      </a>
                    </Button>
                    {/* A wrong address must be visible here: inside the popup the user cannot
                        be carrying a second value, so finding it there costs them the token. */}
                    <p className="text-xs text-muted-foreground">
                      It will point the extension at <code>{artifacts.data?.baseUrl}</code>. If that
                      is not how your other devices reach this server, open Opportun at the address
                      they use and download it again from there.
                    </p>
                    {target.buildStamp !== null ? (
                      // #118: the exact string chrome://extensions / about:debugging show for
                      // an installed copy, so checking "is mine current" is comparing two
                      // strings instead of rebuilding and diffing bytes by hand (#79).
                      <p className="text-xs text-muted-foreground">
                        This download is build{' '}
                        <code className="break-all">{target.buildStamp}</code>. An already-installed
                        copy shows its own build the same way, on its chrome://extensions card or
                        about:debugging/about:addons entry: if the two don&apos;t match, download
                        again.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This server has no built extension to hand over. Build it from a checkout with{' '}
                    <code>{artifacts.data?.buildCommand ?? 'pnpm build'}</code>, then reload this
                    page.
                  </p>
                )}
              </Step>

              <Step n={4} title="Install the extension from the folder where you downloaded it">
                {targetId === 'chrome' ? (
                  <p className="text-sm text-muted-foreground">
                    Chrome can install an extension from a folder on your computer instead of from
                    the Chrome Web Store. Chrome calls that loading an unpacked extension.
                  </p>
                ) : null}
                <ol className="ml-5 list-decimal text-sm">
                  {(INSTALL_STEPS[targetId] ?? []).map((line) => (
                    <li key={line} className="py-0.5">
                      {line}
                    </li>
                  ))}
                </ol>
                <p className="text-xs text-muted-foreground">{TARGET_CAVEAT[targetId]}</p>
              </Step>

              <Step n={5} title="Paste the token into the extension">
                <p className="text-sm text-muted-foreground">
                  Copy the token above first: the popup closes as soon as you click away from it.
                </p>
                <ol className="ml-5 list-decimal text-sm">
                  <li className="py-0.5">Click the Opportun icon, then Settings.</li>
                  <li className="py-0.5">This server&apos;s address is already filled in.</li>
                  <li className="py-0.5">Paste the token, press Save, and allow the prompt.</li>
                  <li className="py-0.5">Press Test connection.</li>
                </ol>
              </Step>

              <Step
                n={6}
                title={connected ? 'Connected' : 'Waiting for the extension to check in'}
                done={connected}
              >
                <p className="text-sm text-muted-foreground">
                  {connected
                    ? 'The extension reached this server. You are set up.'
                    : 'This turns green by itself the first time the extension uses the token.'}
                </p>
              </Step>

              <div className="flex gap-2">
                <Button type="button" onClick={requestClose}>
                  {connected ? 'Done' : 'Close setup'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Close before the extension has checked in?"
        description="The token cannot be shown again: the server keeps only a hash of it. If you have not pasted it into the extension yet, you will have to create another one."
        confirmLabel="Close anyway"
        onConfirm={async () => close()}
      />
    </>
  );
}

function Step({
  n,
  title,
  done = false,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-2 border-t pt-3 first:border-t-0 first:pt-0">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {done ? (
          <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-4 items-center justify-center rounded-full bg-muted text-[10px]"
          >
            {n}
          </span>
        )}
        {title}
      </h3>
      {children}
    </section>
  );
}
