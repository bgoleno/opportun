// Guided Google OAuth client setup. Google offers no API to create an OAuth client, so this is
// a deep-linked walkthrough of the console pages with copy-ready values, an immediate check of
// the credentials on save, and (with an AI key) an explanation of any error Google shows.
// Everything from the server or a model renders as text nodes.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { FormError } from '@/components/FormError';
import { rk, type GoogleClientValidation, type GoogleStatus } from '@/components/resume/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

export const GOOGLE_LINKS = {
  project: 'https://console.cloud.google.com/projectcreate',
  branding: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  projectSelector: 'https://console.cloud.google.com/projectselector2/home/dashboard',
  driveApi: 'https://console.cloud.google.com/apis/library/drive.googleapis.com',
  docsApi: 'https://console.cloud.google.com/apis/library/docs.googleapis.com',
  gmailApi: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
  createClient: 'https://console.cloud.google.com/auth/clients/create',
  help: 'https://support.google.com/cloud/answer/6158849',
} as const;

export const DIAGNOSE_MAX_CHARS = 5000;

/** A link that opens in a new tab with no opener and no referrer. */
export function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** The console and help links, shown on the card whether or not the guide is open. */
export function GoogleQuickLinks() {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      <ExternalAnchor href={GOOGLE_LINKS.createClient}>
        Google Cloud console: OAuth clients
      </ExternalAnchor>
      <ExternalAnchor href={GOOGLE_LINKS.help}>Google help: OAuth clients</ExternalAnchor>
    </p>
  );
}

export function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} copied`, variant: 'success' });
    } catch {
      toast({ title: 'Copy failed', description: 'Select the text and copy it instead.' });
    }
  }
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={() => void copy()}
        >
          <Copy className="size-4" aria-hidden="true" />
          Copy
        </Button>
      </div>
    </div>
  );
}

const ERROR_TEXT: Record<string, string> = {
  client_id_format: 'This is not a Google OAuth Client ID.',
  invalid_client: 'Google rejected the credentials (invalid_client).',
  unreachable: 'Google could not be reached to check the credentials.',
};

const checkedFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The validation result: a status chip, the error and its fix, and a retry when unverified. */
export function ValidationResult({
  validation,
  onRetry,
  retrying,
}: {
  validation: GoogleClientValidation;
  onRetry: () => void;
  retrying: boolean;
}) {
  const chip =
    validation.status === 'valid'
      ? { variant: 'success' as const, label: 'Valid' }
      : validation.status === 'invalid'
        ? { variant: 'destructive' as const, label: 'Invalid' }
        : { variant: 'warning' as const, label: 'Unverified' };
  const error =
    validation.error === undefined
      ? null
      : (ERROR_TEXT[validation.error] ?? `Google answered ${validation.error}.`);
  return (
    <div className="grid gap-2 text-sm" data-testid="google-validation" role="status">
      <p className="flex flex-wrap items-center gap-2">
        <Badge variant={chip.variant}>{chip.label}</Badge>
        <span className="text-xs text-muted-foreground">
          Checked {checkedFmt.format(validation.checkedAt)}
        </span>
      </p>
      {error === null ? null : <p className="font-medium">{error}</p>}
      {validation.fix === undefined ? null : (
        <p className="text-muted-foreground">Fix: {validation.fix}</p>
      )}
      {validation.warning === undefined ? null : (
        <p className="text-muted-foreground">Note: {validation.warning}</p>
      )}
      {validation.status === 'unverified' ? (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
            Retry check
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface Diagnosis {
  explanation: string;
  fix: string;
}

/** Paste the error Google showed; an AI explanation and fix come back as plain text. */
export function DiagnoseBox() {
  const [text, setText] = useState('');
  const diagnose = useMutation({
    mutationFn: (t: string) =>
      api<Diagnosis>('/integrations/google/diagnose', { method: 'POST', body: { text: t } }),
  });
  const trimmed = text.trim();
  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Diagnose an error</summary>
      <form
        className="mt-3 grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          diagnose.mutate(trimmed);
        }}
      >
        <Label htmlFor="google-diagnose-text">Paste the error Google showed you</Label>
        <Textarea
          id="google-diagnose-text"
          value={text}
          maxLength={DIAGNOSE_MAX_CHARS}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <p className="text-xs text-muted-foreground">
          Sent to your AI provider with this app's redirect URI and origin. Never paste the client
          secret.
        </p>
        <div>
          <Button
            type="submit"
            variant="outline"
            disabled={diagnose.isPending || trimmed.length === 0}
          >
            {diagnose.isPending ? 'Diagnosing...' : 'Diagnose'}
          </Button>
        </div>
        {diagnose.error ? <FormError message={errorMessage(diagnose.error)} /> : null}
        {diagnose.data ? (
          <div className="grid gap-1 rounded-md bg-muted/40 px-3 py-2" data-testid="diagnosis">
            <p>{diagnose.data.explanation}</p>
            <p>
              <span className="font-medium">Fix: </span>
              {diagnose.data.fix}
            </p>
          </div>
        ) : null}
      </form>
    </details>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-x-3 gap-y-1">
      <span
        className="flex size-7 items-center justify-center rounded-full border text-xs font-semibold"
        aria-hidden="true"
      >
        {n}
      </span>
      <div className="grid gap-2">
        <h4 className="text-sm font-semibold">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h4>
        {children}
      </div>
    </li>
  );
}

/** Short instruction lines under a step. */
function Lines({ children }: { children: ReactNode }) {
  return <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">{children}</ul>;
}

/** The classic setup errors and their fixes; always available, AI key or not. */
export const TROUBLESHOOTING: readonly { code: string; fix: string }[] = [
  {
    code: 'redirect_uri_mismatch',
    fix: 'The redirect URI on the client must match the copy value above EXACTLY, scheme (https) and path included, with no trailing slash. Fix it on the client page, save, and wait a few minutes.',
  },
  {
    code: 'access_denied',
    fix: 'Your account is not a test user, or you picked a different account at consent. Add the step 0 account under Audience, Test users, and choose that same account when you connect.',
  },
  {
    code: 'accessNotConfigured (or "API has not been used in project")',
    fix: 'The Drive, Docs or Gmail API is not enabled in the project that owns the client. Enable it with the links in step 2, wait a minute, and try again.',
  },
  {
    code: 'invalid_client',
    fix: 'The Client ID and secret do not belong to one live client. Re-copy both values from the same client, or add a new secret on the client page and save again.',
  },
];

export function Troubleshooting() {
  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Troubleshooting</summary>
      <p className="mt-2 text-muted-foreground">
        If Google shows an error while you connect, look up its code here. This is a reference of
        possible error responses and their fixes, not a list of issues with your setup.
      </p>
      <dl className="mt-3 grid gap-3" data-testid="google-troubleshooting">
        {TROUBLESHOOTING.map((t) => (
          <div key={t.code} className="grid gap-1">
            <dt className="font-mono text-xs font-semibold">{t.code}</dt>
            <dd className="text-muted-foreground">{t.fix}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

interface SaveResult {
  stored: boolean;
  validation: GoogleClientValidation;
}

/**
 * The walkthrough: the account and console steps (collapsible once a client checks out), the
 * credentials step, whose save runs the check immediately, and what consent will look like.
 */
export function GoogleSetupGuide({ status }: { status: GoogleStatus }) {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState(status.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [expanded, setExpanded] = useState<boolean | null>(null);
  /** The latest result this session (a refused format check is never stored server side). */
  const [latest, setLatest] = useState<GoogleClientValidation | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: rk.google });

  const saveClient = useMutation({
    mutationFn: () =>
      api<SaveResult>('/integrations/google/client', {
        method: 'POST',
        body: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
      }),
    onSuccess: async (res) => {
      setLatest(res.validation);
      if (!res.stored) return;
      // The id stays visible so the form reflects the stored client; only the secret clears.
      setClientSecret('');
      toast({ title: 'Client saved', description: 'Stored encrypted.', variant: 'success' });
      await refresh();
    },
  });
  const revalidate = useMutation({
    mutationFn: () =>
      api<{ validation: GoogleClientValidation }>('/integrations/google/client/validate', {
        method: 'POST',
      }),
    onSuccess: async (res) => {
      setLatest(res.validation);
      await refresh();
    },
  });

  const validation = latest ?? status.validation;
  const healthy = status.clientConfigured && status.validation?.status === 'valid';
  const open = expanded ?? !healthy;

  function submit(e: FormEvent) {
    e.preventDefault();
    saveClient.mutate();
  }

  return (
    <section className="grid gap-4 border-t pt-6" aria-labelledby="google-setup-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="google-setup-heading" className="text-sm font-semibold">
          Guided setup
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
        >
          {open ? 'Hide console steps' : 'Show console steps'}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Google has no API for creating OAuth clients, so this takes a few minutes in the Google
        Cloud console. Each link opens the right page in a new tab.
      </p>
      <ol className="grid gap-5">
        {open ? (
          <>
            <Step n={0} title="Choose your Google account">
              <Lines>
                <li>
                  Sign in to Google with the account whose Drive holds your resumes and whose Gmail
                  you will connect.
                </li>
                <li>
                  With several Google accounts signed in, Google sometimes opens the console as a
                  different one. Check the avatar at the top right of every console page.
                </li>
                <li>Use this SAME account for every step below and for the final consent.</li>
              </Lines>
            </Step>
            <Step n={1} title="Create or select a project">
              <Lines>
                <li>
                  Create a new project (any name), or use an existing one: that works fine.{' '}
                  <ExternalAnchor href={GOOGLE_LINKS.project}>Create a project</ExternalAnchor>
                </li>
                <li>
                  If Google says you have reached your project limit, pick an existing project
                  instead.{' '}
                  <ExternalAnchor href={GOOGLE_LINKS.projectSelector}>
                    Open the project selector
                  </ExternalAnchor>
                </li>
                <li>Every later page must show this project in the selector at the top.</li>
              </Lines>
            </Step>
            <Step n={2} title="Enable the required APIs">
              <Lines>
                <li>
                  Open each link and click Enable. Without this, Google later answers 403
                  accessNotConfigured.
                </li>
                <li>
                  <ExternalAnchor href={GOOGLE_LINKS.driveApi}>Google Drive API</ExternalAnchor> and{' '}
                  <ExternalAnchor href={GOOGLE_LINKS.docsApi}>Google Docs API</ExternalAnchor>:
                  needed for resume flows.
                </li>
                <li>
                  <ExternalAnchor href={GOOGLE_LINKS.gmailApi}>Gmail API</ExternalAnchor>: needed
                  for inbox sync. It can wait until you connect Gmail.
                </li>
              </Lines>
            </Step>
            <Step n={3} title="Set up branding (the consent screen)">
              <Lines>
                <li>
                  <ExternalAnchor href={GOOGLE_LINKS.branding}>Open Branding</ExternalAnchor> (click
                  Get started if Google asks).
                </li>
                <li>App name: Opportun, or anything you like.</li>
                <li>User support email: pick your email.</li>
                <li>Developer contact email: your email.</li>
                <li>Everything else can stay at its default. Save.</li>
              </Lines>
            </Step>
            <Step n={4} title="Choose the audience and add yourself as a test user">
              <Lines>
                <li>
                  When Google&apos;s setup wizard asks for the audience (right after App
                  Information), choose External and click Next, then finish the wizard. Internal
                  only works inside a Google Workspace organization and would lock out a @gmail.com
                  account.
                </li>
                <li>
                  The Test users list is NOT in that wizard. After finishing it, open{' '}
                  <ExternalAnchor href={GOOGLE_LINKS.audience}>Audience</ExternalAnchor> again (the
                  left-menu entry, even though you just answered an audience question) to reach the
                  full page with Publishing status and Test users. Stay in Testing for now.
                </li>
                <li>
                  Under Test users, click Add users and ADD YOURSELF: the exact account from step 0.
                  Forgetting this causes access_denied at consent.
                </li>
              </Lines>
              <p
                className="rounded-md border bg-muted/40 px-3 py-2 text-sm"
                data-testid="google-testing-expiry"
              >
                While the app is in Testing, Google expires your grant after about 7 days and
                Opportun will ask you to reconnect. To stop that, once everything works come back to
                this page and set Publish status to In production. Google then shows an
                &quot;unverified app&quot; warning at consent (click Advanced, then Continue), which
                is expected for a personal self-hosted app, and the grant stops expiring.
              </p>
            </Step>
            <Step n={5} title="Create the OAuth client">
              <Lines>
                <li>
                  <ExternalAnchor href={GOOGLE_LINKS.createClient}>Create a client</ExternalAnchor>{' '}
                  and use these exact values, then click Create.
                </li>
                <li>
                  FIRST check the project name in the chip at the top of the console: it must be the
                  step 1 project. These links open in whatever project the console last had
                  selected. A client created in the wrong project LOOKS fine (it validates and
                  connects) but fails later with disabled-API errors, because steps 2 to 4 were done
                  elsewhere.
                </li>
                <li>
                  Leave &quot;Use this client for an AI-powered agent&quot; unchecked if Google
                  offers it. Opportun is a standard web app client: its AI never calls Google APIs
                  directly, and the designation cannot be changed after creation.
                </li>
                <li>
                  Optional: if you also browse Opportun at another address (like
                  http://localhost:8080), you can add that origin and its
                  /api/v1/integrations/google/callback as extra entries. Google matches them
                  exactly, PORT INCLUDED. The Connect flow itself always uses the values above, from
                  the server&apos;s base URL, whatever address your browser shows.
                </li>
              </Lines>
              <CopyField id="google-app-type" label="Application type" value="Web application" />
              <CopyField
                id="google-js-origin"
                label="Authorized JavaScript origin"
                value={status.jsOrigin}
              />
              <CopyField
                id="google-redirect-uri"
                label="Authorized redirect URI"
                value={status.redirectUri}
              />
              <Lines>
                <li>
                  After Create, Google shows the Client ID and secret ONCE in a dialog. Copy both
                  right away (or download the JSON).
                </li>
                <li>
                  Lost the secret? Open the client&apos;s page, add a new secret, and use that.
                </li>
              </Lines>
            </Step>
          </>
        ) : null}
        <Step n={6} title="Paste the Client ID and secret">
          <form onSubmit={submit} className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Copy both from the dialog Google shows after Create. Saving checks them with Google
              right away.
            </p>
            <div className="grid gap-2">
              <Label htmlFor="google-client-id">Client id</Label>
              <Input
                id="google-client-id"
                value={clientId}
                autoComplete="off"
                placeholder="1234-abc.apps.googleusercontent.com"
                onChange={(e) => setClientId(e.currentTarget.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="google-client-secret">Client secret</Label>
              <Input
                id="google-client-secret"
                type="password"
                value={clientSecret}
                autoComplete="off"
                placeholder={status.clientConfigured ? '••••••••••••' : undefined}
                onChange={(e) => setClientSecret(e.currentTarget.value)}
              />
              {status.clientConfigured ? (
                <p className="text-xs text-muted-foreground" data-testid="google-secret-saved">
                  A secret is saved and stored encrypted; it is never shown again. Paste a new one
                  only to replace the client.
                </p>
              ) : null}
            </div>
            {saveClient.error ? <FormError message={errorMessage(saveClient.error)} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="outline"
                disabled={
                  saveClient.isPending ||
                  clientId.trim().length === 0 ||
                  clientSecret.trim().length === 0
                }
              >
                {saveClient.isPending
                  ? 'Checking...'
                  : status.clientConfigured
                    ? 'Replace client'
                    : 'Save client'}
              </Button>
              {status.clientConfigured && validation?.status !== 'unverified' ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={revalidate.isPending}
                  onClick={() => revalidate.mutate()}
                >
                  Check saved client again
                </Button>
              ) : null}
            </div>
          </form>
          {validation === null ? null : (
            <ValidationResult
              validation={validation}
              retrying={revalidate.isPending}
              onRetry={() => revalidate.mutate()}
            />
          )}
          {revalidate.error ? <FormError message={errorMessage(revalidate.error)} /> : null}
        </Step>
        <Step n={7} title="Connect: what Google's consent looks like">
          <Lines>
            <li>
              Click Connect Google account above. Google shows an account chooser: pick the step 0
              account.
            </li>
            <li>
              A &quot;Google hasn&apos;t verified this app&quot; screen is expected (Testing, or In
              production without verification): click Advanced, then Go to Opportun.
            </li>
            <li>Tick every permission checkbox, then Continue.</li>
          </Lines>
        </Step>
      </ol>
      <Troubleshooting />
      {status.aiAvailable ? <DiagnoseBox /> : null}
    </section>
  );
}
