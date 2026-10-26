// One suggested company (rationale, accept, deny), one followed company (ATS board status,
// careers URL prompt, detect now), and one denied company (undo). Names and rationales are
// model or third-party derived: every field is a React text node (never markdown, never HTML),
// and the careers link is http(s) only.
import { Check, ExternalLink, RefreshCw, Undo2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/api';
import { formatDate, safeHttpUrl } from '@/lib/opportunities';
import { atsLabel, type CompanyView } from './companiesApi';

/**
 * Types a company name and denies it directly (issue #199): the owner's literal ask ("deny
 * Oracle") was impossible before this, since the only other path to 'denied' goes through a
 * suggestion the system already proposed. No subsidiary inference, stated here rather than left
 * for the user to discover by surprise: Oracle owns NetSuite, Microsoft owns LinkedIn and
 * GitHub, and denying the parent does nothing to the subsidiary's own postings. Add each one
 * separately if that is what you want.
 */
export function DenyCompanyForm(props: {
  busy?: boolean;
  onDeny: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = name.trim();
    if (value === '') {
      setError('Enter a company name.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await props.onDeny(value);
      setName('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-2" onSubmit={(e) => void submit(e)} noValidate>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 flex-1 gap-1">
          <Label htmlFor="deny-company-name">Company name</Label>
          <Input
            id="deny-company-name"
            placeholder="Oracle"
            value={name}
            aria-invalid={error !== null}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <Button type="submit" size="sm" variant="destructive" disabled={submitting || props.busy}>
          <X aria-hidden="true" />
          Deny
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Stops new postings from this company reaching your review queue. Denial is per company: it
        will not reach a subsidiary (denying Microsoft does not deny GitHub) or a parent company,
        and does not remove postings already in your queue -- those stay until you dismiss them
        yourself.
      </p>
      <FormError message={error} />
    </form>
  );
}

export function DeniedCompanyRow(props: {
  company: CompanyView;
  busy?: boolean;
  onUndeny: () => void;
}) {
  const { company: c } = props;
  return (
    <li
      aria-label={c.name}
      className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-4"
    >
      <span className="min-w-0 font-medium break-words">{c.name}</span>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto"
        disabled={props.busy}
        onClick={props.onUndeny}
        aria-label={`Undo denying ${c.name}`}
      >
        <Undo2 aria-hidden="true" />
        Undo
      </Button>
    </li>
  );
}

export function SuggestionCard(props: {
  company: CompanyView;
  busy?: boolean;
  onAccept: () => void;
  onDeny: () => void;
}) {
  const { company: c } = props;
  return (
    <li
      aria-label={c.name}
      className="grid gap-2 rounded-xl border bg-card p-4"
      data-company-id={c.id}
    >
      <div className="grid gap-0.5">
        <span className="font-medium break-words">{c.name}</span>
        {c.domain ? (
          <span className="text-sm break-words text-muted-foreground">{c.domain}</span>
        ) : null}
      </div>
      {c.suggestionRationale ? (
        <p className="text-sm break-words">
          <span className="text-muted-foreground">Why: </span>
          {c.suggestionRationale}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={props.busy}
          onClick={props.onAccept}
          aria-label={`Follow ${c.name}`}
        >
          <Check aria-hidden="true" />
          Follow
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onDeny}
          aria-label={`Deny ${c.name}`}
        >
          <X aria-hidden="true" />
          Deny
        </Button>
      </div>
    </li>
  );
}

/** The detected board, when it was verified, or that detection is still running. */
export function AtsStatusChip({ company: c }: { company: CompanyView }) {
  if (c.atsDetectPending) return <Badge variant="outline">Detecting board...</Badge>;
  const found = c.atsKind != null && c.atsKind !== 'none';
  const verified = c.atsVerifiedAt != null ? ` (checked ${formatDate(c.atsVerifiedAt)})` : '';
  return (
    <Badge variant={found ? 'success' : c.atsKind === 'none' ? 'secondary' : 'outline'}>
      {atsLabel(c.atsKind)}
      {found && c.atsRef ? `: ${c.atsRef}` : ''}
      {verified}
    </Badge>
  );
}

export function FollowedCompanyRow(props: {
  company: CompanyView;
  detecting?: boolean;
  onDetect: () => void;
  onSaveCareersUrl: (careersUrl: string) => Promise<unknown>;
}) {
  const { company: c } = props;
  const careers = safeHttpUrl(c.careersUrl);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputId = `careers-url-${c.id}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = url.trim();
    if (safeHttpUrl(value) === null) {
      setError('Enter an http or https URL.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await props.onSaveCareersUrl(value);
      setUrl('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <li aria-label={c.name} className="grid gap-2 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium break-words">{c.name}</span>
        <AtsStatusChip company={c} />
        {careers !== null ? (
          <a
            href={careers}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
          >
            Careers
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={props.detecting === true || c.atsDetectPending}
          onClick={props.onDetect}
          aria-label={`Detect board for ${c.name}`}
        >
          <RefreshCw aria-hidden="true" />
          Detect now
        </Button>
      </div>
      {c.needsCareersUrl ? (
        <form className="grid gap-2" onSubmit={(e) => void submit(e)} noValidate>
          <p className="text-sm text-muted-foreground">
            No job board found. Add the company's careers page so it can be scanned.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid min-w-0 flex-1 gap-1">
              <Label htmlFor={inputId}>Careers URL</Label>
              <Input
                id={inputId}
                type="url"
                inputMode="url"
                placeholder="https://example.com/careers"
                value={url}
                aria-invalid={error !== null}
                onChange={(e) => setUrl(e.currentTarget.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={saving}>
              Save
            </Button>
          </div>
          <FormError message={error} />
        </form>
      ) : null}
    </li>
  );
}
