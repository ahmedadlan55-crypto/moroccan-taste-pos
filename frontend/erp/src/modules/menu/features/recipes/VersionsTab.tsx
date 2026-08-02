/**
 * Recipe detail · VERSIONS & AUDIT tab.
 *
 * Lists every version of the recipe with its lifecycle actions (activate /
 * clone / archive) and a real DIFF between any two versions via
 * GET /recipes/compare — not two tables side by side.
 *
 * Every lifecycle call carries `expectedVersion` (the version's own rowVersion),
 * so two people acting on the same version cannot both win: the second gets a
 * 409 the page surfaces as a reload affordance rather than silently re-applying.
 */
import { useState } from "react";
import { Archive, CheckCircle2, Copy } from "lucide-react";
import { Badge, Button, ConfirmDialog, Select } from "@/shared/ui";
import { DataTable, TableShell, Td, Th, Thead, Tr, type ColumnDef } from "@/shared/tables";
import { Field } from "@/shared/forms";
import { formatCurrency, formatDate, formatDateTime, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useCompare, type RecipeVersionRow } from "@/modules/menu/recipesApi";
import { statusLabel, statusTone } from "./labels";

export interface VersionsTabProps {
  versions: RecipeVersionRow[];
  canEdit: boolean;
  canViewCost: boolean;
  busy: boolean;
  onActivate: (v: RecipeVersionRow) => void;
  onClone: (v: RecipeVersionRow) => void;
  onArchive: (v: RecipeVersionRow) => void;
}

type PendingAction = { kind: "activate" | "archive"; version: RecipeVersionRow } | null;

export function VersionsTab({
  versions,
  canEdit,
  canViewCost,
  busy,
  onActivate,
  onClone,
  onArchive,
}: VersionsTabProps) {
  const t = useT();
  const dash = t("recipes.dash");
  const [pending, setPending] = useState<PendingAction>(null);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const compare = useCompare(a, b);

  const columns: ColumnDef<RecipeVersionRow>[] = [
    {
      id: "version",
      header: t("recipes.detail.versions.col.version"),
      numeric: true,
      hideable: false,
      accessor: (r) => r.version,
      cell: (r) => formatNumber(r.version),
    },
    {
      id: "status",
      header: t("recipes.detail.versions.col.status"),
      hideable: false,
      accessor: (r) => r.status,
      cell: (r) => <Badge tone={statusTone(r.status)}>{statusLabel(t, r.status)}</Badge>,
    },
    {
      id: "yield",
      header: t("recipes.detail.versions.col.yield"),
      numeric: true,
      accessor: (r) => r.yieldQuantity,
      cell: (r) => `${formatNumber(r.yieldQuantity)} ${r.yieldUnit || ""}`.trim(),
    },
    {
      id: "effectiveFrom",
      header: t("recipes.detail.versions.col.effectiveFrom"),
      accessor: (r) => r.effectiveFrom ?? "",
      cell: (r) => (r.effectiveFrom ? formatDate(r.effectiveFrom) : dash),
    },
    {
      id: "updatedAt",
      header: t("recipes.detail.versions.col.updatedAt"),
      accessor: (r) => r.updatedAt ?? "",
      cell: (r) => (r.updatedAt ? formatDateTime(r.updatedAt) : dash),
    },
    {
      id: "updatedBy",
      header: t("recipes.detail.versions.col.updatedBy"),
      accessor: (r) => r.updatedBy ?? "",
      cell: (r) => r.updatedBy || dash,
    },
    {
      id: "approvedBy",
      header: t("recipes.detail.versions.col.approvedBy"),
      accessor: (r) => r.approvedBy ?? "",
      defaultHidden: true,
      cell: (r) => r.approvedBy || dash,
    },
    {
      id: "unitCost",
      header: t("recipes.detail.versions.col.unitCost"),
      numeric: true,
      requireCap: "menu.cost.view",
      accessor: (r) => r.cachedUnitCost ?? -1,
      cell: (r) => (r.cachedUnitCost == null ? dash : formatCurrency(r.cachedUnitCost)),
    },
  ];

  const visibleColumns = canViewCost ? columns : columns.filter((c) => c.id !== "unitCost");

  return (
    <section className="min-w-0 space-y-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-slate-900">{t("recipes.detail.versions.title")}</h2>
        <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.versions.subtitle")}</p>
      </header>

      <DataTable<RecipeVersionRow>
        columns={visibleColumns}
        rows={versions}
        getRowId={(r) => r.bomId}
        paginate={false}
        columnMenu={false}
        emptyTitle={t("recipes.detail.versions.empty")}
        mobileTitle={(r) => `${t("recipes.detail.versions.col.version")} ${formatNumber(r.version)}`}
        rowActions={
          canEdit
            ? (r) => (
                <span className="flex flex-wrap items-center gap-1">
                  {r.status === "draft" && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPending({ kind: "activate", version: r })}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> {t("recipes.detail.versions.activate")}
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => onClone(r)}>
                    <Copy className="h-3.5 w-3.5" /> {t("recipes.detail.versions.clone")}
                  </Button>
                  {r.status !== "archived" && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPending({ kind: "archive", version: r })}>
                      <Archive className="h-3.5 w-3.5" /> {t("recipes.detail.versions.archive")}
                    </Button>
                  )}
                </span>
              )
            : undefined
        }
      />

      {/* ── compare ── */}
      <div className="surface space-y-4 p-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-bold text-slate-900">{t("recipes.detail.versions.compare.title")}</h3>
          <p className="text-sm font-normal leading-6 text-slate-600">{t("recipes.detail.versions.compare.subtitle")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label={t("recipes.detail.versions.compare.a")}>
            {({ id }) => (
              <Select id={id} className="h-11 w-full" value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">{t("recipes.detail.versions.compare.pick")}</option>
                {versions.map((v) => (
                  <option key={v.bomId} value={v.bomId}>
                    {`${formatNumber(v.version)} — ${statusLabel(t, v.status)}`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("recipes.detail.versions.compare.b")}>
            {({ id }) => (
              <Select id={id} className="h-11 w-full" value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">{t("recipes.detail.versions.compare.pick")}</option>
                {versions.map((v) => (
                  <option key={v.bomId} value={v.bomId}>
                    {`${formatNumber(v.version)} — ${statusLabel(t, v.status)}`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {!a || !b || a === b ? (
          <p className="text-sm font-medium text-slate-500">{t("recipes.detail.versions.compare.needTwo")}</p>
        ) : compare.isError ? (
          <p role="alert" className="text-sm font-bold text-rose-700">
            {t("recipes.detail.toast.failed")}
          </p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-2">
              <li>
                <Badge tone="success">
                  {t("recipes.detail.versions.compare.added")}: {formatNumber(compare.data?.summary.added ?? 0)}
                </Badge>
              </li>
              <li>
                <Badge tone="danger">
                  {t("recipes.detail.versions.compare.removed")}: {formatNumber(compare.data?.summary.removed ?? 0)}
                </Badge>
              </li>
              <li>
                <Badge tone="warning">
                  {t("recipes.detail.versions.compare.modified")}: {formatNumber(compare.data?.summary.modified ?? 0)}
                </Badge>
              </li>
              {compare.data?.header.yieldQuantityChanged && (
                <li>
                  <Badge tone="info">{t("recipes.detail.versions.compare.yieldChanged")}</Badge>
                </li>
              )}
              {compare.data?.header.yieldUnitChanged && (
                <li>
                  <Badge tone="info">{t("recipes.detail.versions.compare.unitChanged")}</Badge>
                </li>
              )}
              {canViewCost && compare.data?.costDelta && (
                <>
                  <li>
                    <Badge tone="neutral">
                      {t("recipes.detail.versions.compare.costDeltaBatch")}: {formatCurrency(compare.data.costDelta.batch)}
                    </Badge>
                  </li>
                  <li>
                    <Badge tone="neutral">
                      {t("recipes.detail.versions.compare.costDeltaUnit")}: {formatCurrency(compare.data.costDelta.unit)}
                    </Badge>
                  </li>
                </>
              )}
            </ul>

            {(compare.data?.lines?.length ?? 0) === 0 ? (
              <p className="text-sm font-medium text-slate-500">{t("recipes.detail.versions.compare.noChange")}</p>
            ) : (
              <TableShell>
                <Thead>
                  <tr>
                    <Th>{t("recipes.detail.versions.compare.component")}</Th>
                    <Th>{t("recipes.detail.versions.compare.change")}</Th>
                    <Th numeric>{`${t("recipes.detail.versions.compare.before")} · ${t("recipes.detail.versions.compare.quantity")}`}</Th>
                    <Th numeric>{`${t("recipes.detail.versions.compare.after")} · ${t("recipes.detail.versions.compare.quantity")}`}</Th>
                    <Th numeric>{`${t("recipes.detail.versions.compare.before")} · ${t("recipes.detail.versions.compare.wastePct")}`}</Th>
                    <Th numeric>{`${t("recipes.detail.versions.compare.after")} · ${t("recipes.detail.versions.compare.wastePct")}`}</Th>
                  </tr>
                </Thead>
                <tbody>
                  {(compare.data?.lines ?? []).map((l) => (
                    <Tr key={l.componentItemId}>
                      <Td>
                        <span className="font-extrabold text-slate-900">{l.itemName}</span>
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            l.change === "added"
                              ? "success"
                              : l.change === "removed"
                                ? "danger"
                                : l.change === "modified"
                                  ? "warning"
                                  : "neutral"
                          }
                        >
                          {t(`recipes.detail.versions.compare.${l.change}`)}
                        </Badge>
                      </Td>
                      <Td numeric>{l.before ? formatNumber(l.before.baseQuantity) : dash}</Td>
                      <Td numeric>{l.after ? formatNumber(l.after.baseQuantity) : dash}</Td>
                      <Td numeric>{l.before ? formatNumber(l.before.wastePct) : dash}</Td>
                      <Td numeric>{l.after ? formatNumber(l.after.wastePct) : dash}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!pending}
        title={pending?.kind === "archive" ? t("recipes.detail.versions.archive") : t("recipes.detail.versions.activate")}
        description={
          pending?.kind === "archive"
            ? t("recipes.detail.versions.confirmArchive")
            : t("recipes.detail.versions.confirmActivate")
        }
        tone={pending?.kind === "archive" ? "danger" : "primary"}
        processing={busy}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          if (pending.kind === "archive") onArchive(pending.version);
          else onActivate(pending.version);
          setPending(null);
        }}
      />
    </section>
  );
}
