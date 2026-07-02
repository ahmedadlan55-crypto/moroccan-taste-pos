import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";

// The persistent shell: dark sidebar (right), sticky topbar with the warehouse
// scope, an animated routed content area, and a mobile bottom nav. The
// <Outlet/> renders the active route; the shell itself never re-mounts.
export function AppShell() {
  const location = useLocation();
  return (
    <div className="min-h-screen">
      {/* RC a11y — keyboard users jump straight to the routed content (WCAG 2.4.1). */}
      <a href="#main" className="skip-link no-print">
        تخطٍّ إلى المحتوى
      </a>
      <Sidebar />
      <Topbar />
      {/* pb clears the fixed MobileNav + the iOS home-indicator safe area on
          phones; desktop has no bottom nav so it reverts to a normal pad. */}
      <main
        className="px-4 py-6 pb-[calc(6.5rem+env(safe-area-inset-bottom))] sm:px-6 lg:mr-72 lg:pb-6 xl:px-8"
        id="main"
        aria-label="المحتوى الرئيسي"
        tabIndex={-1}
      >
        <div className="mx-auto max-w-[1680px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: 0.18 }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <MobileNav />
    </div>
  );
}
