import { createFileRoute } from '@tanstack/react-router';
import { ReviewQueue } from '@/components/discovery/ReviewQueue';

export const Route = createFileRoute('/discovery/')({
  staticData: { layout: 'fluid' },
  component: ReviewQueue,
});
