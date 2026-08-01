// Supplier detail — read-only overview (balance, aging, statement) + an edit
// action that opens SupplierForm pre-filled. Self-contained via ?doc=<id>,
// matching the rest of the purchasing module's search-param protocol
// (modules/purchasing/index.tsx reads the same param to choose list vs detail).
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText, PackageCheck, Receipt, Wallet, Users, Pencil } from "lucide-react";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { Button, PrintDocument } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
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
  const t = useT();
  const lang = useLang();
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
  const displayName = lang === "en" && d.name_en ? String(d.name_en) : s(d.name);
  return (
    <PrintDocument className="grid gap-6 print:gap-4" title={displayName}>
      <BackLink to="/purchasing/suppliers" label={t("purchasing.tabs.suppliers")} />
      <DetailHeader
        eyebrow={t("purchasing.suppliers.detail.eyebrow")}
        title={displayName}
        subtitle={s(d.vat_number, "")}
        status={Number(d.is_active) ? "" : "cancelled"}
        actions={<Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /> {t("common.edit")}</Button>}
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label={t("purchasing.suppliers.field.apBalance")} value={formatCurrency(n(d.apBalance))} icon={Wallet} tone="violet" />
        <MetricCard label={t("purchasing.suppliers.detail.invoicedTotal")} value={formatCurrency(n(d.invoicedTotal))} icon={FileText} tone="teal" />
        <MetricCard label={t("purchasing.suppliers.detail.paidTotal")} value={formatCurrency(n(d.paidTotal))} icon={PackageCheck} tone="blue" />
        <MetricCard label={t("purchasing.suppliers.detail.overdue90")} value={formatCurrency(n(b.d90plus))} icon={Receipt} tone="rose" />
      </div>
      <Section icon={Users} title={t("purchasing.suppliers.detail.basicInfo")}>
        <KV items={[
          { label: t("purchasing.suppliers.detail.nameEn"), value: s(d.name_en) }, { label: t("purchasing.suppliers.field.vatNumber"), value: s(d.vat_number) },
          { label: t("purchasing.suppliers.field.phone"), value: s(d.phone) }, { label: t("purchasing.suppliers.detail.email"), value: s(d.email) },
          { label: t("purchasing.suppliers.field.city"), value: s(d.city) }, { label: t("purchasing.suppliers.field.district"), value: s(d.district) },
          { label: t("purchasing.suppliers.field.street"), value: s(d.street) }, { label: t("purchasing.suppliers.field.buildingNumber"), value: s(d.building_number) },
          { label: t("purchasing.suppliers.field.postalCode"), value: s(d.postal_code) }, { label: t("purchasing.suppliers.field.paymentTerms"), value: s(d.payment_terms) },
          { label: t("purchasing.suppliers.detail.ordersCount"), value: s((d.counts as Record<string, unknown>)?.orders) }, { label: t("purchasing.suppliers.detail.invoicesCount"), value: s((d.counts as Record<string, unknown>)?.invoices) },
        ]} />
      </Section>
      <Section title={t("purchasing.suppliers.detail.aging")}>
        <div className="grid grid-cols-5 gap-2 p-5 text-center">
          {[[t("purchasing.suppliers.detail.agingCurrent"), b.current], ["1-30", b.d30], ["31-60", b.d60], ["61-90", b.d90], ["90+", b.d90plus]].map(([lbl, v]) => (
            <div key={lbl as string} className="rounded-xl border border-slate-100 bg-slate-50 py-3">
              <div className="text-[10px] font-bold text-slate-400">{lbl}</div>
              <div className="mt-1 text-sm font-extrabold tabular-nums text-slate-800">{formatCurrency(n(v))}</div>
            </div>
          ))}
        </div>
      </Section>
      <Section title={t("purchasing.suppliers.detail.statement")} subtitle={`${t("purchasing.suppliers.detail.closingBalance")}: ${formatCurrency(statement.data?.closingBalance ?? 0)}`}>
        {rows.length === 0 ? <div className="p-5"><EmptyState title={t("purchasing.suppliers.detail.noTransactions")} /></div> : (
          <Table head={<><Th>{t("purchasing.col.date")}</Th><Th>{t("purchasing.suppliers.detail.type")}</Th><Th>{t("purchasing.suppliers.detail.reference")}</Th><Th left>{t("purchasing.detail.debit")}</Th><Th left>{t("purchasing.detail.credit")}</Th><Th left>{t("purchasing.suppliers.detail.balance")}</Th></>}>
            {rows.map((r, i) => (
              <tr key={i}><Td>{formatDate(r.date)}</Td><Td>{r.type === "invoice" ? t("purchasing.suppliers.detail.typeInvoice") : t("purchasing.suppliers.detail.typePayment")}</Td><Td>{r.ref}</Td>
                <Td left>{r.debit ? formatCurrency(r.debit) : "—"}</Td><Td left>{r.credit ? formatCurrency(r.credit) : "—"}</Td><Td left bold>{formatCurrency(r.balance)}</Td></tr>
            ))}
          </Table>
        )}
      </Section>
      {editing && <SupplierForm open onClose={() => setEditing(false)} supplierId={id} />}
    </PrintDocument>
  );
}
