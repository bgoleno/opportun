import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  nextPref,
  THEME_STORAGE_KEY,
  ThemeProvider,
  ThemeServerSync,
  useTheme,
  type ThemePref,
} from './theme';

/** A controllable prefers-color-scheme media query (jsdom has no matchMedia). */
function mockColorScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    get matches() {
      return dark;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  );
  return {
    setDark(next: boolean) {
      dark = next;
      listeners.forEach((fn) => fn({ matches: next } as MediaQueryListEvent));
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);
const themeAttr = () => document.documentElement.getAttribute('data-theme');

describe('nextPref', () => {
  it('cycles light, dark, auto', () => {
    expect(nextPref('light')).toBe('dark');
    expect(nextPref('dark')).toBe('auto');
    expect(nextPref('auto')).toBe('light');
  });
});

describe('useTheme', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to auto and follows prefers-color-scheme', () => {
    const scheme = mockColorScheme(false);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.pref).toBe('auto');
    expect(themeAttr()).toBe('light');
    act(() => scheme.setDark(true));
    expect(themeAttr()).toBe('dark');
    act(() => scheme.setDark(false));
    expect(themeAttr()).toBe('light');
  });

  it('cycles the preference, sets data-theme and mirrors it to localStorage', () => {
    const scheme = mockColorScheme(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.pref).toBe('light');
    expect(themeAttr()).toBe('light');

    const seen: [ThemePref, string | null][] = [];
    for (let i = 0; i < 3; i++) {
      act(() => result.current.setPref(nextPref(result.current.pref)));
      seen.push([result.current.pref, themeAttr()]);
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(result.current.pref);
    }
    // auto resolves through the (dark) system preference.
    expect(seen).toEqual([
      ['dark', 'dark'],
      ['auto', 'dark'],
      ['light', 'light'],
    ]);
    // An explicit choice ignores system changes.
    act(() => scheme.setDark(false));
    act(() => result.current.setPref('dark'));
    act(() => scheme.setDark(true));
    act(() => scheme.setDark(false));
    expect(themeAttr()).toBe('dark');
    // Logged out (no server sync mounted): nothing goes to the server.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a corrupt localStorage mirror', () => {
    mockColorScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.pref).toBe('auto');
  });

  it('adopts the server preference and persists changes via PATCH /api/v1/settings/theme', async () => {
    mockColorScheme(false);
    document.cookie = 'opportun_csrf=tok123; path=/';
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ pref: 'dark' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(init?.body as string, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    let api: ReturnType<typeof useTheme> | undefined;
    function Probe() {
      api = useTheme();
      return null;
    }
    render(
      <ThemeProvider>
        <ThemeServerSync />
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(api?.pref).toBe('dark'));
    expect(themeAttr()).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/settings/theme',
      expect.objectContaining({ method: 'GET' }),
    );

    act(() => api?.setPref('light'));
    expect(themeAttr()).toBe('light');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe('/api/v1/settings/theme');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ pref: 'light' });
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('tok123');
  });
});
