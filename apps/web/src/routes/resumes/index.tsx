import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';
import { ResumeList } from '@/components/resume/ResumeList';

export const Route = createFileRoute('/resumes/')({
  component: ResumesPage,
});

function ResumesPage() {
  return (
    <section>
      <PageHeader
        tourId="resumes-header"
        title="Resumes"
        description="Base resumes and the tailored copies made from them."
      />
      <ResumeList />
    </section>
  );
}
