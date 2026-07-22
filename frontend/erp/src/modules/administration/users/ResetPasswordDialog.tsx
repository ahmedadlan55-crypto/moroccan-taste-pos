import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { Button, Dialog, Input, useToast } from "@/shared/ui";
import { Field, FormActions } from "@/shared/forms";
import { useT } from "@/i18n";
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
  const t = useT();
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
      toast({ title: t("administration.users.reset.toastSuccess"), tone: "success" });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = () => {
    setError(null);
    const strength = checkPasswordStrength(password);
    if (!strength.ok) {
      setError(strength.code ? t(`administration.users.pwd.${strength.code}`) : t("administration.users.pwd.invalid"));
      return;
    }
    if (password !== confirm) {
      setError(t("administration.users.err.passwordMismatch"));
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={username ? t("administration.users.reset.titleWith", { username }) : t("administration.users.reset.title")}
      description={t("administration.users.reset.description")}
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
        <Field label={t("administration.users.reset.newPassword")} required>
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
        <Field label={t("administration.users.reset.confirmPassword")} required>
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
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {t("administration.users.reset.submit")}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}
