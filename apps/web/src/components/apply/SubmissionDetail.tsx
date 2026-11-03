// The submission detail page (https://github.com/bgoleno/opportun/issues/149; design Part B S7,
// (d) status words and icons, (g) headings and landmarks): one application, after the fact. Where
// it went, the resume copy that was used, what the user reviewed and when, its status and what
// backs it up, and, for an attempt still submitted or with no confirmation seen, the outcome
// actions: for every such attempt, not only the newest (the Tech Lead's case on #149), since the
// Apply panel offers them for one attempt at a time.
//
// Opportun sends nothing from here: the outcome actions only record what the user saw.
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { FormError } from '@/components/FormError';
import { useOpportunity } from '@/components/opportunity/api';
import { formatDateTime, safeHttpUrl } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import { DETAIL_FIELDS, SavedCopy } from './ApplyPage';
import { atsLabel, useOpportunitySubmissions, useSubmission, type SubmissionView } from './api';
import { OutcomeActions, REPORTABLE } from './OutcomeActions';
import { SubmissionStatusChip } from './parts';

/** What the status means, in words (design S7's status table); null where the page says enough. */
function statusBanner(s: SubmissionView): string | null {
  switch (s.status) {
    case 'submitted':
      return 'Waiting for a confirmation. Most employers send an email within minutes to a few days.';
    case 'unknown':
      return 'No confirmation seen yet. This is not a failure. Many employers send nothing, and some emails land in spam.';
    case 'rejected':
      return 'The application site refused the form. Your stage was not changed.';
    case 'failed':
      return 'This could not be completed. Nothing was submitted.';
    case 'abandoned':
      return s.failureReason === 'review_expired'
        ? 'Your review expired before the form was opened. Nothing was sent.'
        : 'You stopped before submitting. Nothing was sent.';
    case 'draft':
    case 'reviewed':
      return 'This application is still being prepared.';
    case 'handed_off':
      return 'The form was opened on the application site. Opportun does not know if you submitted it.';
    default:
      return null;
  }
}

/** The steps this attempt went through, in order, each with its time (design S7 "History"). */
function history(s: SubmissionView): { label: string; at: number }[] {
  const steps: { label: string; at: number | null }[] = [
    { label: 'Started', at: s.createdAt },
    { label: 'Reviewed', at: s.reviewedAt },
    { label: 'Opened on the application site', at: s.handedOffAt },
    { label: 'Submitted (you reported it)', at: s.submittedAt },
    {
      label:
        s.confirmationKind === 'user'
          ? 'Confirmed (you marked it)'
          : s.confirmationKind === 'email'
            ? 'Confirmed (a confirmation email)'
            : 'Confirmed (a confirmation page)',
      at: s.confirmedAt,
    },
  ];
  // The end states have no time of their own: the last change is when they happened.
  const end: Record<string, string> = {
    unknown: 'No confirmation seen',
    rejected: 'The application site refused it',
    failed: 'Could not be completed',
    abandoned: 'Stopped',
  };
  const last = end[s.status];
  return [
    ...steps.filter((x): x is { label: string; at: number } => x.at !== null),
    ...(last === undefined ? [] : [{ label: last, at: s.updatedAt }]),
  ];
}

export function SubmissionDetail({
  opportunityId,
  submissionId,
}: {
  opportunityId: string;
  submissionId: string;
}) {
  const load = useSubmission(submissionId);
  const opp = useOpportunity(opportunityId);
  const all = useOpportunitySubmissions(opportunityId);

  const back = (
    <Link
      to="/opportunities/$id"
      params={{ id: opportunityId }}
      className="inline-flex w-fit items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to the opportunity
    </Link>
  );

  if (load.isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (load.isError) return <FormError message="This application could not be loaded." />;
  // The flag off, or the demo: nothing of the feature exists here.
  if (load.data.kind === 'off') {
    return (
      <section className="grid gap-4">
        {back}
        <p className="text-sm text-muted-foreground">Assisted apply is not available here.</p>
      </section>
    );
  }
  // None for this user (another user's reads the same), or one of another opportunity.
  if (load.data.kind === 'not_found' || load.data.submission.opportunityId !== opportunityId) {
    return (
      <section className="grid gap-4">
        {back}
        <p role="alert" className="text-sm">
          This application was not found.
        </p>
      </section>
    );
  }

  const s = load.data.submission;
  const company = opp.data?.companyName ?? 'this company';
  const ats = atsLabel(s.atsKind);
  const href = safeHttpUrl(s.destinationUrl);
  const banner = statusBanner(s);
  const others = (all.data?.items ?? []).filter((o) => o.id !== s.id);

  return (
    <section className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6">
      {back}
      <header className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold">Application to {company}</h1>
          <SubmissionStatusChip status={s.status} />
        </div>
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {ats}, {s.atsExternalId}.
          {s.submittedAt !== null
            ? ` You reported submitting it on ${formatDateTime(s.submittedAt)}.`
            : ''}
        </p>
      </header>

      {banner !== null ? (
        <p
          role="status"
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            s.status === 'unknown' ? 'border-warning/40 bg-warning/10' : 'bg-muted/40',
          )}
        >
          {banner}
        </p>
      ) : null}

      {REPORTABLE.includes(s.status) ? (
        <Section title="What happened?">
          <OutcomeActions attempt={s} companyName={company} />
        </Section>
      ) : null}

      <Section title="Evidence">
        {s.confirmationKind === 'user' && s.confirmedAt !== null ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-sm">
            You marked this confirmed on {formatDateTime(s.confirmedAt)}. No evidence attached.
          </p>
        ) : s.confirmationKind !== null ? (
          <p className="text-sm">
            A confirmation {s.confirmationKind === 'email' ? 'email' : 'page'} backs this up.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No confirmation yet.</p>
        )}
      </Section>

      <Section title="Where it went">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Application site</dt>
          <dd>{ats}</dd>
          <dt className="text-muted-foreground">Requisition</dt>
          <dd className="font-mono">{s.atsExternalId}</dd>
          <dt className="text-muted-foreground">Address</dt>
          <dd>
            {href === null ? (
              <span className="font-mono [overflow-wrap:anywhere]">{s.destinationUrl}</span>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-start gap-1 font-mono text-primary underline-offset-4 hover:underline"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">{s.destinationUrl}</span>
                <ExternalLink className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              </a>
            )}
          </dd>
        </dl>
      </Section>

      <Section title="Resume used">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{s.resumeTitle ?? 'Resume'}</p>
        {s.snapshotState === 'ready' ? (
          <SavedCopy live={s} where="review" />
        ) : (
          <p className="text-sm text-muted-foreground">
            {s.snapshotState === 'pending'
              ? 'The saved copy was still being prepared.'
              : 'No saved copy was made: you attached the resume file yourself.'}
          </p>
        )}
      </Section>

      <Section title="What you reviewed">
        <p className="text-sm text-muted-foreground">
          {s.reviewedAt !== null ? `Reviewed on ${formatDateTime(s.reviewedAt)}.` : 'Not reviewed.'}
        </p>
        {Object.keys(s.fields).length > 0 ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            {Object.entries(s.fields).map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">
                  {DETAIL_FIELDS.find((f) => f.key === key)?.label ?? key}
                </dt>
                <dd className="[overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {s.answers.length > 0 ? (
          <dl className="grid gap-2 text-sm">
            {s.answers.map((a) => (
              <div key={a.questionKey} className="grid gap-0.5">
                <dt className="font-medium [overflow-wrap:anywhere]">{a.label}</dt>
                <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{a.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {s.reapplyReason !== null ? (
          <p className="text-sm">Why you applied again: {s.reapplyReason}</p>
        ) : null}
      </Section>

      <Section title="History">
        <ol aria-label="History" className="grid gap-1 text-sm">
          {history(s).map((step) => (
            <li key={step.label} className="flex flex-wrap gap-x-2">
              <span>{step.label}</span>
              <span className="text-muted-foreground">{formatDateTime(step.at)}</span>
            </li>
          ))}
        </ol>
      </Section>

      {others.length > 0 ? (
        <Section title="Other applications for this role">
          <ul aria-label="Other applications for this role" className="grid gap-2 text-sm">
            {others.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <SubmissionStatusChip status={o.status} />
                <Link
                  to="/opportunities/$id/applications/$submissionId"
                  params={{ id: opportunityId, submissionId: o.id }}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {o.submittedAt !== null
                    ? `Submitted ${formatDateTime(o.submittedAt)}`
                    : `Started ${formatDateTime(o.createdAt)}`}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-2 rounded-xl border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
