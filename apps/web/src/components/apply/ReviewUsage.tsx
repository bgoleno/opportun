// The daily review cap, as the user sees it (https://github.com/bgoleno/opportun/issues/130):
// how many reviews they have used in the last 24 hours and when the next frees up, on the review
// screen; and their own lower limit, in Settings. Every number comes from the server
// (GET /settings/applications), which counts with the cap's own function: no client counting.
// Where the feature is off, or on the demo, the route is 404 and neither part renders.
import { useEffect, useId, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import { useReviewUsage, useSetReviewCap, type ReviewUsage } from './api';

/** "3 of 10 reviews used in the last 24 hours", and when a place next frees up. */
export function usageText(u: ReviewUsage): string {
  const used = `${u.used} of ${u.cap} reviews used in the last 24 hours.`;
  if (u.nextFreeAt === null) return used;
  return u.used >= u.cap
    ? `${used} You can confirm another after ${formatDateTime(u.nextFreeAt)}.`
    : `${used} The next place frees up at ${formatDateTime(u.nextFreeAt)}.`;
}

/** On the review screen, under the confirm button. Nothing while loading or where off. */
export function ReviewUsageLine() {
  const usage = useReviewUsage();
  if (usage.data === null || usage.data === undefined) return null;
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {usageText(usage.data)}
    </p>
  );
}

/** Settings > Profile, "Applications" (design (k) 1): the user's own, lower, daily limit. */
export function ReviewCapCard() {
  const usage = useReviewUsage();
  if (usage.data === null || usage.data === undefined) return null;
  return <ReviewCapForm usage={usage.data} />;
}

function ReviewCapForm({ usage }: { usage: ReviewUsage }) {
  const setCap = useSetReviewCap();
  const inputId = useId();
  const helpId = useId();
  const [value, setValue] = useState(String(usage.userCap ?? usage.cap));
  const [error, setError] = useState<string | null>(null);
  // Follow the server's value when it changes (another tab, or "Use the server's limit").
  useEffect(() => setValue(String(usage.userCap ?? usage.cap)), [usage.userCap, usage.cap]);

  async function save(cap: number | null) {
    setError(null);
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > usage.instanceCap)) {
      setError(`Choose a whole number from 1 to ${usage.instanceCap}.`);
      return;
    }
    try {
      await setCap.mutateAsync(cap);
      toast({ title: 'Review limit saved', variant: 'success' });
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'cap_out_of_range'
          ? `Choose a whole number from 1 to ${usage.instanceCap}.`
          : errorMessage(err),
      );
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Applications</CardTitle>
        <CardDescription>
          Controls for Assisted apply. Opportun never submits for you; these set how it helps you
          keep track.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={inputId}>Reviews allowed per 24 hours</Label>
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={1}
            max={usage.instanceCap}
            step={1}
            className="w-28"
            value={value}
            aria-describedby={helpId}
            onChange={(e) => setValue(e.target.value)}
          />
          <p id={helpId} className="text-sm text-muted-foreground">
            You can lower this, up to the limit your server sets ({usage.instanceCap}). A lower
            limit helps you stay deliberate.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">{usageText(usage)}</p>
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={setCap.isPending} onClick={() => void save(Number(value))}>
            Save
          </Button>
          {usage.userCap !== null ? (
            <Button variant="outline" disabled={setCap.isPending} onClick={() => void save(null)}>
              Use the server’s limit
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
