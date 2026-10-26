// Light/dark/auto theming (FR-U10). The resolved theme is written to <html data-theme>;
// colors are CSS custom properties keyed off that attribute (src/index.css). The user's
// choice lives on the server (GET/PATCH /api/v1/settings/theme); localStorage only
// mirrors it so public/theme-init.js can apply it before first paint.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';

export type ThemePref = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFS: readonly ThemePref[] = ['light', 'dark', 'auto'];
/** Keep in sync with public/theme-init.js. */
export const THEME_STORAGE_KEY = 'opportun.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'auto';
}

/** The order the header toggle steps through. */
export function nextPref(p: ThemePref): ThemePref {
  return p === 'light' ? 'dark' : p === 'dark' ? 'auto' : 'light';
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === 'auto') return prefersDark ? 'dark' : 'light';
  return pref;
}

function readMirror(): ThemePref {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePref(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function writeMirror(p: ThemePref): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, p);
  } catch {
    // Storage blocked: the theme still applies for this page view.
  }
}

interface ThemeContextValue {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
}

interface ThemeSyncContextValue {
  /** Takes a server value without echoing it back. */
  adopt: (p: ThemePref) => void;
  /** True while a signed-in shell is mounted; only then do changes go to the server. */
  setServerSync: (on: boolean) => void;
  /** Bumped on every local change, so a slow server read cannot clobber it. */
  changeCount: () => number;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const ThemeSyncContext = createContext<ThemeSyncContextValue | null>(null);

export function ThemeProvider(props: { children: ReactNode }): React.JSX.Element {
  const [pref, setPrefState] = useState<ThemePref>(readMirror);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);
  const serverSync = useRef(false);
  const changes = useRef(0);

  // FR-U10: auto follows the system setting live.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const resolved = resolveTheme(pref, prefersDark);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setPref = useCallback((p: ThemePref) => {
    changes.current += 1;
    setPrefState(p);
    writeMirror(p);
    if (serverSync.current) {
      // Best effort: the mirror already holds the choice for this browser.
      api('/settings/theme', { method: 'PATCH', body: { pref: p } }).catch(() => undefined);
    }
  }, []);

  const sync = useMemo<ThemeSyncContextValue>(
    () => ({
      adopt: (p) => {
        setPrefState(p);
        writeMirror(p);
      },
      setServerSync: (on) => {
        serverSync.current = on;
      },
      changeCount: () => changes.current,
    }),
    [],
  );

  const value = useMemo(() => ({ pref, setPref }), [pref, setPref]);
  return (
    <ThemeContext.Provider value={value}>
      <ThemeSyncContext.Provider value={sync}>{props.children}</ThemeSyncContext.Provider>
    </ThemeContext.Provider>
  );
}

export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * Mount inside the signed-in shell: loads the saved preference once and turns on
 * persistence of later changes. Renders nothing.
 */
export function ThemeServerSync(): null {
  const ctx = useContext(ThemeSyncContext);
  if (ctx === null) throw new Error('ThemeServerSync must be used inside <ThemeProvider>');
  const { adopt, setServerSync, changeCount } = ctx;

  useEffect(() => {
    setServerSync(true);
    const startedAt = changeCount();
    let cancelled = false;
    api<{ pref: ThemePref }>('/settings/theme', { method: 'GET' }).then(
      (res) => {
        if (!cancelled && changeCount() === startedAt && isThemePref(res.pref)) adopt(res.pref);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      setServerSync(false);
    };
  }, [adopt, setServerSync, changeCount]);

  return null;
}
