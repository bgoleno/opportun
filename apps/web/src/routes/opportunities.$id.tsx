import { createFileRoute } from '@tanstack/react-router';
import { OpportunityDetail } from '@/components/opportunity/OpportunityDetail';

export const Route = createFileRoute('/opportunities/$id')({
  component: OpportunityPage,
});

function OpportunityPage() {
  const { id } = Route.useParams();
  // Keyed so switching opportunities resets tab and form state.
  return <OpportunityDetail key={id} id={id} />;
}
