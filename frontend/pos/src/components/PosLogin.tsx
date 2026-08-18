/**
 * PosLogin — the POS's own sign-in screen. It posts directly to the shared
 * public endpoint POST /api/auth/login, stores the returned JWT under the same
 * `pos_token` localStorage key the rest of the POS reads, and (on success)
 * reloads so PosProvider re-reads the token and renders the normal shell.
 *
 * Client-side role gate: the server enforces requireRole('admin','manager',
 * 'cashier') on every /api/pos/v2 route, so a non-POS role would hit a broken
 * screen after "logging in". We decode the JWT role locally (reusing auth.ts)
 * and reject anyone outside those roles with a clear message BEFORE handing over
 * — the server is still the real boundary, this is just better UX.
 */
import { useState, type FormEvent } from "react";
import { ArrowLeft, ChefHat, Languages, LogIn } from "lucide-react";
import { decodeUser, homeAppForRole, isPosRole, setToken } from "@/lib/auth";
import { useLang, useSetLang, useT } from "@/i18n";
import { Button, ErrorBanner } from "./ui";
import { PosChangePassword } from "./PosChangePassword";

interface LoginResponse {
  success?: boolean;
  token?: string;
  role?: string;
  error?: string;
  requires2faCode?: boolean;
  mustChangePassword?: boolean;
}

/**
 * Min-44px language toggle for the login card — switches ar↔en BEFORE the
 * cashier signs in. Deliberately reuses header.languageToggle.* verbatim
 * (same aria-label, same "EN"/"عربي" labels that always name the language
 * you'll switch TO, in its own script) rather than inventing login-scoped
 * copy, so this screen's toggle and the post-login Header toggle read as the
 * exact same control. Positioned with the logical `end-4 top-4` utilities
 * (inline-end, not a hardcoded physical side) so it sits correctly in both
 * RTL (ar) and LTR (en).
 */
function LoginLanguageToggle() {
  const t = useT();
  const lang = useLang();
  const setLang = useSetLang();
  const nextLang = lang === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      onClick={() => setLang(nextLang)}
      title={t("header.languageToggle.ariaLabel")}
      aria-label={t("header.languageToggle.ariaLabel")}
      className="btn-press absolute end-4 top-4 flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-800"
    >
      <Languages className="h-3.5 w-3.5" aria-hidden />
      {lang === "ar" ? t("header.languageToggle.switchToEnglish") : t("header.languageToggle.switchToArabic")}
    </button>
  );
}

/**
 * The door a refused account should actually walk through.
 *
 * The till admits admin / manager / cashier and nothing else — that gate is
 * right and stays. What was wrong is what happened next: the screen said
 * "contact your administrator" and offered a single link to the back office.
 * For a cook or a custody holder that is the wrong app too, so the refusal was
 * a dead end that could only be resolved by asking someone.
 *
 * Now the role names the destination: an employee or custody role is sent to
 * بوابة الموظف, every other non-till role to the main system.
 *
 * A plain <a>, not a router push: these are three separate applications on one
 * origin, and /employee is a different bundle entirely.
 */
function WrongAppCard({ app }: { app: "portal" | "office" }) {
  const t = useT();
  const portal = app === "portal";
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-extrabold text-slate-700">
        {t(portal ? "login.wrongApp.portalTitle" : "login.wrongApp.officeTitle")}
      </p>
      <p className="mt-1 text-[11px] font-bold text-slate-500">
        {t(portal ? "login.wrongApp.portalBody" : "login.wrongApp.officeBody")}
      </p>
      <a
        href={portal ? "/employee/" : "/app/"}
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-extrabold text-teal-700 hover:text-teal-800"
      >
        {/* rtl:rotate-180 — "forward" points the other way in an RTL layout. */}
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
        {t(portal ? "login.wrongApp.portalCta" : "login.wrongApp.officeCta")}
      </a>
    </div>
  );
}

export function PosLogin() {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A forced-change account is signed in but NOT yet allowed into the till.
  const [mustChangePassword, setMustChangePassword] = useState(false);
  // Set when the role gate refuses: which app this account DOES belong to.
  const [wrongApp, setWrongApp] = useState<"portal" | "office" | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    // Clear the previous suggestion — a retry with different credentials must
    // not leave the last account's door on screen.
    setWrongApp(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          totpCode: code || undefined,
          device: { ua: typeof navigator !== "undefined" ? navigator.userAgent : "pos-v2" },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as LoginResponse;

      if (data.requires2faCode) {
        setNeeds2fa(true);
        setError(data.error || t("login.errors.totpRequired"));
        return;
      }
      if (!data.success || !data.token) {
        setError(data.error || t("login.errors.loginFailed"));
        return;
      }

      // Role gate — decode the JWT (server-signed; we only READ it) and refuse
      // any role the POS server would reject anyway. Never store the token for a
      // rejected role.
      const decoded = decodeUser(data.token);
      const role = decoded?.role ?? data.role ?? "";
      if (!isPosRole(role)) {
        setError(t("login.errors.roleNotAllowed"));
        // Refusing is correct; stranding the person is not. Record which app the
        // role actually belongs to so the card can offer that door.
        setWrongApp(homeAppForRole(role));
        return;
      }

      setToken(data.token);
      // A forced-change account (P0 mandate: strong password + forced first-
      // login change) must never reach the POS shell on its temporary
      // password. This used to hop to `/app/change-password?redirect=/pos/` —
      // a cross-app navigation into the ERP bundle. That hop is gone: the
      // cashier portal is now isolated from the back office (a cashier is
      // redirected out of /app and the API refuses back-office paths for
      // their token), so the change happens right here instead.
      if (data.mustChangePassword) {
        setMustChangePassword(true);
        return;
      }
      // Full reload so PosProvider re-reads the token at mount and renders the
      // POS shell (mirrors the ERP login's post-auth navigation).
      window.location.reload();
    } catch {
      setError(t("login.errors.networkError"));
    } finally {
      setBusy(false);
    }
  }

  // Signed in on a temporary password: the till stays out of reach until the
  // change succeeds, then a reload boots the shell with the fresh token.
  if (mustChangePassword) {
    return <PosChangePassword onDone={() => window.location.reload()} />;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <form
        onSubmit={submit}
        className="relative flex w-full max-w-sm flex-col gap-5 rounded-2xl bg-white p-8 shadow-lift"
      >
        <LoginLanguageToggle />

        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-ink text-saffron-500 shadow-sm">
            <ChefHat className="h-8 w-8" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-ink">{t("login.brand")}</h1>
            <p className="text-sm font-bold text-slate-500">{t("login.title")}</p>
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("login.usernameLabel")}</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            aria-label={t("login.usernameLabel")}
            className="field w-full"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("login.passwordLabel")}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-label={t("login.passwordLabel")}
            className="field w-full"
          />
        </label>
        {needs2fa ? (
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("login.totpLabel")}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              placeholder={t("login.totpPlaceholder")}
              aria-label={t("login.totpLabel")}
              className="field num w-full"
            />
          </label>
        ) : null}

        {error ? <ErrorBanner message={error} /> : null}

        {wrongApp ? <WrongAppCard app={wrongApp} /> : null}

        <Button type="submit" variant="saffron" size="lg" loading={busy} disabled={!username || !password}>
          <LogIn className="h-4 w-4" aria-hidden />
          {t("login.submit")}
        </Button>

        <a href="/" className="text-center text-xs font-bold text-slate-400 hover:text-slate-600">
          {t("login.backToSystem")}
        </a>
      </form>
    </main>
  );
}

export default PosLogin;
