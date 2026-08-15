// The shape of a READ-ONLY, PRINTABLE report inside a /reports/<section>
// catalogue.
//
// WHY A REGISTRY AND NOT ONE PAGE PER REPORT
//   The People and Operations catalogues used to link OUT to CRUD screens — an
//   employee list, an attendance editor, a shifts admin. None of those is a
//   report: they are workspaces with create/edit/delete affordances, and
//   clicking one from /reports left the reports section entirely. What a
//   manager asks for instead is a fixed question answered over a period, on
//   paper: "the payroll for July", "who was absent", "which shifts came up
//   short". Every one of those is the SAME page with a different query, a
//   different column list and a different capability — so it is data, not code.
//
//   A report therefore declares WHAT it asks (`load`), WHAT it shows
//   (`columns`) and WHO may see it (`cap`). `GenericReportPage` renders all of
//   them. Adding a report is adding a registry entry plus its dictionary keys;
//   it cannot accidentally gain an edit button, because the renderer has none.
//
// THE ONE RULE THIS FILE ENFORCES BY OMISSION
//   There is no `mockRows`, no `sampleData` and no `comingSoon` flag. A report
//   whose `load` cannot be written against a real endpoint does not get an
//   entry — it stays unbuilt and is reported as unbuildable. A hollow shell in
//   a report catalogue is worse than a missing row: it looks answered.
import type { ComponentType } from "react";
import type { Capability } from "@/shared/permissions";
import type { ReportDirectoryTone } from "../components/ReportDirectory";

/** How one column's value is rendered on screen, on paper and in the CSV. */
export type ReportFieldFormat =
  /** Free text (names, notes). */
  | "text"
  /** Identifiers, references, IP addresses — forced LTR so digits stay legible in RTL. */
  | "code"
  /** ISO date → the app's date format. */
  | "date"
  /** ISO timestamp → the app's date+time format. */
  | "datetime"
  /** An amount — rendered through `Num` (negatives in parentheses, zero as a dash). */
  | "money"
  /** A plain count (days, minutes, rows) — grouped, never parenthesised. */
  | "count"
  /** A server status code resolved through `labels` (falls back to the raw code). */
  | "status";

export interface ReportField {
  /** Key on the row object produced by `load`. */
  key: string;
  /** i18n key path for the column header. */
  labelKey: string;
  format?: ReportFieldFormat;
  /** `format:"status"` — server code → i18n key path. An unmapped code prints raw. */
  labels?: Readonly<Record<string, string>>;
}

/** A cell may only ever be a primitive: the CSV and the printed sheet must agree. */
export type ReportCell = string | number | null;

export interface ReportRow {
  /** Stable row identity (never rendered). */
  id: string;
  [column: string]: ReportCell;
}

/**
 * A figure printed above the table.
 *
 * ONLY server-computed aggregates belong here. A total this page adds up itself
 * would be a second, silently divergent answer to the same question — so the
 * loaders pass through what the server already computed (a payroll run's own
 * `total_net`, for instance) and pass nothing otherwise.
 */
export interface ReportTotal {
  labelKey: string;
  value: number;
  format: "money" | "count";
}

export interface ReportResult {
  rows: ReportRow[];
  totals?: ReportTotal[];
}

export type ReportFilterValues = Readonly<Record<string, string>>;

export interface ReportOption {
  value: string;
  label: string;
}

/**
 * A filter control. `kind` decides the widget; the id is the key the value is
 * stored under and the one `load` reads.
 *
 * `remote` fetches its own options (a payroll-run picker). At most ONE remote
 * filter per report — the renderer holds exactly one options query, and a
 * variable number of hooks is not a thing React allows.
 */
export interface ReportFilterDef {
  id: string;
  labelKey: string;
  kind: "date" | "select" | "month" | "year" | "remote";
  /** `kind:"select"` — option labels are i18n key paths, not display text. */
  options?: ReadonlyArray<{ value: string; labelKey: string }>;
  /** `kind:"remote"` — the fetcher and its react-query key. */
  loadOptions?: (signal?: AbortSignal) => Promise<ReportOption[]>;
  optionsKey?: readonly unknown[];
  /** Initial value. Dates/month/year default from today when omitted. */
  defaultValue?: string;
}

export interface ReportDefinition {
  /** URL segment: /reports/<section>/<id>. */
  id: string;
  groupId: string;
  labelKey: string;
  /** One line under the title — what question this answers. */
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
  tone?: ReportDirectoryTone;
  /**
   * The capability that ALREADY gates this data elsewhere in the product.
   * Reports never introduce a capability and never relax one: a payroll figure
   * is exactly as restricted inside /reports as it is inside /people.
   */
  cap: Capability;
  filters: ReadonlyArray<ReportFilterDef>;
  columns: ReadonlyArray<ReportField>;
  load: (filters: ReportFilterValues, signal?: AbortSignal) => Promise<ReportResult>;
  /** File-name stem for the CSV export. */
  csvName: string;
}

export interface ReportGroupDef {
  id: string;
  titleKey: string;
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
}

export interface ReportSectionDef {
  /** "/reports/people" — every report route is `${path}/${report.id}`. */
  path: string;
  titleKey: string;
  subtitleKey: string;
  eyebrowKey: string;
  groups: ReadonlyArray<ReportGroupDef>;
  reports: ReadonlyArray<ReportDefinition>;
}

export function findReport(section: ReportSectionDef, id: string): ReportDefinition | undefined {
  return section.reports.find((report) => report.id === id);
}

// ── The catalogue shape ─────────────────────────────────────────────────────
// What `ReportsHub` renders: a section, its groups, and the rows inside them.
// `title` / `label` / `description` hold i18n KEY PATHS, not display text — the
// hub resolves them with t() at its render site, the same way the nav manifest
// does. There is no hand-written table of these anywhere: `toReportSection`
// derives them from a registry, which is the single reason a catalogue row and
// the page it opens cannot disagree about the report's name, its icon, the
// capability that hides it — or its address.

export interface ReportLink {
  id: string;
  /** Always `${section.path}/${report.id}`. A row cannot leave /reports. */
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  tone?: ReportDirectoryTone;
  cap?: Capability;
}

export interface ReportGroup {
  id: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  links: ReportLink[];
}

export interface ReportSection {
  path: string;
  title: string;
  subtitle: string;
  groups: ReportGroup[];
}
