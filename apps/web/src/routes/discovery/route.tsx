import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { PageHeader } from '@/components/PageHeader';

const SECTIONS = [
  { to: '/discovery', label: 'Review queue', exact: true },
  { to: '/discovery/decided', label: 'Decided', exact: false },
  { to: '/discovery/companies', label: 'Companies', exact: false },
  { to: '/discovery/sources', label: 'Sources', exact: false },
  { to: '/discovery/prompts', label: 'Prompts', exact: false },
] as const;

export const Route = createFileRoute('/discovery')({
  component: DiscoveryLayout,
});

function DiscoveryLayout() {
  return (
    <section className="min-w-0">
      <PageHeader
        title="Discovery"
        description="New postings from your sources, ranked against your role targets."
      />
      <nav aria-label="Discovery sections" data-tour="discovery-sections" className="mb-4">
        <ul className="flex gap-1 overflow-x-auto border-b pb-2">
          {SECTIONS.map((s) => (
            <li key={s.to}>
              <Link
                to={s.to}
                activeOptions={{ exact: s.exact }}
                className="block rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
              >
                {s.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </section>
  );
}
