// The apply page (design Part B (c) S2 to S5, https://github.com/bgoleno/opportun/issues/117):
// /opportunities/:id/apply?step=resume|details|review|open, so Back and deep links work and the
// draft lives on the server. One opportunity, one attempt.
//
// Opportun never submits an application. The last step hands off: the server returns the
// employer's address, the browser opens it in a new tab, and the user fills in and submits the
// form there themselves.
import { submissionFieldProblem, type ApplicationDetailKey } from '@opportun/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Check, Copy, Download, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
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
import { cn } from '@/lib/utils';
import { usableResumes } from './ApplyPanel';
import {
  atsLabel,
  clockTime,
  hostOf,
  DETAIL_FIELDS,
  detailLabel,
  detailRows,
  isLive,
  profileDetail,
  snapshotErrorText,
  sourceText,
  submissionErrorText,
  useApplicationDetails,
  useAttestSubmission,
  useCancelSubmission,
  useCreateSubmission,
  useExtensionCanFill,
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
  PostingChangedNotice,
  postingMoved,
  SubmissionStatusChip,
  WillNotSubmitCallout,
  type StepId,
} from './parts';
import { ReviewUsageLine } from './ReviewUsage';
import { useProfile } from '@/routes/settings/-api';

export function ApplyPage({
  opportunityId,
  step,
  blocked = false,
  cleared,
}: {
  opportunityId: string;
  step: StepId;
  blocked?: boolean;
  /** Details a start-again did not carry over, named on the details step (#186). */
  cleared?: string[];
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
      ) : live === undefined && items[0]?.failureReason === 'review_expired' ? (
        // The sweep closed a review that was not used in time (tl on #138).
        <Notice role="alert">
          <span>
            <strong>Your review expired and this application was closed.</strong> Nothing was
            submitted. Start again from the{' '}
            <Link
              to="/opportunities/$id/apply"
              params={{ id: o.id }}
              search={{ step: 'resume' }}
              className="text-primary underline-offset-4 hover:underline"
            >
              resume step
            </Link>
            : your details are kept.
          </span>
        </Notice>
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
        <DetailsStep opp={o} live={live} cleared={cleared ?? []} />
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
      let cleared: string[] = [];
      if (live === undefined) {
        const draft = await create.mutateAsync({ idempotencyKey, resumeId });
        if (expired !== undefined) {
          // Only what passes today's checks is carried over (#186): a value stored before a
          // check existed would refuse the whole copy. What is dropped is named on the next step.
          const entries = Object.entries(expired.fields);
          const passes = ([k, v]: [string, string]) =>
            submissionFieldProblem(Object.fromEntries([[k, v]])) === null;
          const carried = Object.fromEntries(entries.filter(passes));
          cleared = entries.filter((e) => !passes(e)).map(([k]) => k);
          // Merged over what the server filled the new draft with (#401): the expired attempt's
          // values win, and the profile fills only the fields that attempt left empty.
          const fields = { ...draft.fields, ...carried };
          if (expired.answers.length > 0 || Object.keys(carried).length > 0) {
            await patch.mutateAsync({
              id: draft.id,
              patch: { fields, answers: expired.answers },
            });
          }
        }
      } else if (live.resumeId !== resumeId) {
        await patch.mutateAsync({ id: live.id, patch: { resumeId } });
      }
      await navigate({
        to: '/opportunities/$id/apply',
        params: { id: opp.id },
        search: { step: 'details', ...(cleared.length > 0 ? { cleared } : {}) },
      });
    } catch (err) {
      setError(submissionErrorText(err));
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

/**
 * The saved copy of the resume (#115's snapshot), or why there is none: on the resume step
 * (design S2), and on the review (S4, criterion 1), where pending and failed are already said by
 * the gate's own notices and so are only named here.
 */
export function SavedCopy({
  live,
  where = 'resume',
}: {
  live: SubmissionView | undefined;
  where?: 'resume' | 'review';
}) {
  const patch = usePatchSubmission(live?.opportunityId ?? '');
  const [error, setError] = useState<string | null>(null);
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
    return where === 'review' ? (
      <p className="text-sm text-muted-foreground">The saved copy is still being prepared.</p>
    ) : (
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
            which resume it used. Attach your resume yourself on the application site.
          </p>
        ) : (
          <>
            <Button variant="outline" size="sm" asChild className="w-fit">
              <a href={`${API_BASE}/submissions/${encodeURIComponent(live.id)}/snapshot`} download>
                <Download className="size-4" aria-hidden="true" />
                Download the saved copy (PDF)
              </a>
            </Button>
            {/* sec on #117: not "immutable" outright; the user can delete the file. */}
            <p className="text-xs text-muted-foreground">
              This copy cannot change. You can delete it from Attachments: the file goes, and its
              fingerprint stays on this application.
            </p>
          </>
        )}
      </div>
    );
  }
  if (where === 'review') {
    return (
      <p className="text-sm text-muted-foreground">
        {state === 'unsupported'
          ? 'You will attach the resume file yourself on the application site.'
          : 'The saved copy could not be made (see above).'}
      </p>
    );
  }
  async function retry(resumeId: string) {
    setError(null);
    try {
      await patch.mutateAsync({ id: (live as SubmissionView).id, patch: { resumeId } });
    } catch (err) {
      setError(submissionErrorText(err));
    }
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
          onClick={() => void retry(live.resumeId as string)}
        >
          Try again
        </Button>
      ) : null}
      <FormError message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// S3: Details

interface AnswerRow {
  label: string;
  value: string;
}

function sortedEntries(o: Record<string, string>): [string, string][] {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}

/** "From your profile" as it reads inside a sentence: "from your profile". */
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function DetailsStep({
  opp,
  live,
  cleared,
}: {
  opp: OpportunityView;
  live: SubmissionView;
  cleared: string[];
}) {
  const navigate = useNavigate();
  const patch = usePatchSubmission(opp.id);
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...live.fields }));
  const [answers, setAnswers] = useState<AnswerRow[]>(() =>
    live.answers.map((a) => ({ label: a.label, value: a.value })),
  );
  const [error, setError] = useState<string | null>(null);
  const canEdit = live.status === 'draft' || live.status === 'reviewed';
  // What Opportun holds, with sources, and the profile as saved (#401). Either may be missing
  // (not loaded yet, or unreadable): the step then shows no source line and no tick, and works.
  const prefill = useApplicationDetails(live.id).data ?? null;
  const profile = useProfile().data ?? null;
  const [ticked, setTicked] = useState<ReadonlySet<ApplicationDetailKey>>(() => new Set());
  const valueOf = (key: string): string | undefined => new Map(Object.entries(fields)).get(key);

  /**
   * How a field's value stands against the profile: null when the profile holds the same (or is
   * not known); `missing` when the profile has none; `differs` when it holds another value;
   * `removing` when the step's field is empty and the profile's is not (tl on #415: the tick then
   * removes it).
   */
  function profileDiff(key: ApplicationDetailKey): 'missing' | 'differs' | 'removing' | null {
    if (profile === null) return null;
    const held = profileDetail(profile, key).trim();
    const value = (valueOf(key) ?? '').trim();
    // A value the server gives from the profile with no detail saved (LinkedIn profile, or Links,
    // from the profile's links) is the profile's too (tl on #430): unchanged it needs no tick,
    // changed it differs, and emptied there is nothing saved to remove.
    const given =
      held === ''
        ? prefill?.values.find((v) => v.key === key && v.source.kind === 'profile')
        : undefined;
    if (given !== undefined) {
      return value === '' || value === given.value.trim() ? null : 'differs';
    }
    if (value === held) return null;
    if (held === '') return 'missing';
    return value === '' ? 'removing' : 'differs';
  }

  /** The source line under a field: only while it still holds the value it was filled with. */
  function sourceOf(key: ApplicationDetailKey): string | null {
    const filled = prefill?.values.find((v) => v.key === key);
    return filled !== undefined && (valueOf(key) ?? '') === filled.value
      ? sourceText(filled.source)
      : null;
  }

  // What Opportun holds but could not fill in, because it fails today's checks (#411, tl rule 4),
  // for fields still empty here and not already named by the start-again notice.
  const notFilled = (prefill?.leftOut ?? []).filter(
    (l) => (valueOf(l.key) ?? '').trim() === '' && !cleared.includes(l.key),
  );

  async function save() {
    setError(null);
    // The ticked fields that still differ from the profile: a tick on a field changed back to
    // the profile's value saves nothing.
    const saveToProfile = DETAIL_FIELDS.map((f) => f.key).filter(
      (k) => ticked.has(k) && profileDiff(k) !== null,
    );
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
    // The draft and the ticked names in one request: the server writes both, or neither.
    const body: SubmissionPatch = {
      fields: cleanFields,
      answers: cleanAnswers,
      ...(saveToProfile.length > 0 ? { saveToProfile } : {}),
    };
    // Nothing changed and nothing to save: no write, so stepping back and forward keeps a valid
    // review.
    const unchanged =
      saveToProfile.length === 0 &&
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
      setError(submissionErrorText(err));
    }
  }

  return (
    <div className="grid gap-4">
      {cleared.length > 0 ? (
        <Notice label="Details not carried over">
          <span>
            Not carried over from your earlier application, because they no longer pass the checks:{' '}
            {cleared.map(detailLabel).join(', ')}. Enter them again if you need them.
          </span>
        </Notice>
      ) : null}
      {notFilled.length > 0 ? (
        <Notice label="Details not filled in">
          <span>
            Not filled in, because the value Opportun holds does not pass the checks:{' '}
            {notFilled
              .map((l) => `${detailLabel(l.key)} (${lowerFirst(sourceText(l.source))})`)
              .join(', ')}
            . Enter them if you need them.
          </span>
        </Notice>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Used to fill the form. Filled in from your profile where it has a value. Changes here
            apply to this application only, unless you tick Save to my profile.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {DETAIL_FIELDS.map((f) => {
              const source = sourceOf(f.key);
              const diff = profileDiff(f.key);
              const sourceId = `field-${f.key}-source`;
              const hintId = `field-${f.key}-hint`;
              const describedBy = [
                ...(f.hint === undefined ? [] : [hintId]),
                ...(source === null ? [] : [sourceId]),
              ].join(' ');
              return (
                <div key={f.key} className="grid gap-1.5">
                  <Label id={`field-${f.key}-label`} htmlFor={`field-${f.key}`}>
                    {f.label}
                  </Label>
                  <Input
                    id={`field-${f.key}`}
                    type={f.type}
                    autoComplete={f.autoComplete}
                    value={fields[f.key] ?? ''}
                    disabled={!canEdit}
                    aria-describedby={describedBy === '' ? undefined : describedBy}
                    onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  />
                  {f.hint === undefined ? null : (
                    <p id={hintId} className="text-xs text-muted-foreground">
                      {f.hint}
                    </p>
                  )}
                  {source === null ? null : (
                    <p id={sourceId} className="text-xs text-muted-foreground">
                      {source}
                    </p>
                  )}
                  {diff === null ? null : (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="text-muted-foreground">
                        {diff === 'missing' ? 'Not in your profile' : 'Differs from your profile'}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {/* Named for what it does; the field it belongs to is its description,
                            so the field's own label names one control only (getByLabel, and a
                            screen reader's list of form fields). */}
                        <Checkbox
                          id={`save-${f.key}`}
                          aria-describedby={`field-${f.key}-label`}
                          checked={ticked.has(f.key)}
                          disabled={!canEdit}
                          onCheckedChange={(v) =>
                            setTicked((prev) => {
                              const next = new Set(prev);
                              if (v === true) next.add(f.key);
                              else next.delete(f.key);
                              return next;
                            })
                          }
                        />
                        <Label htmlFor={`save-${f.key}`} className="text-xs font-normal">
                          {diff === 'removing' ? 'Remove from my profile' : 'Save to my profile'}
                        </Label>
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
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
  | { kind: 'rate'; until: number | null }
  | { kind: 'destination' }
  | { kind: 'changed' }
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
  const canFill = useExtensionCanFill(live, opp);
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
  // Set in the click itself: two clicks in one tick both see `busy` still false (tl on #138).
  const inFlight = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Applying again to a requisition already applied to needs a typed reason (owner decision 6,
  // M2a #118): asked when this opportunity shows an earlier application, or when the server
  // finds one elsewhere (422 reapply_reason_required).
  const [reason, setReason] = useState('');
  const [serverAsksReason, setServerAsksReason] = useState(false);
  const reasonId = useId();
  const reasonHelpId = useId();
  const reasonField = useRef<HTMLTextAreaElement>(null);

  const now = Date.now();
  const reviewedAndValid =
    live.status === 'reviewed' && live.reviewExpiresAt !== null && live.reviewExpiresAt > now;
  const reviewedButExpired =
    live.status === 'reviewed' && live.reviewExpiresAt !== null && live.reviewExpiresAt <= now;
  const earlier = items.find(
    (s) => s.id !== live.id && ['submitted', 'confirmed', 'unknown'].includes(s.status),
  );
  const digestReady = live.reviewDigest !== undefined;
  const asksReason = !reviewedAndValid && (earlier !== undefined || serverAsksReason);
  const reasonMissing = asksReason && reason.trim() === '';
  // The server refuses a review while the saved copy is being made or could not be made (#115:
  // 409 snapshot_pending, snapshot_failed); `ready` and `unsupported` may be reviewed.
  const snapshotBlock =
    live.snapshotState === 'pending'
      ? 'pending'
      : live.snapshotState === 'failed'
        ? 'failed'
        : null;
  // After a 429 daily_review_cap, confirming again before the reset is refused again: keep it
  // off until then, with the reason (tl's optional point on #138).
  const capUntil =
    banner?.kind === 'cap' && banner.resetAt !== null && banner.resetAt > now
      ? banner.resetAt
      : null;
  const confirmDisabled =
    busy ||
    capUntil !== null ||
    (!reviewedAndValid && (!ticked || !digestReady || snapshotBlock !== null || reasonMissing));

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
    // One handoff per click, whatever the review's state: never a second employer tab.
    if (inFlight.current || busy) return;
    if (confirmDisabled) {
      // aria-disabled, not disabled: say why and move to what unlocks it (design S4).
      if (snapshotBlock === 'pending') {
        setHint(SNAPSHOT_PENDING_TEXT);
      } else if (snapshotBlock === 'failed') {
        setHint(SNAPSHOT_FAILED_HINT);
      } else if (capUntil !== null) {
        setHint(`Review limit reached. You can confirm another after ${formatDateTime(capUntil)}.`);
      } else if (reasonMissing) {
        setHint('Say why you are applying again.');
        reasonField.current?.focus();
      } else {
        setHint('Tick the box to continue.');
        checkbox.current?.focus();
      }
      return;
    }
    inFlight.current = true;
    setBanner(null);
    setActionError(null);
    // Opened inside the click, so a pop-up blocker allows it; pointed at the address only once
    // the server has handed off. Nothing is opened if anything is refused.
    const tab = window.open('about:blank', '_blank');
    try {
      if (!reviewedAndValid) {
        await review.mutateAsync({
          id: live.id,
          reviewDigest: live.reviewDigest as string,
          ...(asksReason ? { reapplyReason: reason.trim() } : {}),
        });
      }
      const out = await handoff.mutateAsync(live.id);
      // The blank tab shares Opportun's origin: never point it at anything but http(s), even
      // though the server hands off only an https address it checked (sec, low, on #138).
      const href = safeHttpUrl(out.destinationUrl);
      if (href === null) {
        tab?.close();
        setBanner({ kind: 'destination' });
        return;
      }
      if (tab !== null) {
        tab.opener = null;
        tab.location.href = href;
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
      } else if (code === 'rate_limited') {
        // Too many reviews or handoffs in a minute (#186): when it frees up, from retry-after.
        const sec = err instanceof ApiError ? Number(err.details.retryAfterSec) : NaN;
        setBanner({ kind: 'rate', until: Number.isFinite(sec) ? Date.now() + sec * 1000 : null });
      } else if (code === 'destination_not_allowed') setBanner({ kind: 'destination' });
      else if (code === 'reapply_reason_required') {
        // An earlier application this screen did not know of (another opportunity): ask now.
        setBanner(null);
        setServerAsksReason(true);
        setHint('You have another application for this job. Say why you are applying again.');
        requestAnimationFrame(() => reasonField.current?.focus());
      }
      // The saved copy changed state under the screen: the refreshed row shows which (below).
      else if (code === 'snapshot_pending' || code === 'snapshot_failed') setBanner(null);
      // The attempt moved on elsewhere (another tab, or the sweep closed an expired review):
      // the refreshed list shows where it stands.
      else if (code === 'invalid_transition' || code === 'conflict') setBanner({ kind: 'changed' });
      else setBanner({ kind: 'error' });
    } finally {
      inFlight.current = false;
    }
  }

  async function reviewAgain() {
    setActionError(null);
    try {
      // An unchanged edit sends the attempt back to draft, so it can be reviewed afresh.
      await patch.mutateAsync({ id: live.id, patch: { fields: live.fields } });
      setBanner(null);
      setTicked(false);
    } catch (err) {
      setActionError(submissionErrorText(err));
    }
  }

  const expiredAt =
    banner?.kind === 'expired' ? banner.at : reviewedButExpired ? live.reviewExpiresAt : null;

  return (
    // min-w-0: a grid item may otherwise not shrink below its widest content (#135, 390 px).
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <p className="text-sm text-muted-foreground">
        This is what Opportun will help you put on the form. Nothing leaves Opportun from this page.
      </p>
      <div ref={bannerRef} tabIndex={-1} className="grid gap-2 outline-none">
        {postingMoved(live, opp) ? <PostingChangedNotice live={live} opp={opp} /> : null}
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
        {earlier === undefined && asksReason ? (
          <Notice>
            <span>
              <strong>You have another application for this job</strong>, from another opportunity,
              submitted or on its way. Applying twice can look like a mistake to the employer.
            </span>
          </Notice>
        ) : null}
        {asksReason ? (
          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>Why are you applying again?</Label>
            <Textarea
              id={reasonId}
              ref={reasonField}
              value={reason}
              maxLength={500}
              rows={2}
              aria-describedby={reasonHelpId}
              aria-required="true"
              onChange={(e) => {
                setReason(e.target.value);
                setHint(null);
              }}
            />
            <p id={reasonHelpId} className="text-xs text-muted-foreground">
              Required. It is kept with this application, so you can see later why you applied
              twice.
            </p>
          </div>
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
        {banner?.kind === 'rate' ? (
          <Notice role="alert">
            <span>
              <strong>Too many tries in a short time.</strong>{' '}
              {banner.until !== null
                ? `Try again after ${clockTime(banner.until)}.`
                : 'Try again in a minute.'}{' '}
              Nothing was opened. Your draft is saved.
            </span>
          </Notice>
        ) : null}
        {banner?.kind === 'destination' ? (
          <FormError message="This posting's address cannot be opened from here. Check the posting on the Details tab. Nothing was opened." />
        ) : null}
        {banner?.kind === 'changed' ? (
          <FormError message="This application changed in another tab or window. Nothing was opened. The page now shows where it stands." />
        ) : null}
        <FormError message={actionError} />
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
        <p className="text-sm font-medium [overflow-wrap:anywhere]">
          {live.resumeTitle ?? 'Resume'}
        </p>
        <SavedCopy live={live} where="review" />
      </ReviewSection>

      <ReviewSection title="Your details">
        {Object.keys(live.fields).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No details entered. You fill them in on the form.
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {detailRows(live.fields).map((r) => (
              <DetailRow
                key={r.key}
                label={r.label}
                value={r.value}
                // A value stored before today's checks that fails them (#196): the extension will
                // not fill it. Shown, never blocking: correcting it is an ordinary edit.
                warning={
                  submissionFieldProblem(Object.fromEntries([[r.key, r.value]])) === null
                    ? undefined
                    : "This will not be filled until you correct it: it no longer passes Opportun's checks."
                }
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
            // The label names the host, so it can be wider than a phone: let it wrap (#135).
            className={cn('h-auto min-h-9 whitespace-normal py-2', confirmDisabled && 'opacity-50')}
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
        {/* What to do once the tab opens, said before it takes over (#416), and only where the
            extension can fill this form. */}
        {canFill ? (
          <p className="text-sm">
            {/* "then press Fill in this application" until #403 slice 2 fills on the click itself
                (tl's ruling on #416): never more than the extension does today. */}
            When the form opens, click the Opportun icon in your browser&apos;s toolbar, then press
            Fill in this application. It fills in what you reviewed here.
          </p>
        ) : null}
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
        {/* The daily review cap, from the server (#130). */}
        <ReviewUsageLine />
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

function DetailRow({ label, value, warning }: { label: string; value: string; warning?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">
        {value}
        {warning === undefined ? null : (
          <span className="block text-xs text-amber-800 dark:text-amber-200">{warning}</span>
        )}
      </dd>
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
  const [attesting, setAttesting] = useState(false);
  const canFill = useExtensionCanFill(live, opp);

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
            {canFill ? <ExtensionSteps host={host} /> : <CopySteps />}
            <p>Did the tab not open? {link}.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">When you are done</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>Opportun cannot tell whether you submitted. It only records what you tell it.</p>
            <div className="flex flex-wrap gap-2">
              <Button className="w-fit" onClick={() => setAttesting(true)}>
                I submitted it
              </Button>
              <Button variant="outline" className="w-fit" onClick={() => setStopping(true)}>
                I did not submit it
              </Button>
            </div>
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
      <AttestDialog
        open={attesting}
        onOpenChange={setAttesting}
        opp={opp}
        live={live}
        host={host}
      />
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

/**
 * The steps on the application site where the extension can fill the form (#416, tl's note on
 * #403): where to click, and that the user still checks and submits. The details to copy stay
 * below, as the way without the extension.
 */
function ExtensionSteps({ host }: { host: string }) {
  return (
    <ol className="grid list-decimal gap-1 pl-5">
      <li>
        Go to the <span className="font-mono [overflow-wrap:anywhere]">{host}</span> tab.
      </li>
      <li>
        Click the Opportun icon{' '}
        <img
          src="/favicon.svg"
          // Decorative: the text beside it already names it, so a screen reader hears it once.
          alt=""
          className="inline size-4 align-text-bottom"
        />{' '}
        in the toolbar, then press Fill in this application. Not there? Open your browser&apos;s
        Extensions menu and pin Opportun.
      </li>
      <li>Check every field. The extension lists what it filled and what it left for you.</li>
      <li>Press the site&apos;s own Submit button. Only you can do this.</li>
    </ol>
  );
}

/**
 * The steps where the extension cannot fill this form (no usable token, or a site it does not
 * fill): today's copying, and where to set the extension up, promising nothing more (#416).
 */
function CopySteps() {
  return (
    <>
      <ol className="grid list-decimal gap-1 pl-5">
        <li>Fill in the form, copying from your details below.</li>
        <li>Attach your resume.</li>
        <li>Answer any other questions the site asks.</li>
        <li>Press the site&apos;s own Submit button. Only you can do this.</li>
      </ol>
      <p>
        The Opportun browser extension can fill this form for you:{' '}
        <Link
          to="/settings/integrations"
          className="text-primary underline-offset-4 hover:underline"
        >
          Settings &gt; Integrations &gt; Extensions and Connectors
        </Link>
        .
      </p>
    </>
  );
}

/** A local `datetime-local` value for a time (the input has no time zone of its own). */
function localInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The stages "Move to Applied" can move from: earlier in the pipeline than Applied. */
const BEFORE_APPLIED: readonly string[] = ['interested', 'preparing'];

/**
 * "Record that you submitted this application?" (design S6, M2a #118). The user's word: Opportun
 * cannot see the application site. "Move this opportunity to Applied" is pre-ticked and only
 * moves the stage if left ticked (owner decision 3); a stage already past Applied is not shown
 * the option. The primary button is the user's first-person claim on purpose.
 */
function AttestDialog({
  open,
  onOpenChange,
  opp,
  live,
  host,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opp: OpportunityView;
  live: SubmissionView;
  host: string;
}) {
  const navigate = useNavigate();
  const attest = useAttestSubmission(opp.id);
  // "Now" is when the dialog opens, not when the page loaded (tl on #145): set on each open.
  const [defaultWhen, setDefaultWhen] = useState(() => localInputValue(Date.now()));
  const [when, setWhen] = useState(defaultWhen);
  const canMove = BEFORE_APPLIED.includes(opp.stage);
  const [moveToApplied, setMoveToApplied] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const whenId = useId();
  const moveId = useId();
  const whenField = useRef<HTMLInputElement>(null);
  // The date field takes focus when the dialog opens, so the primary button is never the first
  // stop (design S6). Done here rather than with autoFocus: the content is mounted before it opens.
  useEffect(() => {
    if (!open) return;
    const now = localInputValue(Date.now());
    setDefaultWhen(now);
    setWhen(now);
    requestAnimationFrame(() => whenField.current?.focus());
  }, [open]);

  async function record() {
    setError(null);
    // Unchanged, the server takes "now"; changed, the time the user typed (never the future).
    const typed = when === defaultWhen ? undefined : new Date(when).getTime();
    if (typed !== undefined && !Number.isFinite(typed)) {
      setError('Enter when you pressed Submit.');
      return;
    }
    try {
      await attest.mutateAsync({
        id: live.id,
        moveToApplied: canMove && moveToApplied,
        ...(typed === undefined ? {} : { submittedAt: typed }),
      });
      onOpenChange(false);
      toast({ title: 'Application recorded', variant: 'success' });
      await navigate({ to: '/opportunities/$id', params: { id: opp.id } });
    } catch (err) {
      setError(submissionErrorText(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record that you submitted this application?</DialogTitle>
          <DialogDescription>
            Opportun cannot see {host}, so this is your word. Only continue if you pressed Submit
            and the site accepted the form.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm">
          <div className="grid gap-1.5">
            <Label htmlFor={whenId}>When did you submit?</Label>
            <Input
              id={whenId}
              ref={whenField}
              type="datetime-local"
              value={when}
              max={localInputValue(Date.now())}
              onChange={(e) => setWhen(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <p className="font-medium">This will add:</p>
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              <li>
                An Application entry on the timeline, naming the resume and the questions you
                answered, not your answers.
              </li>
              <li>
                &ldquo;Submitted to {atsLabel(live.atsKind)} / {opp.companyName}&rdquo; on the
                resume.
              </li>
            </ul>
          </div>
          {canMove ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={moveId}
                checked={moveToApplied}
                onCheckedChange={(v) => setMoveToApplied(v === true)}
              />
              <Label htmlFor={moveId}>Move this opportunity to Applied</Label>
            </div>
          ) : null}
        </div>
        {error === null ? null : <FormError message={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Not yet
          </Button>
          <Button disabled={attest.isPending} onClick={() => void record()}>
            Yes, I submitted it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Your details to copy, one button each: the path without the extension (design (g)). */
function CopyDetails({ live }: { live: SubmissionView }) {
  const [copied, setCopied] = useState<string | null>(null);
  const rows = [
    ...detailRows(live.fields).map((r) => ({ ...r, key: `field-${r.key}` })),
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
