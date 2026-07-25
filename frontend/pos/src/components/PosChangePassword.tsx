/**
 * PosChangePassword — the forced first-login password change, INSIDE the
 * cashier app.
 *
 * WHY IT EXISTS HERE
 *   This screen used to live only in the back office: PosLogin sent a cashier
 *   to `/app/change-password?must=1&redirect=/pos/` — a real cross-app
 *   navigation into the ERP bundle. Once the cashier portal was isolated from
 *   the admin portal (a cashier is now redirected out of /app and the API
 *   refuses back-office paths for their token), that hop became the one
 *   remaining hole, so the cashier gets its own screen.
 *
 *   The server contract is unchanged and shared: POST /api/auth/change-password
 *   with { currentPassword, newPassword } and a Bearer token. On success the
 *   server bumps users.token_version — which KILLS the token that made the
 *   request — and returns a fresh one, so storing `data.token` is mandatory,
 *   not an optimisation: skip it and the very next request 401s.
 *
 *   Password RULES are deliberately not duplicated here. lib/passwordPolicy is
 *   settings-driven, so any list this screen hardcoded would drift out of sync
 *   with the policy actually enforced; the server returns `errors[]` and those
 *   are what the cashier sees.
 */
import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { setToken } from "@/lib/auth";
import { useT } from "@/i18n";
import { Button, ErrorBanner } from "./ui";

export function PosChangePassword({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const matches = newPassword.length > 0 && newPassword === confirm;
  const canSubmit = !!currentPassword && matches && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setErrors([]);
    try {
      // The token in storage is the one login just issued; it is still valid
      // until this call succeeds.
      const token = localStorage.getItem("pos_token") || "";
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data || data.success !== true) {
        // Prefer the server's list — it knows the effective policy, we don't.
        setErrors(data?.errors?.length ? data.errors : [data?.error || t("login.changePassword.genericError")]);
        setBusy(false);
        return;
      }
      // MANDATORY: the change revoked the old token_version. Without swapping
      // in the fresh token, the next POS request fails the session-version gate.
      if (data.token) setToken(data.token);
      onDone();
    } catch {
      setErrors([t("login.errors.networkError")]);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5 rounded-2xl bg-white p-8 shadow-lift">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-ink text-saffron-500 shadow-sm">
            <KeyRound className="h-8 w-8" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-ink">{t("login.changePassword.title")}</h1>
            <p className="text-sm font-bold text-slate-500">{t("login.changePassword.mandatoryNote")}</p>
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("login.changePassword.currentLabel")}</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            aria-label={t("login.changePassword.currentLabel")}
            className="field w-full"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("login.changePassword.newLabel")}</span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            aria-label={t("login.changePassword.newLabel")}
            className="field w-full"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("login.changePassword.confirmLabel")}</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            aria-label={t("login.changePassword.confirmLabel")}
            className="field w-full"
          />
        </label>

        {confirm.length > 0 && !matches ? <ErrorBanner message={t("login.changePassword.mismatch")} /> : null}
        {errors.map((msg) => (
          <ErrorBanner key={msg} message={msg} />
        ))}

        <Button type="submit" variant="saffron" size="lg" loading={busy} disabled={!canSubmit}>
          {t("login.changePassword.submit")}
        </Button>
      </form>
    </main>
  );
}

export default PosChangePassword;
