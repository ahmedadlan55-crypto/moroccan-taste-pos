// ── JournalLineRow — one editable line of a journal entry ────────────────────
// Account picker (server-searchable, postable leaf accounts only) + debit/credit
// (mutually exclusive) + description + line cost center + delete. Purely
// controlled: value in, onChange out. The editor owns the array + all totals.

import { Trash2 } from "lucide-react";
import {
  CurrencyInput,
  IconButton,
  Input,
  SearchableEntityCombobox,
  Select,
} from "@/shared/ui";
import { cn } from "@/shared/lib";
import {
  GL_TYPE_LABEL,
  searchPostableAccounts,
  type GlAccountType,
  type JournalLine,
  type PostableAccount,
} from "../api";
import { isPnl } from "./journalModel";

export interface CostCenterOption {
  id: string;
  label: string;
}

export interface JournalLineRowProps {
  value: JournalLine;
  onChange: (next: JournalLine) => void;
  onRemove: () => void;
  costCenters: CostCenterOption[];
  readOnly?: boolean;
}

export function JournalLineRow({
  value,
  onChange,
  onRemove,
  costCenters,
  readOnly = false,
}: JournalLineRowProps) {
  // Reconstruct the picker's current selection from the flat line fields.
  const account: PostableAccount | null = value.accountId
    ? {
        id: value.accountId,
        code: value.accountCode,
        name: value.accountName,
        type: value.accountType ?? "",
      }
    : null;

  const pnl = isPnl(value.accountType);
  const ccMissing = pnl && !value.costCenterId;

  function pickAccount(a: PostableAccount | null) {
    onChange({
      ...value,
      accountId: a?.id ?? null,
      accountCode: a?.code ?? "",
      accountName: a?.name ?? "",
      accountType: a?.type ?? "",
    });
  }

  function setDebit(n: number | null) {
    const debit = n ?? 0;
    // Entering a debit clears the credit (standard journal behavior).
    onChange({ ...value, debit, credit: debit > 0 ? 0 : value.credit });
  }

  function setCredit(n: number | null) {
    const credit = n ?? 0;
    onChange({ ...value, credit, debit: credit > 0 ? 0 : value.debit });
  }

  function setCostCenter(id: string) {
    const opt = costCenters.find((c) => c.id === id);
    onChange({ ...value, costCenterId: id || null, costCenterName: opt?.label ?? "" });
  }

  return (
    <tr className="border-b border-slate-100 align-top last:border-0">
      {/* Account picker */}
      <td className="px-2 py-2 min-w-[16rem]">
        {readOnly ? (
          <div className="py-2 text-sm">
            <span className="font-bold text-slate-800">{value.accountName || "—"}</span>
            {value.accountCode && (
              <code dir="ltr" className="mr-2 text-[11px] font-semibold text-slate-400 tabular-nums">
                {value.accountCode}
              </code>
            )}
          </div>
        ) : (
          <SearchableEntityCombobox<PostableAccount>
            value={account}
            onChange={pickAccount}
            fetcher={searchPostableAccounts}
            queryKey={["postable-accounts"]}
            getKey={(a) => a.id}
            getLabel={(a) => `${a.code} — ${a.name}`}
            getSublabel={(a) => GL_TYPE_LABEL[a.type as GlAccountType] ?? a.type}
            placeholder="ابحث عن حساب…"
            ariaLabel="حساب السطر"
            searchOnEmpty
          />
        )}
      </td>

      {/* Debit */}
      <td className="px-2 py-2 w-40">
        <CurrencyInput
          value={value.debit || null}
          onChange={setDebit}
          disabled={readOnly}
          aria-label="مدين"
        />
      </td>

      {/* Credit */}
      <td className="px-2 py-2 w-40">
        <CurrencyInput
          value={value.credit || null}
          onChange={setCredit}
          disabled={readOnly}
          aria-label="دائن"
        />
      </td>

      {/* Line description */}
      <td className="px-2 py-2 min-w-[12rem]">
        <Input
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          disabled={readOnly}
          placeholder="بيان السطر"
          aria-label="بيان السطر"
        />
      </td>

      {/* Line cost center — required-look for P&L accounts */}
      <td className="px-2 py-2 w-48">
        <Select
          value={value.costCenterId ?? ""}
          invalid={ccMissing}
          disabled={readOnly}
          onChange={(e) => setCostCenter(e.target.value)}
          aria-label="مركز التكلفة"
          className={cn(ccMissing && "border-rose-400")}
        >
          <option value="">{pnl ? "— مطلوب —" : "— بدون —"}</option>
          {costCenters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        {ccMissing && (
          <span className="mt-1 block text-[11px] font-bold text-rose-600">
            إلزامي لسطور الإيراد/المصروف
          </span>
        )}
      </td>

      {/* Delete */}
      <td className="px-2 py-2 w-12 text-left">
        {!readOnly && (
          <IconButton aria-label="حذف السطر" size="sm" onClick={onRemove}>
            <Trash2 className="h-4 w-4 text-rose-600" />
          </IconButton>
        )}
      </td>
    </tr>
  );
}

export default JournalLineRow;
