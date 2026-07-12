// Root barrel for the shared foundation. The concrete, foundation-owned modules
// (api client + lib helpers) are re-exported here. The UI/forms/tables/feedback/
// layouts/hooks/schemas/permissions sub-barrels are filled in by the Shared-UI
// agent (SD2); import those from their own paths (e.g. `@/shared/ui`).
export * from "./api";
export * from "./lib";
