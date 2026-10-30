import { Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { endOfLocalDay, formatDate } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import { useCreateNextStep, useDeleteNextStep, useNextSteps, useToggleNextStep } from './api';

export function NextStepsPanel({ opportunityId }: { opportunityId: string }) {
  const { data, error } = useNextSteps(opportunityId);
  const create = useCreateNextStep(opportunityId);
  const toggle = useToggleNextStep(opportunityId);
  const remove = useDeleteNextStep(opportunityId);
  const [action, setAction] = useState('');
  const [due, setDue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const now = Date.now();

  // Open steps first (soonest due first), then completed ones.
  const steps = [...(data?.items ?? [])].sort((a, b) => {
    if ((a.doneAt == null) !== (b.doneAt == null)) return a.doneAt == null ? -1 : 1;
    return (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity);
  });

  async function add(e: FormEvent) {
    e.preventDefault();
    const text = action.trim();
    if (text === '') {
      setFormError('Describe the next step');
      return;
    }
    setFormError(null);
    try {
      await create.mutateAsync({ action: text, dueAt: due ? endOfLocalDay(due) : null });
      setAction('');
      setDue('');
    } catch (err) {
      setFormError(errorMessage(err));
    }
  }

  return (
    <Card role="region" aria-labelledby="next-steps-title" className="gap-4">
      <CardHeader>
        <CardTitle id="next-steps-title">Next steps</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <FormError message={errorMessage(error)} /> : null}
        {data && steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No next steps yet.</p>
        ) : null}
        <ul className="grid gap-2">
          {steps.map((step) => {
            const done = step.doneAt != null;
            const overdue = !done && step.dueAt != null && step.dueAt < now;
            return (
              <li key={step.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4 cursor-pointer accent-primary"
                  aria-label={`Done: ${step.action}`}
                  checked={done}
                  onChange={() =>
                    toggle.mutate(
                      { stepId: step.id, done: !done },
                      {
                        onError: (err) =>
                          toast({
                            title: 'Could not update the step',
                            description: errorMessage(err),
                            variant: 'destructive',
                          }),
                      },
                    )
                  }
                />
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className={cn('text-sm', done && 'text-muted-foreground line-through')}>
                    {step.action}
                  </span>
                  {step.dueAt != null ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Due {formatDate(step.dueAt)}
                      {overdue ? <Badge variant="destructive">Overdue</Badge> : null}
                    </span>
                  ) : null}
                </div>
                <IconButton
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  label={`Delete step: ${step.action}`}
                  onClick={() => remove.mutate(step.id)}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </li>
            );
          })}
        </ul>
        <form className="grid gap-2" noValidate onSubmit={add}>
          <FormError message={formError} />
          <div className="grid gap-1.5">
            <Label htmlFor="next-step-action">Next step</Label>
            <Input
              id="next-step-action"
              value={action}
              maxLength={500}
              onChange={(e) => setAction(e.currentTarget.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="next-step-due">Due date</Label>
            <Input
              id="next-step-due"
              type="date"
              value={due}
              onChange={(e) => setDue(e.currentTarget.value)}
            />
          </div>
          {/* eslint-disable-next-line opportun/no-stretched-grid-button -- full width by default, not by decision: w-fit or w-full is still to be chosen (https://github.com/bgoleno/opportun/issues/9) */}
          <Button type="submit" variant="outline" disabled={create.isPending}>
            Add step
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
