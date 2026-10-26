// The opportunity's Referrals tab (FR-C3, C4): who could refer the user (ranked by AI when it is
// available, otherwise the deterministic list), an Ask action per contact, and the asks already
// made with their status as chips.
import { REFERRAL_STATUSES, type ReferralStatus } from '@opportun/core';
import { Link } from '@tanstack/react-router';
import { Send } from 'lucide-react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/opportunities';
import {
  useAskReferral,
  useOpportunityReferrals,
  useReferralCandidates,
  useSetReferralStatus,
  type OpportunityReferral,
  type ReferralCandidate,
} from './api';

export function referralStatusLabel(status: ReferralStatus): string {
  switch (status) {
    case 'asked':
      return 'Asked';
    case 'agreed':
      return 'Agreed';
    case 'submitted':
      return 'Submitted';
    case 'declined':
      return 'Declined';
  }
}

export function ReferralStatusBadge({ status }: { status: ReferralStatus | null }) {
  if (status === null) return null;
  const variant =
    status === 'declined'
      ? 'destructive'
      : status === 'agreed' || status === 'submitted'
        ? 'success'
        : 'secondary';
  return <Badge variant={variant}>{referralStatusLabel(status)}</Badge>;
}

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

function aiNote(reason: string): string {
  if (reason === 'no_key') return 'no AI key is set up';
  if (reason === 'over_budget') return "today's AI budget is used up";
  return 'AI is unavailable right now';
}

function CandidateRow({
  c,
  ask,
  onAsk,
  asking,
}: {
  c: ReferralCandidate;
  ask: OpportunityReferral | undefined;
  onAsk: () => void;
  asking: boolean;
}) {
  const role = [c.relation === 'current' ? 'Current' : 'Former', c.title]
    .filter((x) => x !== null)
    .join(', ');
  return (
    <li className="grid gap-2 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            {c.rank !== null ? <Badge variant="outline">#{c.rank}</Badge> : null}
            <h3 className="text-sm font-semibold">
              <Link to="/contacts/$id" params={{ id: c.contactId }} className={linkClass}>
                {c.name}
              </Link>
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            {role}
            {c.relation === 'former' && c.currentCompanyName !== null
              ? `. Now at ${c.currentCompanyName}`
              : ''}
            {c.strength !== null ? `. Strength ${c.strength} of 3` : ''}
          </p>
        </div>
        {ask !== undefined ? (
          <ReferralStatusBadge status={ask.status} />
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={asking}
            aria-label={`Ask ${c.name} for a referral`}
            onClick={onAsk}
          >
            <Send aria-hidden="true" />
            Ask
          </Button>
        )}
      </div>
      {c.rationale !== null ? <p className="text-sm">{c.rationale}</p> : null}
    </li>
  );
}

function StatusChips({
  ask,
  onChange,
}: {
  ask: OpportunityReferral;
  onChange: (status: ReferralStatus) => void;
}) {
  return (
    <div role="group" aria-label={`Status for ${ask.name}`} className="flex flex-wrap gap-1.5">
      {REFERRAL_STATUSES.map((s) => {
        const on = ask.status === s;
        return (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={on ? (s === 'declined' ? 'destructive' : 'default') : 'outline'}
            className="h-7 rounded-full px-3 text-xs"
            aria-pressed={on}
            onClick={() => {
              if (!on) onChange(s);
            }}
          >
            {referralStatusLabel(s)}
          </Button>
        );
      })}
    </div>
  );
}

export function ReferralsTab({
  opportunityId,
  companyName,
}: {
  opportunityId: string;
  companyName: string;
}) {
  const candidates = useReferralCandidates(opportunityId);
  const referrals = useOpportunityReferrals(opportunityId);
  const askReferral = useAskReferral(opportunityId);
  const setStatus = useSetReferralStatus(opportunityId);
  const asks = referrals.data?.items ?? [];
  const byContact = new Map(asks.map((a) => [a.contactId, a]));

  function ask(c: ReferralCandidate) {
    askReferral.mutate(
      { contactId: c.contactId },
      {
        onSuccess: () =>
          toast({ title: 'Referral ask recorded', description: c.name, variant: 'success' }),
        onError: (err) =>
          toast({
            title: 'Ask not recorded',
            description: errorMessage(err),
            variant: 'destructive',
          }),
      },
    );
  }

  function changeStatus(a: OpportunityReferral, status: ReferralStatus) {
    setStatus.mutate(
      { activityId: a.activityId, status },
      {
        onError: (err) =>
          toast({
            title: 'Status not changed',
            description: errorMessage(err),
            variant: 'destructive',
          }),
      },
    );
  }

  const data = candidates.data;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader>
          <CardTitle>Who could refer you</CardTitle>
          <CardDescription>
            Your contacts at {companyName}, then people who used to work there.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {candidates.isPending ? (
            <p className="text-sm text-muted-foreground">Finding contacts...</p>
          ) : candidates.isError ? (
            <FormError message={errorMessage(candidates.error)} />
          ) : data === undefined || data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No contacts at {companyName} yet.{' '}
              <Link to="/contacts" className={linkClass}>
                Add contacts
              </Link>{' '}
              or{' '}
              <Link to="/settings/data" className={linkClass}>
                import your LinkedIn export
              </Link>
              .
            </p>
          ) : (
            <>
              {!data.ranked && data.aiUnavailable !== null ? (
                <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                  These contacts are not ranked by AI ({aiNote(data.aiUnavailable)}). Current
                  colleagues and closer contacts come first.
                </p>
              ) : null}
              <ul className="grid gap-2" aria-label="Referral candidates">
                {data.items.map((c) => (
                  <CandidateRow
                    key={c.contactId}
                    c={c}
                    ask={byContact.get(c.contactId)}
                    asking={askReferral.isPending}
                    onAsk={() => ask(c)}
                  />
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="content-start">
        <CardHeader>
          <CardTitle>Referral asks</CardTitle>
          <CardDescription>Track each ask from request to submission.</CardDescription>
        </CardHeader>
        <CardContent>
          {referrals.isPending ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : referrals.isError ? (
            <FormError message={errorMessage(referrals.error)} />
          ) : asks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No asks yet.</p>
          ) : (
            <ul className="grid gap-3" aria-label="Referral asks">
              {asks.map((a) => (
                <li key={a.activityId} className="grid gap-2 rounded-md border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link to="/contacts/$id" params={{ id: a.contactId }} className={linkClass}>
                      {a.name}
                    </Link>
                    <time
                      className="text-xs text-muted-foreground"
                      dateTime={new Date(a.occurredAt).toISOString()}
                    >
                      {formatDate(a.occurredAt)}
                    </time>
                  </div>
                  {a.note !== null ? (
                    <p className="text-sm text-muted-foreground">{a.note}</p>
                  ) : null}
                  <StatusChips ask={a} onChange={(s) => changeStatus(a, s)} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
