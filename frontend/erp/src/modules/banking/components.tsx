// ── Shared building blocks for the banking screens ──────────────────────────
import { useEffect } from "react";
import { Construction, ExternalLink } from "lucide-react";
import { Badge, Select } from "@/shared/ui";
import { Field } from "@/shared/forms";
import { getIcon } from "@/app/shell/icons";
import { navByPath, navGroupOf } from "@/app/navigation/manifest";
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

// ── Deferred screen (bank reconciliation / cash closing — HEAVY, legacy) ─────
export function DeferredScreen({ pathname }: { pathname: string }) {
  const item = navByPath(pathname);
  const group = item ? navGroupOf(item) : undefined;
  const Icon = item ? getIcon(item.icon) : Construction;
  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-extrabold text-slate-900">{item?.label ?? group?.label}</h1>
          <p className="mt-0.5 text-[12px] font-bold text-slate-400">الواجهة الموحّدة — نظام ADLAN</p>
        </div>
      </header>
      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">
          <Construction className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">الصفحة غير متاحة على هذا المسار</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          {item ? `«${item.label}» ` : "هذه الشاشة "}
          غير متاحة على هذا المسار. عُد إلى نظرة عامة وتابع من القائمة الجانبية.
        </p>
        <a
          href="/app/overview"
          className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-600 px-4 text-sm font-bold text-white transition hover:bg-teal-700"
        >
          <ExternalLink className="h-4 w-4" /> العودة إلى نظرة عامة
        </a>
      </div>
    </div>
  );
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
