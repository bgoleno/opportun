import { createFileRoute } from '@tanstack/react-router';
import { Pipeline } from '@/components/pipeline/Pipeline';
import { PipelineSearchSchema, type PipelineSearch } from '@/components/pipeline/data';

export const Route = createFileRoute('/pipeline')({
  validateSearch: (search): PipelineSearch => PipelineSearchSchema.parse(search),
  component: PipelinePage,
});

function PipelinePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <Pipeline
      search={search}
      onSearchChange={(patch) =>
        void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
      }
    />
  );
}
