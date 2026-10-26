import { createFileRoute } from '@tanstack/react-router';
import { DecidedResults } from '@/components/discovery/DecidedResults';

export const Route = createFileRoute('/discovery/decided')({
  component: DecidedResults,
});
