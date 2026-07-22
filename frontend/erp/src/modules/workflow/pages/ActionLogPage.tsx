import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, History, ScrollText } from "lucide-react";
import { buttonVariants } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { ScreenIntro } from "../components/ScreenIntro";

// سجل الإجراءات — the workflow backend has no distinct action-log READ endpoint;
// every workflow action is written to the ONE unified audit log surfaced under
// الإدارة » سجل التدقيق. We link there (no duplicate log here). The per-transaction
// action log is still visible inside each transaction's detail drawer.
export function ActionLogPage() {
  const t = useTx();
  // Trailing "go to" arrow points toward the reading-flow end (start→end). The
  // direction is read from the document (set by the i18n provider) rather than
  // useLang() so the page still renders in provider-less unit tests.
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const GoIcon = rtl ? ArrowLeft : ArrowRight;
  return (
    <div className="space-y-5">
      <ScreenIntro icon={ScrollText} description={t("workflow.actionLog.description")} />

      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <History className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">{t("workflow.actionLog.unifiedTitle")}</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          {t("workflow.actionLog.unifiedBody")}
        </p>
        <Link to="/administration/audit-log" className={buttonVariants({ variant: "primary" })}>
          <ScrollText className="h-4 w-4" aria-hidden="true" /> {t("workflow.actionLog.openAuditLog")}
          <GoIcon className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
