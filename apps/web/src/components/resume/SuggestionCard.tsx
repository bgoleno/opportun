// One suggested find/replace edit, shown as a word diff. Apply is the only path from a
// suggestion to the document (C-4): it sends exactly this edit and nothing else.
import { diffWords } from 'diff';
import { Check, Info } from 'lucide-react';
import { useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { resumeErrorMessage, useApplyEdit, type ApplyEditOutcome, type Edit } from './api';

function DiffSide({ edit, side }: { edit: Edit; side: 'removed' | 'added' }) {
  const parts = diffWords(edit.find, edit.replace);
  return (
    <>
      {parts.map((part, i) => {
        if (side === 'removed' && part.added) return null;
        if (side === 'added' && part.removed) return null;
        const changed = side === 'removed' ? part.removed : part.added;
        if (!changed) return <span key={i}>{part.value}</span>;
        return (
          <mark
            key={i}
            data-testid={`diff-${side}`}
            className={
              side === 'removed'
                ? 'rounded-sm bg-destructive/20 text-foreground line-through'
                : 'rounded-sm bg-success/25 text-foreground'
            }
          >
            {part.value}
          </mark>
        );
      })}
    </>
  );
}

export function SuggestionCard({ sessionId, edit }: { sessionId: string; edit: Edit }) {
  const apply = useApplyEdit(sessionId);
  const [outcome, setOutcome] = useState<ApplyEditOutcome | null>(null);

  return (
    <div className="grid gap-2 rounded-lg border bg-background p-3 text-sm">
      <div className="grid gap-1 font-mono text-xs leading-relaxed">
        <del className="block rounded-md bg-destructive/5 px-2 py-1 no-underline">
          <span className="sr-only">Remove: </span>
          <DiffSide edit={edit} side="removed" />
        </del>
        <ins className="block rounded-md bg-success/5 px-2 py-1 no-underline">
          <span className="sr-only">Insert: </span>
          <DiffSide edit={edit} side="added" />
        </ins>
      </div>
      {edit.rationale ? <p className="text-muted-foreground">{edit.rationale}</p> : null}
      {apply.error ? (
        <FormError message={resumeErrorMessage(apply.error) ?? errorMessage(apply.error)} />
      ) : null}
      <div className="flex justify-end">
        {outcome === 'applied' ? (
          <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
            <Check className="size-4" aria-hidden="true" />
            Applied
          </span>
        ) : outcome === 'already_consumed' ? (
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Info className="size-4" aria-hidden="true" />
            Already changed by another edit you applied
          </span>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={apply.isPending}
            onClick={() => apply.mutate(edit, { onSuccess: setOutcome })}
          >
            Apply
          </Button>
        )}
      </div>
    </div>
  );
}
