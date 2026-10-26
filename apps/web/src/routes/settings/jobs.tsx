import { createFileRoute } from '@tanstack/react-router';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { JobsCard } from './-jobs';

export const Route = createFileRoute('/settings/jobs')({
  component: JobsSettings,
});

function JobsSettings() {
  const { user } = Route.useRouteContext();
  if (user === null) return null;
  // The server already scopes a non-admin's view to their own jobs; this only spares them a
  // page that has nothing useful to tell them.
  if (!user.isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>Only an administrator can see the job queue.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <JobsCard />;
}
