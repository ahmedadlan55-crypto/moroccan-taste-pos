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
import { ChefHat, LogIn } from "lucide-react";
import { decodeUser, isPosRole, setToken } from "@/lib/auth";
import { Button, ErrorBanner } from "./ui";

interface LoginResponse {
  success?: boolean;
  token?: string;
  role?: string;
  error?: string;
  requires2faCode?: boolean;
  mustChangePassword?: boolean;
}

export function PosLogin() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
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
        setError(data.error || "أدخل رمز التحقق الثنائي");
        return;
      }
      if (!data.success || !data.token) {
        setError(data.error || "تعذّر تسجيل الدخول");
        return;
      }

      // Role gate — decode the JWT (server-signed; we only READ it) and refuse
      // any role the POS server would reject anyway. Never store the token for a
      // rejected role.
      const decoded = decodeUser(data.token);
      const role = decoded?.role ?? data.role ?? "";
      if (!isPosRole(role)) {
        setError("هذا الحساب لا يملك صلاحية الدخول إلى الكاشير. تواصل مع الإدارة.");
        return;
      }

      setToken(data.token);
      // Full reload so PosProvider re-reads the token at mount and renders the
      // POS shell (mirrors the ERP login's post-auth navigation).
      window.location.reload();
    } catch {
      setError("تعذّر الاتصال بالخادم. حاول مجددًا.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5 rounded-2xl bg-white p-8 shadow-lift">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-ink text-saffron-500 shadow-sm">
            <ChefHat className="h-8 w-8" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-ink">المذاق المغربي — كاشير</h1>
            <p className="text-sm font-bold text-slate-500">تسجيل الدخول</p>
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-extrabold text-slate-500">اسم المستخدم</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            aria-label="اسم المستخدم"
            className="field w-full"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold text-slate-500">كلمة المرور</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            aria-label="كلمة المرور"
            className="field w-full"
          />
        </label>
        {needs2fa ? (
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">رمز التحقق الثنائي</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              placeholder="000000"
              aria-label="رمز التحقق الثنائي"
              className="field num w-full"
            />
          </label>
        ) : null}

        {error ? <ErrorBanner message={error} /> : null}

        <Button type="submit" variant="saffron" size="lg" loading={busy} disabled={!username || !password}>
          <LogIn className="h-4 w-4" aria-hidden />
          تسجيل الدخول
        </Button>

        <a href="/" className="text-center text-xs font-bold text-slate-400 hover:text-slate-600">
          الدخول من النظام الرئيسي بدلًا من ذلك
        </a>
      </form>
    </main>
  );
}

export default PosLogin;
