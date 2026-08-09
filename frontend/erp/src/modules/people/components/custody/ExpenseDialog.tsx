import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { FileUploader, Button, DatePicker, Dialog, Input, Select, safeUserMessage, useToast } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { peopleApi } from "../../lib/api";
import { qk } from "../../lib/query-keys";
import { fileToInvoiceDataUrl } from "../../lib/custody";
import type { CustodyExpenseInput } from "../../lib/types";

// تسجيل مصروف عهدة — port of the custodian portal's buildPayload/submitExpense
// (public/custody/app.js:399-497) and the admin openAddExpenseModal
// (public/js/custody.js:272-309). The body is the EXACT field set
// routes/custody.js POST /:id/expenses reads: expenseDate, description, amount,
// hasVat, vatRate, invoiceImage, notes, overrideBalance, glAccountId,
// glAccountName, costCenterId, costCenterName. The creator comes from the JWT.
//
// The over-balance flow is preserved: a { needsOverride } refusal opens the
// legacy confirmation ("طلب تجاوز الرصيد") and the resend carries
// overrideBalance:true → the expense lands as override_pending for the manager.
//
// Attachments: custody_expenses.invoice_image is a LONGTEXT base64 column (the
// same one both legacy apps wrote), so the receipt image/PDF upload is fully
// supported — images are downscaled to 1200px JPEG exactly like the portal.

export interface ExpenseAccountOpt {
  id: string;
  code: string;
  name: string;
}

export function ExpenseDialog({
  custodyId,
  expenseAccounts,
  open,
  onClose,
}: {
  custodyId: string | null;
  /** GL expense accounts for نوع المصروف (id/code/name). */
  expenseAccounts: ExpenseAccountOpt[];
  open: boolean;
  onClose: () => void;
}) {
  const t = useTx();
  const { toast } = useToast();
  const qc = useQueryClient();

  const today = new Date().toISOString().slice(0, 10);
  const [expenseDate, setExpenseDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [hasVat, setHasVat] = useState(false);
  const [vatRate, setVatRate] = useState("15");
  const [glAccountId, setGlAccountId] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [notes, setNotes] = useState("");
  const [invoice, setInvoice] = useState<{ name: string; dataUrl: string } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  // Over-balance confirmation state: server said needsOverride + its message.
  const [overridePrompt, setOverridePrompt] = useState<string | null>(null);

  const costCenters = useQuery({
    queryKey: qk.costCenters(),
    queryFn: ({ signal }) => peopleApi.listCostCenters(signal),
    enabled: open,
  });

  function buildPayload(override: boolean): CustodyExpenseInput | null {
    const desc = description.trim();
    const amt = Number(amount) || 0;
    if (!desc || amt <= 0) {
      toast({ title: t("people.custody.expense.required"), tone: "error" });
      return null;
    }
    const acc = expenseAccounts.find((a) => a.id === glAccountId);
    const cc = (costCenters.data ?? []).find((c) => c.id === costCenterId);
    return {
      expenseDate,
      description: desc,
      amount: amt,
      hasVat,
      vatRate: hasVat ? Number(vatRate) || 15 : 0,
      invoiceImage: invoice?.dataUrl || "",
      notes: notes.trim(),
      overrideBalance: override,
      glAccountId: acc?.id || "",
      glAccountName: acc?.name || "",
      costCenterId: cc?.id || "",
      costCenterName: cc?.name || "",
    };
  }

  const submit = useMutation({
    mutationFn: (payload: CustodyExpenseInput) => peopleApi.addCustodyExpense(custodyId as string, payload),
    onSuccess: (r) => {
      if (r && r.success) {
        toast({
          title:
            r.status === "override_pending"
              ? t("people.custody.expense.overrideSent")
              : t("people.custody.expense.sent"),
          tone: "success",
        });
        reset();
        onClose();
        void qc.invalidateQueries({ queryKey: [...qk.all, "custody"] });
        return;
      }
      if (r && r.needsOverride) {
        // Balance exceeded — the legacy override confirmation.
        setOverridePrompt(r.error || t("people.custody.expense.overBalance"));
        return;
      }
      toast({ title: (r && r.error) || t("people.custody.expense.saveFailed"), tone: "error" });
    },
    onError: (e) => toast({ title: t("people.custody.expense.sendFailed"), description: safeUserMessage(e, t), tone: "error" }),
  });

  function reset() {
    setExpenseDate(today);
    setAmount("");
    setDescription("");
    setHasVat(false);
    setVatRate("15");
    setGlAccountId("");
    setCostCenterId("");
    setNotes("");
    setInvoice(null);
    setOverridePrompt(null);
  }

  function close() {
    if (submit.isPending) return;
    reset();
    onClose();
  }

  function send(override: boolean) {
    const payload = buildPayload(override);
    if (!payload) return;
    setOverridePrompt(null);
    submit.mutate(payload);
  }

  async function onFiles(files: File[]) {
    const f = files[0];
    if (!f) return;
    setFileBusy(true);
    try {
      setInvoice({ name: f.name, dataUrl: await fileToInvoiceDataUrl(f) });
    } catch (e) {
      toast({ title: safeUserMessage(e), tone: "error" });
    } finally {
      setFileBusy(false);
    }
  }

  return (
    <Dialog
      open={open && !!custodyId}
      onClose={close}
      title={t("people.custody.expense.title")}
      description={t("people.custody.expense.desc")}
      size="lg"
      dismissable={!submit.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submit.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={submit.isPending} disabled={fileBusy} onClick={() => send(false)}>
            {t("people.custody.expense.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {overridePrompt && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="flex items-start gap-2 text-sm font-bold text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {overridePrompt}
            </p>
            <p className="mt-1 text-xs font-medium text-amber-700">
              {t("people.custody.expense.overridePromptQuestion")}
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="danger" size="sm" loading={submit.isPending} onClick={() => send(true)}>
                {t("people.custody.expense.overrideSend")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setOverridePrompt(null)} disabled={submit.isPending}>
                {t("people.custody.expense.overrideCancel")}
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">
              {t("people.custody.expense.date")} <span className="text-rose-600">*</span>
            </span>
            <DatePicker className="mt-1 block" value={expenseDate} onChange={setExpenseDate} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">
              {t("people.custody.expense.value")} <span className="text-rose-600">*</span>
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
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">
            {t("people.custody.expense.statement")} <span className="text-rose-600">*</span>
          </span>
          <Input
            className="mt-1"
            placeholder={t("people.custody.expense.statementPlaceholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">{t("people.custody.expense.glType")}</span>
            <Select className="mt-1" value={glAccountId} onChange={(e) => setGlAccountId(e.target.value)}>
              <option value="">{t("people.custody.expense.optional")}</option>
              {expenseAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.code}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600">{t("people.custody.expense.costCenter")}</span>
            <Select className="mt-1" value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
              <option value="">{t("people.custody.expense.optional")}</option>
              {(costCenters.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code ? `${c.code} — ` : ""}
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">{t("people.custody.expense.hasVat")}</span>
            <Select className="mt-1" value={hasVat ? "1" : "0"} onChange={(e) => setHasVat(e.target.value === "1")}>
              <option value="0">{t("common.no")}</option>
              <option value="1">{t("people.bool.yes")}</option>
            </Select>
          </label>
          {hasVat && (
            <label className="block">
              <span className="text-xs font-bold text-slate-600">{t("people.custody.expense.vatRate")}</span>
              <Input
                className="mt-1"
                type="number"
                dir="ltr"
                step="0.1"
                value={vatRate}
                onChange={(e) => setVatRate(e.target.value)}
              />
            </label>
          )}
        </div>

        <label className="block">
          <span className="text-xs font-bold text-slate-600">{t("people.custody.expense.notes")}</span>
          <Input className="mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div>
          <span className="text-xs font-bold text-slate-600">{t("people.custody.expense.invoice")}</span>
          <div className="mt-1">
            <FileUploader accept="image/*,application/pdf" onFiles={(f) => void onFiles(f)} disabled={fileBusy} />
          </div>
          {invoice && <p className="mt-1 text-xs font-medium text-teal-700">{t("people.custody.expense.attached", { name: invoice.name })}</p>}
        </div>
      </div>
    </Dialog>
  );
}
