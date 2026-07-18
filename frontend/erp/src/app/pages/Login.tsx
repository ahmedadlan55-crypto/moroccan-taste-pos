import { useState, type FormEvent } from "react";
import { LayoutGrid, LogIn } from "lucide-react";
import { Button, Input } from "@/shared/ui";
import { Field } from "@/shared/forms";

// FC-P4 — the unified Back-Office login. The legacy app and the ERP share ONE
// JWT (localStorage `pos_token`); this screen lets a user sign in without
// bouncing to the legacy shell, which is what makes `/app` viable as the default
// entry point (see the ERP_DEFAULT_ENABLED cutover in server.js). It posts to
// the existing public POST /api/auth/login and stores the returned token.
export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, totpCode: code || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.requires2faCode) {
        setNeeds2fa(true);
        setError(data.error || "أدخل رمز التحقق الثنائي");
        setBusy(false);
        return;
      }
      if (!data || data.success !== true || !data.token) {
        setError((data && data.error) || "تعذّر تسجيل الدخول");
        setBusy(false);
        return;
      }
      localStorage.setItem("pos_token", data.token);
      // Full navigation so the AuthProvider re-reads the token at mount.
      const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
      // flagDefaultPasswordUsers() (server.js) marks accounts still on a default
      // password. The legacy shell bounced them to /security/?must=1; this screen
      // ignored the flag entirely, so on /app they signed straight in and had no
      // way to clear it. Honour it before handing over the app.
      if (data.mustChangePassword) {
        window.location.assign(base + "/change-password?must=1");
        return;
      }
      // A cashier's home is the POS, not the Back-Office overview. Send them
      // straight to /pos/ so they don't land on a screen their role can't use.
      if (String(data.role || "").toLowerCase() === "cashier") {
        window.location.assign("/pos/");
        return;
      }
      window.location.assign(base + "/overview");
    } catch {
      setError("تعذّر الاتصال بالخادم. حاول مجددًا.");
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <form onSubmit={submit} className="surface grid w-full max-w-sm gap-5 p-8">
        <div className="grid place-items-center gap-3 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-600 text-white">
            <LayoutGrid className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-slate-900">المذاق المغربي</h1>
            <p className="text-sm font-medium text-slate-500">الإدارة الموحّدة — تسجيل الدخول</p>
          </div>
        </div>

        <Field label="اسم المستخدم" required>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </Field>
        <Field label="كلمة المرور" required>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {needs2fa && (
          <Field label="رمز التحقق الثنائي">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              placeholder="000000"
            />
          </Field>
        )}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" loading={busy} disabled={!username || !password}>
          <LogIn className="h-4 w-4" /> تسجيل الدخول
        </Button>
      </form>
    </div>
  );
}

export default LoginPage;
