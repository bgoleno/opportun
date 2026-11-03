import { createFileRoute } from '@tanstack/react-router';
import { SubmissionDetail } from '@/components/apply/SubmissionDetail';

// /opportunities/:id/applications/:submissionId: one application after the fact (design S7,
// https://github.com/bgoleno/opportun/issues/149). A flat route (the `$id_` segment), like the
// apply page, so it replaces the opportunity page instead of rendering inside it.
export const Route = createFileRoute('/opportunities/$id_/applications/$submissionId')({
  component: SubmissionDetailRoute,
});

function SubmissionDetailRoute() {
  const { id, submissionId } = Route.useParams();
  // Keyed so moving between applications starts with fresh state.
  return <SubmissionDetail key={submissionId} opportunityId={id} submissionId={submissionId} />;
}
