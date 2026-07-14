// modules/overview — the Home/Overview domain. Dispatches by pathname because
// each /overview/* manifest path is its own route pointing at this module.
import { useLocation } from "react-router-dom";
import { normalizeRoutePath } from "@/shared/lib";
import { NotFound } from "@/app/shell/NotFound";
import OverviewPage from "./pages/Overview";
import TasksAlertsPage from "./pages/TasksAlerts";
import ApprovalsPage from "./pages/Approvals";
import KpisPage from "./pages/Kpis";

const PAGES: Record<string, () => JSX.Element> = {
  "/overview": OverviewPage,
  "/overview/tasks": TasksAlertsPage,
  "/overview/approvals": ApprovalsPage,
  "/overview/kpis": KpisPage,
};

export default function OverviewModule() {
  const { pathname } = useLocation();
  const Page = PAGES[normalizeRoutePath(pathname)];
  return Page ? <Page /> : <NotFound />;
}
