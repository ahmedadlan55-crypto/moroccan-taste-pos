// ── /accounting/chart-of-accounts — the list page ───────────────────────────
// KPI row, one bilingual search, ten filters, expand/collapse-all, a Tree⇄Table
// toggle, hide-zero, an as-of date and CSV export. Every write action is a real
// URL (…/new, …/:id/edit, …/:id/move) rather than a dialog, so a half-finished
// edit survives a refresh and can be linked to.
//
// LAYOUT RULE: below `lg` there is NO second pane. The tree is the whole
// screen and a tap NAVIGATES to /…/:id. A stacked detail panel under a
// 600-row tree is a scroll position nobody can find their way back from.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  FileUp,
  Layers,
  ListTree,
  Plus,
  Search,
  Stethoscope,
  Table2,
  Wallet,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  DatePicker,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  MetricCard,
  PageHeader,
  SegmentedControl,
  Select,
  Toggle,
} from "@/shared/ui";
import { DataTable, downloadRowsCsv, type ColumnDef } from "@/shared/tables";
import { Field } from "@/shared/forms";
import { useLocalStorage, useMediaQuery } from "@/shared/hooks";
import { useCan } from "@/app/providers";
import { todayISO } from "@/shared/lib";
import { useLang, useT } from "@/i18n";
import { GL_ACCOUNT_TYPES, glTypeLabel, type GlAccount, type GlAccountType } from "../api";
import { COA_BASE, MANAGE_CAP } from "./routes";
import { CoaTree } from "./CoaTree";
import { AccountDetail } from "./AccountDetail";
import { useCoaData } from "./useCoaData";
import {
  EMPTY_FILTERS,
  accountPasses,
  activeFilterCount,
  computeKpis,
  levelOptions,
  matchingIds,
  sectionOptions,
  type CoaFilters,
} from "./coaFilters";
import {
  accountName,
  actualSide,
  fmtMoney,
  getTreeRoots,
  isPostingAccount,
  naturalAmount,
  nodeDisplayBalance,
} from "./coaModel";

type ViewMode = "tree" | "table";

/** A labelled native <select> whose label is actually WIRED to it. */
function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Field label={label}>
      {({ id }) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {children}
        </Select>
      )}
    </Field>
  );
}

export function CoaListPage() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const canManage = useCan(MANAGE_CAP);
  const isStacked = useMediaQuery("(max-width: 1023px)");

  const [asOf, setAsOf] = useState<string>("");
  const data = useCoaData(asOf || null);
  const { accounts, byParent, rollups, health } = data;

  const [filters, setFilters] = useState<CoaFilters>(EMPTY_FILTERS);
  const [view, setView] = useLocalStorage<ViewMode>("erp.coa.view", "tree");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openArr, setOpenArr] = useLocalStorage<string[]>("erp.coa.open", []);
  const [page, setPage] = useState({ page: 1, pageSize: 50 });

  const ctx = useMemo(() => ({ accounts, byParent, rollups, health }), [accounts, byParent, rollups, health]);
  const kpis = useMemo(() => computeKpis(ctx), [ctx]);
  const matchIds = useMemo(() => matchingIds(ctx, filters), [ctx, filters]);
  const sections = useMemo(() => sectionOptions(accounts), [accounts]);
  const levels = useMemo(() => levelOptions(accounts), [accounts]);

  const openSet = useMemo(() => new Set(openArr), [openArr]);
  const selected = selectedId ? (data.byId.get(selectedId) ?? null) : null;

  // Seed the persisted open-set ONCE with the tree roots, so a first visit
  // lands on an opened chart rather than five closed folders. `seeded` guards
  // the case where the user has deliberately collapsed everything: without it
  // an empty set would be re-seeded on every render pass.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || accounts.length === 0) return;
    seeded.current = true;
    if (openArr.length === 0) setOpenArr(getTreeRoots(accounts).map((r) => r.id));
  }, [accounts, openArr.length, setOpenArr]);

  const patch = useCallback((part: Partial<CoaFilters>) => {
    setFilters((prev) => ({ ...prev, ...part }));
    setPage((p) => ({ ...p, page: 1 }));
  }, []);

  const toggleOpen = useCallback(
    (id: string) =>
      setOpenArr((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [setOpenArr],
  );

  const expandAll = useCallback(() => {
    // Only accounts that HAVE children can be open; storing leaves would grow
    // the persisted set without changing a single row.
    setOpenArr(accounts.filter((a) => (byParent.get(a.id) ?? []).length > 0).map((a) => a.id));
  }, [accounts, byParent, setOpenArr]);

  const collapseAll = useCallback(() => setOpenArr([]), [setOpenArr]);

  const openDetail = useCallback(
    (id: string) => navigate(`${COA_BASE}/${encodeURIComponent(id)}`),
    [navigate],
  );

  const onSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      // Mobile/tablet has no second pane — the row IS the link.
      if (isStacked) openDetail(id);
    },
    [isStacked, openDetail],
  );

  // ── the flat rows behind the table view ──
  const tableRows = useMemo(() => {
    const rows = matchIds
      ? accounts.filter((a) => matchIds.has(a.id))
      : accounts.filter((a) => accountPasses(a, ctx, filters));
    return [...rows].sort((a, b) => a.code.localeCompare(b.code));
  }, [accounts, matchIds, ctx, filters]);

  const shownBalance = useCallback(
    (a: GlAccount) =>
      nodeDisplayBalance(a, a.level - 1, (byParent.get(a.id) ?? []).length > 0, rollups),
    [byParent, rollups],
  );

  const columns = useMemo<ColumnDef<GlAccount>[]>(
    () => [
      {
        id: "code",
        header: t("accounting.coa.col.code"),
        accessor: (a) => a.code,
        cell: (a) => (
          <code dir="ltr" className="font-mono text-xs font-bold tabular-nums text-slate-500">
            {a.code}
          </code>
        ),
        width: 120,
      },
      {
        id: "name",
        header: t("accounting.coa.col.name"),
        accessor: (a) => accountName(a, lang),
        cell: (a) => {
          const issues = health.byAccount.get(a.id) ?? [];
          const structural =
            issues.includes("strayRoot") || issues.includes("orphan") || issues.includes("cycle");
          return (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-bold text-slate-800">{accountName(a, lang)}</span>
              {structural && (
                <Badge tone="warning">
                  {issues.includes("orphan")
                    ? t("accounting.coa.health.orphanShort")
                    : issues.includes("cycle")
                      ? t("accounting.coa.health.cycleShort")
                      : t("accounting.coa.health.strayShort")}
                </Badge>
              )}
              {!a.isActive && <Badge tone="neutral">{t("accounting.common.suspended")}</Badge>}
            </span>
          );
        },
      },
      {
        id: "type",
        header: t("accounting.coa.col.type"),
        accessor: (a) => glTypeLabel(t, a.type),
      },
      { id: "level", header: t("accounting.coa.col.level"), accessor: (a) => a.level, numeric: true },
      {
        id: "kind",
        header: t("accounting.coa.col.kind"),
        accessor: (a) =>
          isPostingAccount(a, (byParent.get(a.id) ?? []).length > 0)
            ? t("accounting.coa.filter.postingOnly")
            : t("accounting.coa.filter.controlOnly"),
      },
      {
        id: "section",
        header: t("accounting.coa.col.section"),
        accessor: (a) => a.reportSection || t("accounting.coa.filter.sectionNone"),
      },
      {
        id: "movements",
        header: t("accounting.coa.col.movements"),
        accessor: (a) => a.movementCount,
        numeric: true,
      },
      {
        id: "balance",
        header: t("accounting.coa.col.balance"),
        align: "end",
        accessor: (a) => Math.abs(naturalAmount(a, shownBalance(a))),
        exportValue: (a) =>
          `${fmtMoney(Math.abs(naturalAmount(a, shownBalance(a))))} ${
            actualSide(a, shownBalance(a)) === "debit" ? t("accounting.coa.dr") : t("accounting.coa.cr")
          }`,
        cell: (a) => {
          const bal = shownBalance(a);
          const natural = naturalAmount(a, bal);
          const abnormal = natural < -0.005;
          const side = actualSide(a, bal);
          return (
            <span className="inline-flex items-baseline gap-1">
              <span
                dir="ltr"
                className={`font-semibold tabular-nums ${abnormal ? "text-rose-600" : "text-slate-700"}`}
              >
                {fmtMoney(Math.abs(natural))}
              </span>
              <span className="text-[10px] font-extrabold uppercase text-slate-400">
                {side === "debit" ? t("accounting.coa.dr") : t("accounting.coa.cr")}
              </span>
            </span>
          );
        },
      },
    ],
    [t, lang, health, byParent, shownBalance],
  );

  const exportRows = useCallback(() => {
    downloadRowsCsv(columns, tableRows, `chart-of-accounts-${asOf || todayISO()}`);
  }, [columns, tableRows, asOf]);

  const filterCount = activeFilterCount(filters);

  // Guard against a filter set that hides everything without saying why.
  const treeRootCount = useMemo(() => getTreeRoots(accounts).length, [accounts]);

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.eyebrow")}
        title={t("accounting.coa.title")}
        subtitle={t("accounting.coa.subtitle")}
        action={
          <>
            <Button variant="secondary" onClick={() => navigate(`${COA_BASE}/health`)}>
              <Stethoscope className="h-4 w-4" /> {t("accounting.coa.health.action")}
            </Button>
            <Button variant="secondary" onClick={exportRows} disabled={tableRows.length === 0}>
              <Download className="h-4 w-4" /> {t("common.export")}
            </Button>
            {canManage && (
              <Button variant="secondary" onClick={() => navigate(`${COA_BASE}/import`)}>
                <FileUp className="h-4 w-4" /> {t("accounting.coa.import.action")}
              </Button>
            )}
            {canManage && (
              <Button variant="primary" onClick={() => navigate(`${COA_BASE}/new`)}>
                <Plus className="h-4 w-4" /> {t("accounting.coa.newAccount")}
              </Button>
            )}
          </>
        }
      />

      {/* ── KPI row ── */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <MetricCard icon={Layers} label={t("accounting.coa.kpi.total")} value={String(kpis.total)} />
        <MetricCard icon={ListTree} label={t("accounting.coa.kpi.control")} value={String(kpis.control)} />
        <MetricCard icon={Wallet} label={t("accounting.coa.kpi.posting")} value={String(kpis.posting)} />
        <MetricCard
          icon={XCircle}
          label={t("accounting.coa.kpi.inactive")}
          value={String(kpis.inactive)}
          tone={kpis.inactive > 0 ? "blue" : "teal"}
        />
        <MetricCard
          icon={AlertTriangle}
          label={t("accounting.coa.kpi.issues")}
          value={String(kpis.issues)}
          tone={kpis.issues > 0 ? "amber" : "teal"}
          onClick={() => navigate(`${COA_BASE}/health`)}
        />
        <MetricCard
          icon={Search}
          label={t("accounting.coa.kpi.unmapped")}
          value={String(kpis.unmapped)}
          tone={kpis.unmapped > 0 ? "amber" : "teal"}
          onClick={() => patch({ issue: "unmapped" })}
        />
        <MetricCard
          icon={AlertTriangle}
          label={t("accounting.coa.kpi.abnormal")}
          value={String(kpis.abnormal)}
          tone={kpis.abnormal > 0 ? "rose" : "teal"}
          onClick={() => patch({ issue: "abnormal" })}
        />
      </div>

      {/* ── toolbar ── */}
      <Card className="mb-4 p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[16rem] flex-1">
              <Input
                value={filters.search}
                onChange={(e) => patch({ search: e.target.value })}
                placeholder={t("accounting.coa.searchPlaceholder")}
                leading={<Search className="h-4 w-4" />}
                aria-label={t("accounting.coa.searchAria")}
              />
            </div>

            <SegmentedControl<ViewMode>
              value={view}
              onChange={setView}
              aria-label={t("accounting.coa.viewAria")}
              options={[
                { value: "tree", label: t("accounting.coa.viewTree") },
                { value: "table", label: t("accounting.coa.viewTable") },
              ]}
            />

            {view === "tree" && (
              <>
                <Button variant="secondary" onClick={expandAll}>
                  <ChevronsUpDown className="h-4 w-4" /> {t("accounting.coa.expandAll")}
                </Button>
                <Button variant="secondary" onClick={collapseAll}>
                  <ChevronsDownUp className="h-4 w-4" /> {t("accounting.coa.collapseAll")}
                </Button>
              </>
            )}

            {filterCount > 0 && (
              <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
                <XCircle className="h-4 w-4" /> {t("accounting.coa.clearFilters", { count: filterCount })}
              </Button>
            )}
          </div>

          {/* FilterSelect (below) uses Field's RENDER-FUNCTION form, which is
              the only variant that hands the generated id to the control. A
              plain child leaves <label htmlFor> pointing at nothing: the field
              looks labelled but is anonymous to a screen reader. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            <FilterSelect
              label={t("accounting.coa.filter.type")}
              value={filters.type}
              onChange={(v) => patch({ type: v as GlAccountType | "all" })}
            >
              <option value="all">{t("common.all")}</option>
              {GL_ACCOUNT_TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {glTypeLabel(t, tp)}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.level")}
              value={String(filters.level)}
              onChange={(v) => patch({ level: v === "all" ? "all" : Number(v) })}
            >
              <option value="all">{t("common.all")}</option>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.kind")}
              value={filters.kind}
              onChange={(v) => patch({ kind: v as CoaFilters["kind"] })}
            >
              <option value="all">{t("common.all")}</option>
              <option value="posting">{t("accounting.coa.filter.postingOnly")}</option>
              <option value="control">{t("accounting.coa.filter.controlOnly")}</option>
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.status")}
              value={filters.status}
              onChange={(v) => patch({ status: v as CoaFilters["status"] })}
            >
              <option value="all">{t("common.all")}</option>
              <option value="active">{t("accounting.coa.filter.statusActive")}</option>
              <option value="inactive">{t("accounting.coa.filter.statusInactive")}</option>
              <option value="blocked">{t("accounting.coa.filter.statusBlocked")}</option>
              <option value="archived">{t("accounting.coa.filter.statusArchived")}</option>
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.section")}
              value={filters.section}
              onChange={(v) => patch({ section: v })}
            >
              <option value="all">{t("common.all")}</option>
              <option value="none">{t("accounting.coa.filter.sectionNone")}</option>
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.normal")}
              value={filters.normal}
              onChange={(v) => patch({ normal: v as CoaFilters["normal"] })}
            >
              <option value="all">{t("common.all")}</option>
              <option value="debit">{t("accounting.common.debit")}</option>
              <option value="credit">{t("accounting.common.credit")}</option>
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.origin")}
              value={filters.origin}
              onChange={(v) => patch({ origin: v as CoaFilters["origin"] })}
            >
              <option value="all">{t("common.all")}</option>
              <option value="system">{t("accounting.coa.filter.originSystem")}</option>
              <option value="custom">{t("accounting.coa.filter.originCustom")}</option>
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.movement")}
              value={filters.movement}
              onChange={(v) => patch({ movement: v as CoaFilters["movement"] })}
            >
              <option value="all">{t("common.all")}</option>
              <option value="with">{t("accounting.coa.filter.movementWith")}</option>
              <option value="without">{t("accounting.coa.filter.movementWithout")}</option>
            </FilterSelect>

            <FilterSelect
              label={t("accounting.coa.filter.issue")}
              value={filters.issue}
              onChange={(v) => patch({ issue: v as CoaFilters["issue"] })}
            >
              <option value="all">{t("common.all")}</option>
              <option value="any">{t("accounting.coa.filter.issueAny")}</option>
              <option value="strayRoot">{t("accounting.coa.health.strayRoots")}</option>
              <option value="orphan">{t("accounting.coa.health.orphans")}</option>
              <option value="unmapped">{t("accounting.coa.health.unmapped")}</option>
              <option value="abnormal">{t("accounting.coa.health.abnormal")}</option>
              <option value="cycle">{t("accounting.coa.health.cycles")}</option>
            </FilterSelect>

            <Field label={t("accounting.common.asOfDate")}>
              {({ id }) => <DatePicker id={id} value={asOf} onChange={setAsOf} max={todayISO()} />}
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex min-h-11 items-center gap-3">
              <Toggle
                checked={filters.hideZero}
                onChange={(v) => patch({ hideZero: v })}
                aria-label={t("accounting.coa.hideZero")}
              />
              <span className="text-sm font-bold text-slate-700">{t("accounting.coa.hideZero")}</span>
            </label>
            <span className="text-xs font-bold text-slate-400">
              {t("accounting.coa.showingCount", { count: tableRows.length, total: kpis.total })}
            </span>
          </div>

          {data.asOfIgnored && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
              {t("accounting.coa.asOfUnsupported")}
            </p>
          )}
        </div>
      </Card>

      {data.isLoading ? (
        <LoadingState />
      ) : data.error ? (
        <ErrorState error={data.error} onRetry={data.refetch} />
      ) : accounts.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon={<ListTree className="h-6 w-6" />}
            title={t("accounting.coa.noAccounts")}
            body={t("accounting.coa.noAccountsBody")}
          />
        </Card>
      ) : view === "table" ? (
        <DataTable<GlAccount>
          mode="server"
          columns={columns}
          rows={tableRows.slice((page.page - 1) * page.pageSize, page.page * page.pageSize)}
          rowCount={tableRows.length}
          getRowId={(a) => a.id}
          onRowClick={(a) => openDetail(a.id)}
          onStateChange={(s) =>
            setPage((prev) =>
              prev.page === s.page && prev.pageSize === s.pageSize
                ? prev
                : { page: s.page, pageSize: s.pageSize },
            )
          }
          initialPageSize={50}
          // The page owns ONE bilingual search box shared by both views; a second
          // one inside the table would filter a different set on the same screen.
          searchable={false}
          columnMenu
          tableId="coa-accounts"
          exportFilename={`chart-of-accounts-${asOf || todayISO()}`}
          emptyTitle={t("accounting.coa.noMatches")}
          emptyBody={t("accounting.coa.noMatchesBody")}
          mobileTitle={(a) => accountName(a, lang)}
        />
      ) : (
        <div
          className={
            isStacked ? "" : "grid items-start gap-4 lg:grid-cols-[minmax(320px,460px)_1fr]"
          }
        >
          {/* Mobile/tablet: the tree is the WHOLE screen and scrolls with the
              page (a nested 70vh scroller inside a page scroller is a trap on
              touch). The extra bottom pad clears the fixed MobileNav and the
              iOS home indicator, so the last account is never under the bar. */}
          <Card
            className={
              isStacked
                ? "flex flex-col overflow-hidden pb-[calc(1rem+env(safe-area-inset-bottom))]"
                : "flex max-h-[70vh] min-h-[24rem] flex-col overflow-hidden"
            }
          >
            <div
              className={
                isStacked ? "p-2" : "min-h-0 flex-1 overflow-y-auto p-2"
              }
            >
              <CoaTree
                accounts={accounts}
                matchIds={matchIds}
                selectedId={selectedId}
                onSelect={onSelect}
                onActivate={openDetail}
                openIds={openSet}
                onToggle={toggleOpen}
                health={health}
                hideZero={filters.hideZero}
                emptyLabel={
                  filterCount > 0
                    ? t("accounting.coa.noMatches")
                    : treeRootCount === 0
                      ? t("accounting.coa.noAccounts")
                      : t("accounting.coa.noMatches")
                }
              />
            </div>
          </Card>

          {!isStacked && (
            <div>
              {selected ? (
                <AccountDetail
                  account={selected}
                  accounts={accounts}
                  onEdit={(a) => navigate(`${COA_BASE}/${encodeURIComponent(a.id)}/edit`)}
                  onMove={(a) => navigate(`${COA_BASE}/${encodeURIComponent(a.id)}/move`)}
                  onAddChild={(a) => navigate(`${COA_BASE}/new?parent=${encodeURIComponent(a.id)}`)}
                  onOpenFull={(a) => openDetail(a.id)}
                />
              ) : (
                <Card className="grid min-h-[24rem] place-items-center p-6">
                  <EmptyState
                    icon={<Table2 className="h-6 w-6" />}
                    title={t("accounting.coa.selectAccount")}
                    body={t("accounting.coa.selectAccountBody")}
                  />
                </Card>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default CoaListPage;
