import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUploader, Button, Dialog, Input, Select, safeUserMessage, useToast } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { peopleApi } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { fileToInvoiceDataUrl, splitTopupAccounts, topupAccountOptions, topupRequiresAccount } from "../../lib/custody";
import type { Custody } from "../../lib/types";

// تغذية رصيد العهدة — port of the legacy admin openTopupModal/submitTopup
// (public/js/custody.js:176-266):
//   • GL accounts from the same endpoint the legacy bridge used
//     (GET /erp/gl/accounts) and the SAME cash/bank filter heuristics,
//   • method cash → صندوق picker (required), transfer → bank picker (required),
//     other → optional combined picker,
//   • optional receipt image/PDF stored base64 in custody_topups.receipt_image,
//   • POST /custody/:id/topup — the server posts the GL journal
//     (Dr عهدة الموظف / Cr الصندوق أو البنك) and takes the actor from the JWT.

type Method = "cash" | "transfer" | "other";

export function TopupDialog({ custody, onClose }: { custody: Custody | null; onClose: () => void }) {
  const t = useTx();
  const { toast } = useToast();
  const qc = useQueryClient();
  const open = !!custody;

  const METHOD_LABEL: Record<Method, string> = {
    cash: t("people.custody.topup.methodCash"),
    transfer: t("people.custody.topup.methodTransfer"),
    other: t("people.custody.topup.methodOther"),
  };
  const ACCOUNT_LABEL: Record<Method, string> = {
    cash: t("people.custody.topup.accountCash"),
    transfer: t("people.custody.topup.accountBank"),
    other: t("people.custody.topup.accountOther"),
  };

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("cash");
  const [glAccountId, setGlAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [receipt, setReceipt] = useState<{ name: string; dataUrl: string } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);

  const accounts = useQuery({
    queryKey: qk.glAccounts(),
    queryFn: ({ signal }) => peopleApi.listGlAccounts(signal),
    enabled: open,
  });
  const split = useMemo(() => splitTopupAccounts(accounts.data ?? []), [accounts.data]);
  const options = topupAccountOptions(split, method);

  const topup = useMutation({
    mutationFn: () =>
      peopleApi.topupCustody(custody!.id, {
        amount: Number(amount) || 0,
        paymentMethod: method,
        glAccountId: glAccountId || undefined,
        receiptImage: receipt?.dataUrl || undefined,
        notes,
      }),
    onSuccess: () => {
      toast({ title: t("people.custody.topup.done"), tone: "success" });
      reset();
      onClose();
      void qc.invalidateQueries({ queryKey: [...qk.all, "custody"] });
    },
    onError: (e) => toast({ title: t("people.custody.topup.failed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  function reset() {
    setAmount("");
    setMethod("cash");
    setGlAccountId("");
    setNotes("");
    setReceipt(null);
  }

  function close() {
    if (topup.isPending) return;
    reset();
    onClose();
  }

  function submit() {
    const amt = Number(amount) || 0;
    if (amt <= 0) return toast({ title: t("people.custody.topup.enterAmount"), tone: "error" });
    if (topupRequiresAccount(method) && !glAccountId) {
      return toast({ title: method === "cash" ? t("people.custody.topup.pickCashBox") : t("people.custody.topup.pickBankAccount"), tone: "error" });
    }
    topup.mutate();
  }

  async function onFiles(files: File[]) {
    const f = files[0];
    if (!f) return;
    setFileBusy(true);
    try {
      setReceipt({ name: f.name, dataUrl: await fileToInvoiceDataUrl(f) });
    } catch (e) {
      toast({ title: safeUserMessage(e), tone: "error" });
    } finally {
      setFileBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("people.custody.topup.title")}
      description={custody ? `${custody.custodyNumber} — ${custody.userName}` : undefined}
      dismissable={!topup.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={topup.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={topup.isPending} disabled={fileBusy} onClick={submit}>
            {t("people.custody.topup.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">
              {t("people.custody.topup.amount")} <span className="text-rose-600">*</span>
            </span>
            <Input
              className="mt-1"
              type="number"
              dir="ltr"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">{t("people.custody.topup.method")}</span>
            <Select
              className="mt-1"
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as Method);
                setGlAccountId(""); // the picker's option set changes with the method
              }}
            >
              {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">
            {ACCOUNT_LABEL[method]}
            {topupRequiresAccount(method) && <span className="text-rose-600"> *</span>}
          </span>
          <Select
            className="mt-1"
            value={glAccountId}
            disabled={accounts.isLoading}
            onChange={(e) => setGlAccountId(e.target.value)}
          >
            <option value="">{accounts.isLoading ? t("people.custody.topup.accountsLoading") : t("people.custody.topup.pickAccount")}</option>
            {options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.nameAr || ""}
              </option>
            ))}
          </Select>
        </label>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">{t("people.custody.topup.notes")}</span>
          <Input className="mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div>
          <span className="text-xs font-bold text-slate-600">{t("people.custody.topup.receipt")}</span>
          <div className="mt-1">
            <FileUploader accept="image/*,application/pdf" onFiles={(f) => void onFiles(f)} disabled={fileBusy} />
          </div>
          {receipt && <p className="mt-1 text-xs font-medium text-teal-700">{t("people.custody.topup.attached", { name: receipt.name })}</p>}
        </div>
      </div>
    </Dialog>
  );
}
