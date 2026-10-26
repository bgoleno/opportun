// The one place every keyboard shortcut in the app is listed, mounted once in AppShell so `?`
// opens it from any screen (issue #155). Each screen that adds shortcuts adds its group here;
// there is deliberately no attempt to discover them automatically, since a screen's shortcuts
// are a handful of lines, not something worth a registry for.
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useHotkeys } from '@/lib/useHotkeys';

interface ShortcutGroup {
  title: string;
  items: { keys: string; description: string }[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Everywhere',
    items: [{ keys: '?', description: 'Show this list' }],
  },
  {
    title: 'Discovery review queue',
    items: [
      { keys: 'j / k', description: 'Select the next or previous result' },
      { keys: 'i', description: 'Accept the selected result' },
      { keys: 'x', description: 'Dismiss the selected result' },
      { keys: 'p', description: "Open the selected result's posting in a new tab" },
      { keys: 'Enter', description: 'Open the selected result’s details' },
      { keys: 'Space', description: 'Check the selected result for bulk accept or dismiss' },
      { keys: 'Shift+J / Shift+K', description: 'Extend the checked range while moving' },
      { keys: 'Escape', description: 'Clear the checked selection' },
    ],
  },
  {
    title: 'Decided results',
    items: [
      { keys: 'j / k', description: 'Select the next or previous result' },
      { keys: 'u', description: 'Unsuppress the selected result' },
    ],
  },
  {
    title: 'Pipeline',
    items: [
      { keys: 'j / k', description: 'Select the next or previous opportunity' },
      { keys: 'i', description: 'Mark the selected opportunity interested' },
      { keys: 'x', description: 'Dismiss the selected opportunity' },
      { keys: 'Enter', description: "Open the selected opportunity's page" },
      {
        keys: 'Space, then ↑ / ↓, then Space',
        description: 'On the board: pick up a card, move it, drop it in its column',
      },
    ],
  },
  {
    title: 'Contacts',
    items: [
      { keys: 'n / p', description: 'Next or previous page' },
      { keys: 'Home / End', description: 'First or last page' },
    ],
  },
];

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  useHotkeys({ '?': () => setOpen(true) });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <kbd className="rounded border px-1">?</kbd> anywhere to open this again. A
            shortcut never fires while you are typing in a field.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {GROUPS.map((group) => (
            <div key={group.title} className="grid gap-1.5">
              <h3 className="text-sm font-medium">{group.title}</h3>
              <ul className="grid gap-1">
                {group.items.map((item) => (
                  <li
                    key={item.keys}
                    className="flex items-center justify-between gap-4 text-sm text-muted-foreground"
                  >
                    <span>{item.description}</span>
                    <kbd className="shrink-0 rounded border px-1 text-foreground">{item.keys}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
