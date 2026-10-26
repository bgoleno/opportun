// Resume status (draft, in review, final, submitted). Submitted asks where it went.
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/opportunities';
import {
  RESUME_STATUSES,
  resumeErrorMessage,
  statusLabel,
  useUpdateResume,
  type Resume,
  type ResumeStatus,
} from './api';

export function StatusControl({ resume }: { resume: Resume }) {
  const update = useUpdateResume(resume.id);
  const [askingSubmit, setAskingSubmit] = useState(false);
  const [submittedTo, setSubmittedTo] = useState('');

  function change(status: ResumeStatus) {
    if (status === 'submitted') {
      setAskingSubmit(true);
      return;
    }
    setAskingSubmit(false);
    update.mutate(
      { status },
      {
        onError: (err) =>
          toast({
            title: 'Status not changed',
            description: resumeErrorMessage(err) ?? errorMessage(err),
            variant: 'destructive',
          }),
      },
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    update.mutate(
      { status: 'submitted', submittedTo: submittedTo.trim() },
      { onSuccess: () => setAskingSubmit(false) },
    );
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={`resume-status-${resume.id}`} className="text-muted-foreground">
          Status
        </Label>
        <div className="w-36">
          <Select
            id={`resume-status-${resume.id}`}
            value={askingSubmit ? 'submitted' : resume.status}
            disabled={update.isPending}
            onChange={(e) => change(e.currentTarget.value as ResumeStatus)}
          >
            {RESUME_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {resume.status === 'submitted' && !askingSubmit && resume.submittedTo ? (
        <p className="text-xs text-muted-foreground">
          Sent to {resume.submittedTo}
          {resume.submittedAt ? ` on ${formatDate(resume.submittedAt)}` : ''}
        </p>
      ) : null}
      {askingSubmit ? (
        <form onSubmit={submit} className="grid gap-2 rounded-md border p-3">
          <Label htmlFor={`submitted-to-${resume.id}`}>Submitted to</Label>
          <Input
            id={`submitted-to-${resume.id}`}
            value={submittedTo}
            maxLength={300}
            placeholder="e.g. Acme careers portal"
            onChange={(e) => setSubmittedTo(e.currentTarget.value)}
          />
          {update.error ? (
            <FormError message={resumeErrorMessage(update.error) ?? errorMessage(update.error)} />
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAskingSubmit(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={update.isPending || submittedTo.trim().length === 0}
            >
              Mark submitted
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
