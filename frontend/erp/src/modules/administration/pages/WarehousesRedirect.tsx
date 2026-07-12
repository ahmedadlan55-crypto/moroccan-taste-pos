import { Link } from "react-router-dom";
import { ArrowLeft, Warehouse } from "lucide-react";
import { PageHeader } from "@/shared/ui";

// Warehouse CRUD is owned by the Inventory module (single source of truth). This
// admin entry only points the operator to the canonical screen.
export default function WarehousesRedirectPage() {
  return (
    <div>
      <PageHeader
        eyebrow="الإدارة"
        title="المستودعات"
        subtitle="تُدار المستودعات ضمن وحدة المخزون."
      />
      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <Warehouse className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">إدارة المستودعات في وحدة المخزون</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          إنشاء المستودعات وتعديلها والتحكم في نطاقاتها يتم من شاشة المستودعات ضمن وحدة المخزون
          لتفادي الازدواجية.
        </p>
        <Link
          to="/inventory/warehouses"
          className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-teal-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
        >
          الذهاب إلى المستودعات <ArrowLeft className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
