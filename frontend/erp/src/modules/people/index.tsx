// modules/people — People / HR domain. The router registers each manifest path
// under /people as its own leaf route that renders THIS module's default export
// (one lazy chunk). Because every people path is consumed by its own leaf route,
// nested <Routes> can't discriminate between them — so this entry resolves the
// active screen from the absolute pathname. Every /people/* manifest path
// therefore resolves to its real page.
import type { ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { NotFound } from "@/app/shell/NotFound";
import { EmployeesPage } from "./pages/EmployeesPage";
import { AttendancePage } from "./pages/AttendancePage";
import { ShiftsPage } from "./pages/ShiftsPage";
import { LeavesPage } from "./pages/LeavesPage";
import { ContractsPage } from "./pages/ContractsPage";
import { PayrollPage } from "./pages/PayrollPage";
import { OrgTreePage } from "./pages/OrgTreePage";
import { CustodyPage } from "./pages/CustodyPage";
import { SelfServicePage } from "./pages/SelfServicePage";

/** Absolute manifest path → screen. Keys mirror the `people` group in the nav
 *  manifest (single source of truth). */
const PAGES: Record<string, ComponentType> = {
  "/people/employees": EmployeesPage,
  "/people/attendance": AttendancePage,
  "/people/shifts": ShiftsPage,
  "/people/leaves": LeavesPage,
  "/people/contracts": ContractsPage,
  "/people/payroll": PayrollPage,
  "/people/org-tree": OrgTreePage,
  "/people/custody": CustodyPage,
  "/people/self-service": SelfServicePage,
};

export default function PeopleModule() {
  const { pathname } = useLocation();
  // Never fall back to EmployeesPage: that silently rendered the WRONG screen for
  // an unmapped path instead of saying so.
  const Page = PAGES[normalizeRoutePath(pathname)];
  return Page ? <Page /> : <NotFound />;
}
