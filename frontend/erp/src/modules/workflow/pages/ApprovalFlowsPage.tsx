import { useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  Building2,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  ListChecks,
  Route,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Can } from "@/shared/permissions";
import { Badge, Card, CardBody, Select } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { cn } from "@/shared/lib";
import { PositionsTab } from "../builder/PositionsTab";
import { TransactionTypesTab } from "../builder/TransactionTypesTab";
import { StepsTab } from "../builder/StepsTab";
import { PositionPathsTab } from "../builder/PositionPathsTab";
import { RoutesDslTab } from "../builder/RoutesDslTab";
import { SlaTab } from "../builder/SlaTab";

type SectionId = "types" | "steps" | "position-paths" | "routes" | "positions" | "sla";
type Phase = "define" | "design" | "operate";

interface BuilderSection {
  id: SectionId;
  icon: ComponentType<{ className?: string }>;
  component: ComponentType;
  phase: Phase;
}

// Section labels + descriptions live in the i18n "workflow.builder.section.*"
// namespace, keyed by id; the phase code drives grouping + a translated heading.
const SECTIONS: BuilderSection[] = [
  { id: "types", icon: ListChecks, component: TransactionTypesTab, phase: "define" },
  { id: "positions", icon: UsersRound, component: PositionsTab, phase: "define" },
  { id: "steps", icon: GitBranch, component: StepsTab, phase: "design" },
  { id: "position-paths", icon: Building2, component: PositionPathsTab, phase: "design" },
  { id: "routes", icon: Route, component: RoutesDslTab, phase: "design" },
  { id: "sla", icon: Activity, component: SlaTab, phase: "operate" },
];

const PHASES: Phase[] = ["define", "design", "operate"];

export function ApprovalFlowsPage() {
  const t = useTx();
  const [sectionId, setSectionId] = useState<SectionId>("types");
  const section = useMemo(
    () => SECTIONS.find((item) => item.id === sectionId) ?? SECTIONS[0],
    [sectionId],
  );
  const ActiveSection = section.component;
  const sectionLabel = (id: SectionId) => t(`workflow.builder.section.${id}.label`);
  const sectionDesc = (id: SectionId) => t(`workflow.builder.section.${id}.desc`);
  // The "drill into" chevron follows the reading direction toward the section.
  // Direction is read from the document (maintained by the i18n provider) so this
  // page still renders under provider-less unit tests.
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const IntoIcon = rtl ? ChevronLeft : ChevronRight;

  return (
    <Can cap="workflow.builder.manage" showDenied>
      <div className="space-y-5">
        <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-extrabold text-slate-950">{t("workflow.builder.header")}</h2>
              <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-slate-500">
                {t("workflow.builder.headerSub")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">{t("workflow.builder.badgeConnected")}</Badge>
            <Badge tone="info">{t("workflow.builder.badgeIndependent")}</Badge>
          </div>
        </section>

        <div className="lg:hidden">
          <label htmlFor="workflow-builder-section" className="mb-1 block text-xs font-bold text-slate-600">
            {t("workflow.builder.mobileSectionLabel")}
          </label>
          <Select
            id="workflow-builder-section"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value as SectionId)}
            options={SECTIONS.map((item) => ({
              value: item.id,
              label: `${t(`workflow.builder.phase.${item.phase}`)} — ${sectionLabel(item.id)}`,
            }))}
          />
        </div>

        <div className="grid min-w-0 gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="hidden lg:block" aria-label={t("workflow.builder.asideAria")}>
            <Card className="sticky top-5 overflow-hidden">
              <CardBody className="p-2">
                {PHASES.map((phase) => (
                  <div key={phase} className="mb-3 last:mb-0">
                    <div className="px-3 pb-1 pt-2 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
                      {t(`workflow.builder.phase.${phase}`)}
                    </div>
                    <div className="space-y-1">
                      {SECTIONS.filter((item) => item.phase === phase).map((item) => {
                        const Icon = item.icon;
                        const active = item.id === sectionId;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-current={active ? "page" : undefined}
                            onClick={() => setSectionId(item.id)}
                            className={cn(
                              "group flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-start transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                              active
                                ? "bg-teal-50 text-teal-800"
                                : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                            )}
                          >
                            <Icon className={cn("h-4 w-4 shrink-0", active ? "text-teal-600" : "text-slate-400")} aria-hidden="true" />
                            <span className="min-w-0 flex-1 text-sm font-bold">{sectionLabel(item.id)}</span>
                            <IntoIcon className={cn("h-4 w-4 shrink-0", active ? "text-teal-500" : "text-slate-300")} aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </CardBody>
            </Card>
          </aside>

          <main className="min-w-0 space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
              <div className="flex items-start gap-3">
                <section.icon className="mt-0.5 h-5 w-5 shrink-0 text-teal-600" aria-hidden="true" />
                <div>
                  <h3 className="text-base font-extrabold text-slate-900">{sectionLabel(section.id)}</h3>
                  <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{sectionDesc(section.id)}</p>
                </div>
              </div>
            </div>
            <ActiveSection />
          </main>
        </div>
      </div>
    </Can>
  );
}
