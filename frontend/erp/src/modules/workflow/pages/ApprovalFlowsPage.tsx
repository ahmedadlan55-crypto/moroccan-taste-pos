import { useMemo, useState, type ComponentType } from "react";
import {
  Activity,
  Building2,
  ChevronLeft,
  GitBranch,
  ListChecks,
  Route,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Can } from "@/shared/permissions";
import { Badge, Card, CardBody, Select } from "@/shared/ui";
import { cn } from "@/shared/lib";
import { PositionsTab } from "../builder/PositionsTab";
import { TransactionTypesTab } from "../builder/TransactionTypesTab";
import { StepsTab } from "../builder/StepsTab";
import { PositionPathsTab } from "../builder/PositionPathsTab";
import { RoutesDslTab } from "../builder/RoutesDslTab";
import { SlaTab } from "../builder/SlaTab";

type SectionId = "types" | "steps" | "position-paths" | "routes" | "positions" | "sla";

interface BuilderSection {
  id: SectionId;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  component: ComponentType;
  phase: "تعريف" | "تصميم" | "تشغيل";
}

const SECTIONS: BuilderSection[] = [
  {
    id: "types",
    label: "أنواع المعاملات",
    description: "تعريف النماذج والرموز التي تبدأ منها مسارات الاعتماد.",
    icon: ListChecks,
    component: TransactionTypesTab,
    phase: "تعريف",
  },
  {
    id: "positions",
    label: "المناصب والصلاحيات",
    description: "تحديد المناصب الإدارية ومستوى كل منصب داخل سلسلة القرار.",
    icon: UsersRound,
    component: PositionsTab,
    phase: "تعريف",
  },
  {
    id: "steps",
    label: "خطوات الاعتماد",
    description: "بناء الخطوات القياسية لكل نوع مع صلاحيات القرار والإرجاع.",
    icon: GitBranch,
    component: StepsTab,
    phase: "تصميم",
  },
  {
    id: "position-paths",
    label: "مسارات المناصب",
    description: "مسار مختلف بحسب منصب منشئ المعاملة والفرع أو الإدارة.",
    icon: Building2,
    component: PositionPathsTab,
    phase: "تصميم",
  },
  {
    id: "routes",
    label: "قواعد التوجيه",
    description: "قواعد شرطية مرئية للحالات والمبالغ مع اختبار آمن قبل الاستخدام.",
    icon: Route,
    component: RoutesDslTab,
    phase: "تصميم",
  },
  {
    id: "sla",
    label: "اتفاقيات الخدمة",
    description: "مراقبة الاستحقاق والتأخير والتصعيد التشغيلي للمعاملات.",
    icon: Activity,
    component: SlaTab,
    phase: "تشغيل",
  },
];

export function ApprovalFlowsPage() {
  const [sectionId, setSectionId] = useState<SectionId>("types");
  const section = useMemo(
    () => SECTIONS.find((item) => item.id === sectionId) ?? SECTIONS[0],
    [sectionId],
  );
  const ActiveSection = section.component;

  return (
    <Can cap="workflow.builder.manage" showDenied>
      <div className="space-y-5">
        <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-extrabold text-slate-950">استوديو مسارات الاعتماد</h2>
              <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-slate-500">
                عرّف الهيكل أولًا، ثم صمّم المسار واختبر قواعده، وأخيرًا راقب الالتزام بمواعيد الخدمة.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">متصل بالخادم</Badge>
            <Badge tone="info">حفظ كل قسم مستقل</Badge>
          </div>
        </section>

        <div className="lg:hidden">
          <label htmlFor="workflow-builder-section" className="mb-1 block text-xs font-bold text-slate-600">
            قسم إعداد المسار
          </label>
          <Select
            id="workflow-builder-section"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value as SectionId)}
            options={SECTIONS.map((item) => ({ value: item.id, label: `${item.phase} — ${item.label}` }))}
          />
        </div>

        <div className="grid min-w-0 gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="hidden lg:block" aria-label="مراحل إعداد مسار الاعتماد">
            <Card className="sticky top-5 overflow-hidden">
              <CardBody className="p-2">
                {(["تعريف", "تصميم", "تشغيل"] as const).map((phase) => (
                  <div key={phase} className="mb-3 last:mb-0">
                    <div className="px-3 pb-1 pt-2 text-[10px] font-extrabold uppercase tracking-wide text-slate-400">
                      {phase}
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
                            <span className="min-w-0 flex-1 text-sm font-bold">{item.label}</span>
                            <ChevronLeft className={cn("h-4 w-4 shrink-0", active ? "text-teal-500" : "text-slate-300")} aria-hidden="true" />
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
                  <h3 className="text-base font-extrabold text-slate-900">{section.label}</h3>
                  <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{section.description}</p>
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
