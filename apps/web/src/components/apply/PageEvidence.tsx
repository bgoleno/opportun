// The evidence card for a confirmation page recorded from the extension
// (https://github.com/bgoleno/opportun/issues/121): where it was recorded, when, and the page's
// text as the user's browser read it, shown as plain text (never rendered as Markdown or HTML:
// it is the application site's page). The user may delete it; the application stays confirmed.
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { formatDateTime, safeHttpUrl } from '@/lib/opportunities';
import { useDeleteConfirmationPage, type SubmissionView } from './api';

export function PageEvidence({ attempt }: { attempt: SubmissionView }) {
  const remove = useDeleteConfirmationPage(attempt.opportunityId);
  const [asking, setAsking] = useState(false);
  const recorded = attempt.confirmationPage ?? null;
  if (recorded === null) {
    return (
      <p className="text-sm">
        A confirmation page backed this up. Its recorded copy has been deleted.
      </p>
    );
  }
  const link = safeHttpUrl(recorded.url);
  return (
    <div className="grid gap-3 text-sm">
      <p>A confirmation page backs this up.</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Page</dt>
        <dd className="break-all">
          {link === null ? (
            (recorded.host ?? '(unknown site)')
          ) : (
            <a href={link} target="_blank" rel="noopener noreferrer" className="underline">
              {recorded.host ?? link}
            </a>
          )}
        </dd>
        <dt className="text-muted-foreground">Recorded</dt>
        <dd>{formatDateTime(recorded.recordedAt)}</dd>
      </dl>
      {recorded.text === null || recorded.text === '' ? null : (
        <details>
          <summary className="cursor-pointer">Show the recorded text</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2 font-sans">
            {recorded.text}
          </pre>
        </details>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setAsking(true)}
      >
        Delete the recorded page
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Delete the recorded page?"
        description="Its text is removed from the timeline. This application stays confirmed."
        confirmLabel="Delete"
        onConfirm={async () => {
          await remove.mutateAsync(recorded.activityId);
        }}
      />
    </div>
  );
}
