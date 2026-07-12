import { useCallback, useEffect, useState } from "react";

/**
 * Persisted state backed by localStorage (JSON-serialized). SSR/no-storage safe:
 * falls back to in-memory state when localStorage is unavailable. Cross-tab sync
 * via the `storage` event.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  const read = useCallback((): T => {
    if (typeof window === "undefined") return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  }, [key, initial]);

  const [value, setValue] = useState<T>(read);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* quota / disabled — keep in-memory value */
        }
        return resolved;
      });
    },
    [key],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (e.key === key) setValue(read());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, read]);

  return [value, set];
}
