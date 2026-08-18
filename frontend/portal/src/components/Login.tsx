// Sign-in.
//
// One card, two fields, one button. The portal-access refusal
// («هذا الحساب لا يملك صلاحية الدخول إلى بوابة الموظف») arrives from the server
// as a normal error message and renders in the same place as a wrong password —
// which is right: from the employee's side both mean "you cannot get in here",
// and the server's own wording explains which.
import React, { useState } from "react";
import { Eye, EyeOff, Fingerprint } from "lucide-react";
import { Button } from "./ui";
import { useLang, useSetLang, useT } from "@/i18n";
import { login } from "@/lib/auth";
import type { PortalSession } from "@/lib/api";

export function Login({ onSignedIn }: { onSignedIn: (session: PortalSession) => void }) {
  const t = useT();
  const lang = useLang();
  const setLang = useSetLang();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError(t("login.missing"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      onSignedIn(await login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("login.failed"));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600 text-white shadow-sm">
            <Fingerprint className="h-7 w-7" aria-hidden />
          </span>
          <div>
            <h1 className="text-lg font-extrabold text-slate-900">{t("login.title")}</h1>
            <p className="mt-1 text-xs font-bold text-slate-500">{t("login.subtitle")}</p>
          </div>
        </div>

        <form onSubmit={submit} className="surface flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-600">{t("login.username")}</span>
            <input
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              // The username is an ASCII login on an Arabic-first page: without
              // dir=ltr the caret and the text render right-to-left.
              dir="ltr"
              disabled={busy}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-extrabold text-slate-600">{t("login.password")}</span>
            <div className="relative">
              <input
                className="field pe-12"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                dir="ltr"
                disabled={busy}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                className="absolute inset-y-0 end-0 flex w-12 items-center justify-center text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-extrabold text-rose-700"
            >
              {error}
            </p>
          )}

          <Button type="submit" block loading={busy}>
            {busy ? t("login.submitting") : t("login.submit")}
          </Button>
        </form>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            className="rounded-lg px-3 py-2 text-xs font-extrabold text-slate-500 hover:bg-slate-100"
          >
            {t("common.language")}
          </button>
        </div>
      </div>
    </div>
  );
}
