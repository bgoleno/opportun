import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { FormError } from '@/components/FormError';
import { api, errorMessage } from '@/lib/api';
import { qk, type DashboardData } from '@/lib/opportunities';
import { DueNextSteps } from './DueNextSteps';
import { RecentActivity } from './RecentActivity';
import { StageCounts } from './StageCounts';
import { TriageBadge } from './TriageBadge';

export const dashboardQuery = {
  queryKey: qk.dashboard,
  queryFn: () => api<DashboardData>('/dashboard'),
};

export function Dashboard({ greeting }: { greeting?: string }) {
  const { data, error, isPending, dataUpdatedAt } = useQuery(dashboardQuery);
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Dashboard"
        description={greeting ?? 'Where your search stands today.'}
        actions={data ? <TriageBadge count={data.needsTriage.communications} /> : undefined}
      />
      {error ? <FormError message={errorMessage(error)} /> : null}
      {isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}
      {data ? (
        <>
          <StageCounts counts={data.stageCounts} />
          <div className="grid gap-6 lg:grid-cols-2">
            <DueNextSteps steps={data.dueNextSteps} now={dataUpdatedAt || Date.now()} />
            <RecentActivity items={data.recentActivity} />
          </div>
        </>
      ) : null}
    </section>
  );
}
