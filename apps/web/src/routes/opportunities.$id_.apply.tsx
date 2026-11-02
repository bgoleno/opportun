import { createFileRoute } from '@tanstack/react-router';
import { ApplyPage } from '@/components/apply/ApplyPage';
import { STEPS, type StepId } from '@/components/apply/parts';

// /opportunities/:id/apply?step=…: a flat route (the `$id_` segment), so the apply page
// replaces the opportunity page instead of rendering inside it. An unknown or missing step
// starts at the resume step; `blocked` is set only by the open step when the browser refused
// the new tab, so a deep link never shows that notice by itself.
export interface ApplySearch {
  step: StepId;
  blocked?: true;
}

export function parseApplySearch(search: Record<string, unknown>): ApplySearch {
  const step = STEPS.find((s) => s.id === search['step'])?.id ?? 'resume';
  return search['blocked'] === true || search['blocked'] === 'true'
    ? { step, blocked: true }
    : { step };
}

export const Route = createFileRoute('/opportunities/$id_/apply')({
  validateSearch: parseApplySearch,
  component: ApplyRoute,
});

function ApplyRoute() {
  const { id } = Route.useParams();
  const { step, blocked } = Route.useSearch();
  // Keyed so another opportunity starts with fresh step state.
  return <ApplyPage key={id} opportunityId={id} step={step} blocked={blocked === true} />;
}
