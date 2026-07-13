import { useState } from "react";
import { ArrowRight, BadgeCheck, Banknote, Calculator, Download, FileText, RefreshCw } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DetailStat,
  ErrorState,
  LoadingState,
  Select,
  StatusBadge,
  safeUserMessage,
  useToast,
} from "@/shared/ui";
import { useCan } from "@/app/providers";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { PayslipDrawer } from "./PayslipDrawer";
import {
  downloadPayrollCsv,
  money,
  payrollStatusMeta,
  periodLabel,
  useApprovePayroll,
  useBankAccounts,
  useCalculatePayroll,
  usePayPayroll,
  usePayrollItems,
  usePayrollRuns,
  type PayrollItem,
} from "./api";

interface RunDetailProps {
  runId: string;
  onBack: () => void;
}

export function RunDetail({ runId, onBack }: RunDetailProps) {
  const { toast } = useToast();
  const canManage = useCan("people.payroll.manage");
  const canApprove = useCan("people.payroll.approve");
  const canPay = useCan("people.payroll.pay");

  const runsQuery = usePayrollRuns();
  const run = (runsQuery.data ?? []).find((r) => r.id === runId) ?? null;

  const itemsQuery = usePayrollItems(runId);
  const bankQuery = useBankAccounts();

  const calculate = useCalculatePayroll();
  const approve = useApprovePayroll();
  const pay = usePayPayroll();

  const [confirmApprove, setConfirmApprove] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [bankAccountId, setBankAccountId] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [payslipEmp, setPayslipEmp] = useState<{ id: string; name: string } | null>(null);

  const status = run?.status ?? "draft";
  const showCalc = canManage && (status === "draft" || status === "calculated");
  const showApprove = canApprove && status === "calculated";
  const showPay = canPay && status === "approved";

  function runCalculate() {
    if (!run) return;
    calculate.mutate(run.id, {
      onSuccess: () => toast({ title: status === "draft" ? "تم احتساب المسير" : "تمت إعادة الاحتساب", tone: "success" }),
      onError: (e) => toast({ title: "تعذّر الاحتساب", description: safeUserMessage(e), tone: "error" }),
    });
  }

  function runApprove() {
    if (!run) return;
    setApproveError(null);
    approve.mutate(run.id, {
      onSuccess: (res) => {
        setConfirmApprove(false);
        if (res?.glWarning) {
          toast({ title: "تم الاعتماد مع تنبيه محاسبي", description: res.glWarning, tone: "warning" });
        } else {
          toast({ title: "تم اعتماد المسير وترحيله محاسبيًا", tone: "success" });
        }
      },
      onError: (e) => setApproveError(safeUserMessage(e)),
    });
  }

  function runPay() {
    if (!run) return;
    setPayError(null);
    if (!bankAccountId) {
      setPayError("اختر الحساب البنكي.");
      return;
    }
    pay.mutate(
      { runId: run.id, bankAccountId },
      {
        onSuccess: () => {
          setPayOpen(false);
          setBankAccountId("");
          toast({ title: "تم صرف الرواتب وترحيل قيد الدفع", tone: "success" });
        },
        onError: (e) => setPayError(safeUserMessage(e)),
      },
    );
  }

  async function runExport() {
    if (!run) return;
    setExporting(true);
    try {
      await downloadPayrollCsv(run);
    } catch (e) {
      toast({ title: "تعذّر تصدير الملف", description: safeUserMessage(e), tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  const columns: ColumnDef<PayrollItem>[] = [
    {
      id: "employee",
      header: "الموظف",
      accessor: (r) => r.employeeName,
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate font-bold text-slate-800">{r.employeeName || "—"}</div>
          {r.employeeNumber && (
            <div dir="ltr" className="text-[11px] font-semibold text-slate-400 tabular-nums">
              {r.employeeNumber}
            </div>
          )}
        </div>
      ),
      sortable: true,
    },
    { id: "basic", header: "الأساسي", accessor: (r) => r.basicSalary, cell: (r) => money(r.basicSalary), numeric: true, sortable: true },
    {
      id: "allowances",
      header: "البدلات",
      accessor: (r) => r.housingAllowance + r.transportAllowance + r.otherAllowance,
      cell: (r) => money(r.housingAllowance + r.transportAllowance + r.otherAllowance),
      numeric: true,
    },
    { id: "overtime", header: "الإضافي", accessor: (r) => r.overtimeAmount, cell: (r) => money(r.overtimeAmount), numeric: true },
    { id: "gross", header: "الإجمالي", accessor: (r) => r.grossSalary, cell: (r) => money(r.grossSalary), numeric: true, sortable: true },
    {
      id: "deductions",
      header: "الاستقطاعات",
      accessor: (r) => r.totalDeductions,
      cell: (r) => <span className="text-rose-600">{money(r.totalDeductions)}</span>,
      numeric: true,
    },
    {
      id: "net",
      header: "الصافي",
      accessor: (r) => r.netSalary,
      cell: (r) => <span className="font-extrabold text-emerald-700">{money(r.netSalary)}</span>,
      numeric: true,
      sortable: true,
    },
  ];

  // Run row not yet loaded (came in via a fresh id) — show a light loading shell.
  if (!run) {
    if (runsQuery.isLoading) return <LoadingState rows={4} />;
    if (runsQuery.error) return <ErrorState error={runsQuery.error} onRetry={() => runsQuery.refetch()} />;
    return (
      <div>
        <Button variant="secondary" onClick={onBack}>
          <ArrowRight className="h-4 w-4" /> رجوع
        </Button>
        <div className="surface mt-4 p-8 text-center text-sm font-bold text-slate-500">
          المسير غير موجود أو تم حذفه.
        </div>
      </div>
    );
  }

  const meta = payrollStatusMeta(run.status);

  return (
    <div className="space-y-5">
      {/* Header + action bar */}
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
          <ArrowRight className="h-4 w-4" /> رجوع للمسيّرات
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold tracking-tight text-slate-950">{periodLabel(run)}</h1>
              <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            </div>
            <p className="text-sm font-medium text-slate-500">{run.branchName || "كل الفروع"}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {showCalc && (
              <Button variant="secondary" onClick={runCalculate} loading={calculate.isPending}>
                {status === "draft" ? <Calculator className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
                {status === "draft" ? "حساب" : "إعادة احتساب"}
              </Button>
            )}
            {showApprove && (
              <Button
                variant="primary"
                onClick={() => {
                  setApproveError(null);
                  setConfirmApprove(true);
                }}
              >
                <BadgeCheck className="h-4 w-4" /> اعتماد
              </Button>
            )}
            {showPay && (
              <Button
                variant="primary"
                onClick={() => {
                  setPayError(null);
                  setBankAccountId("");
                  setPayOpen(true);
                }}
              >
                <Banknote className="h-4 w-4" /> صرف
              </Button>
            )}
            <Button variant="secondary" onClick={runExport} loading={exporting}>
              <Download className="h-4 w-4" /> تصدير CSV
            </Button>
          </div>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <DetailStat label="عدد الموظفين" value={<span className="tabular-nums">{run.employeeCount}</span>} />
          <DetailStat
            label="إجمالي المستحق"
            value={
              <span dir="ltr" className="tabular-nums">
                {money(run.totalGross)}
              </span>
            }
          />
          <DetailStat
            label="صافي المستحق"
            value={
              <span dir="ltr" className="tabular-nums text-emerald-700">
                {money(run.totalNet)}
              </span>
            }
          />
          <DetailStat label="الحالة" value={<StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>} />
        </div>
      </div>

      {/* Items */}
      <DataTable
        columns={columns}
        rows={itemsQuery.data ?? []}
        getRowId={(r) => r.id || r.employeeId}
        loading={itemsQuery.isLoading}
        error={itemsQuery.error}
        onRetry={() => itemsQuery.refetch()}
        tableId="people.payroll.items"
        searchable
        searchPlaceholder="بحث باسم الموظف…"
        emptyTitle="لا توجد بنود بعد"
        emptyBody={showCalc ? "اضغط «حساب» لاحتساب مستحقات الموظفين." : "لم تُحتسب مستحقات هذا المسير بعد."}
        rowActions={(r) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPayslipEmp({ id: r.employeeId, name: r.employeeName })}
          >
            <FileText className="h-4 w-4" /> قسيمة
          </Button>
        )}
      />

      {/* Approve confirmation */}
      <ConfirmDialog
        open={confirmApprove}
        title="اعتماد مسير الرواتب؟"
        description={`سيتم اعتماد مسير «${periodLabel(run)}» وترحيل قيود الاستحقاق محاسبيًا. لا يمكن التراجع بسهولة.`}
        tone="primary"
        confirmLabel="اعتماد"
        processing={approve.isPending}
        error={approveError}
        onConfirm={runApprove}
        onClose={() => setConfirmApprove(false)}
      />

      {/* Pay dialog */}
      <Dialog
        open={payOpen}
        onClose={() => !pay.isPending && setPayOpen(false)}
        title="صرف الرواتب"
        description={`اختر الحساب البنكي لصرف صافي رواتب «${periodLabel(run)}».`}
        size="md"
        dismissable={!pay.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPayOpen(false)} disabled={pay.isPending}>
              إلغاء
            </Button>
            <Button variant="primary" onClick={runPay} loading={pay.isPending}>
              تأكيد الصرف
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">
              الحساب البنكي <span className="text-rose-600">*</span>
            </span>
            <Select
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              disabled={bankQuery.isLoading}
              className="mt-1"
            >
              <option value="" disabled>
                {bankQuery.isLoading ? "جارٍ التحميل…" : "— اختر حسابًا —"}
              </option>
              {(bankQuery.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          </label>
          {bankQuery.error && (
            <div className="text-xs font-bold text-rose-600">تعذّر تحميل الحسابات البنكية.</div>
          )}
          {payError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
              {payError}
            </div>
          )}
        </div>
      </Dialog>

      {/* Payslip drawer */}
      <PayslipDrawer
        runId={payslipEmp ? runId : null}
        empId={payslipEmp?.id ?? null}
        employeeName={payslipEmp?.name}
        onClose={() => setPayslipEmp(null)}
      />
    </div>
  );
}
