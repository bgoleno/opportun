import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHotkeys } from './useHotkeys';

function press(key: string, opts: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(event);
  return event;
}

describe('useHotkeys', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('calls the handler bound to the pressed key', () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    press('j');
    expect(onJ).toHaveBeenCalledTimes(1);
  });

  it('does not fire while focus is in a text field, which is most of this app', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    press('j', {}, input);
    expect(onJ).not.toHaveBeenCalled();
  });

  it('does not fire inside a composite widget such as a menu', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    press('j', {}, menu);
    expect(onJ).not.toHaveBeenCalled();
  });

  it('does not fire with a modifier held, but does fire for a shifted key like ?', () => {
    const onJ = vi.fn();
    const onHelp = vi.fn();
    renderHook(() => useHotkeys({ j: onJ, '?': onHelp }));
    press('j', { ctrlKey: true });
    press('j', { metaKey: true });
    press('j', { altKey: true });
    expect(onJ).not.toHaveBeenCalled();
    press('?', { shiftKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it('does not fire while a dialog is open', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    press('j');
    expect(onJ).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }, { enabled: false }));
    press('j');
    expect(onJ).not.toHaveBeenCalled();
  });

  it('leaves preventDefault to the handler, rather than calling it unconditionally', () => {
    // A handler that only sometimes claims the key (ReviewQueue.tsx's Enter, which lets a
    // nested link or button keep its own meaning) needs the choice; the hook must not make it
    // for every binding before the handler even runs.
    const claims = vi.fn((e: KeyboardEvent) => e.preventDefault());
    const declines = vi.fn();
    renderHook(() => useHotkeys({ j: claims, k: declines }));
    expect(press('j').defaultPrevented).toBe(true);
    expect(press('k').defaultPrevented).toBe(false);
    const unbound = press('z');
    expect(unbound.defaultPrevented).toBe(false);
    expect(claims).toHaveBeenCalledTimes(1);
    expect(declines).toHaveBeenCalledTimes(1);
  });

  it('stops listening once unmounted', () => {
    const onJ = vi.fn();
    const { unmount } = renderHook(() => useHotkeys({ j: onJ }));
    unmount();
    press('j');
    expect(onJ).not.toHaveBeenCalled();
  });
});
