import { OPPORTUNITY_STAGES } from '@opportun/core';
import { Link } from '@tanstack/react-router';
import { stageLabel, type DashboardData } from '@/lib/opportunities';
import { cn } from '@/lib/utils';

/** One card per stage; each opens the pipeline filtered to that stage. */
export function StageCounts({ counts }: { counts: DashboardData['stageCounts'] }) {
  const byStage = new Map(Object.entries(counts));
  return (
    <section aria-labelledby="dash-stages" className="grid gap-3">
      <h2 id="dash-stages" className="text-base font-semibold">
        Pipeline by stage
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {OPPORTUNITY_STAGES.map((stage) => {
          const n = byStage.get(stage) ?? 0;
          const terminal = stage === 'dismissed' || stage === 'closed';
          return (
            <li key={stage}>
              <Link
                to="/pipeline"
                search={{ stage }}
                className={cn(
                  'flex h-full flex-col gap-1 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
                  terminal && 'bg-muted text-muted-foreground',
                )}
              >
                <span className="text-xs font-medium">{stageLabel(stage)}</span>
                <span className="text-2xl font-semibold tabular-nums">{n}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
