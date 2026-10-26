// The dashboard's "Get set up" card (FR-U12): the three activation items, computed by the
// server. The tour is a one-time event; this card is what gets people activated over several
// sessions. Not shown on the demo instance, where there is nothing to set up.
import { Link } from '@tanstack/react-router';
import { Check, Circle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { doneCount, useDismissChecklist, useOnboarding } from './api';
import { useTour } from './TourProvider';

const linkClass = 'text-sm font-medium text-primary underline-offset-2 hover:underline';

export function SetupChecklist() {
  const { data } = useOnboarding();
  const dismiss = useDismissChecklist();
  const { launch } = useTour();
  // The success state is shown for one visit: the visit that first sees activation records
  // the dismissal straight away and keeps celebrating until the user leaves.
  const [celebrating, setCelebrating] = useState(false);
  const activatedUnseen =
    data !== undefined && data.checklist.activatedAt !== null && !data.checklist.dismissed;
  const dismissMutate = dismiss.mutate;

  useEffect(() => {
    if (!activatedUnseen || data?.demo !== false) return;
    setCelebrating(true);
    dismissMutate();
  }, [activatedUnseen, data?.demo, dismissMutate]);

  if (data === undefined || data.demo) return null;
  const c = data.checklist;

  if (celebrating) {
    return (
      <Card data-tour="setup-checklist" className="gap-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Check aria-hidden="true" className="size-5 text-success" />
            You&apos;re set up
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <p>Your pipeline now fills itself from your mail.</p>
          <p className="text-muted-foreground">
            Next up: add a role target so Discovery knows what to rank, and register your base
            resume.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link to="/settings/role-targets" className={linkClass}>
              Add a role target
            </Link>
            <Link to="/resumes" className={linkClass}>
              Register a resume
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Activation is a historical fact: once recorded, the card stays hidden even if a key is
  // later deleted (design section 7).
  if (c.dismissed || c.activatedAt !== null) return null;
  const done = doneCount(c);
  const rows = [
    {
      label: 'Add your AI key',
      why: 'Turns on mail sorting, ranking and tailoring. You pay your provider directly.',
      done: c.aiKey,
      action: (
        <Link to="/settings/ai" className={linkClass}>
          Add key
        </Link>
      ),
    },
    {
      label: 'Connect your mail',
      why: 'Gmail (read-only) or Apple Mail. Recruiter mail becomes opportunities.',
      done: c.mail,
      action: (
        <Link to="/settings/integrations" className={linkClass}>
          Connect
        </Link>
      ),
    },
    {
      label: 'Get your first opportunity',
      why: 'Often happens on its own once mail is connected.',
      done: c.firstOpportunity,
      action: (
        <Link to="/pipeline" search={{ new: true }} className={linkClass}>
          Add one
        </Link>
      ),
    },
  ];

  return (
    <Card data-tour="setup-checklist" className="gap-4">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Get set up</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{done} of 3 done</span>
          <div
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={3}
            aria-valuenow={done}
            className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(done / 3) * 100}%` }}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {rows.map((r) => (
            <li key={r.label} className="flex items-start gap-3">
              {r.done ? (
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <Circle
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
              )}
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-sm font-medium">
                  {r.label}
                  <span className="sr-only">{r.done ? ' (done)' : ' (not done)'}</span>
                </span>
                <span className="text-sm text-muted-foreground">{r.why}</span>
              </div>
              {r.done ? null : <div className="shrink-0">{r.action}</div>}
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={launch}>
          Take the tour
        </Button>
        {/* Offered only once something is done, so the card cannot be dismissed by reflex. */}
        {done > 0 ? (
          <Button
            variant="ghost"
            disabled={dismiss.isPending}
            onClick={() =>
              dismiss.mutate(undefined, {
                onError: (err) =>
                  toast({
                    title: 'Could not hide the checklist',
                    description: errorMessage(err),
                    variant: 'destructive',
                  }),
              })
            }
          >
            Hide
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
