import type { LucideIcon } from "lucide-react";
import { Construction } from "lucide-react";
import { Badge } from "@/shared/ui";
import { ScreenIntro } from "./ScreenIntro";

// Clean placeholder for a workflow feature whose editor/engine is HEAVY and
// stays in the legacy app this session (chain builder, transaction editor, org /
// positions / types admin). Marked as a legacy dependency, no engine here.
export function DeferredScreen({
  icon,
  intro,
  feature,
  detail,
}: {
  icon: LucideIcon;
  intro: string;
  feature: string;
  detail: string;
}) {
  return (
    <div className="space-y-5">
      <ScreenIntro icon={icon} description={intro} />

      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">
          <Construction className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">قيد التحويل — يُدار حاليًا في النظام الأصلي</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          {`«${feature}» ${detail}`}
        </p>
        <Badge tone="warning">يعتمد على النظام الأصلي</Badge>
      </div>
    </div>
  );
}
