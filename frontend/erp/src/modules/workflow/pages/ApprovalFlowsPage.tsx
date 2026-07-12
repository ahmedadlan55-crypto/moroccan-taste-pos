import { GitBranch } from "lucide-react";
import { DeferredScreen } from "../components/DeferredScreen";

// مسارات الاعتماد — the chain builder is the HEAVY engine (position workflow
// steps, branching JSON-DSL routes). DEFERRED: stays in the legacy app; this is
// a clean placeholder marked as a legacy dependency.
export function ApprovalFlowsPage() {
  return (
    <DeferredScreen
      icon={GitBranch}
      intro="بناء وتحرير مسارات الاعتماد للمعاملات."
      feature="مُنشئ مسارات الاعتماد"
      detail="أداة إعداد ثقيلة (خطوات المناصب والتفريعات) تُدار حاليًا في النظام الأصلي، وسيُنقل المحرّر لاحقًا."
    />
  );
}
