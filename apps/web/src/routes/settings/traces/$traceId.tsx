import { createFileRoute } from '@tanstack/react-router';
import { TraceDetailPage } from '@/components/traces/TraceDetail';

/** One AI trace's waterfall (FR-T7, https://github.com/bgoleno/opportun/issues/347). */
export const Route = createFileRoute('/settings/traces/$traceId')({
  component: TraceRoute,
});

function TraceRoute() {
  const { traceId } = Route.useParams();
  // Keyed so moving between traces starts each with its first span selected.
  return <TraceDetailPage key={traceId} traceId={traceId} />;
}
