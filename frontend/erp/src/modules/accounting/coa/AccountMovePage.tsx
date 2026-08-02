// ── /accounting/chart-of-accounts/:id/move ──────────────────────────────────
// POST /erp/gl/accounts/:id/move has existed on the server for a long time and
// had NO user interface at all — reparenting an account was only possible via
// the Excel import round-trip. This is that endpoint, as a page.
//
// It is deliberately explicit about consequences, because this one is not
// reversible by a second click: with `autoRenumber` the server rewrites the
// moved account's code AND every descendant's code AND the denormalized
// gl_entries.account_code, all in one transaction.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeftRight } from "lucide-react";
import {
  Button,
  ErrorState,
  FullPageFlow,
  LoadingState,
  Select,
  Toggle,
  useToast,
} from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useCan } from "@/app/providers";
import { useLang, useT } from "@/i18n";
import { useMoveGlAccount } from "../api";
import { COA_BASE, MANAGE_CAP } from "./routes";
import { useCoaData } from "./useCoaData";
import { accountName, descendantIds, isSystemRoot } from "./coaModel";

export function AccountMovePage({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const canManage = useCan(MANAGE_CAP);
  const { toast } = useToast();
  const move = useMoveGlAccount();
  const data = useCoaData();

  const account = data.byId.get(id) ?? null;
  const [parentId, setParentId] = useState<string | null | undefined>(undefined);
  const [autoRenumber, setAutoRenumber] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Never offer self or a descendant: the server rejects that as a cycle, and
  // offering a choice that can only fail is not a choice.
  const options = useMemo(() => {
    if (!account) return [];
    const blocked = new Set<string>([account.id, ...descendantIds(account.id, data.byParent)]);
    return data.accounts
      .filter((a) => !blocked.has(a.id))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [account, data.accounts, data.byParent]);

  const close = () => navigate(`${COA_BASE}/${encodeURIComponent(id)}`);
  const currentParent = account?.parentId ? (data.byId.get(account.parentId) ?? null) : null;
  const target = parentId === undefined ? (account?.parentId ?? null) : parentId;
  const descendantCount = account ? descendantIds(account.id, data.byParent).size : 0;

  function submit() {
    if (!account) return;
    setError(null);
    move.mutate(
      { id: account.id, parentId: target, autoRenumber },
      {
        onSuccess: (res) => {
          if (res && res.success === false) {
            setError(res.error || t("accounting.coa.move.errors.generic"));
            return;
          }
          toast({
            tone: "success",
            title: t("accounting.coa.move.moved", {
              code: res?.newCode ?? account.code,
            }),
          });
          navigate(`${COA_BASE}/${encodeURIComponent(account.id)}`, { replace: true });
        },
        // This route answers HTTP 400 with { error } for a cycle, a code clash
        // or a root move — the message is already localized Arabic from the
        // server, so it is shown as-is rather than flattened into "failed".
        onError: (e) =>
          setError(e instanceof Error && e.message ? e.message : t("accounting.coa.move.errors.generic")),
      },
    );
  }

  const body = () => {
    if (data.isLoading) return <LoadingState />;
    if (data.error) return <ErrorState error={data.error} onRetry={data.refetch} />;
    if (!canManage) {
      return (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
          {t("accounting.coa.form.noPermission")}
        </p>
      );
    }
    if (!account) {
      return (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600">
          {t("accounting.coa.detail.errors.notFound")}
        </p>
      );
    }
    if (isSystemRoot(account, data.accounts)) {
      return (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
          {t("accounting.coa.move.rootBlocked")}
        </p>
      );
    }

    return (
      <div className="space-y-4">
        <dl className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-bold text-slate-400">{t("accounting.coa.move.account")}</dt>
            <dd className="font-extrabold text-slate-800">
              <span dir="ltr" className="font-mono tabular-nums">
                {account.code}
              </span>{" "}
              — {accountName(account, lang)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-slate-400">{t("accounting.coa.move.currentParent")}</dt>
            <dd className="font-bold text-slate-700">
              {currentParent
                ? `${currentParent.code} — ${accountName(currentParent, lang)}`
                : t("accounting.coa.form.root")}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-slate-400">{t("accounting.coa.move.subtreeSize")}</dt>
            <dd className="font-bold tabular-nums text-slate-700">{descendantCount}</dd>
          </div>
        </dl>

        <Field label={t("accounting.coa.move.newParent")} hint={t("accounting.coa.move.newParentHint")}>
          {({ id: fid }) => (
            <Select
              id={fid}
              value={target ?? ""}
              onChange={(e) => setParentId(e.target.value || null)}
            >
              <option value="">{t("accounting.coa.form.root")}</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {accountName(p, lang)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <label className="flex min-h-11 items-start gap-3">
          <Toggle
            checked={autoRenumber}
            onChange={setAutoRenumber}
            aria-label={t("accounting.coa.move.renumber")}
          />
          <span>
            <span className="block text-sm font-bold text-slate-700">
              {t("accounting.coa.move.renumber")}
            </span>
            <span className="block text-xs font-medium text-slate-500">
              {t("accounting.coa.move.renumberHint")}
            </span>
          </span>
        </label>

        {autoRenumber && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
            {t("accounting.coa.move.renumberWarning", { count: descendantCount })}
          </p>
        )}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}
      </div>
    );
  };

  const movable = !!account && canManage && !isSystemRoot(account, data.accounts);

  return (
    <FullPageFlow
      open
      onClose={close}
      icon={ArrowLeftRight}
      eyebrow={t("accounting.coa.title")}
      title={t("accounting.coa.move.title")}
      description={t("accounting.coa.move.description")}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={move.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} loading={move.isPending} disabled={!movable}>
            {t("accounting.coa.move.confirm")}
          </Button>
        </>
      }
    >
      {body()}
    </FullPageFlow>
  );
}

export default AccountMovePage;
