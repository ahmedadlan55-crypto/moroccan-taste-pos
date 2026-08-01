// Sales Analytics Hub — CSV/XLSX export menu (rendered in the AnalyticsTopBar).
//
// Flow: pick a format → POST /analytics/exports with the CURRENT page's
// planner request (per-page registry in lib/api — setPageExportRequest — with
// the DEFAULT_EXPORT_SPEC fallback for pages that never registered) plus the
// t()-resolved header labels for that request (buildExportColumns) → toast
// "queued" → poll GET /analytics/exports/:id every 3s (2min cap) → on done a
// toast announces readiness and a download button appears next to the trigger
// (the shared toast has no action slot, so the action lives inline); the
// download streams via the JWT-attached blob helper (shared/lib/downloadCsv).
//
// Capability: the TopBar only mounts this when useCan("analytics.export") —
// gating lives OUTSIDE so useToast() is never called under a tree that lacks
// a ToastProvider (hub tests render the bar without one).
import { useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { Button, DropdownMenu, useToast } from "@/shared/ui";
import { downloadCsv } from "@/shared/lib/downloadCsv";
import { useT } from "@/i18n";
import type { AnalyticsFilters } from "../lib/filters";
import {
  analyticsExportDownloadPath,
  buildExportColumns,
  buildExportRequest,
  createAnalyticsExport,
  fetchAnalyticsExport,
  type ExportFormat,
} from "../lib/api";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

interface ReadyJob {
  id: string;
  format: ExportFormat;
}

export interface ExportMenuProps {
  /** The hub segment whose export-request factory to use. */
  segment: string;
  filters: AnalyticsFilters;
  /** Test hooks — production uses the 3s / 2min defaults. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export function ExportMenu({
  segment,
  filters,
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS,
}: ExportMenuProps) {
  const t = useT();
  const { toast } = useToast();
  const [ready, setReady] = useState<ReadyJob | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const fail = (description?: string) => {
    if (!alive.current) return;
    setBusy(false);
    toast({ title: t("salesReports.exportMenu.failed"), description, tone: "error" });
  };

  const poll = (id: string, format: ExportFormat, startedAt: number) => {
    const tick = async () => {
      if (!alive.current) return;
      try {
        const job = await fetchAnalyticsExport(id);
        if (!alive.current) return;
        if (job.status === "done") {
          setBusy(false);
          setReady({ id, format });
          toast({ title: t("salesReports.exportMenu.ready"), tone: "success" });
          return;
        }
        if (job.status === "failed") {
          fail(job.error ?? undefined);
          return;
        }
      } catch {
        /* transient poll failure — keep polling until the timeout */
      }
      if (Date.now() - startedAt >= pollTimeoutMs) {
        fail();
        return;
      }
      timer.current = setTimeout(() => void tick(), pollIntervalMs);
    };
    timer.current = setTimeout(() => void tick(), pollIntervalMs);
  };

  const start = async (format: ExportFormat) => {
    setBusy(true);
    setReady(null);
    try {
      const request = buildExportRequest(segment, filters);
      // Header labels travel with the job — the server only knows registry ids,
      // and the reader's language is knowable only here.
      const created = await createAnalyticsExport(request, format, buildExportColumns(request, t));
      if (!alive.current) return;
      toast({ title: t("salesReports.exportMenu.queued"), tone: "info" });
      poll(created.id, format, Date.now());
    } catch (e) {
      fail(e instanceof Error ? e.message : undefined);
    }
  };

  const download = (job: ReadyJob) => {
    const filename = `sales-${segment}-${new Date().toISOString().slice(0, 10)}.${job.format}`;
    void downloadCsv(analyticsExportDownloadPath(job.id), filename).catch((e: unknown) => {
      fail(e instanceof Error ? e.message : undefined);
    });
  };

  return (
    <div className="inline-flex items-center gap-2" data-testid="export-menu">
      {ready && (
        <Button size="sm" variant="secondary" onClick={() => download(ready)}>
          <Download className="h-4 w-4" /> {t("salesReports.exportMenu.download")}
        </Button>
      )}
      {/* The trigger's min-h-11 (44px) is the touch-target floor the rest of the
          action bar already meets. It was 36px, so on a phone it was the one
          control in the bar you could reach for and miss. */}
      <DropdownMenu
        aria-label={t("salesReports.topbar.export")}
        trigger={
          <span className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600 hover:bg-slate-50">
            <Download className="h-4 w-4" /> {t("salesReports.topbar.export")}
          </span>
        }
        items={[
          {
            key: "csv",
            label: t("salesReports.exportMenu.csv"),
            icon: <FileText className="h-4 w-4" />,
            disabled: busy,
            onSelect: () => void start("csv"),
          },
          {
            key: "xlsx",
            label: t("salesReports.exportMenu.xlsx"),
            icon: <FileSpreadsheet className="h-4 w-4" />,
            disabled: busy,
            onSelect: () => void start("xlsx"),
          },
        ]}
      />
    </div>
  );
}
