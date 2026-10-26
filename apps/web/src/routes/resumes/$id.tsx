import { createFileRoute } from '@tanstack/react-router';
import { ResumeWorkspace } from '@/components/resume/ResumeWorkspace';

export const Route = createFileRoute('/resumes/$id')({
  component: ResumePage,
});

function ResumePage() {
  const { id } = Route.useParams();
  // Keyed so switching resumes resets the chat state.
  return <ResumeWorkspace key={id} id={id} />;
}
