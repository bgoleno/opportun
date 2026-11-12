import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  OPPORTUNITY_TABS,
  OpportunityDetail,
  type OpportunityTab,
} from '@/components/opportunity/OpportunityDetail';

// /opportunities/:id?tab=…: the tab is in the URL (https://github.com/bgoleno/opportun/issues/428),
// so a link can open one, for example the Assisted apply panel's link to the Resume tab.
export interface OpportunitySearch {
  tab?: OpportunityTab;
}

/** Only a real tab is kept: a deep link can name nothing else. */
export function parseOpportunitySearch(search: Record<string, unknown>): OpportunitySearch {
  const tab = OPPORTUNITY_TABS.find((t) => t === search['tab']);
  return tab === undefined ? {} : { tab };
}

export const Route = createFileRoute('/opportunities/$id')({
  validateSearch: parseOpportunitySearch,
  component: OpportunityPage,
});

function OpportunityPage() {
  const { id } = Route.useParams();
  // Re-parsed: the router merges a parent's raw search into a route's validated one.
  const { tab } = parseOpportunitySearch(Route.useSearch());
  const navigate = useNavigate();
  // Keyed so switching opportunities resets tab and form state.
  return (
    <OpportunityDetail
      key={id}
      id={id}
      tab={tab ?? 'timeline'}
      onTabChange={(next) =>
        void navigate({
          to: '/opportunities/$id',
          params: { id },
          search: next === 'timeline' ? {} : { tab: next },
          replace: true,
        })
      }
    />
  );
}
