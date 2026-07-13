import { LogOut, UserCircle } from "lucide-react";
import { useAuth } from "@/app/providers";
import { HeaderMenu } from "./HeaderMenu";

// User menu — identity + logout. Logout clears the shared session tokens and
// returns to the in-app /login (FC-P4). When `/app` is not the default, that
// login still works; the legacy shell also remains reachable at /legacy.
export function UserMenu() {
  const { user } = useAuth();
  const initials = (user?.name || user?.username || "؟").slice(0, 2);

  function logout() {
    try {
      localStorage.removeItem("pos_token");
      localStorage.removeItem("pos_session");
      localStorage.removeItem("token");
      localStorage.removeItem("jwt");
    } catch {
      /* ignore storage errors */
    }
    const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
    window.location.assign(base + "/login");
  }

  return (
    <HeaderMenu
      label="حساب المستخدم"
      align="end"
      trigger={<span className="text-xs font-extrabold uppercase">{initials}</span>}
    >
      {() => (
        <div>
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-teal-600 text-sm font-extrabold uppercase text-white">
              {initials}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-extrabold text-slate-800">{user?.name || user?.username || "زائر"}</div>
              <div className="truncate text-[11px] font-bold text-slate-400">{user?.username || "غير مسجّل"}</div>
            </div>
          </div>
          <a
            href="/people/self-service"
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50"
          >
            <UserCircle className="h-4 w-4" /> الخدمة الذاتية
          </a>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2.5 text-sm font-bold text-rose-600 transition hover:bg-rose-50"
          >
            <LogOut className="h-4 w-4" /> تسجيل الخروج
          </button>
        </div>
      )}
    </HeaderMenu>
  );
}
