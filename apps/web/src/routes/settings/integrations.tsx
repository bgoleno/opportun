import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { useGmailStatus, useGmailSync, useSetGmailLookback } from '@/components/comms/api';
import { GoogleQuickLinks, GoogleSetupGuide } from '@/components/google/GoogleSetup';
import {
  resumeErrorMessage,
  rk,
  useDisconnectReactiveResume,
  useDocumentStore,
  useGoogleStatus,
  useReactiveResumeStatus,
  useSaveReactiveResume,
  useSetDocumentStore,
  useValidateReactiveResume,
} from '@/components/resume/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { DevicesCard } from './-devices';
import { GmailLookbackField } from './-gmailLookback';
import { OriginWarning, requiredOrigin } from './-googleOrigin';
import { ReactiveResumeSettings } from './-reactiveResume';

const Search = z.object({
  google: z.enum(['denied', 'error', 'session', 'unavailable']).optional().catch(undefined),
});

export const Route = createFileRoute('/settings/integrations')({
  validateSearch: Search,
  component: IntegrationsSettings,
});

const SCOPE_LABELS = new Map([
  ['https://www.googleapis.com/auth/drive', 'Google Drive: see and copy your files'],
  ['https://www.googleapis.com/auth/documents', 'Google Docs: read and edit documents'],
  ['https://www.googleapis.com/auth/gmail.readonly', 'Gmail: read messages (read-only)'],
]);

function IntegrationsSettings() {
  const { google } = Route.useSearch();
  return (
    <div className="grid gap-6">
      <GoogleCard flash={google} />
      <GmailCard />
      <DevicesCard />
      <ReactiveResumeCard />
      <NamingTemplateCard />
    </div>
  );
}

export function GoogleCard({
  flash,
}: {
  flash: 'denied' | 'error' | 'session' | 'unavailable' | undefined;
}) {
  const status = useGoogleStatus();
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: rk.google });

  const connect = useMutation({
    mutationFn: () => api<{ authUrl: string }>('/integrations/google/connect?scopes=docs'),
    onSuccess: ({ authUrl }) => window.location.assign(authUrl),
  });
  const disconnect = useMutation({
    mutationFn: () => api<void>('/integrations/google', { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const data = status.data;

  return (
    <Card data-tour="google-card">
      <CardHeader>
        <CardTitle>Google</CardTitle>
        <CardDescription>
          Resumes are Google Docs in your own Drive. Connecting grants two permissions: Google Drive
          (to copy a base resume you wrote anywhere in Drive into a tailored copy) and Google Docs
          (to read a resume and apply the edits you accept).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <p>
            Google lists the Drive permission as access to all your files. It is that broad because
            Google offers no narrower scope that can copy a document you created outside this app.
          </p>
          <p>
            The grant goes to your own OAuth client and your own server: the tokens are stored
            encrypted here and no third party sits in the token path. Opportun only touches resume
            documents, and only through actions you take: registering a base resume, creating a
            tailored copy, reading it for tailoring or scoring, and applying an edit you chose.
          </p>
        </div>
        <GoogleQuickLinks />
        {flash === 'denied' ? (
          <FormError message="Google access was not granted. Nothing was changed." />
        ) : flash === 'error' ? (
          <FormError message="Google did not accept the sign-in. Check the client id, secret and redirect URI in the guided setup below, then try again." />
        ) : flash === 'session' ? (
          <FormError message="Google sent you back, but this address had no login session: the connect flow must start and finish on the same address. You are logged in here now, so click Connect Google account again." />
        ) : flash === 'unavailable' ? (
          <FormError message="Something went wrong checking you were signed in. Try again in a moment." />
        ) : null}
        {status.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : status.isError ? (
          <FormError message={errorMessage(status.error)} />
        ) : data?.connected ? (
          <div className="grid gap-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
              Connected{data.email ? ` as ${data.email}` : ''}
            </p>
            <ul className="grid gap-1 text-muted-foreground">
              {data.scopes.map((s) => (
                <li key={s}>{SCOPE_LABELS.get(s) ?? s}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(true)}>
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">
              {data?.clientConfigured
                ? 'Your OAuth client is saved. Connect your account to continue.'
                : 'First save the OAuth client from your Google Cloud project, then connect.'}
            </p>
            {requiredOrigin(data?.redirectUri) !== null ? (
              <OriginWarning origin={requiredOrigin(data?.redirectUri)!} action="connect" />
            ) : null}
            <div>
              <Button
                disabled={
                  !data?.clientConfigured ||
                  connect.isPending ||
                  requiredOrigin(data?.redirectUri) !== null
                }
                onClick={() => connect.mutate()}
              >
                Connect Google account
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Gmail read-only access is a separate grant, requested from the Gmail section below.
            </p>
            {connect.error ? <FormError message={errorMessage(connect.error)} /> : null}
          </div>
        )}

        {data ? <GoogleSetupGuide status={data} /> : null}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect Google?"
        description="Access is revoked at Google and the stored tokens and OAuth client are deleted. Your documents stay in Drive."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutateAsync()}
      />
    </Card>
  );
}

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Gmail ingestion: a separate read-only grant, then sync on demand (and every 15 minutes). */
function GmailCard() {
  const google = useGoogleStatus();
  const gmail = useGmailStatus();
  const sync = useGmailSync();
  const lookback = useSetGmailLookback();
  const connect = useMutation({
    mutationFn: () => api<{ authUrl: string }>('/integrations/google/connect?scopes=gmail'),
    onSuccess: ({ authUrl }) => window.location.assign(authUrl),
  });
  const granted = google.data?.scopes.includes(GMAIL_SCOPE) === true;

  return (
    <Card data-tour="gmail-card">
      <CardHeader>
        <CardTitle>Gmail</CardTitle>
        <CardDescription>
          Reads recruiter mail into the Inbox, where it is classified and linked to your
          opportunities. Access is read-only: Opportun never labels, moves, deletes or sends mail.
          Messages from the last 180 days are read at first, outside spam and trash.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {google.isPending || gmail.isPending ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : granted && gmail.data?.connected ? (
          <>
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
              Gmail read-only access granted
            </p>
            <p className="text-muted-foreground">
              {gmail.data.count} {gmail.data.count === 1 ? 'message' : 'messages'} stored.{' '}
              {gmail.data.lastSyncAt === null
                ? 'Not synced yet.'
                : `Last sync ${new Date(gmail.data.lastSyncAt).toLocaleString()}.`}
              {gmail.data.status === 'error' ? ' The last sync failed; it is retried.' : ''}
            </p>
            <div>
              <Button
                variant="outline"
                disabled={sync.isPending}
                onClick={() =>
                  sync.mutate(undefined, {
                    onSuccess: () => toast({ title: 'Sync queued', variant: 'success' }),
                  })
                }
              >
                Sync now
              </Button>
            </div>
            {sync.error ? <FormError message={errorMessage(sync.error)} /> : null}
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              {google.data?.clientConfigured
                ? 'Grant read-only Gmail access to start.'
                : 'First save the OAuth client in the Google section above.'}
            </p>
            {requiredOrigin(google.data?.redirectUri) !== null ? (
              <OriginWarning origin={requiredOrigin(google.data?.redirectUri)!} action="connect" />
            ) : null}
            <div>
              <Button
                data-tour="gmail-connect"
                disabled={
                  !google.data?.clientConfigured ||
                  connect.isPending ||
                  requiredOrigin(google.data?.redirectUri) !== null
                }
                onClick={() => connect.mutate()}
              >
                Connect Gmail (read-only)
              </Button>
            </div>
            {connect.error ? <FormError message={errorMessage(connect.error)} /> : null}
          </>
        )}
        {gmail.data === undefined ? null : (
          <GmailLookbackField
            value={gmail.data.lookbackDays}
            saving={lookback.isPending}
            onSave={(days) =>
              lookback.mutate(days, {
                onSuccess: () =>
                  toast({
                    title: 'Sync window saved',
                    description: 'The next sync re-reads the window.',
                    variant: 'success',
                  }),
              })
            }
          />
        )}
        {lookback.error ? <FormError message={errorMessage(lookback.error)} /> : null}
      </CardContent>
    </Card>
  );
}

/** Reactive Resume (FR-R7): resumes in the user's own instance instead of Google Docs. */
function ReactiveResumeCard() {
  const status = useReactiveResumeStatus();
  const store = useDocumentStore();
  const save = useSaveReactiveResume();
  const validate = useValidateReactiveResume();
  const disconnect = useDisconnectReactiveResume();
  const setStore = useSetDocumentStore();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const failure = save.error ?? setStore.error ?? validate.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reactive Resume</CardTitle>
        <CardDescription>
          Optional: keep resumes in your own self-hosted Reactive Resume instead of Google Docs.
          Opportun reads them for tailoring and scoring, makes tailored copies, and applies the
          edits you accept, through its API.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status.isPending || store.isPending ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : status.isError ? (
          <FormError message={errorMessage(status.error)} />
        ) : (
          <ReactiveResumeSettings
            status={status.data}
            store={store.data?.store ?? 'google'}
            saving={save.isPending}
            validating={validate.isPending}
            storeSaving={setStore.isPending}
            validation={validate.data ?? null}
            error={failure ? (resumeErrorMessage(failure) ?? errorMessage(failure)) : null}
            onSave={(body) =>
              save.mutate(body, {
                onSuccess: () => {
                  validate.reset();
                  toast({ title: 'Reactive Resume saved', variant: 'success' });
                },
              })
            }
            onValidate={() => validate.mutate()}
            onDisconnect={() => setConfirmOpen(true)}
            onStoreChange={(next) => setStore.mutate(next)}
          />
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect Reactive Resume?"
        description="The stored API key and address are deleted and new resumes go to Google Docs. Your resumes stay in Reactive Resume, and their rows stay here: they work again once you reconnect."
        confirmLabel="Disconnect"
        onConfirm={() => disconnect.mutateAsync().then(() => validate.reset())}
      />
    </Card>
  );
}

const NAMING_KEY = rk.namingTemplate;

function NamingTemplateCard() {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: NAMING_KEY,
    queryFn: () => api<{ template: string }>('/settings/resume-naming-template'),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (template: string) =>
      api<{ template: string }>('/settings/resume-naming-template', {
        method: 'PUT',
        body: { template },
      }),
    onSuccess: (data) => {
      qc.setQueryData(NAMING_KEY, data);
      setDraft(null);
      toast({ title: 'Naming template saved', variant: 'success' });
    },
  });
  const value = draft ?? current.data?.template ?? '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tailored resume names</CardTitle>
        <CardDescription>
          How tailored copies are named in Drive. Placeholders: {'{{displayName}}'}, {'{{company}}'}
          , {'{{roleSlug}}'} (the role title in lowercase with underscores).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(value.trim());
          }}
        >
          <Label htmlFor="naming-template">Template</Label>
          <Input
            id="naming-template"
            value={value}
            maxLength={300}
            disabled={current.isPending}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          {save.error ? <FormError message={errorMessage(save.error)} /> : null}
          <div>
            <Button
              type="submit"
              variant="outline"
              disabled={save.isPending || draft === null || value.trim().length === 0}
            >
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
