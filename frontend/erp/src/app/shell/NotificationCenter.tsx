import { Bell, BellOff } from "lucide-react";
import { HeaderMenu } from "./HeaderMenu";

// Notification bell. The foundation renders a clean empty state; a later
// integration wires live counts + items from the existing endpoints.
export function NotificationCenter() {
  return (
    <HeaderMenu label="الإشعارات" align="end" trigger={<Bell className="h-5 w-5" />}>
      {() => (
        <div>
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-extrabold text-slate-700">الإشعارات</div>
          <div className="grid place-items-center gap-2 px-4 py-8 text-center">
            <BellOff className="h-6 w-6 text-slate-300" aria-hidden="true" />
            <p className="text-xs font-medium text-slate-400">لا توجد إشعارات جديدة</p>
          </div>
        </div>
      )}
    </HeaderMenu>
  );
}
