import { useT } from "@/i18n";

// Suspense fallback shown while a lazy route chunk loads. Kept self-contained
// (raw Tailwind) so the foundation needs nothing from the shared UI kit; SD2's
// polished skeletons replace the per-page loading UX inside the modules.
export function RouteFallback() {
  const t = useT();
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-slate-100" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-slate-100" />
      <span className="sr-only">{t("states.loading")}</span>
    </div>
  );
}
