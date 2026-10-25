"use client";

import * as React from "react";

type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

const fallbackThemeContext: ThemeContextValue = {
  setTheme: () => undefined,
  theme: "light",
  toggleTheme: () => undefined,
};

// Browser storage can throw on access (a private window, blocked site data); the theme then falls back
// to light and is simply not remembered (2026-10-26 cache audit, P3).
function readSavedTheme(): string | null {
  try {
    return window.localStorage.getItem("phoenix-theme");
  } catch {
    return null;
  }
}

function saveTheme(theme: Theme) {
  try {
    window.localStorage.setItem("phoenix-theme", theme);
  } catch {
    // Not remembered — the choice still applies to this page.
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>("light");

  React.useEffect(() => {
    const savedTheme = readSavedTheme();
    const initialTheme = savedTheme === "dark" ? "dark" : "light";
    const frame = window.requestAnimationFrame(() => {
      setThemeState(initialTheme);
    });

    applyTheme(initialTheme);

    return () => window.cancelAnimationFrame(frame);
  }, []);

  const setTheme = React.useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
    applyTheme(nextTheme);
    saveTheme(nextTheme);
  }, []);

  const toggleTheme = React.useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [setTheme, theme]);

  const value = React.useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [setTheme, theme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = React.useContext(ThemeContext);

  if (!context) {
    return fallbackThemeContext;
  }

  return context;
}
