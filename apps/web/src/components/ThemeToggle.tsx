import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isThemePref, useTheme, type ThemePref } from '@/lib/theme';

const OPTIONS: { pref: ThemePref; label: string; icon: LucideIcon }[] = [
  { pref: 'light', label: 'Light', icon: Sun },
  { pref: 'dark', label: 'Dark', icon: Moon },
  { pref: 'auto', label: 'Auto (system)', icon: Monitor },
];

export function themeLabel(pref: ThemePref): string {
  return OPTIONS.find((o) => o.pref === pref)?.label ?? pref;
}

/** Header control: pick light, dark, or auto (follows the operating system). */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const Icon = OPTIONS.find((o) => o.pref === pref)?.icon ?? Monitor;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Theme: ${themeLabel(pref)}`}>
              <Icon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme: {themeLabel(pref)}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(v) => {
            if (isThemePref(v)) setPref(v);
          }}
        >
          {OPTIONS.map((o) => (
            <DropdownMenuRadioItem key={o.pref} value={o.pref}>
              <o.icon aria-hidden="true" />
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
