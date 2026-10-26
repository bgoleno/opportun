import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';

const SECTIONS = [
  { to: '/settings/account', label: 'Account' },
  { to: '/settings/security', label: 'Security' },
  { to: '/settings/profile', label: 'Profile' },
  { to: '/settings/role-targets', label: 'Role targets' },
  { to: '/settings/resume-rules', label: 'Resume rules' },
  { to: '/settings/ai', label: 'AI' },
  { to: '/settings/integrations', label: 'Integrations' },
  { to: '/settings/mail-filters', label: 'Mail filters' },
  { to: '/settings/data', label: 'Import/Export' },
  { to: '/settings/users', label: 'Users', adminOnly: true },
  { to: '/settings/jobs', label: 'Jobs', adminOnly: true },
] as const;

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { user } = Route.useRouteContext();
  const sections = SECTIONS.filter((s) => !('adminOnly' in s) || user?.isAdmin === true);
  return (
    <section>
      <PageHeader
        title="Settings"
        description="Your account, profile, and what you are looking for."
      />
      <div className="flex flex-col gap-6 lg:flex-row">
        <nav aria-label="Settings sections" className="lg:w-48 lg:shrink-0">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col">
            {sections.map((s) => (
              <li key={s.to}>
                <Link
                  to={s.to}
                  className="block rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </section>
  );
}
