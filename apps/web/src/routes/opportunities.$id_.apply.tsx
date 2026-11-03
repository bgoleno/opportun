import { createFileRoute } from '@tanstack/react-router';
import { DETAIL_FIELDS } from '@/components/apply/api';
import { ApplyPage } from '@/components/apply/ApplyPage';
import { STEPS, type StepId } from '@/components/apply/parts';

// /opportunities/:id/apply?step=…: a flat route (the `$id_` segment), so the apply page
// replaces the opportunity page instead of rendering inside it. An unknown or missing step
// starts at the resume step; `blocked` is set only by the open step when the browser refused
// the new tab, so a deep link never shows that notice by itself.
export interface ApplySearch {
  step: StepId;
  blocked?: true;
  /**
   * On the details step only: the detail fields a start-again did not carry over (#186), so the
   * step can name them. Only known field names are kept: a deep link can name nothing else.
   */
  cleared?: string[];
}

const DETAIL_KEYS: readonly string[] = DETAIL_FIELDS.map((f) => f.key);

export function parseApplySearch(search: Record<string, unknown>): ApplySearch {
  const step = STEPS.find((s) => s.id === search['step'])?.id ?? 'resume';
  const raw = search['cleared'];
  const cleared =
    step === 'details' && Array.isArray(raw)
      ? [
          ...new Set(
            raw.filter((k): k is string => typeof k === 'string' && DETAIL_KEYS.includes(k)),
          ),
        ]
      : [];
  return {
    step,
    ...(search['blocked'] === true || search['blocked'] === 'true'
      ? { blocked: true as const }
      : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
  };
}

export const Route = createFileRoute('/opportunities/$id_/apply')({
  validateSearch: parseApplySearch,
  component: ApplyRoute,
});

function ApplyRoute() {
  const { id } = Route.useParams();
  const { step, blocked, cleared } = Route.useSearch();
  // Keyed so another opportunity starts with fresh step state.
  return (
    <ApplyPage
      key={id}
      opportunityId={id}
      step={step}
      blocked={blocked === true}
      {...(cleared === undefined ? {} : { cleared })}
    />
  );
}
