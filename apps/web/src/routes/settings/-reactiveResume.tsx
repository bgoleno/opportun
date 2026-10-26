// The Reactive Resume card body (FR-R7): instance address + API key, Validate, Disconnect,
// and the store new base resumes go to. Presentational: integrations.tsx wires the queries.
import { CheckCircle2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import {
  rrValidationMessage,
  type DocumentStorePref,
  type ReactiveResumeStatus,
  type ReactiveResumeValidation,
} from '@/components/resume/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ReactiveResumeSettingsProps {
  status: ReactiveResumeStatus;
  store: DocumentStorePref;
  saving: boolean;
  validating: boolean;
  storeSaving: boolean;
  validation: ReactiveResumeValidation | null;
  /** A server rejection to show (already a message). */
  error: string | null;
  onSave: (body: { baseUrl: string; apiKey?: string }) => void;
  onValidate: () => void;
  onDisconnect: () => void;
  onStoreChange: (store: DocumentStorePref) => void;
}

const sameOrigin = (a: string, b: string | null): boolean =>
  b !== null && a.trim().replace(/\/+$/, '') === b;

export function ReactiveResumeSettings(props: ReactiveResumeSettingsProps) {
  const { status } = props;
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const shownUrl = baseUrl ?? status.baseUrl ?? '';
  // A stored key is only ever sent to the address it was saved with: a new address needs it again.
  const keyNeeded = !status.keySet || !sameOrigin(shownUrl, status.baseUrl);
  const canSave =
    !props.saving &&
    shownUrl.trim().length > 0 &&
    (apiKey.trim().length > 0 || (!keyNeeded && baseUrl !== null));

  function submit(e: FormEvent) {
    e.preventDefault();
    const key = apiKey.trim();
    props.onSave({ baseUrl: shownUrl.trim(), ...(key === '' ? {} : { apiKey: key }) });
    setApiKey('');
    setBaseUrl(null);
  }

  return (
    <div className="grid gap-6 text-sm">
      <div className="grid gap-2 rounded-md border bg-muted/40 px-3 py-2 text-muted-foreground">
        <p data-testid="rr-versions">
          Written for Reactive Resume {status.targetVersions.join(', ')} (its REST API with an API
          key, created in Reactive Resume under Settings, API keys). Earlier versions are not
          supported. The instance must be served over https at a public address: addresses on a
          private network or localhost are refused, like every outbound fetch here.
        </p>
        <p data-testid="rr-lossy">
          Compared with Google Docs, this is lossy: Opportun reads the visible text fields of the
          resume (not dates, links or layout), and an accepted edit replaces text inside one field.
          An edit that crosses bold, italic or link formatting is refused, to be made by hand in
          Reactive Resume. PDF export stays in Reactive Resume.
        </p>
      </div>

      {status.connected ? (
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
          Connected to {status.baseUrl}
        </p>
      ) : null}

      <form onSubmit={submit} className="grid gap-3">
        <div className="grid gap-2">
          <Label htmlFor="rr-base-url">Reactive Resume address</Label>
          <Input
            id="rr-base-url"
            value={shownUrl}
            maxLength={500}
            placeholder="https://resume.example.com"
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="rr-api-key">API key</Label>
          <Input
            id="rr-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            maxLength={4096}
            placeholder={status.keySet ? 'Saved. Enter a new key to replace it.' : ''}
            onChange={(e) => setApiKey(e.currentTarget.value)}
          />
          {status.keySet && keyNeeded && apiKey.trim() === '' ? (
            <p className="text-xs text-muted-foreground">
              The address changed: enter the API key again. A saved key is only sent to the address
              it was saved for.
            </p>
          ) : null}
        </div>
        {props.error !== null ? <FormError message={props.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canSave}>
            Save
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!status.connected || props.validating}
            onClick={props.onValidate}
          >
            Validate
          </Button>
          {status.connected ? (
            <Button type="button" variant="outline" onClick={props.onDisconnect}>
              Disconnect
            </Button>
          ) : null}
        </div>
        {props.validation !== null ? (
          props.validation.ok ? (
            <p className="flex items-center gap-2" role="status">
              <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
              {rrValidationMessage(props.validation)}
            </p>
          ) : (
            <FormError message={rrValidationMessage(props.validation)} />
          )
        ) : null}
      </form>

      <fieldset className="grid gap-2" disabled={props.storeSaving}>
        <legend className="mb-1 font-medium">Where new base resumes go</legend>
        {(
          [
            ['google', 'Google Docs', false],
            ['reactive_resume', 'Reactive Resume', !status.connected],
          ] as const
        ).map(([value, label, disabled]) => (
          <label key={value} className="flex items-center gap-2" htmlFor={`doc-store-${value}`}>
            <input
              id={`doc-store-${value}`}
              type="radio"
              name="document-store"
              value={value}
              checked={props.store === value}
              disabled={disabled}
              onChange={() => props.onStoreChange(value)}
            />
            {label}
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          Existing resumes stay in the store they were registered in, and tailored copies are made
          next to their base, so switching never strands a resume.
        </p>
      </fieldset>
    </div>
  );
}
