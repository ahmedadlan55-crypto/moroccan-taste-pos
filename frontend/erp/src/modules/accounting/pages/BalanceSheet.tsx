import type { ReactNode } from "react";
import { DatePicker } from "@/shared/ui";
import { formatDate } from "@/shared/lib";
import { useBalanceSheet, todayISO, type BsFlatItem } from "../api";
import {
  Num,
  fmt,
  ReportHeader,
  FilterCard,
  FilterField,
  PrintArea,
  PrintBanner,
  ReportState,
  useAppliedFilter,
  printReport,
} from "../components";

function SubGroup({ title, items, total }: { title: string; items: BsFlatItem[]; total: number }) {
  if (items.length === 0) return null;
  return (
    <div className="border-b border-slate-100 last:border-0">
      <div className="flex items-center justify-between bg-slate-50/70 px-4 py-2 text-xs font-extrabold text-slate-600">
        <span>{title}</span>
        <span dir="ltr" className="tabular-nums">{fmt(total)}</span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {items.map((it) => (
            <tr key={it.id} className="border-b border-slate-50 last:border-0">
              <td className="px-4 py-1.5">
                <span className="font-semibold text-slate-700">{it.name}</span>{" "}
                <code className="text-[11px] text-slate-400">{it.code}</code>
              </td>
              <td className="px-4 py-1.5 text-left">
                <Num value={it.balance} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Side({ title, total, totalLabel, children }: { title: string; total: number; totalLabel: string; children: ReactNode }) {
  return (
    <div className="surface overflow-hidden">
      <div className="border-b border-slate-200 bg-teal-50/60 px-4 py-3 text-sm font-extrabold text-teal-800">
        {title}
      </div>
      {children}
      <div className="flex items-center justify-between border-t-2 border-slate-300 bg-slate-50 px-4 py-3">
        <span className="text-sm font-extrabold text-slate-900">{totalLabel}</span>
        <span dir="ltr" className="text-base font-extrabold tabular-nums text-slate-900">{fmt(total)}</span>
      </div>
    </div>
  );
}

export function BalanceSheetPage() {
  const filter = useAppliedFilter<{ asOf: string }>({ asOf: todayISO() });
  const query = useBalanceSheet(filter.applied.asOf);
  const data = query.data;
  const period = `كما في ${formatDate(filter.applied.asOf)}`;
  const rhs = data ? data.totalLiabilities + data.totEq : 0;

  return (
    <div>
      <ReportHeader
        title="قائمة المركز المالي"
        subtitle="الأصول = الالتزامات + حقوق الملكية، وفق معيار IAS 1 — كما في تاريخ محدّد."
        onPrint={printReport}
      />
      <FilterCard onRun={filter.run} running={query.isFetching}>
        <FilterField label="كما في تاريخ">
          <DatePicker value={filter.draft.asOf} onChange={(asOf) => filter.patch({ asOf })} />
        </FilterField>
      </FilterCard>

      <ReportState
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={
          !!data &&
          data.currentAssets.length === 0 &&
          data.nonCurrentAssets.length === 0 &&
          data.currentLiab.length === 0 &&
          data.nonCurrentLiab.length === 0 &&
          data.equityItems.length === 0
        }
        onRetry={() => query.refetch()}
      >
        {data && (
          <PrintArea>
            <div className="surface mb-5 p-4">
              <PrintBanner title="قائمة المركز المالي" period={period} />
              <div
                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${
                  data.isBalanced
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-700"
                }`}
              >
                {data.isBalanced
                  ? `متوازنة — إجمالي الأصول ${fmt(data.totalAssets)} = الالتزامات وحقوق الملكية ${fmt(rhs)}`
                  : `تنبيه: غير متوازنة — الأصول ${fmt(data.totalAssets)} مقابل ${fmt(rhs)}`}
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Side title="الأصول" total={data.totalAssets} totalLabel="إجمالي الأصول">
                <SubGroup title="الأصول المتداولة" items={data.currentAssets} total={data.totCA} />
                <SubGroup title="الأصول غير المتداولة" items={data.nonCurrentAssets} total={data.totNCA} />
              </Side>
              <Side title="الالتزامات وحقوق الملكية" total={rhs} totalLabel="إجمالي الالتزامات وحقوق الملكية">
                <SubGroup title="الالتزامات المتداولة" items={data.currentLiab} total={data.totCL} />
                <SubGroup title="الالتزامات غير المتداولة" items={data.nonCurrentLiab} total={data.totNCL} />
                <SubGroup title="حقوق الملكية" items={data.equityItems} total={data.totEq} />
              </Side>
            </div>
          </PrintArea>
        )}
      </ReportState>
    </div>
  );
}
