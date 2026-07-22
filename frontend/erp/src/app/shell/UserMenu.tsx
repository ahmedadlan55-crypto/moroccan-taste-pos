import { LogOut, UserCircle } from "lucide-react";
import { useAuth } from "@/app/providers";
import { useT } from "@/i18n";
import { HeaderMenu } from "./HeaderMenu";
import { LanguageToggle } from "./LanguageToggle";

// User menu — identity, an interface-language switch, and logout. Logout clears
// the shared session tokens and returns to the in-app /login.
export function UserMenu() {
  const t = useT();
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
      label={t("shell.userMenu.label")}
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
              <div className="truncate text-sm font-extrabold text-slate-800">{user?.name || user?.username || t("shell.identity.guest")}</div>
              <div className="truncate text-[11px] font-bold text-slate-400">{user?.username || t("shell.identity.unregistered")}</div>
            </div>
          </div>
          <div className="border-b border-slate-100 px-3 py-2.5">
            <LanguageToggle className="w-full" />
          </div>
          <a
            href="/people/self-service"
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-slate-600 transition hover:bg-slate-50"
          >
            <UserCircle className="h-4 w-4" /> {t("shell.userMenu.selfService")}
          </a>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-2 border-t border-slate-100 px-4 py-2.5 text-sm font-bold text-rose-600 transition hover:bg-rose-50"
          >
            <LogOut className="h-4 w-4" /> {t("shell.userMenu.logout")}
          </button>
        </div>
      )}
    </HeaderMenu>
  );
}
