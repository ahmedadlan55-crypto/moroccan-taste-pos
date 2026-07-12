import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

// Small shell-wide UI state: the collapsible sidebar + the command palette.
// Kept here so the Sidebar, Topbar and content margin all stay in sync without
// prop drilling.
interface ShellContextValue {
  collapsed: boolean;
  toggleCollapsed: () => void;
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

const COLLAPSE_KEY = "erp:sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // Global ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ShellContext.Provider value={{ collapsed, toggleCollapsed, paletteOpen, openPalette, closePalette }}>
      {children}
    </ShellContext.Provider>
  );
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within <ShellProvider>");
  return ctx;
}
