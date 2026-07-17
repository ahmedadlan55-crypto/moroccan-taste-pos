import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, ErrorState, LoadingState, Select, safeUserMessage, useToast } from "@/shared/ui";
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
        title: "تم إنشاء العهدة: " + (r.custodyNumber || ""),
        description: "لتفعيلها بمبلغ افتتاحي استخدم «تغذية» من قائمة العهدة.",
        tone: "success",
      });
      setUserId("");
      onClose();
      void qc.invalidateQueries({ queryKey: [...qk.all, "custody"] });
    },
    onError: (e) => toast({ title: "تعذّر إنشاء العهدة", description: safeUserMessage(e), tone: "error" }),
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
      title="إنشاء عهدة جديدة"
      description="اختر مسؤول العهدة — يُنشأ رقم العهدة تلقائيًا وتُموَّل لاحقًا عبر «تغذية»."
      dismissable={!create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={create.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!userId} onClick={() => create.mutate()}>
            إنشاء
          </Button>
        </>
      }
    >
      {users.isLoading && <LoadingState rows={2} />}
      {users.error && <ErrorState error={users.error} onRetry={() => users.refetch()} />}
      {!users.isLoading && !users.error && (
        <label className="block">
          <span className="text-xs font-bold text-slate-600">
            مسؤول العهدة <span className="text-rose-600">*</span>
          </span>
          <Select className="mt-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">— اختر مسؤول العهدة —</option>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
                {u.jobTitle ? ` (${u.jobTitle})` : ""}
              </option>
            ))}
          </Select>
          {!active.length && (
            <p className="mt-2 text-xs font-medium text-slate-500">
              لا يوجد مسؤولو عهدة نشطون — أضفهم أولًا من إدارة مسؤولي العهدة.
            </p>
          )}
        </label>
      )}
    </Dialog>
  );
}
