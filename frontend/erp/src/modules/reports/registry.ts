// THE report catalogue — one index over every report in the product.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Eight registries describe reports in this codebase, with four different
// column-format unions, three different capability shapes and two different
// id→component tables. Each is reasonable inside its own section; none of them
// can answer "what reports exist?". So nothing could: not a search box, not a
// favourites list, not `/reports` itself, and not the Saved Reports page —
// which resorted to a HAND-WRITTEN list of 16 segment names, drifted from the
// real 17, and made every saved view on the Channels report permanently
// invisible.
//
// ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
// Not a ninth registry. Nothing is re-declared here. Every entry is DERIVED
// from the section registry that already owns it, so a report added to
// `purchasing/registry.ts` appears in the hub with no edit to this file, and a
// report renamed there cannot go stale here. The adapters below are the only
// code that knows each section's private shape.
//
// ─── ON METADATA WE DO NOT HAVE ─────────────────────────────────────────────
// `maturity`, `basis`, `source` and `standard` are populated ONLY where the
// owning registry actually declares them (today: inventory and purchasing, via
// the warehouse catalogue). Everywhere else they are `undefined` and the UI
// renders nothing. Inventing a badge — labelling a report "authoritative"
// because the section felt trustworthy — would be exactly the fabricated
// confidence this project refuses elsewhere.
import type { ComponentType } from "react";
import {
  BarChart3,
  Boxes,
  Calculator,
  CalendarClock,
  ClipboardList,
  CreditCard,
  FileBarChart,
  FileSearch,
  FileSpreadsheet,
  GitCompareArrows,
  HandCoins,
  LineChart,
  PackageSearch,
  ReceiptText,
  RotateCcw,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  Tags,
  UserRoundSearch,
  Users,
  WalletCards,
} from "lucide-react";
import type { Capability } from "@/shared/permissions";
import { FINANCIAL_REPORTS } from "./financial/registry";
import { PURCHASING_REPORTS, PURCHASING_REPORT_IDS } from "./purchasing/registry";
import { RECEIVABLES_REPORTS, RECEIVABLES_VIEW_CAP } from "./receivables/registry";
import { PEOPLE_REPORTS_SECTION } from "./people/registry";
import { OPERATIONS_REPORTS_SECTION } from "./operations/registry";
import { CENTERS, REPORT_BY_ID } from "./sales/lib/reportRegistry";
import {
  INVENTORY_INTELLIGENCE_REPORTS,
  PURCHASING_INTELLIGENCE_REPORTS,
  type IntelligenceReportLink,
} from "./warehouse/reportCatalog";

/**
 * The six sections the catalogue is organised by.
 *
 * Receivables folds into `sales` deliberately: from the reader's side "what did
 * we sell and did we collect it" is one question, and the owner asked for six
 * sections, not seven. The receivables ROUTES are untouched — only the shelf
 * they sit on changes.
 */
export type ReportSectionId =
  | "sales"
  | "inventory"
  | "purchasing"
  | "financial"
  | "people"
  | "operations";

export const REPORT_SECTIONS: ReadonlyArray<{
  id: ReportSectionId;
  titleKey: string;
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
  /** Where the section's own catalogue lives. */
  route: string;
}> = [
  { id: "sales", titleKey: "reportsHome.sections.sales.title", descriptionKey: "reportsHome.sections.sales.description", icon: BarChart3, route: "/reports/sales" },
  { id: "inventory", titleKey: "reportsHome.sections.inventory.title", descriptionKey: "reportsHome.sections.inventory.description", icon: Boxes, route: "/reports/inventory" },
  { id: "purchasing", titleKey: "reportsHome.sections.purchasing.title", descriptionKey: "reportsHome.sections.purchasing.description", icon: ShoppingCart, route: "/reports/purchasing" },
  { id: "financial", titleKey: "reportsHome.sections.financial.title", descriptionKey: "reportsHome.sections.financial.description", icon: LineChart, route: "/reports/financial" },
  { id: "people", titleKey: "reportsHome.sections.people.title", descriptionKey: "reportsHome.sections.people.description", icon: Users, route: "/reports/people" },
  { id: "operations", titleKey: "reportsHome.sections.operations.title", descriptionKey: "reportsHome.sections.operations.description", icon: ClipboardList, route: "/reports/operations" },
];

export type ReportMaturity = "authoritative" | "operational" | "conditional";

export interface CatalogEntry {
  /** Unique across the whole catalogue — section-scoped, because ids collide
   *  (`data-quality` exists in purchasing, inventory AND receivables). */
  key: string;
  /** The id inside its own section. */
  id: string;
  section: ReportSectionId;
  /** A real, refreshable address — never an anchor into the page you are on. */
  route: string;
  titleKey: string;
  descriptionKey?: string;
  /** Required to open it. `capsAny` means any-of; both may be absent. */
  cap?: Capability;
  capsAny?: readonly Capability[];
  icon: ComponentType<{ className?: string }>;
  /** Declared by the owning registry, or absent. Never inferred. */
  maturity?: ReportMaturity;
  basis?: string;
  source?: string;
  standard?: string;
  /** Extra words the search box should match beyond the resolved title. */
  keywords?: readonly string[];
  /**
   * The `saved_views.module` key, when this report can persist views.
   * Declared by the adapter that owns the report, never inferred from the
   * URL: the inventory catalogue contains `sales-cost-profitability`, whose
   * route deliberately points INTO the sales hub. Reading the route would
   * mint `analytics:sales-cost-profitability` — a module no segment answers
   * to, so the Saved Reports page would fan out over a dead key forever.
   */
  savedViewModule?: string;
}

/* ── icons, per section ─────────────────────────────────────────────────── */

const SALES_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  executive: BarChart3, items: PackageSearch, profitability: Calculator, modifiers: Tags,
  payments: WalletCards, taxes: ReceiptText, discounts: CreditCard, reconciliation: GitCompareArrows,
  branches: Store, channels: Boxes, hours: CalendarClock, cashiers: UserRoundSearch,
  shifts: Store, voids: RotateCcw, orders: FileSearch, explorer: SlidersHorizontal,
  builder: SlidersHorizontal,
};

const FINANCIAL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "income-statement": LineChart, "balance-sheet": FileSpreadsheet, "cash-flow": WalletCards,
  "equity-changes": GitCompareArrows, "general-ledger": FileSearch, "trial-balance": Calculator,
  "financial-ratios": BarChart3, "ar-aging": HandCoins, "ap-aging": ReceiptText,
  profitability: Calculator, "inventory-valuation": Boxes,
};

/* ── adapters — the only code that knows each registry's private shape ──── */

function fromSales(): CatalogEntry[] {
  // Walk CENTERS, not REPORTS: a spec not reachable from any centre has no URL
  // a person can open, and a catalogue row that navigates nowhere is worse than
  // an absent one.
  const out: CatalogEntry[] = [];
  for (const center of CENTERS) {
    for (const viewId of center.views) {
      const spec = REPORT_BY_ID[viewId];
      if (!spec) continue;
      out.push({
        key: `sales:${spec.id}`,
        id: spec.id,
        section: "sales",
        route: `/reports/sales/${spec.center}?view=${spec.id}`,
        titleKey: `salesReports.pages.${spec.id}.title`,
        cap: spec.cap,
        icon: SALES_ICONS[spec.id] ?? BarChart3,
        savedViewModule: `analytics:${spec.id}`,
        keywords: [spec.center],
      });
    }
  }
  return out;
}

function fromReceivables(): CatalogEntry[] {
  return RECEIVABLES_REPORTS.map((report) => ({
    key: `receivables:${report.id}`,
    id: report.id,
    section: "sales" as const,
    route: `/reports/receivables/${report.id}`,
    titleKey: `receivablesReports.reports.${report.i18nKey}.title`,
    // Only `data-quality` declares its own cap; the rest ride the section gate.
    cap: report.cap ?? RECEIVABLES_VIEW_CAP,
    icon: report.icon ?? HandCoins,
    keywords: ["receivables", report.group],
  }));
}

function fromIntelligence(
  links: IntelligenceReportLink[],
  section: ReportSectionId,
): CatalogEntry[] {
  // The warehouse catalogue is the ONE registry that already carries governance
  // metadata, so this is the only adapter that can fill maturity/basis/standard
  // without inventing it.
  return links.map((link) => ({
    key: `${section}:${link.id}`,
    id: link.id,
    section,
    route: link.to,
    titleKey: link.labelKey,
    descriptionKey: link.descriptionKey,
    icon: link.icon ?? FileBarChart,
    maturity: link.maturity,
    basis: link.basis,
    standard: link.standard,
    keywords: [link.family],
  }));
}

function fromPurchasingRegistry(): CatalogEntry[] {
  // PURCHASING_REPORTS carries the capabilities; the intelligence catalogue
  // carries the governance badges. Same nine ids, two half-descriptions —
  // joined here rather than picking one and losing the other half.
  const badges = new Map(PURCHASING_INTELLIGENCE_REPORTS.map((l) => [l.id, l]));
  return PURCHASING_REPORT_IDS.map((id) => {
    const def = PURCHASING_REPORTS[id];
    const badge = badges.get(id);
    return {
      key: `purchasing:${id}`,
      id,
      section: "purchasing" as const,
      route: `/reports/purchasing/${id}`,
      titleKey: def.labelKey,
      descriptionKey: def.descriptionKey,
      capsAny: def.capsAny,
      icon: def.icon ?? ShoppingCart,
      maturity: badge?.maturity,
      basis: badge?.basis,
      standard: badge?.standard,
      keywords: ["purchasing"],
    };
  });
}

function fromFinancial(): CatalogEntry[] {
  return FINANCIAL_REPORTS.map((report) => ({
    key: `financial:${report.id}`,
    id: report.id,
    section: "financial" as const,
    route: `/reports/financial/${report.id}`,
    titleKey: report.labelKey,
    cap: report.cap,
    icon: FINANCIAL_ICONS[report.id] ?? FileSpreadsheet,
    keywords: ["financial", "accounting"],
  }));
}

function fromSection(
  section: typeof PEOPLE_REPORTS_SECTION,
  id: ReportSectionId,
): CatalogEntry[] {
  return section.reports.map((report) => ({
    key: `${id}:${report.id}`,
    id: report.id,
    section: id,
    route: `${section.path}/${report.id}`,
    titleKey: report.labelKey,
    descriptionKey: report.descriptionKey,
    cap: report.cap,
    icon: report.icon ?? FileBarChart,
    keywords: [report.groupId],
  }));
}

/** Every report in the product, derived. Stable order: section, then registry order. */
export function buildReportCatalog(): CatalogEntry[] {
  return [
    ...fromSales(),
    ...fromReceivables(),
    ...fromIntelligence(INVENTORY_INTELLIGENCE_REPORTS, "inventory"),
    ...fromPurchasingRegistry(),
    ...fromFinancial(),
    ...fromSection(PEOPLE_REPORTS_SECTION, "people"),
    ...fromSection(OPERATIONS_REPORTS_SECTION, "operations"),
  ];
}

export const REPORT_CATALOG: readonly CatalogEntry[] = buildReportCatalog();

/** Can this reader open it? `capsAny` is any-of; no declared cap means the
 *  section guard is the only gate. */
export function canOpen(entry: CatalogEntry, can: (cap: Capability) => boolean): boolean {
  if (entry.capsAny && entry.capsAny.length > 0) return entry.capsAny.some(can);
  if (entry.cap) return can(entry.cap);
  return true;
}

/**
 * The saved-views module key for a report, or null when it has none.
 *
 * The Saved Reports page used to fan out over a hand-written list of segment
 * names; deriving the key here is what stops that list existing at all. Only
 * the sales hub persists views today, under `analytics:<segment>` —
 * see AnalyticsTopBar, which derives the same key from the live segment.
 */
export function savedViewModule(entry: CatalogEntry): string | null {
  return entry.savedViewModule ?? null;
}

/** Every saved-views module the catalogue knows about — derived, never listed. */
export function savedViewModules(): string[] {
  return [...new Set(REPORT_CATALOG.map(savedViewModule).filter((m): m is string => m !== null))];
}
