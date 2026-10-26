// Pre-paint theme (FR-U10). Loaded synchronously from <head> as a same-origin file so
// the strict CSP (no inline scripts) allows it. Reads the localStorage mirror written by
// src/lib/theme.tsx (key "opportun.theme") and sets <html data-theme> before first paint.
(function () {
  var pref = 'auto';
  try {
    var stored = window.localStorage.getItem('opportun.theme');
    if (stored === 'light' || stored === 'dark' || stored === 'auto') pref = stored;
  } catch {
    // Storage blocked: fall back to the system preference.
  }
  var dark =
    pref === 'dark' ||
    (pref === 'auto' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
