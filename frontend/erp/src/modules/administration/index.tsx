// modules/administration — the Administration domain. Each manifest path under
// /administration/* is registered as its own route pointing at this module, so
// the module dispatches to the matching page by pathname (the router consumes
// the full path, so nested <Routes> can't sub-match). Toasts flow through the
// single shell-level <ToastProvider> in app/providers — no local provider here.
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { NotFound } from "@/app/shell/NotFound";
import CompaniesBrandsPage from "./pages/CompaniesBrands";
import BranchesPage from "./pages/Branches";
import WarehousesRedirectPage from "./pages/WarehousesRedirect";
import UsersPage from "./pages/Users";
import RolesPermissionsPage from "./pages/RolesPermissions";
import SettingsPage from "./pages/Settings";
import InvoiceSettingsPage from "./pages/InvoiceSettings";
import TaxVatPage from "./pages/TaxVat";
import PaymentMethodsPage from "./pages/PaymentMethods";
import SecurityPage from "./pages/Security";
import AuditLogPage from "./pages/AuditLog";

const PAGES: Record<string, () => JSX.Element> = {
  "/administration/companies": CompaniesBrandsPage,
  "/administration/branches": BranchesPage,
  "/administration/warehouses": WarehousesRedirectPage,
  "/administration/users": UsersPage,
  "/administration/roles": RolesPermissionsPage,
  "/administration/settings": SettingsPage,
  "/administration/invoice-settings": InvoiceSettingsPage,
  "/administration/tax": TaxVatPage,
  "/administration/payment-methods": PaymentMethodsPage,
  "/administration/security": SecurityPage,
  "/administration/audit-log": AuditLogPage,
};

function AdministrationRoutes() {
  const { pathname } = useLocation();
  const Page = PAGES[normalizeRoutePath(pathname)];
  return Page ? <Page /> : <NotFound />;
}

export default function AdministrationModule() {
  return <AdministrationRoutes />;
}
