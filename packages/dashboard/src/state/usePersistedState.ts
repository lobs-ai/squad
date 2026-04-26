import { useEffect, useState } from "react";

/**
 * Tiny typed wrapper around localStorage. Tracks one key as React state and
 * mirrors the value back to storage on every change. Hydration runs once,
 * synchronously, so a value is available on the very first render.
 */
export function usePersistedState(
  key: string,
  initial: string,
): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored != null) return stored;
    } catch {
      // Silently ignore — Safari private mode, etc.
    }
    return initial;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Silently ignore.
    }
  }, [key, value]);
  return [value, setValue];
}
