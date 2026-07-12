import type { StatusTone } from "@/shared/ui";

// Arabic status labels + semantic tone for every People / HR status string. The
// tone maps onto the shared <StatusBadge> semantic tones (never a raw color).

interface Meta {
  label: string;
  tone: StatusTone;
}

const STATUS: Record<string, Meta> = {
  // employees
  active: { label: "نشط", tone: "success" },
  suspended: { label: "مجمد", tone: "warning" },
  terminated: { label: "منتهي الخدمة", tone: "danger" },
  on_leave: { label: "في إجازة", tone: "info" },
  // leave requests
  pending: { label: "قيد الاعتماد", tone: "warning" },
  branch_approved: { label: "اعتماد الفرع", tone: "info" },
  hr_approved: { label: "معتمدة", tone: "success" },
  approved: { label: "معتمدة", tone: "success" },
  rejected: { label: "مرفوضة", tone: "danger" },
  // advances / custody / attendance
  paid: { label: "مسددة", tone: "success" },
  partially_paid: { label: "مسددة جزئيًا", tone: "warning" },
  open: { label: "مفتوحة", tone: "info" },
  closed: { label: "مغلقة", tone: "neutral" },
  posted: { label: "مُرحّلة", tone: "success" },
  present: { label: "حاضر", tone: "success" },
  absent: { label: "غائب", tone: "danger" },
  late: { label: "متأخر", tone: "warning" },
  leave: { label: "إجازة", tone: "info" },
};

export function statusMeta(status: string | null | undefined): Meta {
  const key = String(status || "").toLowerCase();
  return STATUS[key] || { label: status ? String(status) : "—", tone: "neutral" };
}

export const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  full_time: "دوام كامل",
  part_time: "دوام جزئي",
  hourly: "بالساعة",
  contract: "عقد",
};

export const EXCEPTION_TYPE_LABEL: Record<string, string> = {
  ignore_late: "تجاهل تأخير",
  ignore_early_leave: "تجاهل انصراف مبكر",
  ignore_overtime: "تجاهل إضافي",
  adjust_attendance: "تعديل حضور",
  grant_day: "منح يوم",
  excuse_absence: "عذر غياب",
};

const DAY_LABELS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** Map a CSV / array of weekday indices (0..6) to Arabic day names. */
export function weekdayLabels(days: number[] | string): string {
  const arr = Array.isArray(days)
    ? days
    : String(days || "")
        .split(",")
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n));
  const names = arr.filter((n) => n >= 0 && n <= 6).map((n) => DAY_LABELS[n]);
  return names.length ? names.join("، ") : "—";
}
