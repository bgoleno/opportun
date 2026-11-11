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
  { to: '/settings/metrics', label: 'Metrics' },
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
          {/* -m-1.5 p-1.5: padding inside the scroller, so a link's focus ring (2px out) and its
              forced-colors outline (2px, 2px out: 4px) are inside the list's clip box with 2px
              to spare, and the same negative margin, so no link moves (issue
              https://github.com/bgoleno/opportun/issues/70). All four sides, not only the scroll
              axis: overflow-x-auto makes overflow-y compute to auto too, which is why a link's
              top was cut as well.
              On a phone the list scrolls sideways, and Chromium's own focus scroll leaves a link
              that is already partly in view where it is: Tab left the last link 8.8px past the
              list's end at 375, and Shift+Tab left the first link past its start (qa's report
              on https://github.com/bgoleno/opportun/pull/71). So each link scrolls itself fully
              into view on focus (nearest, so a link already in view does not move), and
              scroll-px-1.5 keeps it 6px from the edge, room for the outline. Scroll padding on
              its own changed nothing in CI: it only applies once something scrolls. */}
          <ul className="-m-1.5 flex scroll-px-1.5 gap-1 overflow-x-auto p-1.5 lg:flex-col">
            {sections.map((s) => (
              <li key={s.to}>
                <Link
                  to={s.to}
                  // Optional call: jsdom, which the unit tests run in, has no scrollIntoView.
                  onFocus={(e) =>
                    e.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
                  }
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
