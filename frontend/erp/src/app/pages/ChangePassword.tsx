import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react";
import { Button, Input } from "@/shared/ui";
import { Field } from "@/shared/forms";

// The self-service credential screen for /app. It replaces public/security/,
// which was the ONLY change-password UI in the product — and which /app had no
// equivalent of, so an account flagged by flagDefaultPasswordUsers() could sign
// in on a default password and had no way to clear the flag (the legacy shell
// redirected such users here via /security/?must=1; React never checked).
//
// POST /api/auth/change-password is the authority: it re-verifies the current
// password, applies the admin-configured policy, bumps token_version (revoking
// OTHER sessions), clears must_change_password, and returns a FRESH token for
// this session. The checks below mirror lib/passwordPolicy's DEFAULT_POLICY for
// live guidance only — a non-admin can't read the effective policy (GET
// /api/security-policies needs administration.security), so when the server
// rejects, we render ITS errors rather than guessing.

const COMMON = new Set([
  "admin123", "admin", "password", "password1", "passw0rd", "123456", "1234567",
  "12345678", "123456789", "1234567890", "qwerty", "qwerty123", "letmein",
  "welcome", "welcome1", "changeme", "admin@123", "admin1234", "p@ssw0rd",
  "iloveyou", "abc123", "test1234", "root", "toor", "moroccan", "pos12345",
]);
const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/;

interface Check {
  label: string;
  ok: boolean;
}

function checksFor(pw: string): Check[] {
  return [
    { label: "12 حرفًا على الأقل", ok: pw.length >= 12 },
    { label: "تحتوي على حرف", ok: /[a-zA-Z؀-ۿ]/.test(pw) },
    { label: "تحتوي على رقم", ok: /[0-9]/.test(pw) },
    { label: "تحتوي على رمز خاص (‏!@#$…)", ok: SPECIAL.test(pw) },
    { label: "ليست كلمة مرور شائعة", ok: pw.length > 0 && !COMMON.has(pw.toLowerCase().trim()) },
  ];
}

function strengthOf(pw: string): number {
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw) && SPECIAL.test(pw)) score++;
  if (COMMON.has(pw.toLowerCase().trim())) score = 0;
  return Math.min(4, score);
}

const STRENGTH_LABEL = ["ضعيفة جدًا", "ضعيفة", "متوسطة", "جيدة", "قوية"];
const STRENGTH_TONE = [
  "bg-rose-500",
  "bg-rose-400",
  "bg-amber-400",
  "bg-teal-400",
  "bg-teal-600",
];

export function ChangePasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const mandatory = params.get("must") === "1";

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const checks = useMemo(() => checksFor(newPassword), [newPassword]);
  const allPass = checks.every((c) => c.ok);
  const matches = newPassword.length > 0 && newPassword === confirm;
  const score = strengthOf(newPassword);
  const canSubmit = !!currentPassword && allPass && matches && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      const token = localStorage.getItem("pos_token") || "";
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data || data.success !== true) {
        // Prefer the server's list — it knows the effective policy, we don't.
        setErrors(data?.errors?.length ? data.errors : [data?.error || "تعذّر تغيير كلمة المرور"]);
        setBusy(false);
        return;
      }
      // The change bumped token_version, so the OLD token is dead. Store the
      // fresh one or this session logs itself out on the next request.
      if (data.token) localStorage.setItem("pos_token", data.token);
      const redirect = params.get("redirect");
      navigate(redirect && redirect.startsWith("/") ? redirect : "/overview", { replace: true });
    } catch {
      setErrors(["تعذّر الاتصال بالخادم. حاول مجددًا."]);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <form onSubmit={submit} className="surface grid w-full max-w-sm gap-5 p-8">
        <div className="grid place-items-center gap-3 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-600 text-white">
            <KeyRound className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-xl font-extrabold text-slate-900">تغيير كلمة المرور</h1>
            <p className="text-sm font-medium text-slate-500">اختر كلمة مرور قوية لحسابك</p>
          </div>
        </div>

        {mandatory && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>حسابك يستخدم كلمة مرور افتراضية. يجب تغييرها قبل المتابعة.</span>
          </div>
        )}

        <Field label="كلمة المرور الحالية" required>
          <Input
            type={reveal ? "text" : "password"}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        </Field>

        <Field label="كلمة المرور الجديدة" required>
          <div className="relative">
            <Input
              type={reveal ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              className="pl-10"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-label={reveal ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
              className="absolute inset-y-0 left-0 grid w-10 place-items-center text-slate-400 hover:text-slate-600"
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        {newPassword && (
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full transition-all ${STRENGTH_TONE[score]}`}
                  style={{ width: `${((score + 1) / 5) * 100}%` }}
                />
              </div>
              <span className="text-xs font-bold text-slate-500">{STRENGTH_LABEL[score]}</span>
            </div>
            <ul className="grid gap-1">
              {checks.map((c) => (
                <li
                  key={c.label}
                  className={`text-xs font-medium ${c.ok ? "text-teal-700" : "text-slate-400"}`}
                >
                  {c.ok ? "✓" : "○"} {c.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Field label="تأكيد كلمة المرور الجديدة" required>
          <Input
            type={reveal ? "text" : "password"}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        {confirm && !matches && (
          <p className="text-xs font-bold text-rose-700">الكلمتان غير متطابقتين</p>
        )}

        {errors.length > 0 && (
          <div className="grid gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {errors.map((msg) => (
              <span key={msg}>{msg}</span>
            ))}
          </div>
        )}

        <Button type="submit" variant="primary" loading={busy} disabled={!canSubmit}>
          <KeyRound className="h-4 w-4" /> حفظ كلمة المرور
        </Button>

        {!mandatory && (
          <button
            type="button"
            onClick={() => navigate("/overview", { replace: true })}
            className="text-xs font-bold text-slate-500 hover:text-slate-700"
          >
            العودة إلى نظرة عامة
          </button>
        )}
      </form>
    </div>
  );
}

export default ChangePasswordPage;
