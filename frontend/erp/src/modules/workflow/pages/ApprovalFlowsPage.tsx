import { useState } from "react";
import { PageHeader, Tabs } from "@/shared/ui";
import { Can } from "@/shared/permissions";
import { PositionsTab } from "../builder/PositionsTab";
import { TransactionTypesTab } from "../builder/TransactionTypesTab";

// مسارات الاعتماد — approval-flow builder. FC-P3 wires the real Positions and
// Transaction-Types CRUD tabs (on /api/workflow/*). The heavier step-definition /
// position-path / routes-DSL / SLA tabs are NOT built yet (the builder agent
// stalled mid-run) — this is an honest partial builder, gated on
// workflow.builder.manage, not a faked-complete screen.
const TABS = [
  { value: "positions", label: "المناصب" },
  { value: "types", label: "أنواع المعاملات" },
];

export function ApprovalFlowsPage() {
  const [tab, setTab] = useState("positions");
  return (
    <Can cap="workflow.builder.manage" showDenied>
      <div>
        <PageHeader
          eyebrow="المعاملات والموافقات"
          title="مسارات الاعتماد"
          subtitle="إدارة المناصب وأنواع المعاملات لبناء سلاسل الاعتماد."
        />
        <div className="mb-4">
          <Tabs items={TABS} value={tab} onChange={setTab} />
        </div>
        {tab === "positions" ? <PositionsTab /> : <TransactionTypesTab />}
      </div>
    </Can>
  );
}
