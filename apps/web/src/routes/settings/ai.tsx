import { createFileRoute } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { usePolicies } from '@/components/ai/api';
import { PolicyEditor } from '@/components/ai/PolicyEditor';
import { ProposedRefinement } from '@/components/ai/ProposedRefinement';
import { PromptEditor } from '@/components/ai/promptEditor';
import { ProviderKeysCard } from '@/components/ai/ProviderKeysCard';
import { UsageTable } from '@/components/ai/UsageTable';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export const Route = createFileRoute('/settings/ai')({
  component: AiSettings,
});

function AiSettings() {
  return (
    <div className="grid gap-6">
      <ProposedRefinement />
      <ProviderKeysCard />
      <Card>
        <CardHeader>
          <CardTitle>Models</CardTitle>
          <CardDescription>
            Which provider and model each AI task uses. Change one to override its default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PolicyEditor />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
          <CardDescription>Tokens and estimated cost per task per day.</CardDescription>
        </CardHeader>
        <CardContent>
          <UsageTable />
        </CardContent>
      </Card>
      <PromptsCard />
    </div>
  );
}

// --- prompts (advanced) -------------------------------------------------------------

function PromptsCard() {
  const policies = usePolicies();
  const tasks = policies.data?.items.map((t) => t.taskKey) ?? [];
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const selected = taskKey ?? tasks[0];

  return (
    <Card>
      <CardContent className="pt-6">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight
              aria-hidden="true"
              className="size-4 transition-transform group-open:rotate-90"
            />
            Advanced: prompts
          </summary>
          <div className="mt-4 grid gap-4">
            <p className="text-sm text-muted-foreground">
              View and edit the instructions each task sends to the model. Edits are saved as your
              own versions; the defaults stay available through Reset to default.
            </p>
            {selected === undefined ? (
              <p className="text-sm text-muted-foreground">Loading tasks...</p>
            ) : (
              <>
                <div className="grid max-w-sm gap-1.5">
                  <Label htmlFor="ai-prompt-task">Task</Label>
                  <Select
                    id="ai-prompt-task"
                    value={selected}
                    onChange={(e) => setTaskKey(e.target.value)}
                  >
                    {tasks.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </div>
                <PromptEditor key={selected} taskKey={selected} />
              </>
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
