import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetToasts } from '@/components/ui/toast';

// How long findBy* and waitFor wait for an element, 1000 ms by default. On a loaded host a
// worker can take longer than that to render a mocked response, and the wait failed with the
// page correctly showing a query still in flight
// (https://github.com/bgoleno/opportun/issues/41). These waits assert that something
// appears, not how fast: the API is mocked, so latency here measures the machine, not the
// app. Something that never appears still fails, after 5 s instead of 1 s. 5 s stays well
// under testTimeout (15 s, vite.config.ts), so a missing element is reported by Testing
// Library with its DOM dump rather than as a bare test timeout.
configure({ asyncUtilTimeout: 5_000 });

// jsdom does not implement scrolling; the router calls it on every navigation.
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = () => undefined;

// jsdom does not implement the Pointer Events capture methods; Radix's Toast swipe-to-dismiss
// gesture calls them on every pointer event over a toast, including a plain click on its own
// action button (#184 adds the first toast action a test here clicks).
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

afterEach(() => {
  cleanup();
  resetToasts();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
});
