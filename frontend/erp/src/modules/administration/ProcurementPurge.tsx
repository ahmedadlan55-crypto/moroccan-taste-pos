// Danger zone — erase ALL purchasing and goods-receipt data.
//
// Lives on the Settings page rather than inside the procurement module for two
// reasons: the /api/procurement namespace is flag-gated (a cleanup tool that
// vanishes with a feature flag is one nobody can reach when they need it), and
// an irreversible wipe belongs where destructive administration lives, not one
// click away from the screens people use daily.
//
// THREE GATES, deliberately. This deletes financial history and unwinds the
// warehouse quantities those receipts created, with no undo:
//   1. admin-only — the server enforces it too; this only hides the button;
//   2. PREVIEW FIRST — the first press reads and writes nothing, and shows the
//      exact per-table row counts plus the stock coming back out;
//   3. TYPE-TO-CONFIRM — the delete needs the word typed by hand, so no
//      mis-click and no double-submit can trigger it.
import { useState } from "react";
import { Trash2, AlertTriangle } from "lucide-react";
import { apiClient } from "@/shared/api";
import { Button, Dialog, Input, PanelTitle, useToast } from "@/shared/ui";
import { useCan } from "@/app/providers";
import { useT } from "@/i18n";

/** The word the operator has to type. Deliberately NOT translated: it is a
 *  mechanical safety interlock, not prose, and it must read identically in
 *  every language so a screenshot of the confirmation is unambiguous. */
const CONFIRM_WORD = "DELETE";

interface PurgePlan {
  success: boolean;
  applied: boolean;
  docRows: number;
  movements: number;
  glJournals: number;
  empty: boolean;
  tables: Array<{ table: string; rows: number; missing?: boolean }>;
  stockUnwind: Array<{ itemId: string; warehouseId: string | null; netQty: number }>;
  removed?: Record<string, number>;
}

export function ProcurementPurge() {
  const t = useT();
  const { toast } = useToast();
  // Same capability the Settings page itself gates on; the server
  // independently requires the admin role, so this only hides the button.
  const canManage = useCan("administration.settings");
  const [plan, setPlan] = useState<PurgePlan | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  if (!canManage) return null;

  async function preview() {
    setBusy(true);
    try {
      // No `confirm` in the body → the server returns the plan and writes nothing.
      const res = await apiClient.post<PurgePlan>("/purchases/purge", {});
      setTyped("");
      setPlan(res);
    } catch (e) {
      toast({ title: t("administration.purge.failed"), description: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      const res = await apiClient.post<PurgePlan>("/purchases/purge", { confirm: CONFIRM_WORD });
      setPlan(null);
      setTyped("");
      toast({ title: t("administration.purge.doneToast", { count: res.docRows }), tone: "success" });
    } catch (e) {
      toast({ title: t("administration.purge.failed"), description: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="surface border-rose-200">
        <PanelTitle
          icon={AlertTriangle}
          title={t("administration.purge.title")}
          subtitle={t("administration.purge.subtitle")}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-xs font-bold text-rose-700">{t("administration.purge.warning")}</p>
          <Button variant="secondary" onClick={preview} disabled={busy}>
            <Trash2 className="h-4 w-4" />
            {busy && !plan ? t("administration.purge.checking") : t("administration.purge.previewBtn")}
          </Button>
        </div>
      </section>

      {plan && (
        <Dialog
          open
          onClose={() => { if (!busy) { setPlan(null); setTyped(""); } }}
          title={t("administration.purge.dialogTitle")}
          description={
            plan.empty
              ? t("administration.purge.nothingToDelete")
              : t("administration.purge.dialogDesc", { count: plan.docRows })
          }
          size="lg"
          footer={
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => { setPlan(null); setTyped(""); }} disabled={busy}>
                {t("common.cancel")}
              </Button>
              {!plan.empty && (
                <Button
                  variant="danger"
                  onClick={confirmDelete}
                  // The interlock: an exact typed match, nothing else.
                  disabled={busy || typed.trim() !== CONFIRM_WORD}
                >
                  {busy ? t("administration.purge.deleting") : t("administration.purge.confirmBtn")}
                </Button>
              )}
            </div>
          }
        >
          {!plan.empty && (
            <>
              <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">
                {t("administration.purge.irreversible")}
              </p>

              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-100">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {plan.tables.filter((r) => r.rows > 0).map((r) => (
                      <tr key={r.table}>
                        <td className="px-3 py-1.5 font-mono text-xs text-slate-600">{r.table}</td>
                        <td dir="ltr" className="px-3 py-1.5 text-end tabular-nums font-bold text-slate-800">{r.rows}</td>
                      </tr>
                    ))}
                    {/* The consequences people forget: the stock those receipts
                        added, and the journal entries they posted. */}
                    <tr className="bg-amber-50/60">
                      <td className="px-3 py-1.5 text-xs font-bold text-amber-800">{t("administration.purge.stockRows")}</td>
                      <td dir="ltr" className="px-3 py-1.5 text-end tabular-nums font-extrabold text-amber-800">{plan.stockUnwind.length}</td>
                    </tr>
                    <tr className="bg-amber-50/60">
                      <td className="px-3 py-1.5 text-xs font-bold text-amber-800">{t("administration.purge.glRows")}</td>
                      <td dir="ltr" className="px-3 py-1.5 text-end tabular-nums font-extrabold text-amber-800">{plan.glJournals}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <label className="mt-4 block">
                <span className="text-xs font-bold text-slate-700">
                  {t("administration.purge.typeToConfirm", { word: CONFIRM_WORD })}
                </span>
                <Input
                  dir="ltr"
                  className="mt-1"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={CONFIRM_WORD}
                  autoComplete="off"
                />
              </label>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
