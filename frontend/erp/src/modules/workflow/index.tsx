// modules/workflow — Workflow / Approvals domain (المعاملات والموافقات).
//
// The app router (src/app/router.tsx) registers EVERY manifest item as its own
// EXACT leaf route (e.g. "workflow/inbox", "workflow/outbox", …) that all render
// THIS module's default export. Because those routes carry no trailing splat,
// a descendant <Routes> here can only ever match "" — it cannot tell the five
// boxes apart. So we switch on the (basename-stripped) pathname, which maps 1:1
// to the manifest paths. This IS the per-manifest-path routing, done the way the
// parent router allows.
//
// All five boxes are real React: صندوق الوارد (with the live action bar) / صندوق
// الصادر / طلباتي / مسارات الاعتماد (the full builder: positions, transaction
// types, steps, position paths, routes DSL + dry-run, SLA). سجل الإجراءات links
// to the unified audit log (no duplicate).

import type { ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { NotFound } from "@/app/shell/NotFound";
import { normalizeRoutePath } from "@/shared/lib";
import { InboxPage } from "./pages/InboxPage";
import { OutboxPage } from "./pages/OutboxPage";
import { MyRequestsPage } from "./pages/MyRequestsPage";
import { ApprovalFlowsPage } from "./pages/ApprovalFlowsPage";
import { ActionLogPage } from "./pages/ActionLogPage";
import { CreateTransactionPage } from "./pages/CreateTransactionPage";

const PAGES: Record<string, ComponentType> = {
  "/workflow/new": CreateTransactionPage,
  "/workflow/inbox": InboxPage,
  "/workflow/outbox": OutboxPage,
  "/workflow/my-requests": MyRequestsPage,
  "/workflow/approval-flows": ApprovalFlowsPage,
  "/workflow/action-log": ActionLogPage,
};

export default function WorkflowModule() {
  const { pathname } = useLocation();
  const Page = PAGES[normalizeRoutePath(pathname)];
  return Page ? <Page /> : <NotFound />;
}
