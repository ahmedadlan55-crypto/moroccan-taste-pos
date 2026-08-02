// ── AccountDetail — the account hero, lifecycle actions and recent ledger ────
// Rendered both as the desktop second pane on the list page and as the body of
// the routed /…/:id page. Every write action is a callback the caller turns
// into a NAVIGATION, so this component never owns a dialog.

import { useMemo, useState } from "react";
import { ArrowLeftRight, ExternalLink, Pencil, Plus, Power, Trash2 } from "lucide-react";
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
import { useLang, useT, type TFunction } from "@/i18n";
import {
  glTypeLabel,
  useAccountLedger,
  useDeleteGlAccount,
  useSetAccountActive,
  type GlAccount,
} from "../api";
import { MANAGE_CAP } from "./routes";
import {
  BalanceAmount,
  Money,
  accountName,
  buildChildrenMap,
  computeRollups,
  fmtMoney,
  isFolderAccount,
  isSystemRoot,
  normalSide,
} from "./coaModel";

function mapError(t: TFunction, raw: string | undefined): string {
  const s = raw ?? "";
  if (/has-children|children/i.test(s)) return t("accounting.coa.detail.errors.hasChildren");
  if (/has-(entries|movements|journals)|movement/i.test(s))
    return t("accounting.coa.detail.errors.hasMovements");
  if (/not-found/i.test(s)) return t("accounting.coa.detail.errors.notFound");
  if (/protected|reserved|system/i.test(s)) return t("accounting.coa.detail.errors.protected");
  return s || t("accounting.coa.detail.errors.generic");
}

export interface AccountDetailProps {
  account: GlAccount;
  accounts: GlAccount[];
  onEdit: (account: GlAccount) => void;
  onAddChild: (parent: GlAccount) => void;
  onMove?: (account: GlAccount) => void;
  /** Only the embedded (second-pane) variant offers "open the full page". */
  onOpenFull?: (account: GlAccount) => void;
  /** Where to go after a successful delete (the routed page navigates away). */
  onDeleted?: () => void;
}

export function AccountDetail({
  account,
  accounts,
  onEdit,
  onAddChild,
  onMove,
  onOpenFull,
  onDeleted,
}: AccountDetailProps) {
  const t = useT();
  const lang = useLang();
  const canManage = useCan(MANAGE_CAP);
  const { toast } = useToast();
  const setActive = useSetAccountActive();
  const del = useDeleteGlAccount();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const byParent = useMemo(() => buildChildrenMap(accounts), [accounts]);
  const hasChildren = (byParent.get(account.id) ?? []).length > 0;
  const folder = isFolderAccount(account, hasChildren);
  // Rollup at EVERY depth — the shared memoized walk, not a private one that
  // could drift from what the tree shows for the same account.
  const rollups = useMemo(() => computeRollups(accounts, byParent), [accounts, byParent]);
  const shown = folder ? (rollups.get(account.id) ?? account.balance) : Number(account.balance) || 0;

  const systemRoot = isSystemRoot(account, accounts);
  const canDelete =
    !account.isFolder && !hasChildren && account.movementCount === 0 && !systemRoot;
  const canMove = !systemRoot;

  const parent = account.parentId ? accounts.find((a) => a.id === account.parentId) : null;
  const dangling = !!account.parentId && !parent;

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
            toast({ tone: "error", title: mapError(t, res.error) });
            return;
          }
          toast({
            tone: "success",
            title: next ? t("accounting.coa.detail.activated") : t("accounting.coa.detail.deactivated"),
          });
        },
        onError: (e) =>
          toast({ tone: "error", title: mapError(t, e instanceof Error ? e.message : "") }),
      },
    );
  }

  function confirmDelete() {
    setDeleteError(null);
    del.mutate(account.id, {
      onSuccess: (res) => {
        if (res && res.success === false) {
          setDeleteError(mapError(t, res.error));
          return;
        }
        setConfirmOpen(false);
        toast({ tone: "success", title: t("accounting.coa.detail.deleted") });
        onDeleted?.();
      },
      onError: (e) => setDeleteError(mapError(t, e instanceof Error ? e.message : "")),
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
                className="rounded-lg bg-slate-100 px-2 py-0.5 font-mono text-xs font-extrabold tabular-nums text-slate-600"
              >
                {account.code}
              </code>
              <Badge tone="teal">{glTypeLabel(t, account.type)}</Badge>
              <Badge tone="neutral">
                {normalSide(account) === "debit"
                  ? t("accounting.coa.detail.natureDebit")
                  : t("accounting.coa.detail.natureCredit")}
              </Badge>
              {account.isContra && <Badge tone="purple">{t("accounting.coa.contra")}</Badge>}
              {folder && <Badge tone="info">{t("accounting.coa.folder")}</Badge>}
              {systemRoot && <Badge tone="warning">{t("accounting.coa.systemRoot")}</Badge>}
              {account.systemManaged && <Badge tone="warning">{t("accounting.coa.systemManaged")}</Badge>}
              {!account.isActive && <Badge tone="neutral">{t("accounting.common.suspended")}</Badge>}
            </div>
            <h2 className="truncate text-xl font-extrabold text-slate-900">
              {accountName(account, lang)}
            </h2>
            <p
              dir={lang === "en" ? "rtl" : "ltr"}
              className="mt-0.5 truncate text-sm font-medium text-slate-400"
            >
              {lang === "en" ? account.nameAr : account.nameEn}
            </p>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs font-bold text-slate-500">
              <div>
                <dt className="inline text-slate-400">{t("accounting.coa.form.parent")}: </dt>
                <dd className="inline">
                  {parent
                    ? `${parent.code} — ${accountName(parent, lang)}`
                    : dangling
                      ? t("accounting.coa.health.orphanShort")
                      : t("accounting.coa.form.root")}
                </dd>
              </div>
              <div>
                <dt className="inline text-slate-400">{t("accounting.coa.form.level")}: </dt>
                <dd className="inline tabular-nums">{account.level}</dd>
              </div>
              <div>
                <dt className="inline text-slate-400">{t("accounting.coa.col.section")}: </dt>
                <dd className="inline">
                  {account.reportSection || t("accounting.coa.filter.sectionNone")}
                </dd>
              </div>
            </dl>
          </div>
          <div className="text-end">
            <div className="text-[11px] font-bold text-slate-400">
              {folder ? t("accounting.coa.detail.rollupBalance") : t("accounting.coa.detail.balance")}
            </div>
            <BalanceAmount
              account={account}
              value={shown}
              debitLabel={t("accounting.coa.dr")}
              creditLabel={t("accounting.coa.cr")}
              strong
              className="text-2xl"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {onOpenFull && (
            <Button variant="secondary" onClick={() => onOpenFull(account)}>
              <ExternalLink className="h-4 w-4" /> {t("accounting.coa.detail.openFull")}
            </Button>
          )}
          {canManage && (
            <>
              <Button variant="secondary" onClick={() => onEdit(account)}>
                <Pencil className="h-4 w-4" /> {t("common.edit")}
              </Button>
              <Button variant="secondary" onClick={() => onAddChild(account)}>
                <Plus className="h-4 w-4" /> {t("accounting.coa.detail.addChild")}
              </Button>
              {onMove && canMove && (
                <Button variant="secondary" onClick={() => onMove(account)}>
                  <ArrowLeftRight className="h-4 w-4" /> {t("accounting.coa.move.action")}
                </Button>
              )}
              <Button variant="secondary" onClick={toggleActive} loading={setActive.isPending}>
                <Power className="h-4 w-4" />{" "}
                {account.isActive
                  ? t("accounting.coa.detail.deactivate")
                  : t("accounting.coa.detail.activate")}
              </Button>
              {canDelete && (
                <Button
                  variant="danger"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" /> {t("common.delete")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Recent movements */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CardHeader className="border-b-0">
          <CardTitle>{t("accounting.coa.detail.recentMovements")}</CardTitle>
          {!folder && lines.length > 0 && (
            <span className="text-xs font-bold text-slate-400">
              {t("accounting.coa.detail.movementsTotal", { count: account.movementCount })}
            </span>
          )}
        </CardHeader>
        <CardBody className="pt-0">
          {folder ? (
            <p className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-center text-sm font-medium text-slate-500">
              {t("accounting.coa.detail.folderNote")}
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
            <EmptyState
              title={t("accounting.coa.detail.noMovements")}
              body={t("accounting.coa.detail.noMovementsBody")}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-extrabold text-slate-500">
                    <th className="px-3 py-2 text-start">{t("accounting.common.date")}</th>
                    <th className="px-3 py-2 text-start">{t("accounting.common.journalNo")}</th>
                    <th className="px-3 py-2 text-start">{t("accounting.common.statement")}</th>
                    <th className="px-3 py-2 text-end">{t("accounting.common.debit")}</th>
                    <th className="px-3 py-2 text-end">{t("accounting.common.credit")}</th>
                    <th className="px-3 py-2 text-end">{t("accounting.common.balance")}</th>
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
                      <td className="px-3 py-1.5 text-end">
                        <span dir="ltr" className="font-semibold tabular-nums text-slate-700">
                          {l.debit ? fmtMoney(l.debit) : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-end">
                        <span dir="ltr" className="font-semibold tabular-nums text-slate-700">
                          {l.credit ? fmtMoney(l.credit) : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-end">
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
        title={t("accounting.coa.detail.deleteTitle")}
        description={t("accounting.coa.detail.deleteDesc", { name: accountName(account, lang) })}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={del.isPending}
        error={deleteError}
        onConfirm={confirmDelete}
        onClose={() => setConfirmOpen(false)}
      />
    </Card>
  );
}

export default AccountDetail;
