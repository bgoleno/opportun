import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetToasts } from '@/components/ui/toast';

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
