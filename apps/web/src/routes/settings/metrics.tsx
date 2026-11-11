import { createFileRoute } from '@tanstack/react-router';
import { type MetricsSearch, MetricsPage } from '@/components/metrics/MetricsPage';

/**
 * Settings > Metrics (FR-T6, https://github.com/bgoleno/opportun/issues/346). The list's
 * filters and the chosen metric are the URL's search, so a view can be linked to. A value of
 * the wrong shape is dropped rather than failing the route; the page only compares it against
 * the catalog the server sent, and the server checks the metric again.
 */
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

export function parseMetricsSearch(search: Record<string, unknown>): MetricsSearch {
  const out: MetricsSearch = {};
  const q = text(search['q'], 100);
  const attr = text(search['attr'], 128);
  const metric = text(search['metric'], 128);
  if (q !== undefined) out.q = q;
  if (attr !== undefined) out.attr = attr;
  if (metric !== undefined) out.metric = metric;
  return out;
}

export const Route = createFileRoute('/settings/metrics')({
  validateSearch: parseMetricsSearch,
  component: MetricsRoute,
});

function MetricsRoute() {
  const { user } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <MetricsPage
      isAdmin={user?.isAdmin === true}
      search={search}
      // Typing in the search box replaces the entry rather than adding one per keystroke.
      onSearchChange={(next) =>
        void navigate({ search: parseMetricsSearch({ ...next }), replace: true })
      }
    />
  );
}
