import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { Button, Dialog, Input, useToast } from "@/shared/ui";
import { Field, FormActions } from "@/shared/forms";
import { ensureAck, type MutationAck } from "../_common";
import { checkPasswordStrength } from "./password";

/**
 * Small confirm + new-password sub-dialog. Calls
 * POST /api/auth/users/:username/reset-password with the same strength rule the
 * server enforces (validated client-side first). Clears failed-attempts + lock
 * server-side. On success the account still keeps must_change_password semantics
 * decided at the backend.
 */
export function ResetPasswordDialog({
  open,
  username,
  onClose,
}: {
  open: boolean;
  username: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setConfirm("");
      setError(null);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!username) return {};
      const res = await apiClient.post<MutationAck>(
        `/auth/users/${encodeURIComponent(username)}/reset-password`,
        { password },
      );
      return ensureAck(res);
    },
    onSuccess: () => {
      toast({ title: "تم تعيين كلمة مرور جديدة", tone: "success" });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = () => {
    setError(null);
    const strength = checkPasswordStrength(password);
    if (!strength.ok) {
      setError(strength.error ?? "كلمة المرور غير صالحة");
      return;
    }
    if (password !== confirm) {
      setError("كلمتا المرور غير متطابقتين");
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={username ? `إعادة تعيين كلمة المرور — ${username}` : "إعادة تعيين كلمة المرور"}
      description="سيتم تسجيل خروج جلسات المستخدم الحالية وإجباره على تغيير كلمة المرور عند الدخول التالي."
      size="sm"
      dismissable={!mutation.isPending}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4"
        noValidate
      >
        <Field label="كلمة المرور الجديدة" required>
          {({ id }) => (
            <Input
              id={id}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        <Field label="تأكيد كلمة المرور" required>
          {({ id }) => (
            <Input
              id={id}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>
        {error && (
          <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700" role="alert">
            {error}
          </p>
        )}
        <FormActions>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            إلغاء
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            تعيين كلمة المرور
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
