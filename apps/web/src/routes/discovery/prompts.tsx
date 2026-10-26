import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { DiscoveryPrompts } from '@/components/discovery/DiscoveryPrompts';

const SearchSchema = z.object({
  roleTargetId: z.string().min(1).max(64).optional().catch(undefined),
});

export const Route = createFileRoute('/discovery/prompts')({
  validateSearch: (search) => SearchSchema.parse(search),
  component: PromptsPage,
});

function PromptsPage() {
  const { roleTargetId } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <DiscoveryPrompts
      roleTargetId={roleTargetId}
      onRoleTargetChange={(id) => void navigate({ search: { roleTargetId: id }, replace: true })}
    />
  );
}
