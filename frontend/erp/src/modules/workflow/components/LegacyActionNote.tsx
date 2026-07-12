import { ExternalLink, Info } from "lucide-react";
import { Button } from "@/shared/ui";

// ── DOCUMENTED ESCAPE HATCH ─────────────────────────────────────────────────
// The approve/reject/route ENGINE is heavy and stays in the legacy app this
// session. These read-only surfaces therefore cannot act on a transaction; when
// an action is needed we point the user back to the current system. This is the
// ONE deliberate, documented `window.location` use in the workflow module — the
// only spot that leaves React to hand control back to the legacy engine. No
// other React file in this module touches the browser location object.
export function LegacyActionNote() {
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-center gap-2 text-xs font-semibold text-slate-500">
        <Info className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
        هذه شاشة عرض فقط. للإجراء (اعتماد/رفض/إحالة) استخدم النظام الحالي.
      </p>
      <Button
        variant="subtle"
        size="sm"
        onClick={() => {
          // Return to the legacy app root, where the full workflow engine lives.
          window.location.assign("/");
        }}
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" /> فتح النظام الحالي
      </Button>
    </div>
  );
}
