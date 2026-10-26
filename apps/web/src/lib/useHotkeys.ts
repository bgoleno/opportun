// A single document-level keyboard listener per screen, so every surface that wants shortcuts
// gets the same guards instead of a second copy of them (issue #155): never while focus is in
// a text field, which is most of this app; never with a modifier held, so browser and OS
// shortcuts stay untouched; never inside a composite widget with its own key handling (a menu,
// a listbox); and never while a dialog is open, since a dialog's own keys (Escape, the native
// <dialog> element's focus trap) should be the only ones firing underneath it.
import { useEffect } from 'react';

/** Elements that own their own keystrokes: a shortcut must never steal from one of these. */
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Composite widgets with their own key handling. */
const WIDGET = '[role="menu"], [role="menuitem"], [role="listbox"], [role="combobox"]';

export type Hotkeys = Record<string, (e: KeyboardEvent) => void>;

/**
 * Registers one handler per key (matching `KeyboardEvent.key`, so a shifted character like
 * `?` is its own binding, not `Shift` plus `/`). A key with no binding is left alone. The hook
 * does not call `preventDefault` on the matched event itself: a handler that always wants the
 * key calls it unconditionally, same as before; one that only sometimes claims the key (Enter
 * on a row that lets a nested link or button keep its own native activation, say) calls it
 * only on the branch that actually handles the key, exactly as ReviewQueue.tsx's handler
 * already needs to.
 */
export function useHotkeys(bindings: Hotkeys, opts: { enabled?: boolean } = {}): void {
  const enabled = opts.enabled ?? true;
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(TYPING) || target?.closest(WIDGET)) return;
      if (document.querySelector('dialog[open]') !== null) return;
      const handler = bindings[e.key];
      if (handler === undefined) return;
      handler(e);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [bindings, enabled]);
}
