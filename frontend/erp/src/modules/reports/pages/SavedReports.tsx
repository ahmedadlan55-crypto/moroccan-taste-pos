import { useCallback, useEffect, useState } from "react";
import { Bookmark, RefreshCw, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, PageHeader, EmptyState } from "@/shared/ui";
import { useT } from "@/i18n";

// "التقارير المحفوظة" — a localStorage-backed list of the named table views the
// user saved across the app (DataTable's SavedViews store under adlan.views.*).
// This aggregates them into one place and lets the user prune them.
const PREFIX = "adlan.views.";

interface SavedEntry {
  storageKey: string;
  tableId: string;
  id: string;
  name: string;
}

function readSaved(): SavedEntry[] {
  if (typeof window === "undefined") return [];
  const out: SavedEntry[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) || "[]");
      if (!Array.isArray(parsed)) continue;
      for (const v of parsed) {
        if (v && typeof v === "object" && v.id && v.name) {
          out.push({ storageKey: key, tableId: key.slice(PREFIX.length), id: String(v.id), name: String(v.name) });
        }
      }
    } catch {
      /* ignore malformed entries */
    }
  }
  return out.sort((a, b) => a.tableId.localeCompare(b.tableId));
}

// Known table ids that have a translated label (misc.reports.saved.tableLabels.*).
// Any other id is shown raw — matching the original `map[id] ?? id` fallback.
const KNOWN_TABLE_IDS = new Set([
  "admin-companies",
  "admin-brands",
  "admin-branches",
  "admin-users",
  "admin-payment-methods",
  "admin-audit-log",
  "admin-vat-reports",
]);

export default function SavedReportsPage() {
  const t = useT();
  const [entries, setEntries] = useState<SavedEntry[]>([]);
  const tableLabel = (tableId: string) =>
    KNOWN_TABLE_IDS.has(tableId) ? t(`misc.reports.saved.tableLabels.${tableId}`) : tableId;
  const refresh = useCallback(() => setEntries(readSaved()), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const remove = (entry: SavedEntry) => {
    try {
      const arr = JSON.parse(window.localStorage.getItem(entry.storageKey) || "[]");
      if (Array.isArray(arr)) {
        const next = arr.filter((v: { id?: unknown }) => String(v?.id) !== entry.id);
        window.localStorage.setItem(entry.storageKey, JSON.stringify(next));
      }
    } catch {
      /* ignore */
    }
    refresh();
  };

  return (
    <div>
      <PageHeader
        eyebrow={t("misc.reports.eyebrow")}
        title={t("misc.reports.saved.title")}
        subtitle={t("misc.reports.saved.subtitle")}
        action={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="h-4 w-4" /> {t("states.refreshBtn")}
          </Button>
        }
      />
      {entries.length === 0 ? (
        <EmptyState
          icon={<Bookmark className="h-6 w-6" />}
          title={t("misc.reports.saved.emptyTitle")}
          body={t("misc.reports.saved.emptyBody", { menu: t("table.savedViews.menu") })}
        />
      ) : (
        <ul className="surface divide-y divide-slate-100">
          {entries.map((entry) => (
            <li key={`${entry.storageKey}:${entry.id}`} className="flex items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
                  <Bookmark className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-extrabold text-slate-900">{entry.name}</div>
                  <div className="mt-0.5 text-xs font-medium text-slate-400">
                    {t("misc.reports.saved.source")}: {tableLabel(entry.tableId)}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone="neutral">{t("misc.reports.saved.badge")}</Badge>
                <IconButton aria-label={t("misc.reports.saved.deleteView", { name: entry.name })} size="sm" variant="danger" onClick={() => remove(entry)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
