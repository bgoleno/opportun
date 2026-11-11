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
// The shapes the server accepts (apps/server/src/routes/obsTraces.ts: TASK, MODEL, PROVIDER,
// ROW_ID). A value of any other shape would be refused there with its validation text, so it is
// dropped here and never sent (https://github.com/bgoleno/opportun/issues/365). Keep the two in
// step: a shape the server widens is refused here until this follows.
const TASK = /^[a-z][a-z0-9_.]{0,63}$/;
const PROVIDER = /^[a-z][a-z0-9_]{0,31}$/;
const ROW_ID = /^[A-Za-z0-9-]{1,64}$/;
const MODEL_SEGMENT = /^[A-Za-z0-9._:-]+$/;
/** A model id: up to 128 characters, at most one `/`, each side of it a model segment. */
const isModel = (v: string) => {
  const parts = v.split('/');
  return v.length <= 128 && parts.length <= 2 && parts.every((p) => MODEL_SEGMENT.test(p));
};

const shaped = (v: unknown, ok: (s: string) => boolean): string | undefined =>
  typeof v === 'string' && ok(v) ? v : undefined;

export function parseTraceSearch(search: Record<string, unknown>): TraceFilters {
  const out: TraceFilters = {};
  const task = shaped(search['task'], (v) => TASK.test(v));
  const model = shaped(search['model'], isModel);
  const provider = shaped(search['provider'], (v) => PROVIDER.test(v));
  const conversation = shaped(search['conversation'], (v) => ROW_ID.test(v));
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
  // Parsed again: the router hands a route its own validated search merged over what its parent
  // routes passed through unvalidated, so a value parseTraceSearch dropped (?status=failed) is
  // still in useSearch(). Only the parsed filters reach the page and the server (qa on
  // https://github.com/bgoleno/opportun/pull/361).
  const filters = parseTraceSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  return (
    <TracesPage
      isAdmin={user?.isAdmin === true}
      filters={filters}
      onFiltersChange={(next) => void navigate({ search: parseTraceSearch({ ...next }) })}
    />
  );
}
