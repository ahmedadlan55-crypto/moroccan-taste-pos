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
import { fmt, mapError } from "../components";

const CREATE_CAP = "banking.vouchers.create" as const;
const APPROVE_CAP = "banking.vouchers.approve" as const;

export type VoucherKind = "receipt" | "payment";

const PARTY_TYPES: Record<VoucherKind, { value: string; label: string }[]> = {
  receipt: [
    { value: "customer", label: "عميل" },
    { value: "employee", label: "موظف" },
    { value: "rent", label: "إيجار" },
    { value: "sales", label: "مبيعات" },
    { value: "other", label: "أخرى" },
  ],
  payment: [
    { value: "supplier", label: "مورد" },
    { value: "employee", label: "موظف" },
    { value: "expense", label: "مصروف" },
    { value: "other", label: "أخرى" },
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
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={kind === "receipt" ? "سند قبض جديد" : "سند صرف جديد"}
      description={
        kind === "receipt"
          ? "يُحفظ كمسودة ثم يُعتمد لترحيل قيده المحاسبي وإضافة المبلغ للخزينة/البنك."
          : "يُحفظ كمسودة ثم يُعتمد لترحيل قيده المحاسبي وخصم المبلغ من الخزينة/البنك."
      }
    >
      {open && <VoucherFormBody kind={kind} onClose={onClose} />}
    </Dialog>
  );
}

function VoucherFormBody({ kind, onClose }: { kind: VoucherKind; onClose: () => void }) {
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
    if (!amt || amt <= 0) return { error: "أدخل مبلغاً صحيحاً أكبر من صفر." };
    if (!channelId)
      return {
        error: isReceipt
          ? "اختر الخزينة أو الحساب البنكي المستلِم."
          : "اختر الخزينة أو الحساب البنكي الدافع.",
      };
    if (showExpensePicker && !expenseAccount)
      return { error: "اختر حساب المصروف من شجرة الحسابات." };
    if (!manualOn) return {};

    const filled = manualRows.filter((r) => r.account || r.debit || r.credit);
    if (filled.length < 2) return { error: "القيد اليدوي يحتاج سطرين على الأقل." };
    for (const r of filled) {
      if (!r.account) return { error: "كل سطر في القيد اليدوي يحتاج حساباً." };
      const d = Number(r.debit) || 0;
      const c = Number(r.credit) || 0;
      if (d > 0 && c > 0) return { error: "لا يمكن أن يكون السطر مديناً ودائناً معاً." };
      if (d === 0 && c === 0) return { error: "كل سطر يحتاج مبلغاً مديناً أو دائناً." };
    }
    if (!totals.balanced) return { error: "القيد اليدوي غير متوازن — المدين لا يساوي الدائن." };
    if (!totals.matches) return { error: "إجمالي القيد اليدوي يجب أن يساوي مبلغ السند." };

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
      const msg = v.error ?? "بيانات غير صالحة";
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
        const msg = mapError(new Error(res.error));
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
            title: "حُفظ السند كمسودة، وتعذّر اعتماده",
            description: mapError(new Error(ar.error)),
          });
          onClose();
          return;
        }
        toast({
          tone: "success",
          title: isReceipt ? "تم حفظ سند القبض واعتماده" : "تم حفظ سند الصرف واعتماده",
        });
      } else {
        toast({
          tone: "success",
          title: isReceipt ? "تم حفظ سند القبض كمسودة" : "تم حفظ سند الصرف كمسودة",
        });
      }
      onClose();
    } catch (e) {
      const msg = mapError(e);
      setFormError(msg);
      toast({ tone: "error", title: msg });
    }
  }

  const channelLabel = isReceipt ? "الجهة المستلِمة" : "الجهة الدافعة";
  const partyLabel = isReceipt ? "المصدر" : "المستفيد";

  return (
    <div className="space-y-5">
      {/* Core fields */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="التاريخ" required>
          <DatePicker value={date} onChange={setDate} />
        </Field>
        <Field label="المبلغ" required>
          <CurrencyInput
            value={amount}
            onChange={setAmount}
            invalid={!!formError && !(Number(amount) > 0)}
            aria-label="المبلغ"
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
                { value: "cash", label: "صندوق" },
                { value: "bank", label: "بنك" },
              ]}
            />
            <Select
              value={channelId}
              invalid={!!formError && !channelId}
              onChange={(e) => setChannelId(e.target.value)}
              disabled={channel === "cash" ? cashBoxes.isLoading : bankAccounts.isLoading}
            >
              <option value="">
                {channel === "cash" ? "— اختر الخزينة —" : "— اختر الحساب البنكي —"}
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
        <Field label={`نوع ${partyLabel}`}>
          <div className="space-y-2">
            <Select value={partyType} onChange={(e) => selectPartyType(e.target.value)}>
              {partyTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
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
                placeholder={isReceipt ? "ابحث عن عميل…" : "ابحث عن مورد…"}
                ariaLabel={partyLabel}
              />
            )}
            {showExpensePicker &&
              (coa.isLoading ? (
                <p className="text-[11px] font-bold text-slate-400">جارٍ تحميل شجرة الحسابات…</p>
              ) : (
                <SearchableEntityCombobox<CoaAccount>
                  value={expenseAccount}
                  onChange={setExpenseAccount}
                  fetcher={coaFetcher}
                  queryKey={["banking-expense-acc", postable.length]}
                  getKey={(a) => a.id}
                  getLabel={(a) => `${a.code} — ${a.nameAr}`}
                  placeholder="ابحث عن حساب المصروف…"
                  ariaLabel="حساب المصروف"
                />
              ))}
            <Input
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
              placeholder={`اسم ${partyLabel} (اختياري)`}
              aria-label={`اسم ${partyLabel}`}
            />
          </div>
        </Field>
      </div>

      {/* Reference + description */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="المرجع">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} dir="ltr" />
        </Field>
        <Field label="البيان">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>

      {/* Optional dimensions */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="البراند">
          <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            <option value="">— الكل —</option>
            {(brands.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="الفرع">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">— الكل —</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="مركز التكلفة">
          <Select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
            <option value="">— بدون —</option>
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
          <span className="text-sm font-bold text-slate-700">قيد يدوي (اختياري)</span>
          <span className="text-[11px] font-medium text-slate-400">
            حدّد المدين/الدائن بنفسك بدل التوجيه التلقائي — يجب أن يوازن مبلغ السند.
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
                        <th className="px-2 py-2 text-right">الحساب</th>
                        <th className="px-2 py-2 text-left">مدين</th>
                        <th className="px-2 py-2 text-left">دائن</th>
                        <th className="px-2 py-2 text-right">البيان</th>
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
                              placeholder="ابحث عن حساب…"
                              ariaLabel="حساب السطر"
                            />
                          </td>
                          <td className="px-2 py-2 w-36">
                            <CurrencyInput
                              value={r.debit ?? null}
                              onChange={(n) => setRowDebit(r.key, n)}
                              aria-label="مدين"
                            />
                          </td>
                          <td className="px-2 py-2 w-36">
                            <CurrencyInput
                              value={r.credit ?? null}
                              onChange={(n) => setRowCredit(r.key, n)}
                              aria-label="دائن"
                            />
                          </td>
                          <td className="px-2 py-2 min-w-[10rem]">
                            <Input
                              value={r.description}
                              onChange={(e) => patchRow(r.key, { description: e.target.value })}
                              placeholder="بيان السطر"
                              aria-label="بيان السطر"
                            />
                          </td>
                          <td className="px-2 py-2 w-10 text-left">
                            <IconButton
                              aria-label="حذف السطر"
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
                        <td className="px-2 py-2.5 text-right">الإجمالي</td>
                        <td className="px-2 py-2.5 text-left">
                          <span dir="ltr" className="tabular-nums text-slate-800">
                            {fmt(totals.dr)}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-left">
                          <span dir="ltr" className="tabular-nums text-slate-800">
                            {fmt(totals.cr)}
                          </span>
                        </td>
                        <td className="px-2 py-2.5" colSpan={2}>
                          {totals.balanced && totals.matches ? (
                            <span className="font-extrabold text-emerald-600">
                              متوازن ويطابق مبلغ السند
                            </span>
                          ) : !totals.balanced ? (
                            <span className="font-extrabold text-rose-600">
                              غير متوازن — الفرق:{" "}
                              <span dir="ltr" className="tabular-nums">
                                {fmt(totals.diff)}
                              </span>
                            </span>
                          ) : (
                            <span className="font-extrabold text-amber-600">
                              الإجمالي لا يطابق مبلغ السند
                            </span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="mt-3">
                  <Button variant="secondary" size="sm" onClick={addRow}>
                    <Plus className="h-4 w-4" /> إضافة سطر
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
          إلغاء
        </Button>
        <Button variant="secondary" onClick={() => submit(false)} loading={busy}>
          حفظ كمسودة
        </Button>
        {canApprove && (
          <Button variant="primary" onClick={() => submit(true)} loading={busy}>
            حفظ واعتماد
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
