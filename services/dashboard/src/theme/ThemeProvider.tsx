import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'dark' | 'light';

interface ThemeValue {
  // The theme in effect now: the choice made with the toggle, else the preference of the browser.
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const query = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;

// The theme follows prefers-color-scheme. The toggle overrides it for this page load only: the choice is kept in memory
// (React state) and nowhere else, so it is gone after a reload. No storage API is used (docs/architecture.md, decision 35).
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [system, setSystem] = useState<Theme>(() => (query()?.matches ? 'light' : 'dark'));
  const [chosen, setChosen] = useState<Theme | null>(null);

  useEffect(() => {
    const list = query();
    if (!list) return;
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'light' : 'dark');
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);

  // Without a choice the attribute is absent, and the CSS media query decides.
  useEffect(() => {
    const root = document.documentElement;
    if (chosen) root.dataset.theme = chosen;
    else delete root.dataset.theme;
  }, [chosen]);

  const theme = chosen ?? system;
  const toggle = useCallback(() => setChosen(theme === 'dark' ? 'light' : 'dark'), [theme]);
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme needs a ThemeProvider');
  return value;
}
