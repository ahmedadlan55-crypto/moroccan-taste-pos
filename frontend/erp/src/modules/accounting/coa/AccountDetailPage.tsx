// ── /accounting/chart-of-accounts/:id — the routed account page ─────────────
// A real URL: bookmarkable, linkable from the ledger, and it survives a hard
// refresh. On mobile this is where a tap in the tree lands.

import { useNavigate } from "react-router-dom";
import { ArrowRight, ListTree } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from "@/shared/ui";
import { useT, useLang } from "@/i18n";
import { COA_BASE } from "./routes";
import { AccountDetail } from "./AccountDetail";
import { useCoaData } from "./useCoaData";
import { accountName } from "./coaModel";

export function AccountDetailPage({ id }: { id: string }) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const data = useCoaData();
  const account = data.byId.get(id) ?? null;

  const back = (
    <Button variant="secondary" onClick={() => navigate(COA_BASE)}>
      <ArrowRight className="h-4 w-4 rtl:rotate-0 ltr:rotate-180" />
      {t("accounting.coa.backToChart")}
    </Button>
  );

  if (data.isLoading) return <LoadingState />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.refetch} />;

  if (!account) {
    return (
      <div>
        <PageHeader
          eyebrow={t("accounting.coa.title")}
          title={t("accounting.coa.detail.errors.notFound")}
          action={back}
        />
        <Card className="p-6">
          <EmptyState
            icon={<ListTree className="h-6 w-6" />}
            title={t("accounting.coa.detail.errors.notFound")}
            body={t("accounting.coa.detail.notFoundBody")}
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.coa.title")}
        title={accountName(account, lang)}
        subtitle={account.code}
        action={back}
      />
      <AccountDetail
        account={account}
        accounts={data.accounts}
        onEdit={(a) => navigate(`${COA_BASE}/${encodeURIComponent(a.id)}/edit`)}
        onMove={(a) => navigate(`${COA_BASE}/${encodeURIComponent(a.id)}/move`)}
        onAddChild={(a) => navigate(`${COA_BASE}/new?parent=${encodeURIComponent(a.id)}`)}
        onDeleted={() => navigate(COA_BASE, { replace: true })}
      />
    </div>
  );
}

export default AccountDetailPage;
