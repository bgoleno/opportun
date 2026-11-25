// Manual capture (FR-D1 manual source): hand over a posting as a link or as pasted text, and
// the server extracts it into the review queue. Opened from the queue for a new posting, or
// from a needs_capture lead to complete that lead in place (its link pre-filled).
//
// Server answers handled here: 422 with a hint (LinkedIn, Indeed and other unfetchable pages:
// paste the text instead), 503 ai_unavailable (fall back to the New Opportunity dialog), 409
// duplicate (with the opportunity it was linked to: #971, or the place its job is in already:
// https://github.com/bgoleno/opportun/issues/1053), 409 company_denied (the posting was stored as
// dismissed: https://github.com/bgoleno/opportun/issues/1044), 429 rate_limited (the user's capture
// budget, shared with the browser extension: https://github.com/bgoleno/opportun/issues/272).
// Server text (hints, messages) and posting fields are rendered as text only.
import { Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { safeHttpUrl } from '@/lib/opportunities';
import { useCapture, type CaptureVars, type DiscoveryResult } from './api';
import { resultLabel } from './QueueRow';

type Mode = 'url' | 'text';

/** What the last failed submit asks of the user. */
type Failure =
  | { kind: 'paste_text'; hint: string }
  | { kind: 'ai_unavailable'; hint: string }
  | { kind: 'decided'; message: string }
  /**
   * No failure, and no card to show: the posting was linked to an opportunity (#971) or stored as
   * dismissed (#1044), or its job is there already (#1053). With the way to it, where there is one;
   * `stored` is what was sent, when the same once more could only be a duplicate.
   */
  | { kind: 'notice'; message: string; to: NoticeLink | null; stored?: CaptureVars }
  | { kind: 'other'; message: string };

type NoticeLink = { opportunityId: string } | 'decided';

/** Where a job that is there already is, as the server names it (#1053), and the way to it. */
function alreadyThere(place: unknown, existingId: string | null): Failure | null {
  const notice = (where: string, to: NoticeLink | null): Failure => ({
    kind: 'notice',
    message: `This job is already in ${where}. Nothing was added.`,
    to,
  });
  switch (place) {
    case 'pipeline':
      return existingId === null ? null : notice('your pipeline', { opportunityId: existingId });
    case 'queue':
      // Behind the dialog: no way to go.
      return notice('your review queue', null);
    case 'dismissed':
      return notice('Decided, as dismissed', 'decided');
    case 'accepted':
      return notice('Decided, in the Accepted tab: its opportunity was deleted', 'decided');
    default:
      return null;
  }
}

const textOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const TEXT_MAX = 200_000;

function validUrl(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? null : 'Enter an https link';
  } catch {
    return 'Enter the posting link';
  }
}

function hintOf(err: ApiError, fallback: string): string {
  const hint = err.details.hint;
  return typeof hint === 'string' && hint.length > 0 ? hint : fallback;
}

const isCount = (v: unknown, most: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= most;

/** The capture budget's refusal: its size when the server gives one, and when it frees up. */
function limitMessage(err: ApiError): string {
  const { max, windowMinutes, retryAfterSec } = err.details;
  const size =
    isCount(max, 10_000) && isCount(windowMinutes, 1440)
      ? ` (${max} captures per ${windowMinutes} minutes, counting the browser extension too)`
      : '';
  const m = isCount(retryAfterSec, 86_400) ? Math.ceil(retryAfterSec / 60) : null;
  const wait = m === null ? 'a few minutes' : `about ${m} minute${m === 1 ? '' : 's'}`;
  return `Capture limit for your account reached${size}. Try again in ${wait}.`;
}

function toFailure(err: unknown, sent: CaptureVars): Failure {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.code === 'rate_limited') {
      return { kind: 'other', message: limitMessage(err) };
    }
    if (err.status === 422 && typeof err.details.hint === 'string') {
      const fetchProblem = ['prohibited_host', 'fetch_blocked', 'fetch_failed'].includes(err.code);
      return fetchProblem
        ? { kind: 'paste_text', hint: hintOf(err, '') }
        : { kind: 'other', message: hintOf(err, errorMessage(err)) };
    }
    // Another capture of yours is being saved and this one could not wait for it (#309). Not the
    // AI: the posting was read, so pressing Capture again in a moment is all it takes.
    if (err.status === 503 && err.code === 'capture_busy') {
      return {
        kind: 'other',
        message:
          'Another capture of yours is still being saved. Wait a few seconds and press Capture again.',
      };
    }
    if (err.status === 503 && err.code === 'ai_unavailable') {
      return {
        kind: 'ai_unavailable',
        hint: hintOf(err, 'AI extraction is unavailable. Add the posting by hand instead.'),
      };
    }
    // The lead was completed or decided somewhere else (#968): no second try can succeed.
    if (err.code === 'not_capturable') return { kind: 'decided', message: errorMessage(err) };
    if (err.code === 'company_denied') {
      return {
        kind: 'notice',
        message: `${textOf(err.details.company) ?? 'The company'} is on your denied list, so the posting was put in Decided as dismissed.`,
        to: 'decided',
        stored: sent,
      };
    }
    if (err.code === 'duplicate') {
      const id = textOf(err.details.existingId);
      if (err.details.place === undefined && id !== null) {
        return {
          kind: 'notice',
          message:
            'This job is already in your pipeline, so the posting was linked to that opportunity.',
          to: { opportunityId: id },
        };
      }
      return (
        alreadyThere(err.details.place, id) ?? {
          kind: 'other',
          message: 'That posting is already in your queue or pipeline.',
        }
      );
    }
  }
  return { kind: 'other', message: errorMessage(err) };
}

/**
 * Mounted while open (the parent unmounts it on close, which resets it). `lead` is a pending
 * needs_capture result to complete; without it the capture adds a new result.
 */
export function CaptureDialog(props: {
  lead?: DiscoveryResult | null;
  onClose: () => void;
  /** Opens the New Opportunity dialog (the manual-entry fallback when AI is unavailable). */
  onManualEntry: () => void;
}) {
  const lead = props.lead ?? null;
  const capture = useCapture();
  const modeName = useId();
  const [mode, setMode] = useState<Mode>('url');
  const [url, setUrl] = useState(() => {
    const href = safeHttpUrl(lead?.posting.postingUrl);
    return href !== null && href.startsWith('https:') ? href : '';
  });
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setFieldError(undefined);
  }

  // The same once more could only be a duplicate. Compared with what was sent: the field can be
  // edited while a capture runs.
  const stored = failure?.kind === 'notice' ? failure.stored : undefined;
  const storedAlready =
    stored !== undefined &&
    (mode === 'url'
      ? 'url' in stored && stored.url === url.trim()
      : 'text' in stored && stored.text === text.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    let body: CaptureVars;
    if (mode === 'url') {
      const value = url.trim();
      const problem = validUrl(value);
      if (problem !== null) {
        setFieldError(problem);
        return;
      }
      body = { url: value };
    } else {
      const value = text.trim();
      if (value === '') {
        setFieldError('Paste the posting description');
        return;
      }
      if (value.length > TEXT_MAX) {
        setFieldError('That text is too long to capture');
        return;
      }
      body = { text: value };
    }
    setFieldError(undefined);
    if (lead !== null) body = { ...body, resultId: lead.id };
    try {
      const res = await capture.mutateAsync(body);
      toast({
        title: lead === null ? 'Posting captured' : 'Description captured',
        description: `${res.posting.title} at ${res.posting.company}`,
        variant: 'success',
      });
      props.onClose();
    } catch (err) {
      setFailure(toFailure(err, body));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{lead === null ? 'Capture posting' : 'Capture description'}</DialogTitle>
          <DialogDescription>
            {lead === null
              ? 'Give a posting link or paste its text. It is added to the review queue.'
              : `Complete the lead for ${resultLabel(lead)} with its full description.`}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={(e) => void submit(e)}>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Capture from</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={modeName}
                  value="url"
                  checked={mode === 'url'}
                  onChange={() => switchMode('url')}
                />
                Link
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name={modeName}
                  value="text"
                  checked={mode === 'text'}
                  onChange={() => switchMode('text')}
                />
                Pasted text
              </label>
            </div>
          </fieldset>

          {mode === 'url' ? (
            <FormField
              label="Posting link"
              hint="An https link to the job posting."
              error={fieldError}
            >
              {(c) => (
                <Input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  {...c}
                />
              )}
            </FormField>
          ) : (
            <FormField
              label="Posting description"
              hint="Paste the whole posting: title, company, location and description."
              error={fieldError}
            >
              {(c) => (
                <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} {...c} />
              )}
            </FormField>
          )}

          {failure?.kind === 'other' || failure?.kind === 'decided' ? (
            <FormError message={failure.message} />
          ) : null}
          {failure?.kind === 'notice' ? (
            <div
              role="alert"
              className="rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm [overflow-wrap:anywhere] text-accent-foreground"
            >
              {failure.message}{' '}
              {failure.to === null ? null : failure.to === 'decided' ? (
                <Link to="/discovery/decided" className="font-medium underline underline-offset-2">
                  View Decided
                </Link>
              ) : (
                <Link
                  to="/opportunities/$id"
                  params={{ id: failure.to.opportunityId }}
                  className="font-medium underline underline-offset-2"
                >
                  View opportunity
                </Link>
              )}
            </div>
          ) : null}
          {failure?.kind === 'paste_text' ? (
            <div
              role="alert"
              className="grid gap-2 rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm text-accent-foreground"
            >
              <p className="break-words">{failure.hint}</p>
              {mode === 'url' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  onClick={() => {
                    setFailure(null);
                    switchMode('text');
                  }}
                >
                  Paste the text instead
                </Button>
              ) : null}
            </div>
          ) : null}
          {failure?.kind === 'ai_unavailable' ? (
            <div
              role="alert"
              className="grid gap-2 rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm text-accent-foreground"
            >
              <p className="break-words">{failure.hint}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={props.onManualEntry}
              >
                New opportunity
              </Button>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={capture.isPending || failure?.kind === 'decided' || storedAlready}
            >
              {capture.isPending ? 'Capturing...' : 'Capture'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
