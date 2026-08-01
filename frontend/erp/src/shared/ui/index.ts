// Shared UI kit — the ONE component library for the unified ADLAN Back-Office.
// ADLAN identity: enterprise, calm, dense. 40px controls / 44px touch targets,
// radii 8/10/14, light shadows, no heroes/gradients/purple/nested-cards.
// Every overlay is accessible (focus trap, Esc, focus restore, aria).

// ── primitives / atoms ──
export * from "./button";
export * from "./icon-button";
export * from "./card";
export * from "./skeleton";
export * from "./spinner";
export * from "./progress";
export * from "./badge";
export * from "./status-badge";
export * from "./page-header";
export * from "./error-boundary";

// ── page states / feedback ──
export * from "./states";
export * from "./toast";
export * from "./tooltip";

// ── overlays ──
export * from "./overlay";
export * from "./full-page-flow";
export * from "./dialog";
export * from "./alert-dialog";
export * from "./confirm-dialog";
export * from "./drawer";
export * from "./dropdown-menu";

// ── form controls ──
export * from "./input";
export * from "./number-input";
export * from "./currency-input";
export * from "./quantity-input";
export * from "./unit-qty-input";
export * from "./select";
export * from "./combobox";
export * from "./searchable-entity-combobox";
export * from "./date-picker";
export * from "./checkbox";
export * from "./toggle";
export * from "./tabs";
export * from "./segmented-control";
export * from "./stepper";

// ── rich display ──
export * from "./timeline";
export * from "./file-uploader";

// ── analytics kit (Sales Analytics Hub wave) ──
export * from "./metric-card";
export * from "./date-range-picker";
export * from "./multi-select-combobox";
export * from "./explain-number";

// ── the one printed-report house style (every module) ──
export * from "./print-document";
