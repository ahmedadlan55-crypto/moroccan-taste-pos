// UI-facing permission helpers. The permission MODEL (catalog + can) lives in
// `@/app/permissions`; the bound hooks in `@/app/providers`. These are re-exported
// here so screens can import guard + hooks from one shared surface.
export { Can } from "./Can";
export type { CanProps } from "./Can";
export { usePermissions, useCan } from "@/app/providers";
export { can, type Capability } from "@/app/permissions";
