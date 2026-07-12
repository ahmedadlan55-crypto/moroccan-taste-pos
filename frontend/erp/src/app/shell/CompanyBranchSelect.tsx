import { useState } from "react";
import { Building2 } from "lucide-react";

// Company / branch scope selector. Kept intentionally minimal and side-effect
// free in the foundation: it renders clean selects with an "all" default and
// no-ops safely. A later scope provider wires these to /api/erp/companies +
// /api/erp/branches-full and broadcasts the active scope to the modules.
export function CompanyBranchSelect({ fullWidth = false }: { fullWidth?: boolean }) {
  const [company, setCompany] = useState("all");
  const [branch, setBranch] = useState("all");

  return (
    <div className={fullWidth ? "flex w-full gap-2" : "flex items-center gap-2"}>
      <span className="hidden shrink-0 items-center gap-1 text-slate-400 lg:inline-flex" aria-hidden="true">
        <Building2 className="h-4 w-4" />
      </span>
      <select
        className={fullWidth ? "field flex-1" : "field max-w-44"}
        aria-label="اختيار الشركة"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
      >
        <option value="all">كل الشركات</option>
      </select>
      <select
        className={fullWidth ? "field flex-1" : "field max-w-40"}
        aria-label="اختيار الفرع"
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
      >
        <option value="all">كل الفروع</option>
      </select>
    </div>
  );
}
