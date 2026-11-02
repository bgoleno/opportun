// The apply page (design Part B (c) S2 to S5, https://github.com/bgoleno/opportun/issues/117):
// /opportunities/:id/apply?step=resume|details|review|open, so Back and deep links work and the
// draft lives on the server. One opportunity, one attempt.
//
// Opportun never submits an application. The last step hands off: the server returns the
// employer's address, the browser opens it in a new tab, and the user fills in and submits the
// form there themselves.
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Check, Copy, Download, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { useOpportunity } from '@/components/opportunity/api';
import { useResumes, type Resume } from '@/components/resume/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { API_BASE, ApiError } from '@/lib/api';
import { formatDateTime, safeHttpUrl, type OpportunityView } from '@/lib/opportunities';
import { usableResumes } from './ApplyPanel';
import {
  atsLabel,
  clockTime,
  hostOf,
  isLive,
  snapshotErrorText,
  useCancelSubmission,
  useCreateSubmission,
  useHandoffSubmission,
  useOpportunitySubmissions,
  usePatchSubmission,
  useReviewSubmission,
  type SubmissionPatch,
  type SubmissionView,
} from './api';
import {
  ApplyStepper,
  Notice,
  SubmissionStatusChip,
  WillNotSubmitCallout,
  type StepId,
} from './parts';

export function ApplyPage({
  opportunityId,
  step,
  blocked,
}: {
  opportunityId: string;
  step: StepId;
  blocked: boolean;
}) {
  const opp = useOpportunity(opportunityId);
  const submissions = useOpportunitySubmissions(opportunityId);
  const heading = useRef<HTMLHeadingElement>(null);

  // Moving between steps, and arriving, moves focus to the step's heading (design (g)), as
  // AppShell does. `loaded`: the heading exists only once both queries have answered.
  const loaded = !opp.isPending && !submissions.isPending;
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [step, loaded]);

  if (opp.isPending || submissions.isPending) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }
  if (opp.data === undefined) return <FormError message="This opportunity could not be loaded." />;
  if (submissions.data === null || submissions.data === undefined) {
    return (
      <section className="grid gap-4">
        <BackToOpportunity id={opportunityId} />
        <p className="text-sm text-muted-foreground">Assisted apply is not available here.</p>
      </section>
    );
  }

  const items = submissions.data.items;
  const live = items.find(isLive);
  const o = opp.data;
  const destination = live?.destinationUrl ?? o.atsJobRef?.url ?? '';
  const ats = atsLabel(live?.atsKind ?? o.atsJobRef?.kind ?? '');
  const host = hostOf(destination);
  const requisition = live?.atsExternalId ?? o.atsJobRef?.externalId ?? '';

  return (
    <section className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-4">
      <BackToOpportunity id={o.id} title={o.title} />
      <div className="grid gap-1">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          {headingFor(step, o)}
        </h1>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {o.title}
          {requisition !== '' ? `, ${requisition}` : ''}, on {ats}
        </p>
      </div>
      <ApplyStepper current={step} openLabel={`Open ${ats}`} />
      <WillNotSubmitCallout host={host} />
      {step === 'resume' ? (
        <ResumeStep opp={o} live={live} items={items} />
      ) : live === undefined ? (
        <p className="text-sm text-muted-foreground">
          This application has not started yet.{' '}
          <Link
            to="/opportunities/$id/apply"
            params={{ id: o.id }}
            search={{ step: 'resume' }}
            className="text-primary underline-offset-4 hover:underline"
          >
            Choose a resume first
          </Link>
          .
        </p>
      ) : step === 'details' ? (
        <DetailsStep opp={o} live={live} />
      ) : step === 'review' ? (
        <ReviewStep opp={o} live={live} items={items} ats={ats} host={host} />
      ) : (
        <OpenStep opp={o} live={live} host={host} blocked={blocked} />
      )}
    </section>
  );
}

function headingFor(step: StepId, o: OpportunityView): string {
  if (step === 'review') return 'Check everything before you open the form';
  if (step === 'open') return 'Finish on the application site';
  return `Apply to ${o.companyName}`;
}

function BackToOpportunity({ id, title }: { id: string; title?: string }) {
  return (
    <Link
      to="/opportunities/$id"
      params={{ id }}
      className="inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {title ?? 'Opportunity'}
    </Link>
  );
}

function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

// ---------------------------------------------------------------------------------------------
// S2: Resume

function ResumeStep({
  opp,
  live,
  items,
}: {
  opp: OpportunityView;
  live: SubmissionView | undefined;
  items: SubmissionView[];
}) {
  const navigate = useNavigate();
  const resumes = useResumes();
  const usable = usableResumes(resumes.data?.items ?? [], opp.id);
  const fallback = usable.find((r) => r.opportunityId === opp.id) ?? usable[0];
  const [chosen, setChosen] = useState<string>(live?.resumeId ?? fallback?.id ?? '');
  // One key per attempt: a double click or a retry replays the same draft (M1a).
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const create = useCreateSubmission(opp.id);
  const patch = usePatchSubmission(opp.id);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const resumeId = chosen !== '' ? chosen : (fallback?.id ?? '');
  // The last attempt's review expired and the sweep closed it: start again with its details.
  const expired = items.find(
    (s) => s.status === 'abandoned' && s.failureReason === 'review_expired',
  );

  async function next() {
    setError(null);
    try {
      if (live === undefined) {
        const draft = await create.mutateAsync({ idempotencyKey, resumeId });
        if (
          expired !== undefined &&
          (expired.answers.length > 0 || Object.keys(expired.fields).length > 0)
        ) {
          await patch.mutateAsync({
            id: draft.id,
            patch: { fields: expired.fields, answers: expired.answers },
          });
        }
      } else if (live.resumeId !== resumeId) {
        await patch.mutateAsync({ id: live.id, patch: { resumeId } });
      }
      await navigate({
        to: '/opportunities/$id/apply',
        params: { id: opp.id },
        search: { step: 'details' },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your choice. Try again.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Choose the resume to use</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Only resumes marked Final can be used. The copy is saved when you continue, so later edits
          will not change it.
        </p>
        {usable.length === 0 ? (
          <Notice>
            <span>
              <strong>No final resume yet.</strong> Mark a resume Final on the Resume tab to use it
              here.
            </span>
          </Notice>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={selectId}>Resume</Label>
            <Select id={selectId} value={resumeId} onChange={(e) => setChosen(e.target.value)}>
              {usable.map((r: Resume) => (
                <option key={r.id} value={r.id}>
                  {r.title} ({r.kind === 'tailored' ? 'Tailored' : 'Base'})
                </option>
              ))}
            </Select>
          </div>
        )}
        {live?.status === 'reviewed' && live.resumeId !== resumeId ? (
          <p role="status" className="text-sm text-muted-foreground">
            Your earlier review no longer counts once you change the resume.
          </p>
        ) : null}
        <SavedCopy live={live} />
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void next()}
            disabled={usable.length === 0 || create.isPending || patch.isPending}
          >
            Next: Details
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The saved copy of the resume (#115's snapshot), or why there is none (design S2). */
function SavedCopy({ live }: { live: SubmissionView | undefined }) {
  const patch = usePatchSubmission(live?.opportunityId ?? '');
  if (live === undefined) {
    return (
      <p className="text-sm text-muted-foreground">The saved copy is made when you continue.</p>
    );
  }
  const state = live.snapshotState;
  if (state === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        The saved copy of this resume is not available yet.
      </p>
    );
  }
  if (state === 'pending') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        Preparing your resume file. This usually takes a few seconds.
      </p>
    );
  }
  if (state === 'ready') {
    return (
      <div className="grid gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Saved copy</span>
          <Badge variant="success" className="gap-1">
            <Check className="size-3" aria-hidden="true" />
            Ready
          </Badge>
          {live.resumeSha256 !== null ? (
            <span className="font-mono text-xs text-muted-foreground">
              Fingerprint {live.resumeSha256.slice(0, 8)}
            </span>
          ) : null}
        </div>
        {live.resumeAttachmentId === null ? (
          // The user deleted the file from Attachments; the server keeps its fingerprint.
          <p className="text-muted-foreground">
            The saved file was deleted. Its fingerprint is kept, so this application still records
            which resume it used.
          </p>
        ) : (
          <Button variant="outline" size="sm" asChild className="w-fit">
            <a href={`${API_BASE}/submissions/${encodeURIComponent(live.id)}/snapshot`} download>
              <Download className="size-4" aria-hidden="true" />
              Download copy
            </a>
          </Button>
        )}
      </div>
    );
  }
  return (
    <div role="alert" className="grid gap-2 text-sm">
      <p>{snapshotErrorText(live.snapshotError)}</p>
      {state === 'failed' && live.resumeId !== null ? (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={patch.isPending}
          onClick={() =>
            void patch.mutateAsync({ id: live.id, patch: { resumeId: live.resumeId as string } })
          }
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// S3: Details

/** The profile values a form usually asks for. Keys follow the server's field-name rule. */
export const DETAIL_FIELDS = [
  { key: 'fullName', label: 'Full name', type: 'text', autoComplete: 'name' },
  { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel', autoComplete: 'tel' },
  { key: 'location', label: 'Location', type: 'text', autoComplete: 'address-level2' },
  { key: 'workAuthorization', label: 'Work authorisation', type: 'text', autoComplete: 'off' },
  { key: 'links', label: 'Links', type: 'text', autoComplete: 'url' },
] as const;

interface AnswerRow {
  label: string;
  value: string;
}

function sortedEntries(o: Record<string, string>): [string, string][] {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}

function DetailsStep({ opp, live }: { opp: OpportunityView; live: SubmissionView }) {
  const navigate = useNavigate();
  const patch = usePatchSubmission(opp.id);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...live.fields }));
  const [answers, setAnswers] = useState<AnswerRow[]>(() =>
    live.answers.map((a) => ({ label: a.label, value: a.value })),
  );
  const [error, setError] = useState<string | null>(null);
  const canEdit = live.status === 'draft' || live.status === 'reviewed';

  async function save() {
    setError(null);
    const cleanFields = Object.fromEntries(
      Object.entries(fields)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([, v]) => v !== ''),
    );
    const cleanAnswers = answers
      .map((a) => ({ label: a.label.trim(), value: a.value.trim() }))
      .filter((a) => a.label !== '' && a.value !== '')
      .map((a, i) => ({
        questionKey: `question_${i + 1}`,
        label: a.label,
        value: a.value,
        source: 'user' as const,
      }));
    const body: SubmissionPatch = { fields: cleanFields, answers: cleanAnswers };
    // Nothing changed: no write, so stepping back and forward keeps a valid review.
    const unchanged =
      JSON.stringify(sortedEntries(cleanFields)) === JSON.stringify(sortedEntries(live.fields)) &&
      JSON.stringify(cleanAnswers.map((a) => [a.label, a.value])) ===
        JSON.stringify(live.answers.map((a) => [a.label, a.value]));
    try {
      // Any edit after a review sends the attempt back to draft: the user reviews again
      // (#117 criterion 2).
      if (!unchanged) await patch.mutateAsync({ id: live.id, patch: body });
      await navigate({
        to: '/opportunities/$id/apply',
        params: { id: opp.id },
        search: { step: 'review' },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your details. Try again.');
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Used to fill the form. Changes here apply to this application only, not to your profile.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {DETAIL_FIELDS.map((f) => (
              <div key={f.key} className="grid gap-1.5">
                <Label htmlFor={`field-${f.key}`}>{f.label}</Label>
                <Input
                  id={`field-${f.key}`}
                  type={f.type}
                  autoComplete={f.autoComplete}
                  value={fields[f.key] ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Questions on this form</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            This site asks its own questions. You will answer them on the form before you press its
            Submit button. If you want them on your review, add the question and your answer here.
          </p>
          {answers.map((a, i) => (
            <fieldset key={i} className="grid gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">Question {i + 1}</legend>
              <div className="grid gap-1.5">
                <Label htmlFor={`q-label-${i}`}>Question</Label>
                <Input
                  id={`q-label-${i}`}
                  value={a.label}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setAnswers((prev) =>
                      prev.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)),
                    )
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`q-value-${i}`}>Your answer</Label>
                <Textarea
                  id={`q-value-${i}`}
                  value={a.value}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setAnswers((prev) =>
                      prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)),
                    )
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="w-fit"
                disabled={!canEdit}
                onClick={() => setAnswers((prev) => prev.filter((_, j) => j !== i))}
              >
                Remove question {i + 1}
              </Button>
            </fieldset>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={!canEdit}
            onClick={() => setAnswers((prev) => [...prev, { label: '', value: '' }])}
          >
            Add a question
          </Button>
        </CardContent>
      </Card>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" asChild>
          <Link to="/opportunities/$id/apply" params={{ id: opp.id }} search={{ step: 'resume' }}>
            Back
          </Link>
        </Button>
        <Button onClick={() => void save()} disabled={!canEdit || patch.isPending}>
          Next: Review
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// S4: Review (the gate)

/** Design Part B, S4 "Snapshot pending". */
const SNAPSHOT_PENDING_TEXT =
  'Still preparing your resume file. The Confirm button turns on when it is ready.';
const SNAPSHOT_FAILED_HINT =
  'Your resume file could not be saved. Go to the resume step to try again.';

type Banner =
  | { kind: 'stale' }
  | { kind: 'expired'; at: number }
  | { kind: 'cap'; resetAt: number | null }
  | { kind: 'destination' }
  | { kind: 'error' };

function ReviewStep({
  opp,
  live,
  items,
  ats,
  host,
}: {
  opp: OpportunityView;
  live: SubmissionView;
  items: SubmissionView[];
  ats: string;
  host: string;
}) {
  const navigate = useNavigate();
  const review = useReviewSubmission(opp.id);
  const handoff = useHandoffSubmission(opp.id);
  const patch = usePatchSubmission(opp.id);
  const cancel = useCancelSubmission(opp.id);
  const [ticked, setTicked] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const checkboxId = useId();
  const hintId = useId();
  const checkbox = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const busy = review.isPending || handoff.isPending || patch.isPending;

  const now = Date.now();
  const reviewedAndValid =
    live.status === 'reviewed' && live.reviewExpiresAt !== null && live.reviewExpiresAt > now;
  const reviewedButExpired =
    live.status === 'reviewed' && live.reviewExpiresAt !== null && live.reviewExpiresAt <= now;
  const earlier = items.find(
    (s) => s.id !== live.id && ['submitted', 'confirmed', 'unknown'].includes(s.status),
  );
  const digestReady = live.reviewDigest !== undefined;
  // The server refuses a review while the saved copy is being made or could not be made (#115:
  // 409 snapshot_pending, snapshot_failed); `ready` and `unsupported` may be reviewed.
  const snapshotBlock =
    live.snapshotState === 'pending'
      ? 'pending'
      : live.snapshotState === 'failed'
        ? 'failed'
        : null;
  const confirmDisabled =
    !reviewedAndValid && (!ticked || !digestReady || busy || snapshotBlock !== null);

  useEffect(() => {
    if (banner !== null) bannerRef.current?.focus();
  }, [banner]);
  // A hint about the saved copy stops applying once its state changes (it polls to ready).
  useEffect(() => {
    setHint(null);
  }, [snapshotBlock]);

  if (live.status === 'handed_off') {
    return (
      <p className="text-sm text-muted-foreground">
        This application was opened on {ats}.{' '}
        <Link
          to="/opportunities/$id/apply"
          params={{ id: opp.id }}
          search={{ step: 'open' }}
          className="text-primary underline-offset-4 hover:underline"
        >
          See what to do next
        </Link>
        .
      </p>
    );
  }

  async function confirm() {
    if (confirmDisabled) {
      // aria-disabled, not disabled: say why and move to what unlocks it (design S4).
      if (snapshotBlock === 'pending') {
        setHint(SNAPSHOT_PENDING_TEXT);
      } else if (snapshotBlock === 'failed') {
        setHint(SNAPSHOT_FAILED_HINT);
      } else {
        setHint('Tick the box to continue.');
        checkbox.current?.focus();
      }
      return;
    }
    setBanner(null);
    // Opened inside the click, so a pop-up blocker allows it; pointed at the address only once
    // the server has handed off. Nothing is opened if anything is refused.
    const tab = window.open('about:blank', '_blank');
    try {
      if (!reviewedAndValid) {
        await review.mutateAsync({ id: live.id, reviewDigest: live.reviewDigest as string });
      }
      const out = await handoff.mutateAsync(live.id);
      if (tab !== null) {
        tab.opener = null;
        tab.location.href = out.destinationUrl;
      }
      await navigate({
        to: '/opportunities/$id/apply',
        params: { id: opp.id },
        search: { step: 'open', ...(tab === null ? { blocked: true } : {}) },
      });
    } catch (err) {
      tab?.close();
      setTicked(false);
      const code = errorCode(err);
      if (code === 'review_stale') setBanner({ kind: 'stale' });
      else if (code === 'review_expired')
        setBanner({ kind: 'expired', at: live.reviewExpiresAt ?? now });
      else if (code === 'daily_review_cap') {
        const resetAt = err instanceof ApiError ? Number(err.details.resetAt) : NaN;
        setBanner({ kind: 'cap', resetAt: Number.isFinite(resetAt) ? resetAt : null });
      } else if (code === 'destination_not_allowed') setBanner({ kind: 'destination' });
      // The saved copy changed state under the screen: the refreshed row shows which (below).
      else if (code === 'snapshot_pending' || code === 'snapshot_failed') setBanner(null);
      else setBanner({ kind: 'error' });
    }
  }

  async function reviewAgain() {
    // An unchanged edit sends the attempt back to draft, so it can be reviewed afresh.
    await patch.mutateAsync({ id: live.id, patch: { fields: live.fields } });
    setBanner(null);
    setTicked(false);
  }

  const expiredAt =
    banner?.kind === 'expired' ? banner.at : reviewedButExpired ? live.reviewExpiresAt : null;

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        This is what Opportun will help you put on the form. Nothing leaves Opportun from this page.
      </p>
      <div ref={bannerRef} tabIndex={-1} className="grid gap-2 outline-none">
        {earlier !== undefined ? (
          <Notice>
            <span>
              <strong>You already applied to this role.</strong> You submitted{' '}
              {earlier.atsExternalId}
              {earlier.submittedAt !== null ? ` on ${formatDateTime(earlier.submittedAt)}` : ''} (
              <SubmissionStatusChip status={earlier.status} />
              ). Applying twice can look like a mistake to the employer.
            </span>
          </Notice>
        ) : null}
        {banner?.kind === 'stale' ? (
          <Notice role="alert">
            <span>
              <strong>Something changed while you were reviewing.</strong> Your earlier review no
              longer counts. Check everything below, then review again.
            </span>
            {live.status === 'reviewed' ? (
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => void reviewAgain()}
                disabled={busy}
              >
                Review again
              </Button>
            ) : null}
          </Notice>
        ) : null}
        {expiredAt !== null ? (
          <Notice role="alert">
            <span>
              <strong>Your review expired at {clockTime(expiredAt)}.</strong> Review again so what
              you checked is what you use. Nothing was lost.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => void reviewAgain()}
              disabled={busy}
            >
              Review again
            </Button>
          </Notice>
        ) : null}
        {!reviewedAndValid && snapshotBlock === 'pending' ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
            {SNAPSHOT_PENDING_TEXT}
          </p>
        ) : null}
        {!reviewedAndValid && snapshotBlock === 'failed' ? (
          <Notice role="alert">
            <span>
              <strong>Opportun could not save a PDF of this resume.</strong>{' '}
              {snapshotErrorText(live.snapshotError)}{' '}
              <Link
                to="/opportunities/$id/apply"
                params={{ id: opp.id }}
                search={{ step: 'resume' }}
                className="text-primary underline-offset-4 hover:underline"
              >
                Go to the resume step
              </Link>{' '}
              to try again. Nothing was lost.
            </span>
          </Notice>
        ) : null}
        {banner?.kind === 'cap' ? (
          <Notice role="alert">
            <span>
              <strong>Review limit reached for today.</strong>{' '}
              {banner.resetAt !== null
                ? `You can confirm another after ${formatDateTime(banner.resetAt)}.`
                : 'You can confirm another later.'}{' '}
              Your draft is saved.
            </span>
          </Notice>
        ) : null}
        {banner?.kind === 'destination' ? (
          <FormError message="This posting's address cannot be opened from here. Check the posting on the Details tab. Nothing was opened." />
        ) : null}
        {banner?.kind === 'error' ? (
          <FormError message="Could not save your review. Nothing was opened. Check your connection and try again." />
        ) : null}
      </div>

      <ReviewSection title="Where it goes">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Application site</dt>
          <dd>{ats}</dd>
          <dt className="text-muted-foreground">Company, role</dt>
          <dd className="[overflow-wrap:anywhere]">
            {opp.companyName}, {opp.title}
          </dd>
          <dt className="text-muted-foreground">Requisition</dt>
          <dd className="font-mono">{live.atsExternalId}</dd>
          <dt className="text-muted-foreground">Address</dt>
          <dd>
            {/* The whole address, query included: it is exactly what the review covers. */}
            <span className="font-mono [overflow-wrap:anywhere]">{live.destinationUrl}</span>
            <span className="block text-xs text-muted-foreground">Opens in a new tab.</span>
          </dd>
        </dl>
      </ReviewSection>

      <ReviewSection title="Resume">
        <p className="text-sm">
          {live.resumeTitle ?? 'Resume'}
          {live.resumeSha256 !== null ? (
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              Fingerprint {live.resumeSha256.slice(0, 8)}
            </span>
          ) : null}
        </p>
        <p className="text-sm text-muted-foreground">
          {live.snapshotState === 'ready'
            ? 'The saved copy is the file you will attach.'
            : live.snapshotState === 'unsupported' || live.snapshotState === 'failed'
              ? 'You will attach the resume file yourself on the application site.'
              : 'The saved copy of this resume is not available yet.'}
        </p>
      </ReviewSection>

      <ReviewSection title="Your details">
        {Object.keys(live.fields).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No details entered. You fill them in on the form.
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {Object.entries(live.fields).map(([key, value]) => (
              <DetailRow
                key={key}
                label={DETAIL_FIELDS.find((f) => f.key === key)?.label ?? key}
                value={value}
              />
            ))}
          </dl>
        )}
      </ReviewSection>

      <ReviewSection title="Your answers">
        {live.answers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No answers entered.</p>
        ) : (
          <dl className="grid gap-2 text-sm">
            {live.answers.map((a) => (
              <div key={a.questionKey} className="grid gap-0.5">
                <dt className="font-medium [overflow-wrap:anywhere]">{a.label}</dt>
                <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{a.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="text-xs text-muted-foreground">
          Anything else the site asks, you answer on the form.
        </p>
      </ReviewSection>

      <section
        aria-labelledby="gate-title"
        className="grid gap-3 rounded-xl border-2 border-primary bg-card p-4"
      >
        <h2 id="gate-title" className="text-base font-semibold">
          Ready to open the form?
        </h2>
        {reviewedAndValid ? (
          <p className="text-sm">
            Your review is saved. It stays valid until {clockTime(live.reviewExpiresAt as number)}.
          </p>
        ) : (
          <div className="flex items-start gap-2">
            <Checkbox
              ref={checkbox}
              id={checkboxId}
              checked={ticked}
              onCheckedChange={(v) => {
                setTicked(v === true);
                setHint(null);
              }}
              disabled={expiredAt !== null}
            />
            <Label htmlFor={checkboxId} className="text-sm font-normal leading-snug">
              I have read the resume and my answers, and I will press Submit myself on{' '}
              <span className="font-mono [overflow-wrap:anywhere]">{host}</span>.
            </Label>
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            onClick={() => void confirm()}
            aria-disabled={confirmDisabled ? 'true' : undefined}
            aria-describedby={hintId}
            className={confirmDisabled ? 'opacity-50' : undefined}
          >
            {reviewedAndValid ? `Open ${host}` : `Confirm review and open ${host}`}
          </Button>
          <Button variant="outline" asChild>
            <Link
              to="/opportunities/$id/apply"
              params={{ id: opp.id }}
              search={{ step: 'details' }}
            >
              Back
            </Link>
          </Button>
          <Button variant="ghost" onClick={() => setStopping(true)}>
            Cancel application
          </Button>
        </div>
        <p id={hintId} className="text-sm text-muted-foreground" aria-live="polite">
          {hint ??
            (reviewedAndValid
              ? 'The form opens in a new tab.'
              : !digestReady
                ? 'The review step is not available on this server yet.'
                : snapshotBlock === 'pending'
                  ? SNAPSHOT_PENDING_TEXT
                  : snapshotBlock === 'failed'
                    ? SNAPSHOT_FAILED_HINT
                    : 'Tick the box to continue. Once you confirm, your review stays valid for 30 minutes, until a time shown here.')}
        </p>
      </section>
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title="Stop this application?"
        description="Nothing was submitted. You can start again later."
        confirmLabel="Stop application"
        onConfirm={async () => {
          await cancel.mutateAsync(live.id);
          await navigate({ to: '/opportunities/$id', params: { id: opp.id } });
        }}
      />
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2 rounded-xl border bg-card p-4">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{value}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// S5: Open the application site (handoff)

function OpenStep({
  opp,
  live,
  host,
  blocked,
}: {
  opp: OpportunityView;
  live: SubmissionView;
  host: string;
  blocked: boolean;
}) {
  const navigate = useNavigate();
  const cancel = useCancelSubmission(opp.id);
  const [stopping, setStopping] = useState(false);

  if (live.status !== 'handed_off') {
    return (
      <p className="text-sm text-muted-foreground">
        The form has not been opened yet.{' '}
        <Link
          to="/opportunities/$id/apply"
          params={{ id: opp.id }}
          search={{ step: 'review' }}
          className="text-primary underline-offset-4 hover:underline"
        >
          Go to the review
        </Link>
        .
      </p>
    );
  }

  // The server hands off only an https address it checked; never trust it into an href blindly.
  const href = safeHttpUrl(live.destinationUrl);
  const link =
    href === null ? (
      <span className="font-mono [overflow-wrap:anywhere]">{live.destinationUrl}</span>
    ) : (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-primary underline-offset-4 [overflow-wrap:anywhere] hover:underline"
      >
        Open {host}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );

  return (
    <div className="grid gap-4">
      {blocked ? (
        <Notice role="alert">
          <span>Your browser blocked the new tab. {link} yourself.</span>
        </Notice>
      ) : (
        <p
          role="status"
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-foreground"
        >
          The form opened in a new tab. Opportun has not submitted anything and cannot see that
          page.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">On the application site</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <ol className="grid list-decimal gap-1 pl-5">
              <li>Fill in the form, copying from your details below.</li>
              <li>Attach your resume.</li>
              <li>Answer any other questions the site asks.</li>
              <li>Press the site&apos;s own Submit button. Only you can do this.</li>
            </ol>
            <p>Did the tab not open? {link}.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">When you are done</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>Opportun cannot tell whether you submitted. It only records what you tell it.</p>
            <Button variant="outline" className="w-fit" onClick={() => setStopping(true)}>
              I did not submit it
            </Button>
            {live.handedOffAt !== null ? (
              <p className="text-xs text-muted-foreground">
                Opened {formatDateTime(live.handedOffAt)}. There is no deadline here: come back
                whenever you finish.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <CopyDetails live={live} />
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title="Stop this application?"
        description="Nothing was submitted. You can start again later."
        confirmLabel="Stop application"
        onConfirm={async () => {
          await cancel.mutateAsync(live.id);
          await navigate({ to: '/opportunities/$id', params: { id: opp.id } });
        }}
      />
    </div>
  );
}

/** Your details to copy, one button each: the path without the extension (design (g)). */
function CopyDetails({ live }: { live: SubmissionView }) {
  const [copied, setCopied] = useState<string | null>(null);
  const rows = [
    ...Object.entries(live.fields).map(([k, v]) => ({
      key: `field-${k}`,
      label: DETAIL_FIELDS.find((f) => f.key === k)?.label ?? k,
      value: v,
    })),
    ...live.answers.map((a) => ({
      key: `answer-${a.questionKey}`,
      label: a.label,
      value: a.value,
    })),
  ];
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your details to copy</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-start justify-between gap-2">
              <span className="grid min-w-0 gap-0.5">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{r.value}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                // A whole name, not text plus an sr-only span: name computation can drop the space.
                aria-label={`${copied === r.key ? 'Copied' : 'Copy'} ${r.label}`}
                onClick={() => {
                  void navigator.clipboard?.writeText(r.value).then(() => setCopied(r.key));
                }}
              >
                <Copy className="size-4" aria-hidden="true" />
                {copied === r.key ? 'Copied' : 'Copy'}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
