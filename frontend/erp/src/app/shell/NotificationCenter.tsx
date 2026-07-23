import { Bell, BellOff } from "lucide-react";
import { useT } from "@/i18n";
import { HeaderMenu } from "./HeaderMenu";

// Notification bell. The foundation renders a clean empty state; a later
// integration wires live counts + items from the existing endpoints.
export function NotificationCenter() {
  const t = useT();
  return (
    <HeaderMenu label={t("shell.notifications.label")} align="end" trigger={<Bell className="h-5 w-5" />}>
      {() => (
        <div>
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-extrabold text-slate-700">{t("shell.notifications.heading")}</div>
          <div className="grid place-items-center gap-2 px-4 py-8 text-center">
            <BellOff className="h-6 w-6 text-slate-300" aria-hidden="true" />
            <p className="text-xs font-medium text-slate-400">{t("shell.notifications.empty")}</p>
          </div>
        </div>
      )}
    </HeaderMenu>
  );
}
