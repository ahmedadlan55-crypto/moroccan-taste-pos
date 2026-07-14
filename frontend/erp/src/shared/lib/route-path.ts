/**
 * Normalize a location pathname for exact lookup in a module's route table.
 *
 * WHY: react-router matches routes ignoring a trailing slash and case, but
 * `useLocation().pathname` returns the RAW path. So `/accounting/journals/` (or
 * `/Accounting/Journals`) matches the registered route — the module mounts — yet
 * `ROUTES["/accounting/journals/"]` misses and the module falls through to its
 * fallback, showing a "not available" screen on a fully-built page. Every module
 * that dispatches on pathname must normalize first.
 *
 * All manifest paths are lower-case kebab, so lower-casing is safe.
 */
export function normalizeRoutePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return (trimmed || "/").toLowerCase();
}
