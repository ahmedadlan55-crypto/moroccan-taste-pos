// Supplier detail — read-only overview (balance, aging, statement) + an edit
// action that opens SupplierForm pre-filled. Self-contained via ?doc=<id>,
// matching the rest of the purchasing module's search-param protocol
// (modules/purchasing/index.tsx reads the same param to choose list vs detail).
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText, PackageCheck, Receipt, Wallet, Users, Pencil } from "lucide-react";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useSupplier, useSupplierStatement, useSupplierAging } from "@/modules/inventory/lib/hooks/useProcurement";
import { BackLink, DetailHeader, Section, KV } from "@/modules/purchasing/features/procurement/detail-shared";
import { SupplierForm } from "./SupplierForm";

function s(v: unknown, d = "—"): string { return v == null || v === "" ? d : String(v); }
function n(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function Th({ children, left }: { children: ReactNode; left?: boolean }) { return <th className={`px-3 py-2 text-[11px] font-extrabold uppercase text-slate-400 ${left ? "text-left" : "text-right"}`}>{children}</th>; }
function Td({ children, left, bold }: { children: ReactNode; left?: boolean; bold?: boolean }) { return <td className={`px-3 py-2.5 text-sm text-slate-700 ${left ? "text-left tabular-nums" : ""} ${bold ? "font-bold" : ""}`}>{children}</td>; }
function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full border-collapse"><thead className="bg-slate-50"><tr>{head}</tr></thead><tbody className="divide-y divide-slate-100">{children}</tbody></table></div>;
}

export function SupplierDetail() {
  const [sp] = useSearchParams();
  const id = sp.get("doc") ?? "";
  const { data, isLoading, isError, error, refetch } = useSupplier(id);
  const statement = useSupplierStatement(id, {});
  const aging = useSupplierAging(id);
  const [editing, setEditing] = useState(false);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const d = data as Record<string, unknown>;
  const rows = (statement.data?.data ?? []) as Array<{ date: string; type: string; ref: string; debit: number; credit: number; balance: number }>;
  const b = aging.data?.buckets ?? { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
  return (
    <div className="grid gap-6 print:gap-4">
      <BackLink to="/purchasing/suppliers" label="الموردون" />
      <DetailHeader
        eyebrow="مورد"
        title={s(d.name)}
        subtitle={s(d.vat_number, "")}
        status={Number(d.is_active) ? "" : "cancelled"}
        actions={<Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> تعديل</Button>}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="الرصيد المستحق" value={formatCurrency(n(d.apBalance))} icon={Wallet} tone="violet" />
        <MetricCard label="إجمالي الفواتير" value={formatCurrency(n(d.invoicedTotal))} icon={FileText} tone="teal" />
        <MetricCard label="المسدد" value={formatCurrency(n(d.paidTotal))} icon={PackageCheck} tone="blue" />
        <MetricCard label="متأخر 90+" value={formatCurrency(n(b.d90plus))} icon={Receipt} tone="rose" />
      </div>
      <Section icon={Users} title="البيانات الأساسية">
        <KV items={[
          { label: "الاسم (EN)", value: s(d.name_en) }, { label: "الرقم الضريبي", value: s(d.vat_number) },
          { label: "الهاتف", value: s(d.phone) }, { label: "البريد", value: s(d.email) },
          { label: "المدينة", value: s(d.city) }, { label: "الحي", value: s(d.district) },
          { label: "الشارع", value: s(d.street) }, { label: "رقم المبنى", value: s(d.building_number) },
          { label: "الرمز البريدي", value: s(d.postal_code) }, { label: "شروط الدفع", value: s(d.payment_terms) },
          { label: "أوامر", value: s((d.counts as Record<string, unknown>)?.orders) }, { label: "فواتير", value: s((d.counts as Record<string, unknown>)?.invoices) },
        ]} />
      </Section>
      <Section title="أعمار الذمم">
        <div className="grid grid-cols-5 gap-2 p-5 text-center">
          {[["جاري", b.current], ["1-30", b.d30], ["31-60", b.d60], ["61-90", b.d90], ["90+", b.d90plus]].map(([lbl, v]) => (
            <div key={lbl as string} className="rounded-xl border border-slate-100 bg-slate-50 py-3">
              <div className="text-[10px] font-bold text-slate-400">{lbl}</div>
              <div className="mt-1 text-sm font-extrabold tabular-nums text-slate-800">{formatCurrency(n(v))}</div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="كشف الحساب" subtitle={`الرصيد الختامي: ${formatCurrency(statement.data?.closingBalance ?? 0)}`}>
        {rows.length === 0 ? <div className="p-5"><EmptyState title="لا حركات" /></div> : (
          <Table head={<><Th>التاريخ</Th><Th>النوع</Th><Th>المرجع</Th><Th left>مدين</Th><Th left>دائن</Th><Th left>الرصيد</Th></>}>
            {rows.map((r, i) => (
              <tr key={i}><Td>{formatDate(r.date)}</Td><Td>{r.type === "invoice" ? "فاتورة" : "سداد"}</Td><Td>{r.ref}</Td>
                <Td left>{r.debit ? formatCurrency(r.debit) : "—"}</Td><Td left>{r.credit ? formatCurrency(r.credit) : "—"}</Td><Td left bold>{formatCurrency(r.balance)}</Td></tr>
            ))}
          </Table>
        )}
      </Section>
      {editing && <SupplierForm open onClose={() => setEditing(false)} supplierId={id} />}
    </div>
  );
}
