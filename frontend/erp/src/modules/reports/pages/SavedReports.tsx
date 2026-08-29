// "التقارير المحفوظة" (/reports/saved) — wave 4: two tabs.
//
//   1) التقارير المحفوظة — the union of the SERVER's saved views
//      (GET /api/saved-views?module=… — one call per known module: the 16
//      analytics:<segment> modules plus every module found in localStorage —
//      the endpoint has no "all modules" listing) and the localStorage
//      DataTable views (adlan.views.*). On a name+module collision the SERVER
//      row wins; each row is badged جهاز (device) or خادم (server). Views of
//      an analytics:* module get an "فتح" action deep-linking to
//      /reports/sales/<segment>?<captured search>.
//   2) الجداول الزمنية — scheduled exports (components/SchedulesPanel), shown
//      only with the analytics.schedule capability.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { Badge, Button, IconButton, PageHeader, EmptyState, Tabs } from "@/shared/ui";
import { useCan } from "@/shared/permissions";
import { useT } from "@/i18n";
import {
  deleteSavedView,
  fetchSavedViews,
  savedViewSearchString,
  type AnalyticsSavedView,
} from "@/modules/reports/sales/lib/api";
import { SchedulesPanel } from "@/modules/reports/sales/components/SchedulesPanel";
import { savedViewModules } from "../registry";

const PREFIX = "adlan.views.";
const ANALYTICS_PREFIX = "analytics:";


interface SavedEntry {
  /** Stable list key. */
  key: string;
  name: string;
  /** The saved-views module (localStorage tableId doubles as the module). */
  module: string;
  source: "local" | "server";
  /** Captured URL search string (analytics views) — null when not a URL state. */
  search: string | null;
  /** local: the localStorage key + view id needed to prune it. */
  storageKey?: string;
  localId?: string;
  /** server: the row id for DELETE /api/saved-views/:id. */
  serverId?: string;
}

function readLocalEntries(): SavedEntry[] {
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
          const module = key.slice(PREFIX.length);
          out.push({
            key: `local:${key}:${String(v.id)}`,
            name: String(v.name),
            module,
            source: "local",
            search: savedViewSearchString({ filtersJson: (v as { state?: { filters?: unknown } }).state?.filters }),
            storageKey: key,
            localId: String(v.id),
          });
        }
      }
    } catch {
      /* ignore malformed entries */
    }
  }
  return out;
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canSchedule = useCan("analytics.schedule");
  const [tab, setTab] = useState<"views" | "schedules">("views");
  const [localEntries, setLocalEntries] = useState<SavedEntry[]>([]);

  const refreshLocal = useCallback(() => setLocalEntries(readLocalEntries()), []);
  useEffect(() => {
    refreshLocal();
  }, [refreshLocal]);

  // Server views: one GET per known module (analytics segments ∪ local tableIds).
  const localModules = useMemo(
    () => [...new Set(localEntries.map((e) => e.module))],
    [localEntries],
  );
  const serverViews = useQuery({
    queryKey: ["saved-views", "all", localModules],
    queryFn: async ({ signal }) => {
      // DERIVED, never listed. This used to be a hand-written array of 16
      // segment names with a comment claiming it mirrored the hub. The hub
      // has 17. The missing one was `channels`, and because there is no
      // "list all modules" endpoint, this page only ever queried the names in
      // that array — so a view saved on the Channels report was written
      // successfully and then never appeared here, and could not be deleted.
      // A list that must be kept in sync by hand eventually is not.
      const modules = [...new Set([...savedViewModules(), ...localModules])];
      const lists = await Promise.all(
        modules.map((m) => fetchSavedViews(m, signal).catch(() => [] as AnalyticsSavedView[])),
      );
      return lists.flat();
    },
  });

  const refresh = () => {
    refreshLocal();
    void queryClient.invalidateQueries({ queryKey: ["saved-views", "all"] });
    void queryClient.invalidateQueries({ queryKey: ["analytics", "schedules"] });
  };

  // ── merge: server wins on a name+module collision ──
  const entries = useMemo<SavedEntry[]>(() => {
    const server = (serverViews.data ?? []).map<SavedEntry>((v) => ({
      key: `server:${v.id}`,
      name: v.name,
      module: v.module,
      source: "server",
      search: savedViewSearchString(v),
      serverId: v.id,
    }));
    const taken = new Set(server.map((e) => `${e.module}${e.name}`));
    const locals = localEntries.filter((e) => !taken.has(`${e.module}${e.name}`));
    return [...server, ...locals].sort(
      (a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name),
    );
  }, [serverViews.data, localEntries]);

  const moduleLabel = (module: string) => {
    if (module.startsWith(ANALYTICS_PREFIX)) {
      const segment = module.slice(ANALYTICS_PREFIX.length);
      // Ask the catalogue whether this segment is a real report. The old check
      // consulted the hand-written 16-name array, so a view on `channels`
      // rendered as the raw fallback "Sales — channels" even on the rare path
      // that surfaced it at all.
      return savedViewModules().includes(module)
        ? t(`salesReports.pages.${segment}.title`)
        : `${t("salesReports.hub.title")} — ${segment}`;
    }
    return KNOWN_TABLE_IDS.has(module) ? t(`misc.reports.saved.tableLabels.${module}`) : module;
  };

  const openEntry = (entry: SavedEntry) => {
    // Analytics views deep-link back into the hub segment with the captured
    // search (an empty capture still opens the segment on its defaults).
    const segment = entry.module.slice(ANALYTICS_PREFIX.length);
    navigate(`/reports/sales/${segment}${entry.search ? `?${entry.search}` : ""}`);
  };

  const removeEntry = (entry: SavedEntry) => {
    if (entry.source === "server" && entry.serverId) {
      void deleteSavedView(entry.serverId)
        .catch(() => undefined)
        .then(() => queryClient.invalidateQueries({ queryKey: ["saved-views", "all"] }));
      return;
    }
    if (entry.storageKey) {
      try {
        const arr = JSON.parse(window.localStorage.getItem(entry.storageKey) || "[]");
        if (Array.isArray(arr)) {
          const next = arr.filter((v: { id?: unknown }) => String(v?.id) !== entry.localId);
          window.localStorage.setItem(entry.storageKey, JSON.stringify(next));
        }
      } catch {
        /* ignore */
      }
    }
    refreshLocal();
  };

  const viewsList =
    entries.length === 0 ? (
      <EmptyState
        icon={<Bookmark className="h-6 w-6" />}
        title={t("misc.reports.saved.emptyTitle")}
        body={t("misc.reports.saved.emptyBody", { menu: t("table.savedViews.menu") })}
      />
    ) : (
      <ul className="surface divide-y divide-slate-100">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-center justify-between gap-3 p-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
                <Bookmark className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-extrabold text-slate-900">{entry.name}</div>
                <div className="mt-0.5 text-xs font-medium text-slate-400">
                  {t("misc.reports.saved.source")}: {moduleLabel(entry.module)}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone={entry.source === "server" ? "teal" : "neutral"}>
                {entry.source === "server"
                  ? t("salesReports.saved.sourceServer")
                  : t("salesReports.saved.sourceLocal")}
              </Badge>
              {entry.module.startsWith(ANALYTICS_PREFIX) && (
                <Button size="sm" variant="secondary" onClick={() => openEntry(entry)}>
                  <ExternalLink className="h-4 w-4" /> {t("salesReports.saved.open")}
                </Button>
              )}
              <IconButton
                aria-label={t("misc.reports.saved.deleteView", { name: entry.name })}
                size="sm"
                variant="danger"
                onClick={() => removeEntry(entry)}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <div>
      <PageHeader
        eyebrow={t("misc.reports.eyebrow")}
        title={t("salesReports.saved.title")}
        subtitle={t("misc.reports.saved.subtitle")}
        action={
          <Button variant="secondary" onClick={refresh}>
            <RefreshCw className="h-4 w-4" /> {t("states.refreshBtn")}
          </Button>
        }
      />
      <Tabs
        aria-label={t("salesReports.saved.title")}
        className="mb-4"
        items={[
          { value: "views", label: t("salesReports.saved.tabViews") },
          // The schedules tab exists ONLY with the analytics.schedule cap.
          ...(canSchedule ? [{ value: "schedules", label: t("salesReports.saved.tabSchedules") }] : []),
        ]}
        value={canSchedule ? tab : "views"}
        onChange={(next) => setTab(next === "schedules" ? "schedules" : "views")}
      />
      {tab === "schedules" && canSchedule ? <SchedulesPanel /> : viewsList}
    </div>
  );
}
