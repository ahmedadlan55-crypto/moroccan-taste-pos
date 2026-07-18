import { AlertTriangle, CheckCircle2, EyeOff, Search, SlidersHorizontal } from "lucide-react";
import { Button, Input, Select } from "@/shared/ui";
import { cn } from "@/shared/lib";

export type QueueSegment = "all" | "unread" | "overdue" | "active";

export interface QueueFilterState {
  search: string;
  segment: QueueSegment;
  status: string;
  importance: string;
}

const SEGMENTS: Array<{
  value: QueueSegment;
  label: string;
  icon: typeof CheckCircle2;
}> = [
  { value: "all", label: "الكل", icon: SlidersHorizontal },
  { value: "active", label: "تحتاج متابعة", icon: CheckCircle2 },
  { value: "unread", label: "غير مقروءة", icon: EyeOff },
  { value: "overdue", label: "متأخرة", icon: AlertTriangle },
];

export function WorkflowQueueToolbar({
  value,
  onChange,
  counts,
  searchPlaceholder,
}: {
  value: QueueFilterState;
  onChange: (next: QueueFilterState) => void;
  counts: Record<QueueSegment, number>;
  searchPlaceholder?: string;
}) {
  const filtered = value.status || value.importance || value.segment !== "all";

  return (
    <section className="surface overflow-hidden" aria-label="تصفية المعاملات">
      <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[minmax(18rem,1fr)_12rem_12rem_auto]">
        <Input
          value={value.search}
          onChange={(event) => onChange({ ...value, search: event.target.value })}
          placeholder={searchPlaceholder ?? "ابحث بالرقم أو الموضوع أو الجهة…"}
          aria-label="البحث في المعاملات"
          leading={<Search className="h-4 w-4" aria-hidden="true" />}
        />
        <Select
          value={value.status}
          aria-label="تصفية حسب الحالة"
          onChange={(event) => onChange({ ...value, status: event.target.value })}
        >
          <option value="">كل الحالات</option>
          <option value="pending">قيد الانتظار</option>
          <option value="in_progress">قيد التنفيذ</option>
          <option value="approved">معتمدة</option>
          <option value="returned">معادة للتعديل</option>
          <option value="rejected">مرفوضة</option>
          <option value="closed">مغلقة</option>
        </Select>
        <Select
          value={value.importance}
          aria-label="تصفية حسب الأهمية"
          onChange={(event) => onChange({ ...value, importance: event.target.value })}
        >
          <option value="">كل الأولويات</option>
          <option value="critical">حرجة</option>
          <option value="high">عالية</option>
          <option value="medium">متوسطة</option>
          <option value="low">منخفضة</option>
        </Select>
        <Button
          variant="ghost"
          disabled={!filtered && !value.search}
          onClick={() => onChange({ search: "", segment: "all", status: "", importance: "" })}
        >
          مسح الفلاتر
        </Button>
      </div>

      <div className="flex gap-2 overflow-x-auto p-3 scrollbar-thin" role="group" aria-label="نطاق المعاملات">
        {SEGMENTS.map(({ value: segment, label, icon: Icon }) => {
          const selected = value.segment === segment;
          return (
            <button
              key={segment}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange({ ...value, segment })}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                selected
                  ? "border-teal-600 bg-teal-50 text-teal-800"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
              <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-xs tabular-nums">{counts[segment]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
