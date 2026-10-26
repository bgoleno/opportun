import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate, qk, setNextStepDone, type DueNextStep } from '@/lib/opportunities';

export function DueNextSteps({ steps, now }: { steps: DueNextStep[]; now: number }) {
  const qc = useQueryClient();
  const done = useMutation({
    mutationFn: (id: string) => setNextStepDone(id, true),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.dashboard }),
        qc.invalidateQueries({ queryKey: ['opportunity'] }),
      ]);
    },
    onError: (err) =>
      toast({
        title: 'Could not update the step',
        description: errorMessage(err),
        variant: 'destructive',
      }),
  });

  return (
    <Card aria-labelledby="dash-steps" role="region">
      <CardHeader>
        <CardTitle id="dash-steps">Due next steps</CardTitle>
      </CardHeader>
      <CardContent>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing due in the next 7 days.</p>
        ) : (
          <ul className="grid gap-3">
            {steps.map((step) => {
              const overdue = step.dueAt != null && step.dueAt < now;
              const checkboxId = `due-step-${step.id}`;
              return (
                <li key={step.id} className="flex items-start gap-3">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    className="mt-1 size-4 cursor-pointer accent-primary"
                    aria-label={`Done: ${step.action}`}
                    disabled={done.isPending && done.variables === step.id}
                    onChange={(e) => {
                      if (e.currentTarget.checked) done.mutate(step.id);
                    }}
                  />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <label htmlFor={checkboxId} className="text-sm font-medium">
                      {step.action}
                    </label>
                    <Link
                      to="/opportunities/$id"
                      params={{ id: step.opportunityId }}
                      className="truncate text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                    >
                      {step.companyName}: {step.opportunityTitle}
                    </Link>
                  </div>
                  {step.dueAt != null ? (
                    <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                      <span>{formatDate(step.dueAt)}</span>
                      {overdue ? <Badge variant="destructive">Overdue</Badge> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
