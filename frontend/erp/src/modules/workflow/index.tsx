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
// BUILT this session (read-only, real React): صندوق الوارد / صندوق الصادر / طلباتي.
// DEFERRED (heavy engine, stays legacy): مسارات الاعتماد (chain builder) — clean
// placeholder. سجل الإجراءات links to the unified audit log (no duplicate).

import type { ComponentType } from "react";
import { useLocation } from "react-router-dom";
import { InboxPage } from "./pages/InboxPage";
import { OutboxPage } from "./pages/OutboxPage";
import { MyRequestsPage } from "./pages/MyRequestsPage";
import { ApprovalFlowsPage } from "./pages/ApprovalFlowsPage";
import { ActionLogPage } from "./pages/ActionLogPage";

const PAGES: Record<string, ComponentType> = {
  "/workflow/inbox": InboxPage,
  "/workflow/outbox": OutboxPage,
  "/workflow/my-requests": MyRequestsPage,
  "/workflow/approval-flows": ApprovalFlowsPage,
  "/workflow/action-log": ActionLogPage,
};

export default function WorkflowModule() {
  const { pathname } = useLocation();
  const Page = PAGES[pathname] ?? InboxPage;
  return <Page />;
}
