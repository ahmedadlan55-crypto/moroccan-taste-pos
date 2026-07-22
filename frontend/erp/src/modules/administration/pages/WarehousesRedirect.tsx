import { Link } from "react-router-dom";
import { ArrowLeft, ArrowRight, Warehouse } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { useT, useLang } from "@/i18n";

// Warehouse CRUD is owned by the Inventory module (single source of truth). This
// admin entry only points the operator to the canonical screen.
export default function WarehousesRedirectPage() {
  const t = useT();
  const lang = useLang();
  // The "go" arrow points toward the reading direction: left in RTL, right in LTR.
  const GoArrow = lang === "ar" ? ArrowLeft : ArrowRight;
  return (
    <div>
      <PageHeader
        eyebrow={t("administration.eyebrow")}
        title={t("administration.warehousesRedirect.title")}
        subtitle={t("administration.warehousesRedirect.subtitle")}
      />
      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <Warehouse className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">{t("administration.warehousesRedirect.cardTitle")}</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          {t("administration.warehousesRedirect.cardBody")}
        </p>
        <Link
          to="/inventory/warehouses"
          className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-teal-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
        >
          {t("administration.warehousesRedirect.goBtn")} <GoArrow className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
