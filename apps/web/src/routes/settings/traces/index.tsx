import { createFileRoute } from '@tanstack/react-router';
import { RANGES, type TraceFilters } from '@/components/traces/api';
import { TracesPage } from '@/components/traces/TracesPage';

/**
 * Settings > AI traces (FR-T7, https://github.com/bgoleno/opportun/issues/347). Not in the
 * Settings nav: design.md 14.12 gives Settings' link to the metric dashboards (FR-T6), and this
 * page is linked from there.
 *
 * The filters are the URL's search, so a filtered view can be linked to. A value of the wrong
 * shape is dropped rather than failing the route: people type and paste these. The server
 * checks every value again and binds it.
 */
const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

export function parseTraceSearch(search: Record<string, unknown>): TraceFilters {
  const out: TraceFilters = {};
  const task = text(search['task'], 64);
  const model = text(search['model'], 128);
  const provider = text(search['provider'], 32);
  const conversation = text(search['conversation'], 64);
  const status =
    search['status'] === 'ok' || search['status'] === 'error' ? search['status'] : undefined;
  const range = RANGES.find((r) => r.value === search['range'])?.value;
  if (task !== undefined) out.task = task;
  if (model !== undefined) out.model = model;
  if (provider !== undefined) out.provider = provider;
  if (status !== undefined) out.status = status;
  if (range !== undefined) out.range = range;
  if (conversation !== undefined) out.conversation = conversation;
  return out;
}

export const Route = createFileRoute('/settings/traces/')({
  validateSearch: parseTraceSearch,
  component: TracesRoute,
});

function TracesRoute() {
  const { user } = Route.useRouteContext();
  const filters = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <TracesPage
      isAdmin={user?.isAdmin === true}
      filters={filters}
      onFiltersChange={(next) => void navigate({ search: parseTraceSearch({ ...next }) })}
    />
  );
}
