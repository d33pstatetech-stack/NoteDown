import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "localnotes.theme";

function readStored(): ThemeMode {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): ResolvedTheme {
  const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  return query?.matches ? "dark" : "light";
}

/**
 * Light/dark theming driven by a `data-theme` attribute so CSS owns all colour
 * decisions. Defaults to the OS preference and remembers an explicit choice.
 */
export function useTheme(): {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(readStored);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const listener = () => setSystem(query.matches ? "dark" : "light");
    query.addEventListener?.("change", listener);
    return () => query.removeEventListener?.("change", listener);
  }, []);

  const resolved: ResolvedTheme = mode === "system" ? system : mode;

  useEffect(() => {
    document.documentElement.dataset["theme"] = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing: theming simply will not persist.
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(resolved === "dark" ? "light" : "dark");
  }, [resolved, setMode]);

  return { mode, resolved, setMode, toggle };
}
