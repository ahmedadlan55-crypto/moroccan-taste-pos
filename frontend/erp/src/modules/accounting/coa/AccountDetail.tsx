// ── AccountDetail — the right pane: account hero, lifecycle actions, ledger ───
// Shows the selected account with a rollup (folder) / own (leaf) balance, the
// write actions gated on `accounting.accounts.manage`, and the recent movements
// for leaf accounts.

import { useMemo, useState } from "react";
import { Pencil, Plus, Power, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  useToast,
} from "@/shared/ui";
import { useCan } from "@/app/providers";
import { formatDate } from "@/shared/lib";
import {
  GL_TYPE_LABEL,
  GL_TYPE_NATURE,
  useAccountLedger,
  useDeleteGlAccount,
  useSetAccountActive,
  type GlAccount,
} from "../api";
import {
  Money,
  ROOT_CODES,
  buildChildrenMap,
  fmtMoney,
  isFolderAccount,
} from "./coaModel";

const MANAGE_CAP = "accounting.accounts.manage" as const;

function mapError(raw: string | undefined): string {
  const s = raw ?? "";
  if (/has-children|children/i.test(s)) return "لا يمكن حذف حساب له حسابات فرعية.";
  if (/has-(entries|movements|journals)|movement/i.test(s))
    return "لا يمكن حذف حساب له حركات مسجّلة.";
  if (/not-found/i.test(s)) return "الحساب غير موجود.";
  if (/protected|reserved|system/i.test(s)) return "لا يمكن حذف حساب رئيسي في النظام.";
  return s || "تعذّرت العملية. أعد المحاولة.";
}

export interface AccountDetailProps {
  account: GlAccount;
  accounts: GlAccount[];
  onEdit: (account: GlAccount) => void;
  onAddChild: (parent: GlAccount) => void;
}

export function AccountDetail({ account, accounts, onEdit, onAddChild }: AccountDetailProps) {
  const canManage = useCan(MANAGE_CAP);
  const { toast } = useToast();
  const setActive = useSetAccountActive();
  const del = useDeleteGlAccount();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const byParent = useMemo(() => buildChildrenMap(accounts), [accounts]);
  const hasChildren = (byParent.get(account.id) ?? []).length > 0;
  const folder = isFolderAccount(account, hasChildren);
  const rollup = useMemo(() => {
    // Folder balance = self + all descendants; leaves show their own balance.
    if (!folder) return Number(account.balance) || 0;
    let sum = Number(account.balance) || 0;
    const walk = (id: string) => {
      for (const child of byParent.get(id) ?? []) {
        sum += Number(child.balance) || 0;
        walk(child.id);
      }
    };
    walk(account.id);
    return sum;
  }, [account, byParent, folder]);

  const nature = GL_TYPE_NATURE[account.type];
  const canDelete =
    !account.isFolder &&
    !hasChildren &&
    account.movementCount === 0 &&
    !ROOT_CODES.has(account.code);

  // Ledger is only meaningful for leaf accounts.
  const ledgerId = folder ? null : account.id;
  const ledger = useAccountLedger(ledgerId);
  const lines = ledger.data ?? [];

  function toggleActive() {
    const next = !account.isActive;
    setActive.mutate(
      { account, isActive: next },
      {
        onSuccess: (res) => {
          if (res && res.success === false) {
            toast({ tone: "error", title: mapError(res.error) });
            return;
          }
          toast({ tone: "success", title: next ? "تم تفعيل الحساب." : "تم تعطيل الحساب." });
        },
        onError: (e) => toast({ tone: "error", title: mapError(e instanceof Error ? e.message : "") }),
      },
    );
  }

  function confirmDelete() {
    setDeleteError(null);
    del.mutate(account.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(mapError(res.error));
          return;
        }
        setConfirmOpen(false);
        toast({ tone: "success", title: "تم حذف الحساب." });
      },
      onError: (e) => setDeleteError(mapError(e instanceof Error ? e.message : "")),
    });
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      {/* Hero */}
      <div className="border-b border-slate-100 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <code
                dir="ltr"
                className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-xs font-extrabold text-slate-600 tabular-nums"
              >
                {account.code}
              </code>
              <Badge tone="teal">{GL_TYPE_LABEL[account.type]}</Badge>
              <Badge tone="neutral">{nature === "debit" ? "طبيعته مدين" : "طبيعته دائن"}</Badge>
              {folder && <Badge tone="info">مجموعة</Badge>}
              {!account.isActive && <Badge tone="neutral">متوقّف</Badge>}
            </div>
            <h2 className="truncate text-xl font-extrabold text-slate-900">{account.nameAr}</h2>
            {account.nameEn && (
              <p dir="ltr" className="mt-0.5 truncate text-sm font-medium text-slate-400">
                {account.nameEn}
              </p>
            )}
          </div>
          <div className="text-left">
            <div className="text-[11px] font-bold text-slate-400">
              {folder ? "الرصيد الإجمالي" : "الرصيد"}
            </div>
            <Money value={rollup} strong className="text-2xl" />
          </div>
        </div>

        {canManage && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => onEdit(account)}>
              <Pencil className="h-4 w-4" /> تعديل
            </Button>
            <Button variant="secondary" onClick={() => onAddChild(account)}>
              <Plus className="h-4 w-4" /> إضافة حساب فرعي
            </Button>
            <Button variant="secondary" onClick={toggleActive} loading={setActive.isPending}>
              <Power className="h-4 w-4" /> {account.isActive ? "تعطيل" : "تفعيل"}
            </Button>
            {canDelete && (
              <Button
                variant="danger"
                onClick={() => {
                  setDeleteError(null);
                  setConfirmOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4" /> حذف
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Recent movements */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CardHeader className="border-b-0">
          <CardTitle>آخر الحركات</CardTitle>
          {!folder && lines.length > 0 && (
            <span className="text-xs font-bold text-slate-400">
              {account.movementCount} حركة إجمالاً
            </span>
          )}
        </CardHeader>
        <CardBody className="pt-0">
          {folder ? (
            <p className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-center text-sm font-medium text-slate-500">
              هذا حساب تجميعي (مجموعة). تُعرض الحركات على الحسابات النهائية فقط.
            </p>
          ) : ledger.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : ledger.error ? (
            <ErrorState error={ledger.error} />
          ) : lines.length === 0 ? (
            <EmptyState title="لا توجد حركات" body="لم تُسجّل أي حركات على هذا الحساب بعد." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
                    <th className="px-3 py-2 text-right">التاريخ</th>
                    <th className="px-3 py-2 text-right">القيد</th>
                    <th className="px-3 py-2 text-right">البيان</th>
                    <th className="px-3 py-2 text-left">مدين</th>
                    <th className="px-3 py-2 text-left">دائن</th>
                    <th className="px-3 py-2 text-left">الرصيد</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr
                      key={`${l.journalId}-${i}`}
                      className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70"
                    >
                      <td className="px-3 py-1.5 tabular-nums text-slate-600" dir="ltr">
                        {formatDate(l.journalDate)}
                      </td>
                      <td className="px-3 py-1.5">
                        <code dir="ltr" className="text-[11px] text-slate-400">
                          {l.journalNumber}
                        </code>
                      </td>
                      <td className="px-3 py-1.5 text-slate-700">
                        {l.entryDesc || l.journalDesc || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-left">
                        <span dir="ltr" className="tabular-nums font-semibold text-slate-700">
                          {l.debit ? fmtMoney(l.debit) : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-left">
                        <span dir="ltr" className="tabular-nums font-semibold text-slate-700">
                          {l.credit ? fmtMoney(l.credit) : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-left">
                        <Money value={l.balance} className="text-xs" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="حذف الحساب"
        description={`سيتم حذف «${account.nameAr}» نهائيًا. لا يمكن التراجع عن هذا الإجراء.`}
        tone="danger"
        confirmLabel="حذف"
        processing={del.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
        onClose={() => setConfirmOpen(false)}
      />
    </Card>
  );
}

export default AccountDetail;
