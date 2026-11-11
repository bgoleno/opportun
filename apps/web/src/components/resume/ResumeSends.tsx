// Resume sends (https://github.com/bgoleno/opportun/issues/158): recording that a resume, often
// a base one sent as it is through a job site's own apply flow, was sent for an opportunity.
// A send is a record, not an attachment: the resume itself does not change.
import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/opportunities';
import {
  resumeErrorMessage,
  useRecordSend,
  useRemoveSend,
  useResumeSends,
  type Resume,
  type ResumeSend,
} from './api';

/** Today as the date input's YYYY-MM-DD, in the browser's own time zone. */
function todayIso(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The time to record for a chosen day: none (the server's "now") for today, otherwise midday
 * local time on that day, so no time zone moves it to the day before or after.
 */
export function sentAtFor(day: string, today = todayIso()): number | undefined {
  if (day === today) return undefined;
  return new Date(`${day}T12:00:00`).getTime();
}

/** "Sent via" and "Date sent" for one resume, and the button that records it. */
export function RecordSendFields({
  opportunityId,
  resume,
  quiet = false,
  onStart,
  onFail,
}: {
  opportunityId: string;
  resume: Resume;
  /** An outline button, where the next action is elsewhere on the page (#440). */
  quiet?: boolean;
  /**
   * Told as the send is submitted, and again if it fails, so the resume flow can move focus to
   * where it leads (#440). Before, not after: the refreshed lists can show the new place first.
   */
  onStart?: () => void;
  onFail?: () => void;
}) {
  const record = useRecordSend(opportunityId);
  const [via, setVia] = useState('');
  const [day, setDay] = useState(todayIso());
  const viaId = useId();
  const dayId = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    const sentAt = sentAtFor(day);
    onStart?.();
    record.mutate(
      { resumeId: resume.id, sentVia: via.trim(), ...(sentAt === undefined ? {} : { sentAt }) },
      {
        onSuccess: () => {
          setVia('');
          toast({ title: 'Recorded as sent', description: resume.title, variant: 'success' });
        },
        onError: () => onFail?.(),
      },
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {resume.kind === 'base'
          ? 'A base resume stays as it is. This records that you sent it for this opportunity, and it can still be sent for others and tailored from.'
          : 'This records that you sent it for this opportunity, and how.'}
      </p>
      <div className="grid gap-2">
        <Label htmlFor={viaId}>Sent via</Label>
        <Input
          id={viaId}
          value={via}
          maxLength={300}
          placeholder="e.g. Indeed"
          onChange={(e) => setVia(e.currentTarget.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={dayId}>Date sent</Label>
        <Input
          id={dayId}
          type="date"
          value={day}
          max={todayIso()}
          onChange={(e) => setDay(e.currentTarget.value)}
        />
      </div>
      {record.error ? (
        <FormError message={resumeErrorMessage(record.error) ?? errorMessage(record.error)} />
      ) : null}
      {/* eslint-disable-next-line opportun/no-stretched-grid-button -- full width by default, not by decision: w-fit or w-full is still to be chosen (https://github.com/bgoleno/opportun/issues/9) */}
      <Button
        type="submit"
        variant={quiet ? 'outline' : 'default'}
        disabled={record.isPending || via.trim() === '' || day === ''}
      >
        {record.isPending ? 'Recording...' : 'Record as sent'}
      </Button>
    </form>
  );
}

/** Removes one send of this opportunity; the resume is left as it is. */
export function RemoveSendButton({
  opportunityId,
  send,
}: {
  opportunityId: string;
  send: ResumeSend;
}) {
  const remove = useRemoveSend(opportunityId);
  return (
    <IconButton
      variant="ghost"
      label={`Remove the record that ${send.resumeTitle} was sent`}
      disabled={remove.isPending}
      // Its toasts are useRemoveSend's own: this button has gone by the time the list refreshes.
      onClick={() => remove.mutate(send.id)}
    >
      <Trash2 aria-hidden="true" />
    </IconButton>
  );
}

/** "Sent via Indeed on 3 Nov 2026", the line a send shows wherever it is listed. */
export function sentLine(send: ResumeSend): string {
  return `Sent via ${send.sentVia} on ${formatDate(send.sentAt)}`;
}

/** On a resume's page: every opportunity it was sent for, newest first. Nothing when none. */
export function ResumeSentFor({ resumeId }: { resumeId: string }) {
  const sends = useResumeSends(resumeId);
  const items = sends.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sent for</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2">
          {items.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
            >
              <Link
                to="/opportunities/$id"
                params={{ id: s.opportunityId }}
                className="font-medium break-words text-primary underline-offset-4 hover:underline"
              >
                {s.companyName}: {s.opportunityTitle}
              </Link>
              <span className="text-muted-foreground">{sentLine(s)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
