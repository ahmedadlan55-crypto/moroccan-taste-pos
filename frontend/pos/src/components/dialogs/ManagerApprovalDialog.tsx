/**
 * Manager approval gate — parity with the legacy #modalManagerAuth
 * (public/pos/index.html:368-392, public/pos/app.js:3511-3552).
 *
 * IMPORTANT: this dialog is a UX shortcut, NOT the security boundary. The
 * server re-authorizes every void/return with bcrypt + role
 * (routes/sales.js:_requireManagerApproval) and refuses on its own. Skipping
 * this dialog for a privileged role is therefore safe — the server still checks.
 */
import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { ApproverCredentials } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Button, ErrorBanner } from "../ui";

export function ManagerApprovalDialog({
  open,
  title,
  /** When set, a reason field is shown and required (returns). */
  reasonLabel,
  defaultReason,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  reasonLabel?: string;
  defaultReason?: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (creds: ApproverCredentials, reason: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState(defaultReason ?? "");
  const userRef = useRef<HTMLInputElement>(null);

  // Never leave a manager's password sitting in state after the dialog closes.
  useEffect(() => {
    if (open) {
      setUsername("");
      setPassword("");
      setReason(defaultReason ?? "");
      // Focus after the dialog paints, or the ref is still null.
      const t = setTimeout(() => userRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    setPassword("");
    return undefined;
  }, [open, defaultReason]);

  const needsReason = !!reasonLabel;
  const canSubmit =
    username.trim().length > 0 && password.length > 0 && (!needsReason || reason.trim().length > 0) && !busy;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ approverUsername: username.trim(), approverPassword: password }, reason.trim());
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} widthClass="max-w-md">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
          هذا الإجراء يتطلب اعتماد مدير · Manager approval required
        </div>

        {error ? <ErrorBanner message={error} /> : null}

        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold text-slate-500">اسم المستخدم للمدير</span>
          <input
            ref={userRef}
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm font-bold text-ink outline-none focus:border-teal-500"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-bold text-slate-500">كلمة المرور</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm font-bold text-ink outline-none focus:border-teal-500"
          />
        </label>

        {needsReason ? (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-bold text-slate-500">{reasonLabel}</span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm font-bold text-ink outline-none focus:border-teal-500"
            />
          </label>
        ) : null}

        <div className="mt-1 grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            إلغاء
          </Button>
          <Button type="submit" variant="danger" disabled={!canSubmit} loading={busy}>
            اعتماد · Approve
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
