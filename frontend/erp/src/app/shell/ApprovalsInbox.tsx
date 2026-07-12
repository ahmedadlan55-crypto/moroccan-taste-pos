import { useNavigate } from "react-router-dom";
import { ClipboardCheck, Inbox } from "lucide-react";
import { HeaderMenu } from "./HeaderMenu";

// Approvals inbox button. Empty state in the foundation; opens the workflow
// inbox screen. Live badge counts are wired later from the workflow endpoints.
export function ApprovalsInbox() {
  const navigate = useNavigate();
  return (
    <HeaderMenu label="الموافقات المطلوبة" align="end" trigger={<ClipboardCheck className="h-5 w-5" />}>
      {(close) => (
        <div>
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-extrabold text-slate-700">الموافقات المطلوبة</div>
          <div className="grid place-items-center gap-2 px-4 py-8 text-center">
            <Inbox className="h-6 w-6 text-slate-300" aria-hidden="true" />
            <p className="text-xs font-medium text-slate-400">لا توجد موافقات معلّقة</p>
          </div>
          <button
            type="button"
            onClick={() => {
              close();
              navigate("/workflow/inbox");
            }}
            className="block w-full border-t border-slate-100 px-4 py-2.5 text-center text-xs font-bold text-teal-700 transition hover:bg-slate-50"
          >
            فتح صندوق الوارد
          </button>
        </div>
      )}
    </HeaderMenu>
  );
}
