import { Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";
import { CommandPalette } from "./CommandPalette";
import { RouteFallback } from "./RouteFallback";
import { ShellProvider } from "./shell-context";
import { useShell } from "./shell-context";
import { cn } from "@/shared/lib";

// The ONE persistent shell: fixed RTL sidebar (right), sticky topbar, an animated
// routed content area, a mobile bottom nav and the command palette. The Suspense
// boundary is INSIDE the content area so the shell never re-mounts while a lazy
// route chunk loads.
export function AppShell() {
  return (
    <ShellProvider>
      <ShellFrame />
    </ShellProvider>
  );
}

function ShellFrame() {
  const location = useLocation();
  const { collapsed } = useShell();

  return (
    <div className="min-h-screen min-h-[100dvh] overflow-x-hidden">
      {/* a11y — keyboard users jump straight to the routed content (WCAG 2.4.1). */}
      <a href="#main" className="skip-link no-print">
        تخطٍّ إلى المحتوى
      </a>
      <Sidebar />
      <Topbar />
      {/* pb clears the fixed MobileNav + the iOS home-indicator safe area on
          phones; desktop has no bottom nav so it reverts to a normal pad. */}
      <main
        className={cn(
          "px-4 py-6 pb-[calc(7.75rem+env(safe-area-inset-bottom))] transition-[margin] sm:px-6 lg:pb-6 xl:px-8",
          collapsed ? "lg:mr-20" : "lg:mr-72",
        )}
        id="main"
        aria-label="المحتوى الرئيسي"
        tabIndex={-1}
      >
        <div className="mx-auto max-w-[1520px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.18 }}
            >
              <Suspense fallback={<RouteFallback />}>
                <Outlet />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <MobileNav />
      <CommandPalette />
    </div>
  );
}
