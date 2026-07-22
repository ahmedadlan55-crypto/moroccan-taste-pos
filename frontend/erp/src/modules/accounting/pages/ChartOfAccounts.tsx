// ── Chart of Accounts (دليل الحسابات) ────────────────────────────────────────
// Two-pane screen: the account tree (left) + the selected account's detail
// (right). This page is the orchestrator — it owns selection, the type filter,
// the search text and the create/edit form state, and gates the "new account"
// action on `accounting.accounts.manage`. The route already gates on
// `accounting.view`.

import { useEffect, useMemo, useRef, useState } from "react";
import { ListTree, Plus } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "@/shared/ui";
import { useCan } from "@/app/providers";
import { useMediaQuery } from "@/shared/hooks";
import { useT } from "@/i18n";
import {
  useGlAccounts,
  type GlAccount,
  type GlAccountInput,
  type GlAccountType,
} from "../api";
import { CoaTree } from "../coa/CoaTree";
import { AccountDetail } from "../coa/AccountDetail";
import { AccountForm } from "../coa/AccountForm";

const MANAGE_CAP = "accounting.accounts.manage" as const;

type TypeFilter = GlAccountType | "all";

const NEW_ACCOUNT: GlAccountInput = {
  code: "",
  nameAr: "",
  nameEn: "",
  type: "asset",
  parentId: null,
  level: 1,
  isFolder: true,
  isActive: true,
};

export function ChartOfAccountsPage() {
  const t = useT();
  const canManage = useCan(MANAGE_CAP);
  const query = useGlAccounts();
  const accounts = useMemo(() => query.data ?? [], [query.data]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");
  const [formAccount, setFormAccount] = useState<GlAccountInput | null>(null);

  const detailRef = useRef<HTMLDivElement>(null);
  const isStacked = useMediaQuery("(max-width: 1023px)");

  const selected = useMemo(
    () => accounts.find((a) => a.id === selectedId) ?? null,
    [accounts, selectedId],
  );

  // Drop the selection if the account disappears (deleted / filtered away).
  useEffect(() => {
    if (selectedId && !accounts.some((a) => a.id === selectedId)) setSelectedId(null);
  }, [accounts, selectedId]);

  // On a stacked (mobile/tablet) layout, bring the detail into view on select.
  useEffect(() => {
    if (selectedId && isStacked) {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedId, isStacked]);

  function openNew() {
    setFormAccount({ ...NEW_ACCOUNT });
  }

  function openEdit(account: GlAccount) {
    setFormAccount({
      id: account.id,
      code: account.code,
      nameAr: account.nameAr,
      nameEn: account.nameEn,
      type: account.type,
      parentId: account.parentId,
      level: account.level,
      isFolder: account.isFolder,
      isActive: account.isActive,
    });
  }

  function openAddChild(parent: GlAccount) {
    setFormAccount({
      code: "",
      nameAr: "",
      nameEn: "",
      type: parent.type,
      parentId: parent.id,
      level: parent.level + 1,
      isFolder: false,
      isActive: true,
    });
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.eyebrow")}
        title={t("accounting.coa.title")}
        subtitle={t("accounting.coa.subtitle")}
        action={
          canManage ? (
            <Button variant="primary" onClick={openNew}>
              <Plus className="h-4 w-4" /> {t("accounting.coa.newAccount")}
            </Button>
          ) : undefined
        }
      />

      {query.isLoading ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(320px,420px)_1fr]">
          <CoaTree
            accounts={accounts}
            selectedId={selectedId}
            onSelect={setSelectedId}
            typeFilter={typeFilter}
            onTypeFilter={setTypeFilter}
            search={search}
            onSearch={setSearch}
          />

          <div ref={detailRef}>
            {selected ? (
              <AccountDetail
                account={selected}
                accounts={accounts}
                onEdit={openEdit}
                onAddChild={openAddChild}
              />
            ) : (
              <Card className="grid min-h-[24rem] place-items-center p-6">
                <EmptyState
                  icon={<ListTree className="h-6 w-6" />}
                  title={t("accounting.coa.selectAccount")}
                  body={t("accounting.coa.selectAccountBody")}
                />
              </Card>
            )}
          </div>
        </div>
      )}

      <AccountForm
        open={!!formAccount}
        account={formAccount}
        accounts={accounts}
        onClose={() => setFormAccount(null)}
        onSaved={() => query.refetch()}
      />
    </div>
  );
}

export default ChartOfAccountsPage;
