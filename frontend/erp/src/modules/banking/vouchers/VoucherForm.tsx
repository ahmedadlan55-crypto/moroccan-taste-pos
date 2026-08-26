// ── VoucherForm — create a cash receipt (سند قبض) or payment (سند صرف) ────────
// A single xl Dialog, driven by a `kind` prop (opened from the matching
// register). Captures date, amount, the cash/bank channel, an optional party,
// header dimensions, and an OPTIONAL hand-picked GL journal ("قيد يدوي") that
// must balance to the amount. Submits a DRAFT to /cash/{receipts|payments};
// "حفظ واعتماد" chains the existing approve endpoint to post it immediately.

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Button,
  CurrencyInput,
  DatePicker,
  Dialog,
  IconButton,
  Input,
  LoadingState,
  SearchableEntityCombobox,
  SegmentedControl,
  Select,
  Toggle,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useT, translateApiError } from "@/i18n";
import { useCan } from "@/app/providers";
import {
  customerFetcher,
  makeCoaFetcher,
  supplierFetcher,
  todayISO,
  useApprovePayment,
  useApproveReceipt,
  useBankAccounts,
  useBranchDims,
  useBrandDims,
  useCashBoxes,
  useCoaAccounts,
  useCostCenterDims,
  useCreatePayment,
  useCreateReceipt,
  type CoaAccount,
  type ManualGlLine,
  type PartyHit,
  type PaymentInput,
  type ReceiptInput,
} from "../api";
import { fmt } from "../components";

const CREATE_CAP = "banking.vouchers.create" as const;
const APPROVE_CAP = "banking.vouchers.approve" as const;

export type VoucherKind = "receipt" | "payment";

const PARTY_TYPES: Record<VoucherKind, { value: string; labelKey: string }[]> = {
  receipt: [
    { value: "customer", labelKey: "banking.voucherForm.party.customer" },
    { value: "employee", labelKey: "banking.voucherForm.party.employee" },
    { value: "rent", labelKey: "banking.voucherForm.party.rent" },
    { value: "sales", labelKey: "banking.voucherForm.party.sales" },
    { value: "other", labelKey: "banking.voucherForm.party.other" },
  ],
  payment: [
    { value: "supplier", labelKey: "banking.voucherForm.party.supplier" },
    { value: "employee", labelKey: "banking.voucherForm.party.employee" },
    { value: "expense", labelKey: "banking.voucherForm.party.expense" },
    { value: "other", labelKey: "banking.voucherForm.party.other" },
  ],
};

// One editable manual-GL row (local, richer than the wire ManualGlLine).
interface ManualRow {
  key: string;
  account: CoaAccount | null;
  debit: number | null;
  credit: number | null;
  description: string;
}
let seq = 0;
function blankRow(): ManualRow {
  return { key: `m${++seq}`, account: null, debit: null, credit: null, description: "" };
}

export interface VoucherFormProps {
  kind: VoucherKind;
  open: boolean;
  onClose: () => void;
}

/** Keeps the Dialog mounted for its exit animation while resetting the body's
 *  state on every open (the body only mounts while `open`). */
export function VoucherForm({ kind, open, onClose }: VoucherFormProps) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={kind === "receipt" ? t("banking.voucherForm.receiptTitle") : t("banking.voucherForm.paymentTitle")}
      description={
        kind === "receipt"
          ? t("banking.voucherForm.receiptDesc")
          : t("banking.voucherForm.paymentDesc")
      }
    >
      {open && <VoucherFormBody kind={kind} onClose={onClose} />}
    </Dialog>
  );
}

function VoucherFormBody({ kind, onClose }: { kind: VoucherKind; onClose: () => void }) {
  const t = useT();
  const isReceipt = kind === "receipt";
  const { toast } = useToast();
  const canApprove = useCan(APPROVE_CAP);

  // ── form state ──
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(null);
  const [channel, setChannel] = useState<"cash" | "bank">("cash");
  const [channelId, setChannelId] = useState("");
  const [partyType, setPartyType] = useState(isReceipt ? "customer" : "supplier");
  const [party, setParty] = useState<PartyHit | null>(null);
  const [partyName, setPartyName] = useState("");
  const [expenseAccount, setExpenseAccount] = useState<CoaAccount | null>(null);
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [brandId, setBrandId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [manualOn, setManualOn] = useState(false);
  const [manualRows, setManualRows] = useState<ManualRow[]>(() => [blankRow(), blankRow()]);
  const [formError, setFormError] = useState<string | null>(null);

  // ── lookups ──
  const cashBoxes = useCashBoxes();
  const bankAccounts = useBankAccounts();
  const brands = useBrandDims();
  const branches = useBranchDims();
  const costCenters = useCostCenterDims();
  const needsCoa = manualOn || (!isReceipt && partyType === "expense");
  const coa = useCoaAccounts(needsCoa);
  const postable = useMemo(() => (coa.data ?? []).filter((a) => a.isLeaf), [coa.data]);
  const coaFetcher = useMemo(() => makeCoaFetcher(postable), [postable]);

  // ── mutations ──
  const createReceipt = useCreateReceipt();
  const createPayment = useCreatePayment();
  const approveReceipt = useApproveReceipt();
  const approvePayment = useApprovePayment();
  const busy =
    createReceipt.isPending ||
    createPayment.isPending ||
    approveReceipt.isPending ||
    approvePayment.isPending;

  const channelOptions = useMemo(() => {
    if (channel === "cash") {
      return (cashBoxes.data ?? [])
        .filter((b) => b.isActive)
        .map((b) => ({ value: b.id, label: b.code ? `${b.name} (${b.code})` : b.name }));
    }
    return (bankAccounts.data ?? []).map((b) => ({
      value: b.id,
      label: b.accountName ? `${b.bankName} — ${b.accountName}` : b.bankName,
    }));
  }, [channel, cashBoxes.data, bankAccounts.data]);

  // ── live manual-GL totals ──
  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const r of manualRows) {
      dr += Number(r.debit) || 0;
      cr += Number(r.credit) || 0;
    }
    const target = Number(amount) || 0;
    return {
      dr,
      cr,
      diff: dr - cr,
      balanced: Math.abs(dr - cr) < 0.01,
      matches: target > 0 && Math.abs(dr - target) < 0.01,
    };
  }, [manualRows, amount]);

  const partyTypes = PARTY_TYPES[kind];
  const showPartyPicker = isReceipt ? partyType === "customer" : partyType === "supplier";
  const showExpensePicker = !isReceipt && partyType === "expense";

  function selectChannel(next: "cash" | "bank") {
    setChannel(next);
    setChannelId("");
  }
  function selectPartyType(next: string) {
    setPartyType(next);
    setParty(null);
    setExpenseAccount(null);
  }
  function pickParty(hit: PartyHit | null) {
    setParty(hit);
    if (hit) setPartyName(hit.name);
  }

  // ── manual-GL row ops (debit/credit mutually exclusive, like a journal) ──
  function patchRow(key: string, patch: Partial<ManualRow>) {
    setManualRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function setRowDebit(key: string, n: number | null) {
    // Entering a debit clears the credit (standard journal behavior).
    patchRow(key, n && n > 0 ? { debit: n, credit: null } : { debit: n });
  }
  function setRowCredit(key: string, n: number | null) {
    patchRow(key, n && n > 0 ? { credit: n, debit: null } : { credit: n });
  }
  function addRow() {
    setManualRows((prev) => [...prev, blankRow()]);
  }
  function removeRow(key: string) {
    setManualRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  type ValidateResult = { manual?: ManualGlLine[]; error?: undefined } | { error: string };
  function validate(): ValidateResult {
    const amt = Number(amount) || 0;
    if (!amt || amt <= 0) return { error: t("banking.voucherForm.validation.amount") };
    if (!channelId)
      return {
        error: isReceipt
          ? t("banking.voucherForm.validation.channelReceipt")
          : t("banking.voucherForm.validation.channelPayment"),
      };
    if (showExpensePicker && !expenseAccount)
      return { error: t("banking.voucherForm.validation.expenseAccount") };
    if (!manualOn) return {};

    const filled = manualRows.filter((r) => r.account || r.debit || r.credit);
    if (filled.length < 2) return { error: t("banking.voucherForm.validation.manualMinRows") };
    for (const r of filled) {
      if (!r.account) return { error: t("banking.voucherForm.validation.manualRowAccount") };
      const d = Number(r.debit) || 0;
      const c = Number(r.credit) || 0;
      if (d > 0 && c > 0) return { error: t("banking.voucherForm.validation.manualDrCr") };
      if (d === 0 && c === 0) return { error: t("banking.voucherForm.validation.manualRowAmount") };
    }
    if (!totals.balanced) return { error: t("banking.voucherForm.validation.manualUnbalanced") };
    if (!totals.matches) return { error: t("banking.voucherForm.validation.manualMismatch") };

    const manual: ManualGlLine[] = filled.map((r) => ({
      accountId: r.account!.id,
      debit: Number(r.debit) || 0,
      credit: Number(r.credit) || 0,
      description: r.description.trim() || undefined,
    }));
    return { manual };
  }

  function buildPayload(manual?: ManualGlLine[]): ReceiptInput | PaymentInput {
    const name = (partyName.trim() || party?.name || "").trim();
    const common = {
      amount: Number(amount) || 0,
      reference: reference.trim() || undefined,
      description: description.trim() || undefined,
      brandId: brandId || null,
      branchId: branchId || null,
      costCenterId: costCenterId || null,
      manualGlLines: manual,
    };
    if (isReceipt) {
      return {
        receiptDate: date,
        destinationType: channel,
        destinationId: channelId,
        sourceType: partyType,
        sourceId: partyType === "customer" ? party?.id ?? null : null,
        sourceName: name || undefined,
        ...common,
      } satisfies ReceiptInput;
    }
    return {
      paymentDate: date,
      sourceType: channel,
      sourceId: channelId,
      recipientType: partyType,
      recipientId: partyType === "supplier" ? party?.id ?? null : null,
      recipientName: name || undefined,
      expenseAccountId: partyType === "expense" ? expenseAccount?.id ?? null : null,
      ...common,
    } satisfies PaymentInput;
  }

  async function submit(approveAfter: boolean) {
    const v = validate();
    if ("error" in v) {
      const msg = v.error ?? t("banking.voucherForm.validation.invalid");
      setFormError(msg);
      toast({ tone: "error", title: msg });
      return;
    }
    setFormError(null);
    const payload = buildPayload(v.manual);
    try {
      const res = isReceipt
        ? await createReceipt.mutateAsync(payload as ReceiptInput)
        : await createPayment.mutateAsync(payload as PaymentInput);
      if (res && res.success === false) {
        const msg = translateApiError(new Error(res.error), t);
        setFormError(msg);
        toast({ tone: "error", title: msg });
        return;
      }
      const id = res.id;
      if (approveAfter && id) {
        const ar = isReceipt
          ? await approveReceipt.mutateAsync(id)
          : await approvePayment.mutateAsync(id);
        if (ar && ar.success === false) {
          // Draft saved but posting failed — it stays in the register to approve there.
          toast({
            tone: "warning",
            title: t("banking.voucherForm.toast.savedDraftApproveFailed"),
            description: translateApiError(new Error(ar.error), t),
          });
          onClose();
          return;
        }
        toast({
          tone: "success",
          title: isReceipt
            ? t("banking.voucherForm.toast.receiptSavedApproved")
            : t("banking.voucherForm.toast.paymentSavedApproved"),
        });
      } else {
        toast({
          tone: "success",
          title: isReceipt
            ? t("banking.voucherForm.toast.receiptSavedDraft")
            : t("banking.voucherForm.toast.paymentSavedDraft"),
        });
      }
      onClose();
    } catch (e) {
      const msg = translateApiError(e, t);
      setFormError(msg);
      toast({ tone: "error", title: msg });
    }
  }

  const channelLabel = isReceipt ? t("banking.voucherForm.channelLabelReceipt") : t("banking.voucherForm.channelLabelPayment");
  const partyLabel = isReceipt ? t("banking.shared.source") : t("banking.shared.beneficiary");

  return (
    <div className="space-y-5">
      {/* Core fields */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("banking.shared.date")} required>
          <DatePicker value={date} onChange={setDate} />
        </Field>
        <Field label={t("banking.shared.amount")} required>
          <CurrencyInput
            value={amount}
            onChange={setAmount}
            invalid={!!formError && !(Number(amount) > 0)}
            aria-label={t("banking.shared.amount")}
          />
        </Field>

        {/* cash | bank channel + its account */}
        <Field label={channelLabel} required>
          <div className="space-y-2">
            <SegmentedControl<"cash" | "bank">
              aria-label={channelLabel}
              value={channel}
              onChange={selectChannel}
              options={[
                { value: "cash", label: t("banking.shared.cashLabel") },
                { value: "bank", label: t("banking.shared.bankLabel") },
              ]}
            />
            <Select
              value={channelId}
              invalid={!!formError && !channelId}
              onChange={(e) => setChannelId(e.target.value)}
              disabled={channel === "cash" ? cashBoxes.isLoading : bankAccounts.isLoading}
            >
              <option value="">
                {channel === "cash" ? t("banking.voucherForm.selectCashbox") : t("banking.voucherForm.selectBankAccount")}
              </option>
              {channelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        {/* party type + picker / free-text name */}
        <Field label={t("banking.voucherForm.partyTypeLabel", { party: partyLabel })}>
          <div className="space-y-2">
            <Select value={partyType} onChange={(e) => selectPartyType(e.target.value)}>
              {partyTypes.map((pt) => (
                <option key={pt.value} value={pt.value}>
                  {t(pt.labelKey)}
                </option>
              ))}
            </Select>
            {showPartyPicker && (
              <SearchableEntityCombobox<PartyHit>
                value={party}
                onChange={pickParty}
                fetcher={isReceipt ? customerFetcher : supplierFetcher}
                queryKey={["banking-party", kind, partyType]}
                getKey={(p) => p.id}
                getLabel={(p) => p.name}
                getSublabel={(p) => p.phone ?? undefined}
                placeholder={isReceipt ? t("banking.voucherForm.searchCustomer") : t("banking.voucherForm.searchSupplier")}
                ariaLabel={partyLabel}
              />
            )}
            {showExpensePicker &&
              (coa.isLoading ? (
                <p className="text-[11px] font-bold text-slate-400">{t("banking.voucherForm.loadingCoa")}</p>
              ) : (
                <SearchableEntityCombobox<CoaAccount>
                  value={expenseAccount}
                  onChange={setExpenseAccount}
                  fetcher={coaFetcher}
                  queryKey={["banking-expense-acc", postable.length]}
                  getKey={(a) => a.id}
                  getLabel={(a) => `${a.code} — ${a.nameAr}`}
                  placeholder={t("banking.voucherForm.searchExpenseAccount")}
                  ariaLabel={t("banking.voucherForm.expenseAccount")}
                />
              ))}
            <Input
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
              placeholder={t("banking.voucherForm.partyNamePlaceholder", { party: partyLabel })}
              aria-label={t("banking.voucherForm.partyNameAria", { party: partyLabel })}
            />
          </div>
        </Field>
      </div>

      {/* Reference + description */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("banking.voucherForm.reference")}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} dir="ltr" />
        </Field>
        <Field label={t("banking.voucherForm.statement")}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      {/* Optional dimensions */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("banking.voucherForm.brand")}>
          <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">{t("banking.shared.allOption")}</option>
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("banking.shared.branch")}>
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">{t("banking.shared.allOption")}</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("banking.voucherForm.costCenter")}>
          <Select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
            <option value="">{t("banking.voucherForm.noneOption")}</option>
            {(costCenters.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Optional manual GL journal */}
      <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
        <label className="flex items-center gap-3">
          <Toggle checked={manualOn} onChange={setManualOn} />
          <span className="text-sm font-bold text-slate-700">{t("banking.voucherForm.manualToggle")}</span>
          <span className="text-[11px] font-medium text-slate-400">
            {t("banking.voucherForm.manualHint")}
          </span>
        </label>

        {manualOn && (
          <div className="mt-4">
            {coa.isLoading ? (
              <LoadingState rows={1} />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-[11px] font-extrabold text-slate-500">
                        <th className="px-2 py-2 text-start">{t("banking.voucherForm.manual.account")}</th>
                        <th className="px-2 py-2 text-end">{t("banking.voucherForm.manual.debit")}</th>
                        <th className="px-2 py-2 text-end">{t("banking.voucherForm.manual.credit")}</th>
                        <th className="px-2 py-2 text-start">{t("banking.voucherForm.statement")}</th>
                        <th className="px-2 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {manualRows.map((r) => (
                        <tr key={r.key} className="border-b border-slate-100 align-top last:border-0">
                          <td className="px-2 py-2 min-w-[15rem]">
                            <SearchableEntityCombobox<CoaAccount>
                              value={r.account}
                              onChange={(a) => patchRow(r.key, { account: a })}
                              fetcher={coaFetcher}
                              queryKey={["banking-manual-acc", postable.length]}
                              getKey={(a) => a.id}
                              getLabel={(a) => `${a.code} — ${a.nameAr}`}
                              placeholder={t("banking.voucherForm.searchAccount")}
                              ariaLabel={t("banking.voucherForm.manual.rowAccountAria")}
                            />
                          </td>
                          <td className="px-2 py-2 w-36">
                            <CurrencyInput
                              value={r.debit ?? null}
                              onChange={(n) => setRowDebit(r.key, n)}
                              aria-label={t("banking.voucherForm.manual.debit")}
                            />
                          </td>
                          <td className="px-2 py-2 w-36">
                            <CurrencyInput
                              value={r.credit ?? null}
                              onChange={(n) => setRowCredit(r.key, n)}
                              aria-label={t("banking.voucherForm.manual.credit")}
                            />
                          </td>
                          <td className="px-2 py-2 min-w-[10rem]">
                            <Input
                              value={r.description}
                              onChange={(e) => patchRow(r.key, { description: e.target.value })}
                              placeholder={t("banking.voucherForm.manual.rowStatement")}
                              aria-label={t("banking.voucherForm.manual.rowStatement")}
                            />
                          </td>
                          <td className="px-2 py-2 w-10 text-end">
                            <IconButton
                              aria-label={t("banking.voucherForm.manual.removeRow")}
                              size="sm"
                              onClick={() => removeRow(r.key)}
                            >
                              <Trash2 className="h-4 w-4 text-rose-600" />
                            </IconButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-200 bg-white text-xs font-extrabold">
                        <td className="px-2 py-2.5 text-start">{t("banking.voucherForm.manual.total")}</td>
                        <td className="px-2 py-2.5 text-end">
                          <span dir="ltr" className="tabular-nums text-slate-800">
                            {fmt(totals.dr)}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-end">
                          <span dir="ltr" className="tabular-nums text-slate-800">
                            {fmt(totals.cr)}
                          </span>
                        </td>
                        <td className="px-2 py-2.5" colSpan={2}>
                          {totals.balanced && totals.matches ? (
                            <span className="font-extrabold text-emerald-600">
                              {t("banking.voucherForm.manual.balancedMatches")}
                            </span>
                          ) : !totals.balanced ? (
                            <span className="font-extrabold text-rose-600">
                              {t("banking.voucherForm.manual.unbalancedDiff")}{" "}
                              <span dir="ltr" className="tabular-nums">
                                {fmt(totals.diff)}
                              </span>
                            </span>
                          ) : (
                            <span className="font-extrabold text-amber-600">
                              {t("banking.voucherForm.manual.totalMismatch")}
                            </span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="mt-3">
                  <Button variant="secondary" size="sm" onClick={addRow}>
                    <Plus className="h-4 w-4" /> {t("banking.voucherForm.manual.addRow")}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {formError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">
          {formError}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button variant="secondary" onClick={() => submit(false)} loading={busy}>
          {t("banking.voucherForm.saveDraft")}
        </Button>
        {canApprove && (
          <Button variant="primary" onClick={() => submit(true)} loading={busy}>
            {t("banking.voucherForm.saveApprove")}
          </Button>
        )}
      </div>
    </div>
  );
}

export default VoucherForm;

// Re-export the capability so the register can gate the trigger with the exact
// same constant the form enforces.
export { CREATE_CAP as VOUCHER_CREATE_CAP };
