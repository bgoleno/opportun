import { createFileRoute } from '@tanstack/react-router';
import { CompaniesManager } from '@/components/discovery/CompaniesManager';

export const Route = createFileRoute('/discovery/companies')({
  component: CompaniesManager,
});
