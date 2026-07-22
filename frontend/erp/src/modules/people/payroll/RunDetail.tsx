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
import { useTx } from "@/shared/ui/i18n";
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
  const t = useTx();
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
      onSuccess: () => toast({ title: status === "draft" ? t("people.payroll.detail.calcDone") : t("people.payroll.detail.recalcDone"), tone: "success" }),
      onError: (e) => toast({ title: t("people.payroll.detail.calcFailed"), description: safeUserMessage(e, t), tone: "error" }),
    });
  }

  function runApprove() {
    if (!run) return;
    setApproveError(null);
    approve.mutate(run.id, {
      onSuccess: (res) => {
        setConfirmApprove(false);
        if (res?.glWarning) {
          toast({ title: t("people.payroll.detail.approvedWithWarning"), description: res.glWarning, tone: "warning" });
        } else {
          toast({ title: t("people.payroll.detail.approvedDone"), tone: "success" });
        }
      },
      onError: (e) => setApproveError(safeUserMessage(e, t)),
    });
  }

  function runPay() {
    if (!run) return;
    setPayError(null);
    if (!bankAccountId) {
      setPayError(t("people.payroll.detail.pickBank"));
      return;
    }
    pay.mutate(
      { runId: run.id, bankAccountId },
      {
        onSuccess: () => {
          setPayOpen(false);
          setBankAccountId("");
          toast({ title: t("people.payroll.detail.paidDone"), tone: "success" });
        },
        onError: (e) => setPayError(safeUserMessage(e, t)),
      },
    );
  }

  async function runExport() {
    if (!run) return;
    setExporting(true);
    try {
      await downloadPayrollCsv(run);
    } catch (e) {
      toast({ title: t("people.payroll.detail.exportFailed"), description: safeUserMessage(e, t), tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  const columns: ColumnDef<PayrollItem>[] = [
    {
      id: "employee",
      header: t("people.field.employee"),
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
    { id: "basic", header: t("people.payroll.item.basic"), accessor: (r) => r.basicSalary, cell: (r) => money(r.basicSalary), numeric: true, sortable: true },
    {
      id: "allowances",
      header: t("people.payroll.item.allowances"),
      accessor: (r) => r.housingAllowance + r.transportAllowance + r.otherAllowance,
      cell: (r) => money(r.housingAllowance + r.transportAllowance + r.otherAllowance),
      numeric: true,
    },
    { id: "overtime", header: t("people.payroll.item.overtime"), accessor: (r) => r.overtimeAmount, cell: (r) => money(r.overtimeAmount), numeric: true },
    { id: "gross", header: t("people.payroll.item.gross"), accessor: (r) => r.grossSalary, cell: (r) => money(r.grossSalary), numeric: true, sortable: true },
    {
      id: "deductions",
      header: t("people.payroll.item.deductions"),
      accessor: (r) => r.totalDeductions,
      cell: (r) => <span className="text-rose-600">{money(r.totalDeductions)}</span>,
      numeric: true,
    },
    {
      id: "net",
      header: t("people.payroll.item.net"),
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
          <ArrowRight className="h-4 w-4" /> {t("common.back")}
        </Button>
        <div className="surface mt-4 p-8 text-center text-sm font-bold text-slate-500">
          {t("people.payroll.detail.notFound")}
        </div>
      </div>
    );
  }

  const meta = payrollStatusMeta(run.status, t);

  return (
    <div className="space-y-5">
      {/* Header + action bar */}
      <div className="flex flex-col gap-4">
        <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
          <ArrowRight className="h-4 w-4" /> {t("people.payroll.detail.back")}
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold tracking-tight text-slate-950">{periodLabel(run, t)}</h1>
              <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            </div>
            <p className="text-sm font-medium text-slate-500">{run.branchName || t("people.payroll.allBranches")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {showCalc && (
              <Button variant="secondary" onClick={runCalculate} loading={calculate.isPending}>
                {status === "draft" ? <Calculator className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
                {status === "draft" ? t("people.payroll.detail.calc") : t("people.payroll.detail.recalc")}
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
                <BadgeCheck className="h-4 w-4" /> {t("people.payroll.detail.approve")}
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
                <Banknote className="h-4 w-4" /> {t("people.payroll.detail.pay")}
              </Button>
            )}
            <Button variant="secondary" onClick={runExport} loading={exporting}>
              <Download className="h-4 w-4" /> {t("people.payroll.detail.exportCsv")}
            </Button>
          </div>
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <DetailStat label={t("people.payroll.totals.employeeCount")} value={<span className="tabular-nums">{run.employeeCount}</span>} />
          <DetailStat
            label={t("people.payroll.totals.totalGross")}
            value={
              <span dir="ltr" className="tabular-nums">
                {money(run.totalGross)}
              </span>
            }
          />
          <DetailStat
            label={t("people.payroll.totals.totalNet")}
            value={
              <span dir="ltr" className="tabular-nums text-emerald-700">
                {money(run.totalNet)}
              </span>
            }
          />
          <DetailStat label={t("common.status")} value={<StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>} />
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
        searchPlaceholder={t("people.payroll.detail.searchByEmployee")}
        emptyTitle={t("people.payroll.detail.itemsEmpty")}
        emptyBody={showCalc ? t("people.payroll.detail.itemsEmptyBodyManage") : t("people.payroll.detail.itemsEmptyBodyView")}
        rowActions={(r) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPayslipEmp({ id: r.employeeId, name: r.employeeName })}
          >
            <FileText className="h-4 w-4" /> {t("people.payroll.detail.payslipBtn")}
          </Button>
        )}
      />

      {/* Approve confirmation */}
      <ConfirmDialog
        open={confirmApprove}
        title={t("people.payroll.detail.confirmApproveTitle")}
        description={t("people.payroll.detail.confirmApproveDesc", { period: periodLabel(run, t) })}
        tone="primary"
        confirmLabel={t("people.payroll.detail.approve")}
        processing={approve.isPending}
        error={approveError}
        onConfirm={runApprove}
        onClose={() => setConfirmApprove(false)}
      />

      {/* Pay dialog */}
      <Dialog
        open={payOpen}
        onClose={() => !pay.isPending && setPayOpen(false)}
        title={t("people.payroll.detail.payTitle")}
        description={t("people.payroll.detail.payDesc", { period: periodLabel(run, t) })}
        size="md"
        dismissable={!pay.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPayOpen(false)} disabled={pay.isPending}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={runPay} loading={pay.isPending}>
              {t("people.payroll.detail.payConfirm")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-bold text-slate-600">
              {t("people.payroll.detail.bankAccount")} <span className="text-rose-600">*</span>
            </span>
            <Select
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              disabled={bankQuery.isLoading}
              className="mt-1"
            >
              <option value="" disabled>
                {bankQuery.isLoading ? t("people.payroll.detail.bankLoading") : t("people.payroll.detail.bankPick")}
              </option>
              {(bankQuery.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </Select>
          </label>
          {bankQuery.error && (
            <div className="text-xs font-bold text-rose-600">{t("people.payroll.detail.bankLoadFailed")}</div>
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
