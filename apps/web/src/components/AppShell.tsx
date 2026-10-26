import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Briefcase,
  Check,
  ChevronDown,
  Compass,
  Contact,
  FileText,
  Inbox,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ShortcutsOverlay } from '@/components/ShortcutsOverlay';
import { ThemeToggle } from '@/components/ThemeToggle';
import { TourProvider, useTour } from '@/components/tour/TourProvider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api';
import { forceLocalSignOut, logout, type User } from '@/lib/auth';
import { useSidebarCollapsed } from '@/lib/sidebar';
import { ThemeServerSync } from '@/lib/theme';
import { cn } from '@/lib/utils';

interface NavItem {
  to: '/' | '/pipeline' | '/discovery' | '/resumes' | '/inbox' | '/contacts' | '/settings';
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/pipeline', label: 'Pipeline', icon: Briefcase },
  { to: '/discovery', label: 'Discovery', icon: Compass },
  { to: '/resumes', label: 'Resumes', icon: FileText },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/contacts', label: 'Contacts', icon: Contact },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** Mirrors the router's own matching so the menu agrees with the sidebar's active style. */
function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

const navLinkClass =
  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-accent data-[status=active]:text-accent-foreground';

function Brand() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2 rounded-md text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img src="/favicon.svg" alt="" className="size-6" />
      Opportun
    </Link>
  );
}

function UserMenu({ user }: { user: User }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { launch } = useTour();
  // #151: set only when the server could not confirm the session ended, so the dialog below
  // is the one place this ever offers forceLocalSignOut, never a silent fallback inside
  // signOut itself. Staying on this page with the menu still showing the signed-in account is
  // the honest state for a failure the server never confirmed either way.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);

  async function signOut() {
    try {
      await logout(qc);
      await navigate({ to: '/login' });
    } catch (err) {
      setUnconfirmed(errorMessage(err));
    }
  }

  function leaveAnyway(): void {
    forceLocalSignOut(qc);
    setUnconfirmed(null);
    void navigate({ to: '/login' });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="gap-1.5 px-2"
            aria-label={`Account: ${user.displayName}`}
            data-tour="account-menu"
          >
            <span
              aria-hidden="true"
              className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
            >
              {user.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden max-w-40 truncate sm:inline">{user.displayName}</span>
            <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="grid gap-0.5">
            <span className="truncate">{user.displayName}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void navigate({ to: '/settings' })}>
            <Settings aria-hidden="true" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={launch}>
            <MapIcon aria-hidden="true" />
            Take the tour
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={unconfirmed !== null}
        onOpenChange={(open) => {
          if (!open) setUnconfirmed(null);
        }}
        title="Could not confirm sign-out"
        description={`${unconfirmed ?? ''} The server did not confirm your session ended, so you are still signed in on this device. If this is a shared or public computer, try again before stepping away: leaving anyway does not end the session on the server, and whoever uses this browser next could be signed back in without a password until it does.`}
        confirmLabel="Sign out of this browser anyway"
        onConfirm={leaveAnyway}
      />
    </>
  );
}

/**
 * The destinations behind a three-bar button. Shown only below md, where the sidebar is
 * hidden: a portrait phone has no room for a row of seven labelled links.
 */
function MobileNavMenu() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <DropdownMenu>
      {/* #138: a dropdown trigger needs its own composition (Tooltip > TooltipTrigger
          asChild > DropdownMenuTrigger asChild > Button) rather than IconButton, which owns
          the Tooltip-wraps-Button pairing outright and has no slot to interpose a second
          trigger into. Both asChild layers chain their prop merges the normal Radix way. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open navigation menu"
            >
              <Menu aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Open navigation menu</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-56">
        {NAV_ITEMS.map((item) => (
          <DropdownMenuItem
            key={item.to}
            asChild
            aria-current={isActive(pathname, item) ? 'page' : undefined}
          >
            <Link to={item.to}>
              <item.icon aria-hidden="true" />
              {item.label}
              {isActive(pathname, item) && <Check aria-hidden="true" className="ml-auto" />}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Collapses the sidebar to an icon rail. Only shown at md and up, where the sidebar is a
 * column that costs horizontal room; below that the nav is a horizontal strip already.
 */
function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <IconButton
      variant="ghost"
      className="hidden md:inline-flex"
      label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      aria-controls="main-nav"
      onClick={onToggle}
    >
      <Icon aria-hidden="true" />
    </IconButton>
  );
}

/**
 * Signed-in layout: header (brand, theme, account), sidebar navigation, main content, under the
 * first-run tour (FR-U11), which renders its Resume pill after the content in tab order.
 */
export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  return (
    <TourProvider>
      <Shell user={user}>{children}</Shell>
    </TourProvider>
  );
}

function Shell({ user, children }: { user: User; children: ReactNode }) {
  const { collapsed, toggle } = useSidebarCollapsed();
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <ThemeServerSync />
      <ShortcutsOverlay />
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-card/95 px-4 backdrop-blur">
        <MobileNavMenu />
        <Brand />
        <SidebarToggle collapsed={collapsed} onToggle={toggle} />
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <UserMenu user={user} />
        </div>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          id="main-nav"
          aria-label="Main"
          data-collapsed={collapsed}
          className={cn(
            'hidden bg-sidebar transition-[width] md:block md:shrink-0 md:border-r',
            collapsed ? 'md:w-14' : 'md:w-56',
          )}
        >
          <ul className="sticky top-14 flex flex-col gap-1 p-3">
            {NAV_ITEMS.map((item) => {
              const link = (
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.exact ?? false }}
                  className={cn(navLinkClass, collapsed && 'justify-center px-0')}
                >
                  <item.icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className={cn(collapsed && 'sr-only')}>{item.label}</span>
                </Link>
              );
              // #138: collapsed is the only state where this link is icon-only (the label is
              // sr-only above); expanded, the visible label already says what this is, and a
              // redundant tooltip over fully-visible text would be noise.
              return (
                <li key={item.to}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
