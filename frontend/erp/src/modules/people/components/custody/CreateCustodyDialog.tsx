import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, ErrorState, LoadingState, Select, safeUserMessage, useToast } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { peopleApi } from "../../lib/api";
import { qk } from "../../lib/query-keys";

// إنشاء عهدة — port of the legacy admin openCreateCustodyModal/createCustodyFn
// (public/js/custody.js:139-168): pick an ACTIVE custodian from /custody/users,
// POST /custody/create { userId, userName }. The server generates the custody
// number and takes the creator from the JWT.
//
// Deliberately NO "opening amount" field: POST /custody/create does not accept
// one — funding is a separate GL-posting operation (تغذية). The success toast
// points the operator at it, exactly like the legacy two-step flow.

export function CreateCustodyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTx();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [userId, setUserId] = useState("");

  const users = useQuery({
    queryKey: qk.custodyUsers(),
    queryFn: ({ signal }) => peopleApi.listCustodyUsers(signal),
    enabled: open,
  });
  const active = (users.data ?? []).filter((u) => !!u.isActive);
  const picked = active.find((u) => u.id === userId);

  const create = useMutation({
    mutationFn: () => peopleApi.createCustody({ userId, userName: picked?.name ?? "" }),
    onSuccess: (r) => {
      toast({
        title: t("people.custody.create.created", { number: r.custodyNumber || "" }),
        description: t("people.custody.create.createdDesc"),
        tone: "success",
      });
      setUserId("");
      onClose();
      void qc.invalidateQueries({ queryKey: [...qk.all, "custody"] });
    },
    onError: (e) => toast({ title: t("people.custody.create.createFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  function close() {
    if (create.isPending) return;
    setUserId("");
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("people.custody.create.title")}
      description={t("people.custody.create.desc")}
      dismissable={!create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={create.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!userId} onClick={() => create.mutate()}>
            {t("people.custody.create.submitBtn")}
          </Button>
        </>
      }
    >
      {users.isLoading && <LoadingState rows={2} />}
      {users.error && <ErrorState error={users.error} onRetry={() => users.refetch()} />}
      {!users.isLoading && !users.error && (
        <label className="block">
          <span className="text-xs font-bold text-slate-600">
            {t("people.custody.create.holderLabel")} <span className="text-rose-600">*</span>
          </span>
          <Select className="mt-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t("people.custody.create.pickHolder")}</option>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.jobTitle ? ` (${u.jobTitle})` : ""}
              </option>
            ))}
          </Select>
          {!active.length && (
            <p className="mt-2 text-xs font-medium text-slate-500">
              {t("people.custody.create.noActiveHolders")}{" "}
              <Link
                to="/people/custody-officers"
                onClick={onClose}
                className="font-bold text-teal-700 underline underline-offset-2 hover:text-teal-800"
              >
                {t("people.custody.create.addFromOfficers")}
              </Link>
              .
            </p>
          )}
        </label>
      )}
    </Dialog>
  );
}
