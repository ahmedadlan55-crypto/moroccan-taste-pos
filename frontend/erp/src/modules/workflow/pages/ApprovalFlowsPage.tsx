import { useState } from "react";
import { PageHeader, Tabs } from "@/shared/ui";
import { Can } from "@/shared/permissions";
import { PositionsTab } from "../builder/PositionsTab";
import { TransactionTypesTab } from "../builder/TransactionTypesTab";
import { StepsTab } from "../builder/StepsTab";
import { PositionPathsTab } from "../builder/PositionPathsTab";
import { RoutesDslTab } from "../builder/RoutesDslTab";
import { SlaTab } from "../builder/SlaTab";

// مسارات الاعتماد — the full approval-flow builder. All six tabs are real,
// backend-wired screens (nothing stubbed): Positions + Transaction-Types manage
// the primitives; Steps / Position-Paths define the chains (single-step and
// per-initiator bulk); Routes is the JSON-DSL layer with a dry-run tester; SLA is
// the read-only queue-health view with an admin escalate-now sweep. The whole
// page is gated on workflow.builder.manage via <Can>.
const TABS = [
  { value: "positions", label: "المناصب" },
  { value: "types", label: "أنواع المعاملات" },
  { value: "steps", label: "خطوات الاعتماد" },
  { value: "position-paths", label: "مسارات المناصب" },
  { value: "routes", label: "قواعد التوجيه" },
  { value: "sla", label: "اتفاقيات الخدمة" },
];

export function ApprovalFlowsPage() {
  const [tab, setTab] = useState("positions");
  return (
    <Can cap="workflow.builder.manage" showDenied>
      <div>
        <PageHeader
          eyebrow="المعاملات والموافقات"
          title="مسارات الاعتماد"
          subtitle="إدارة المناصب وأنواع المعاملات وخطوات ومسارات وقواعد الاعتماد ومستوى الخدمة."
        />
        <div className="mb-4">
          <Tabs items={TABS} value={tab} onChange={setTab} />
        </div>
        {tab === "positions" && <PositionsTab />}
        {tab === "types" && <TransactionTypesTab />}
        {tab === "steps" && <StepsTab />}
        {tab === "position-paths" && <PositionPathsTab />}
        {tab === "routes" && <RoutesDslTab />}
        {tab === "sla" && <SlaTab />}
      </div>
    </Can>
  );
}
