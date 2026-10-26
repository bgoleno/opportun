import { createFileRoute } from '@tanstack/react-router';
import { SourcesManager } from '@/components/discovery/SourcesManager';

export const Route = createFileRoute('/discovery/sources')({
  component: SourcesManager,
});
