// ── /accounting/chart-of-accounts/health ────────────────────────────────────
// The defects in the chart, stated out loud. Every one of these used to be
// INVISIBLE on the old screen: a stray root simply did not render (the tree
// only walked codes 1..5), an orphan pointed at a parent that no longer
// existed and vanished with it, an unmapped account silently let the balance
// sheet fall back to guessing from its Arabic name, and an abnormal balance
// was indistinguishable from a normal credit because every negative number was
// painted red.
//
// Nothing here is hidden behind a toggle and nothing is "fixed" automatically:
// each row links to the account so a human decides.

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FolderTree,
  GitBranch,
  Hash,
  Languages,
  RefreshCw,
  Repeat,
  Scale,
  Unlink,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
} from "@/shared/ui";
import { useLang, useT } from "@/i18n";
import { useStatementSections, type GlAccount } from "../api";
import { COA_BASE } from "./routes";
import { useCoaData } from "./useCoaData";
import { BalanceAmount, accountName, computeHealth, nodeDisplayBalance } from "./coaModel";

export function CoaHealthPage() {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const data = useCoaData();
  const sectionCatalog = useStatementSections();
  const health = useMemo(
    () => computeHealth(data.accounts, data.byParent, data.rollups, sectionCatalog.data ?? []),
    [data.accounts, data.byParent, data.rollups, sectionCatalog.data],
  );

  if (data.isLoading || sectionCatalog.isLoading) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.refetch} />;

  const back = (
    <>
      <Button variant="secondary" onClick={data.refetch}>
        <RefreshCw className="h-4 w-4" /> {t("accounting.coa.refresh")}
      </Button>
      <Button variant="secondary" onClick={() => navigate(COA_BASE)}>
        <ArrowRight className="h-4 w-4 ltr:rotate-180" /> {t("accounting.coa.backToChart")}
      </Button>
    </>
  );

  const Section = ({
    title,
    body,
    rows,
    icon,
    showBalance = false,
  }: {
    title: string;
    body: string;
    rows: GlAccount[];
    icon: React.ReactNode;
    showBalance?: boolean;
  }) => (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>
          <span className="flex items-center gap-2">
            {icon}
            {title}
          </span>
        </CardTitle>
        <Badge tone={rows.length > 0 ? "warning" : "success"}>{rows.length}</Badge>
      </CardHeader>
      <CardBody className="pt-0">
        <p className="mb-3 text-sm font-medium leading-6 text-slate-600">{body}</p>
        {rows.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> {t("accounting.coa.health.clean")}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {rows.map((a) => {
              const hasChildren = (data.byParent.get(a.id) ?? []).length > 0;
              const shown = nodeDisplayBalance(a, a.level - 1, hasChildren, data.rollups);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`${COA_BASE}/${encodeURIComponent(a.id)}`)}
                    className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-start transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
                  >
                    <code
                      dir="ltr"
                      className="shrink-0 font-mono text-xs font-bold tabular-nums text-slate-400"
                    >
                      {a.code}
                    </code>
                    <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-700">
                      {accountName(a, lang)}
                    </span>
                    {showBalance && (
                      <BalanceAmount
                        account={a}
                        value={shown}
                        debitLabel={t("accounting.coa.dr")}
                        creditLabel={t("accounting.coa.cr")}
                        className="shrink-0 text-xs"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.coa.title")}
        title={t("accounting.coa.health.title")}
        subtitle={t("accounting.coa.health.subtitle")}
        action={back}
      />

      {sectionCatalog.error && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
          {t("accounting.coa.health.catalogUnavailable")}
        </p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          icon={AlertTriangle}
          label={t("accounting.coa.health.strayRoots")}
          value={String(health.strayRoots.length)}
          tone={health.strayRoots.length > 0 ? "amber" : "teal"}
        />
        <MetricCard
          icon={Unlink}
          label={t("accounting.coa.health.orphans")}
          value={String(health.orphans.length)}
          tone={health.orphans.length > 0 ? "amber" : "teal"}
        />
        <MetricCard
          icon={Scale}
          label={t("accounting.coa.health.unmapped")}
          value={String(health.unmapped.length)}
          tone={health.unmapped.length > 0 ? "amber" : "teal"}
        />
        <MetricCard
          icon={AlertTriangle}
          label={t("accounting.coa.health.abnormal")}
          value={String(health.abnormal.length)}
          tone={health.abnormal.length > 0 ? "rose" : "teal"}
        />
        <MetricCard
          icon={Repeat}
          label={t("accounting.coa.health.cycles")}
          value={String(health.cycles.length)}
          tone={health.cycles.length > 0 ? "rose" : "teal"}
        />
        <MetricCard
          icon={Languages}
          label={t("accounting.coa.health.missingEnglish")}
          value={String(health.missingEnglish.length)}
          tone={health.missingEnglish.length > 0 ? "amber" : "teal"}
        />
        <MetricCard
          icon={Hash}
          label={t("accounting.coa.health.invalidCodes")}
          value={String(health.invalidCodes.length + health.codeClassMismatches.length)}
          tone={health.invalidCodes.length + health.codeClassMismatches.length > 0 ? "rose" : "teal"}
        />
        <MetricCard
          icon={Hash}
          label={t("accounting.coa.health.nonCanonicalCodes")}
          value={String(health.nonCanonicalCodes.length)}
          tone={health.nonCanonicalCodes.length > 0 ? "amber" : "teal"}
        />
        <MetricCard
          icon={GitBranch}
          label={t("accounting.coa.health.levelMismatches")}
          value={String(health.levelMismatches.length)}
          tone={health.levelMismatches.length > 0 ? "rose" : "teal"}
        />
        <MetricCard
          icon={FolderTree}
          label={t("accounting.coa.health.folderFlagMismatches")}
          value={String(health.folderFlagMismatches.length)}
          tone={health.folderFlagMismatches.length > 0 ? "amber" : "teal"}
        />
        <MetricCard
          icon={Scale}
          label={t("accounting.coa.health.typeMismatches")}
          value={String(health.typeMismatches.length)}
          tone={health.typeMismatches.length > 0 ? "rose" : "teal"}
        />
        <MetricCard
          icon={Scale}
          label={t("accounting.coa.health.invalidStatementSections")}
          value={String(health.invalidStatementSections.length)}
          tone={health.invalidStatementSections.length > 0 ? "rose" : "teal"}
        />
        <MetricCard
          icon={Scale}
          label={t("accounting.coa.health.statementSectionTypeMismatches")}
          value={String(health.statementSectionTypeMismatches.length)}
          tone={health.statementSectionTypeMismatches.length > 0 ? "rose" : "teal"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section
          title={t("accounting.coa.health.strayRoots")}
          body={t("accounting.coa.health.strayRootsBody")}
          rows={health.strayRoots}
          icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
        />
        <Section
          title={t("accounting.coa.health.orphans")}
          body={t("accounting.coa.health.orphansBody")}
          rows={health.orphans}
          icon={<Unlink className="h-4 w-4 text-amber-600" />}
        />
        <Section
          title={t("accounting.coa.health.unmapped")}
          body={t("accounting.coa.health.unmappedBody")}
          rows={health.unmapped}
          icon={<Scale className="h-4 w-4 text-amber-600" />}
        />
        <Section
          title={t("accounting.coa.health.abnormal")}
          body={t("accounting.coa.health.abnormalBody")}
          rows={health.abnormal}
          icon={<AlertTriangle className="h-4 w-4 text-rose-600" />}
          showBalance
        />
        {health.cycles.length > 0 && (
          <Section
            title={t("accounting.coa.health.cycles")}
            body={t("accounting.coa.health.cyclesBody")}
            rows={health.cycles}
            icon={<Repeat className="h-4 w-4 text-rose-600" />}
          />
        )}
        <Section
          title={t("accounting.coa.health.missingEnglish")}
          body={t("accounting.coa.health.missingEnglishBody")}
          rows={health.missingEnglish}
          icon={<Languages className="h-4 w-4 text-amber-600" />}
        />
        <Section
          title={t("accounting.coa.health.invalidCodes")}
          body={t("accounting.coa.health.invalidCodesBody")}
          rows={[...health.invalidCodes, ...health.codeClassMismatches].filter(
            (a, index, rows) => rows.findIndex((x) => x.id === a.id) === index,
          )}
          icon={<Hash className="h-4 w-4 text-rose-600" />}
        />
        <Section
          title={t("accounting.coa.health.nonCanonicalCodes")}
          body={t("accounting.coa.health.nonCanonicalCodesBody")}
          rows={health.nonCanonicalCodes}
          icon={<Hash className="h-4 w-4 text-amber-600" />}
        />
        <Section
          title={t("accounting.coa.health.levelMismatches")}
          body={t("accounting.coa.health.levelMismatchesBody")}
          rows={health.levelMismatches}
          icon={<GitBranch className="h-4 w-4 text-rose-600" />}
        />
        <Section
          title={t("accounting.coa.health.folderFlagMismatches")}
          body={t("accounting.coa.health.folderFlagMismatchesBody")}
          rows={health.folderFlagMismatches}
          icon={<FolderTree className="h-4 w-4 text-amber-600" />}
        />
        <Section
          title={t("accounting.coa.health.typeMismatches")}
          body={t("accounting.coa.health.typeMismatchesBody")}
          rows={health.typeMismatches}
          icon={<Scale className="h-4 w-4 text-rose-600" />}
        />
        <Section
          title={t("accounting.coa.health.invalidStatementSections")}
          body={t("accounting.coa.health.invalidStatementSectionsBody")}
          rows={health.invalidStatementSections}
          icon={<Scale className="h-4 w-4 text-rose-600" />}
        />
        <Section
          title={t("accounting.coa.health.statementSectionTypeMismatches")}
          body={t("accounting.coa.health.statementSectionTypeMismatchesBody")}
          rows={health.statementSectionTypeMismatches}
          icon={<Scale className="h-4 w-4 text-rose-600" />}
        />
      </div>
    </div>
  );
}

export default CoaHealthPage;
