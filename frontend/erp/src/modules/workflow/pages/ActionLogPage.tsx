import { Link } from "react-router-dom";
import { ArrowLeft, History, ScrollText } from "lucide-react";
import { buttonVariants } from "@/shared/ui";
import { ScreenIntro } from "../components/ScreenIntro";

// سجل الإجراءات — the workflow backend has no distinct action-log READ endpoint;
// every workflow action is written to the ONE unified audit log surfaced under
// الإدارة » سجل التدقيق. We link there (no duplicate log here). The per-transaction
// action log is still visible inside each transaction's detail drawer.
export function ActionLogPage() {
  return (
    <div className="space-y-5">
      <ScreenIntro icon={ScrollText} description="سجل إجراءات المعاملات (اعتماد/رفض/إحالة/إغلاق)." />

      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <History className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">السجل موحّد ضمن سجل التدقيق</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          تُقيَّد إجراءات المعاملات في سجل التدقيق الموحّد للنظام. كما يظهر سجل كل معاملة على
          حدة داخل نافذة تفاصيلها ضمن «صندوق الوارد» و«صندوق الصادر».
        </p>
        <Link to="/administration/audit-log" className={buttonVariants({ variant: "primary" })}>
          <ScrollText className="h-4 w-4" aria-hidden="true" /> فتح سجل التدقيق
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
