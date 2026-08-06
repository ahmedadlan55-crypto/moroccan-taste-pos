import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Factory, Layers, Plus, TriangleAlert } from "lucide-react";
import { Button, DatePicker, PageHeader, PermissionDenied, Select } from "@/shared/ui";
import { useCan } from "@/shared/permissions";
import { useUnsavedGuard } from "@/shared/forms";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import {
  readLineErrors,
  type BatchInput,
  type BatchItemInput,
  type BatchLineError,
  type BomPickOption,
} from "../../lib/batchApi";
import { useBatchMutations, useBatchPreview } from "../../lib/useBatches";
import { BomPicker } from "./BomPicker";
import { CostSummary } from "./CostSummary";
import { MaterialsPreview } from "./MaterialsPreview";
import { OutputsTable, type OutputRow } from "./OutputsTable";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let rowSeq = 0;
function newRow(bom: BomPickOption | null): OutputRow {
  rowSeq += 1;
  return {
    key: `row-${rowSeq}-${Math.random().toString(36).slice(2, 7)}`,
    bom,
    qtyPlanned: null,
    outputWarehouseId: "",
    batchNumber: "",
    expiryDate: "",
    // null on purpose: an untouched scrap field means "use the default policy".
    // Defaulting it to 0 would silently arm the zero-scrap manager gate.
    allowedScrapPct: null,
  };
}

function isComplete(r: OutputRow): boolean {
  return !!r.bom && r.qtyPlanned != null && r.qtyPlanned > 0;
}

/**
 * FULL-PAGE multi-product production create screen (/inventory/production/new).
 *
 * ONE document, SEVERAL independent products. The consolidated preview shows
 * every material once with its per-product attribution; a shortage warns and
 * never blocks. The create request is all-or-nothing: any rejected row refuses
 * the whole document, and `detail[].line` is mapped straight back onto the row
 * that caused it.
 */
export function ProductionBatchCreatePage() {
  const t = useT();
  const navigate = useNavigate();
  const canCreate = useCan("production.create");

  const { accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const allWh = useWarehouses();
  const warehouses = useMemo(() => {
    if (!allWarehousesAccess) return accessibleWarehouses.map((w) => ({ id: w.id, name: w.name }));
    return (allWh.data?.warehouses ?? []).map((w) => ({ id: w.id, name: w.name }));
  }, [allWarehousesAccess, accessibleWarehouses, allWh.data]);

  const [batchDate, setBatchDate] = useState(today());
  const [warehouseId, setWarehouseId] = useState("");
  const [outputWarehouseId, setOutputWarehouseId] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<OutputRow[]>([]);
  const [labour, setLabour] = useState<number | null>(null);
  const [overhead, setOverhead] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ open: boolean; targetKey: string | null }>({ open: false, targetKey: null });
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const submitted = useRef(false);

  const { create } = useBatchMutations();

  // Leaving with unsaved rows is a real loss — the draft lives only here until
  // the create call succeeds.
  useUnsavedGuard(rows.length > 0 && !submitted.current);

  const patchRow = useCallback((key: string, patch: Partial<OutputRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);
  const removeRow = useCallback((key: string) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }, []);
  const openPickerFor = useCallback((key: string) => setPicker({ open: true, targetKey: key }), []);

  function handlePick(bom: BomPickOption) {
    setRows((rs) => {
      if (picker.targetKey) return rs.map((r) => (r.key === picker.targetKey ? { ...r, bom } : r));
      return [...rs, newRow(bom)];
    });
    setPicker({ open: false, targetKey: null });
  }

  /* ── preview ────────────────────────────────────────────────────────────
     Only COMPLETE rows are previewed (the endpoint refuses the whole request
     when any line is invalid). The server answers with its own zero-based line
     indices, so keep the map back to our row order — attribution labels would
     otherwise point at the wrong product the moment a row is incomplete. */
  const completeRows = useMemo(
    () => rows.map((r, index) => ({ r, index })).filter((x) => isComplete(x.r)),
    [rows],
  );
  const previewLineToRow = useMemo(() => completeRows.map((x) => x.index), [completeRows]);

  const previewInput: BatchInput | null = useMemo(() => {
    if (!warehouseId || completeRows.length === 0) return null;
    return {
      warehouseId,
      outputWarehouseId: outputWarehouseId || warehouseId,
      items: completeRows.map(({ r }) => toItem(r)),
    };
  }, [warehouseId, outputWarehouseId, completeRows]);

  const preview = useBatchPreview(previewInput);

  /* ── row error map (local + server), keyed by ROW index ─────────────────── */
  const serverLineErrors = useMemo<BatchLineError[]>(() => readLineErrors(create.error), [create.error]);
  // A preview rejection names lines in the PREVIEW's own numbering (complete
  // rows only) — translate before showing it on a row.
  const previewLineErrors = useMemo<BatchLineError[]>(() => readLineErrors(preview.error), [preview.error]);

  const lineErrors = useMemo(() => {
    const map = new Map<number, BatchLineError[]>();
    const push = (line: number, e: BatchLineError) => {
      const list = map.get(line);
      if (list) list.push(e);
      else map.set(line, [e]);
    };
    if (submitAttempted) {
      rows.forEach((r, i) => {
        if (!r.bom) push(i, { line: i, code: "LOCAL_BOM_REQUIRED", message: t("production.batch.create.validation.bomRequired") });
        else if (r.qtyPlanned == null || r.qtyPlanned <= 0)
          push(i, { line: i, code: "LOCAL_QTY_REQUIRED", message: t("production.batch.create.validation.qtyRequired") });
      });
    }
    for (const e of previewLineErrors) {
      const rowIndex = previewLineToRow[e.line];
      if (rowIndex != null) push(rowIndex, e);
    }
    // The create request sends EVERY row in order, so detail[].line IS the row
    // index — no translation, and no chance of blaming the wrong product.
    for (const e of serverLineErrors) {
      const rowIndex = e.line >= 0 && e.line < rows.length ? e.line : -1;
      if (rowIndex >= 0) push(rowIndex, e);
    }
    return map;
  }, [rows, submitAttempted, serverLineErrors, previewLineErrors, previewLineToRow, t]);

  const productLabel = useCallback(
    (previewLine: number) => {
      const rowIndex = previewLineToRow[previewLine];
      const row = rowIndex == null ? undefined : rows[rowIndex];
      return row?.bom?.productName ?? t("production.batch.create.lineBadge", { line: formatNumber(previewLine + 1) });
    },
    [previewLineToRow, rows, t],
  );

  const describe = useCallback(
    (previewLine: number) => {
      const rowIndex = previewLineToRow[previewLine];
      const row = rowIndex == null ? undefined : rows[rowIndex];
      return {
        product: productLabel(previewLine),
        unit: row?.bom?.yieldUnit || row?.bom?.productUnit || "",
      };
    },
    [previewLineToRow, rows, productLabel],
  );

  /* ── submit ─────────────────────────────────────────────────────────────── */
  const docError =
    !warehouseId ? t("production.batch.create.validation.warehouseRequired")
    : rows.length === 0 ? t("production.batch.create.validation.rowsRequired")
    : null;
  const rowsValid = rows.length > 0 && rows.every(isComplete);

  async function submit() {
    setSubmitAttempted(true);
    if (!warehouseId || !rowsValid) return;
    const input: BatchInput = {
      warehouseId,
      outputWarehouseId: outputWarehouseId || warehouseId,
      batchDate: batchDate || undefined,
      notes: notes.trim() || undefined,
      items: rows.map(toItem),
    };
    const result = await create.mutateAsync(input).catch(() => null);
    if (!result) return; // rejection state is rendered inline, per row
    submitted.current = true;
    navigate(`/inventory/production/batches/${result.id}`, { replace: true });
  }

  // ApiError already carries a safe, human message for every canonical code;
  // anything else falls back to its own message.
  const rejection = create.error ? create.error.message : null;

  if (!canCreate) return <PermissionDenied />;

  return (
    <div>
      <PageHeader
        eyebrow={t("production.batch.eyebrow")}
        title={t("production.batch.create.title")}
        subtitle={t("production.batch.create.subtitle")}
        action={
          <Button variant="ghost" onClick={() => navigate("/inventory/production")}>
            <ArrowRight className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden="true" />{" "}
            {t("production.batch.backToOrders")}
          </Button>
        }
      />

      {/* ── document ── */}
      <section className="surface p-5" aria-labelledby="batch-doc-heading">
        <h2 id="batch-doc-heading" className="mb-4 text-sm font-extrabold text-slate-800">
          {t("production.batch.create.sectionDocument")}
        </h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="block text-xs font-bold text-slate-500">
            {t("production.batch.create.batchDateLabel")}
            <DatePicker
              className="mt-1 block"
              value={batchDate}
              onChange={setBatchDate}
              aria-label={t("production.batch.create.batchDateLabel")}
            />
          </label>
          <label className="block text-xs font-bold text-slate-500">
            {t("production.batch.create.sourceWarehouseLabel")}
            <Select
              className="mt-1 w-full"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              aria-label={t("production.batch.create.sourceWarehouseLabel")}
              invalid={submitAttempted && !warehouseId}
            >
              <option value="">{t("production.batch.create.chooseWarehouse")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            <span className="mt-1 block text-[11px] font-medium text-slate-400">
              {t("production.batch.create.sourceWarehouseHint")}
            </span>
          </label>
          <label className="block text-xs font-bold text-slate-500">
            {t("production.batch.create.outputWarehouseLabel")}
            <Select
              className="mt-1 w-full"
              value={outputWarehouseId}
              onChange={(e) => setOutputWarehouseId(e.target.value)}
              aria-label={t("production.batch.create.outputWarehouseLabel")}
            >
              <option value="">{t("production.batch.create.sameAsSource")}</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-xs font-bold text-slate-500">
            {t("production.batch.create.notesLabel")}
            <textarea
              className="field mt-1 min-h-11 w-full py-2"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              aria-label={t("production.batch.create.notesLabel")}
            />
          </label>
        </div>
      </section>

      {/* ── outputs ── */}
      <section className="surface mt-4 p-5" aria-labelledby="batch-outputs-heading">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="batch-outputs-heading" className="text-sm font-extrabold text-slate-800">
            {t("production.batch.create.sectionOutputs")}
          </h2>
          <Button variant="secondary" onClick={() => setPicker({ open: true, targetKey: null })}>
            <Plus className="h-4 w-4" aria-hidden="true" /> {t("production.batch.create.addProduct")}
          </Button>
        </div>

        {picker.open && (
          <div className="mb-4">
            <BomPicker onPick={handlePick} onClose={() => setPicker({ open: false, targetKey: null })} />
          </div>
        )}

        <OutputsTable
          rows={rows}
          warehouses={warehouses}
          defaultOutputWarehouseLabel={
            warehouses.find((w) => w.id === (outputWarehouseId || warehouseId))?.name ??
            t("production.batch.create.sameAsSource")
          }
          lineErrors={lineErrors}
          onPatch={patchRow}
          onRemove={removeRow}
          onPickProduct={openPickerFor}
        />

        <p className="mt-3 text-[11px] font-medium text-slate-400">{t("production.batch.create.scrapEmptyHint")}</p>
        <p className="mt-1 text-[11px] font-medium text-slate-400">{t("production.batch.create.expiryHint")}</p>
      </section>

      {/* ── consolidated materials ── */}
      <section className="mt-4" aria-labelledby="batch-materials-heading">
        <h2 id="batch-materials-heading" className="mb-3 text-sm font-extrabold text-slate-800">
          {t("production.batch.create.sectionMaterials")}
        </h2>
        <MaterialsPreview
          preview={previewInput ? preview.data : undefined}
          loading={!!previewInput && preview.isLoading}
          error={previewInput ? preview.error : null}
          onRetry={() => void preview.refetch()}
          productLabel={productLabel}
          idleMessage={previewInput ? undefined : t("production.batch.create.previewIdle")}
        />
      </section>

      {/* ── cost ── */}
      <section className="surface mt-4 p-5" aria-labelledby="batch-cost-heading">
        <h2 id="batch-cost-heading" className="mb-4 text-sm font-extrabold text-slate-800">
          {t("production.batch.create.sectionCosts")}
        </h2>
        <CostSummary
          preview={previewInput ? preview.data : undefined}
          labour={labour}
          overhead={overhead}
          onLabourChange={setLabour}
          onOverheadChange={setOverhead}
          describe={describe}
        />
      </section>

      {/* ── submit ── */}
      <div className="mt-4 space-y-3">
        <p className="flex items-start gap-2 rounded-xl border border-teal-200 bg-teal-50 p-3 text-xs font-bold text-teal-800">
          <Factory className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {t("production.batch.create.draftNote")} {t("production.batch.create.atomicNote")}
          </span>
        </p>

        {create.isError && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-700">
            <p className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              {serverLineErrors.length > 0 ? t("production.batch.create.serverRejected") : rejection}
            </p>
            {serverLineErrors.length > 0 && (
              <p className="mt-1 font-medium">{t("production.batch.create.validation.fixRows")}</p>
            )}
          </div>
        )}

        {submitAttempted && docError && (
          <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold text-rose-700">
            {docError}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={() => navigate("/inventory/production")}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            <Layers className="h-4 w-4" aria-hidden="true" />{" "}
            {create.isPending ? t("production.batch.create.submitting") : t("production.batch.create.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Row → wire item. `allowedScrapPct` stays NULL when untouched (default
 *  policy) and is sent as 0 only when the user really typed 0 (zero scrap). */
function toItem(r: OutputRow): BatchItemInput {
  return {
    bomId: r.bom?.id ?? "",
    qtyPlanned: r.qtyPlanned ?? 0,
    outputWarehouseId: r.outputWarehouseId || undefined,
    allowedScrapPct: r.allowedScrapPct,
    batchNumber: r.batchNumber.trim() || undefined,
    expiryDate: r.expiryDate || undefined,
  };
}
