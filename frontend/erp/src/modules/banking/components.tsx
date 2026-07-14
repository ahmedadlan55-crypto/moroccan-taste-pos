// ── Shared building blocks for the banking screens ──────────────────────────
import { useEffect } from "react";
import { Badge, Select } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { useGlTree, nextChildCode } from "./api";

const NUM = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export function fmt(value: number | null | undefined): string {
  return NUM.format(Number(value) || 0);
}

/** Money cell — LTR + tabular, optional currency suffix. */
export function Money({
  value,
  currency,
  tone = "text-slate-800",
}: {
  value: number | null | undefined;
  currency?: string;
  tone?: string;
}) {
  return (
    <span dir="ltr" className={`tabular-nums font-extrabold ${tone}`}>
      {fmt(value)}
      {currency ? <span className="ms-1 text-xs font-bold text-slate-400">{currency}</span> : null}
    </span>
  );
}

const STATUS_TONE: Record<string, "neutral" | "success" | "danger"> = {
  draft: "neutral",
  posted: "success",
  cancelled: "danger",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  posted: "مُرحَّل",
  cancelled: "ملغى",
};
export function StatusPill({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

// Server error strings → friendly Arabic.
export function mapError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (!raw) return "تعذّرت العملية. أعد المحاولة.";
  return raw;
}

// ── GL account linking (new box / bank) ─────────────────────────────────────
// The server mints a fresh gl_account under the chosen parent and computes its
// code + level itself, so we only send the parent id. We still preview the
// next code for the user (same algorithm the server uses).
export function GlLinkSection({
  root,
  rootLabel,
  parentId,
  onParentChange,
}: {
  root: string;
  rootLabel: string;
  parentId: string;
  onParentChange: (id: string) => void;
}) {
  const tree = useGlTree(root, true);
  const nodes = tree.data ?? [];

  useEffect(() => {
    if (!parentId && nodes.length) {
      const rootNode = nodes.find((n) => n.code === root) ?? nodes[0];
      onParentChange(rootNode.id);
    }
  }, [parentId, nodes, root, onParentChange]);

  const selected = nodes.find((n) => n.id === parentId);
  const preview = selected ? nextChildCode(selected, nodes) : null;

  return (
    <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-3">
      <div className="mb-2 text-xs font-extrabold text-teal-800">
        ربط حساب الأستاذ (تحت {rootLabel})
      </div>
      <Field label="الحساب الأب">
        <Select
          value={parentId}
          onChange={(e) => onParentChange(e.target.value)}
          disabled={tree.isLoading}
        >
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.code} — {n.nameAr}
            </option>
          ))}
        </Select>
      </Field>
      {preview && (
        <div className="mt-2 text-[11px] font-bold text-slate-500">
          كود الحساب الجديد المتوقّع: <code className="text-teal-700">{preview.code}</code> (مستوى{" "}
          {preview.level}) — يحسبه الخادم نهائيًا عند الحفظ.
        </div>
      )}
    </div>
  );
}
