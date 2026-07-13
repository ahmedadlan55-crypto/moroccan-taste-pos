import { useState } from "react";
import { Button, Dialog, Input, Select, safeUserMessage } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { monthName, useBranches, useCreatePayrollRun } from "./api";

interface CreateRunDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a run is created — receives the created run id when known. */
  onCreated: (runId: string | null) => void;
}

const now = new Date();

export function CreateRunDialog({ open, onClose, onCreated }: CreateRunDialogProps) {
  const create = useCreatePayrollRun();
  const branchesQuery = useBranches();
  const branches = branchesQuery.data ?? [];

  const [month, setMonth] = useState<number>(now.getMonth() + 1);
  const [year, setYear] = useState<number>(now.getFullYear());
  const [branchId, setBranchId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMonth(now.getMonth() + 1);
    setYear(now.getFullYear());
    setBranchId("");
    setError(null);
  }

  function close() {
    if (create.isPending) return;
    reset();
    onClose();
  }

  function submit() {
    setError(null);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      setError("أدخل سنة صحيحة.");
      return;
    }
    create.mutate(
      { month, year, branchId: branchId || null },
      {
        onSuccess: (res) => {
          reset();
          onCreated(res?.id ? String(res.id) : null);
        },
        onError: (e) => setError(safeUserMessage(e)),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="مسير رواتب جديد"
      description="أنشئ مسير رواتب لشهرٍ وسنة. يمكنك بعد الإنشاء احتساب المستحقات."
      size="md"
      dismissable={!create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={create.isPending}>
            إلغاء
          </Button>
          <Button variant="primary" onClick={submit} loading={create.isPending}>
            إنشاء
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="الشهر" required>
            <Select value={String(month)} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="السنة" required>
            <Input
              type="number"
              inputMode="numeric"
              min={2000}
              max={2100}
              value={year}
              dir="ltr"
              className="tabular-nums"
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </Field>
        </div>

        <Field label="الفرع" hint="اترك الحقل فارغًا لإنشاء مسير لكل الفروع.">
          <Select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            disabled={branchesQuery.isLoading || branches.length === 0}
          >
            <option value="">كل الفروع</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
