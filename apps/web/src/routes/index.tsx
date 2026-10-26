import { createFileRoute } from '@tanstack/react-router';
import { Dashboard } from '@/components/dashboard/Dashboard';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage() {
  const { user } = Route.useRouteContext();
  return <Dashboard greeting={user ? `Welcome back, ${user.displayName}.` : undefined} />;
}
