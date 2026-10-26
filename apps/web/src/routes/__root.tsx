import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { meQuery, PUBLIC_PATHS } from '@/lib/auth';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Every screen except sign-in and registration needs a session.
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(meQuery);
    const isPublic = PUBLIC_PATHS.has(location.pathname);
    if (user === null && !isPublic) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    if (user !== null && isPublic) throw redirect({ to: '/' });
    return { user };
  },
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootComponent() {
  const { user } = Route.useRouteContext();
  if (user === null) return <Outlet />;
  return (
    <AppShell user={user}>
      <Outlet />
    </AppShell>
  );
}

function NotFound() {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">That page does not exist.</p>
      <Button asChild variant="outline">
        <Link to="/">Back to the dashboard</Link>
      </Button>
    </section>
  );
}
