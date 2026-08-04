// ── CoA filter vocabulary + the ONE predicate both views use ────────────────
// The tree and the table must agree about what "matching" means, or toggling
// the view silently changes the answer. One filter object, one predicate.

import type { GlAccount, GlAccountType } from "../api";
import {
  ZERO_EPSILON,
  accountMatches,
  isAbnormalBalance,
  isPostingAccount,
  isSystemRoot,
  nodeDisplayBalance,
  normalSide,
  type CoaHealth,
  type CoaIssueKind,
} from "./coaModel";

export type TypeFilter = GlAccountType | "all";
export type KindFilter = "all" | "posting" | "control";
export type StatusFilter = "all" | "active" | "inactive" | "blocked" | "archived";
export type NormalFilter = "all" | "debit" | "credit";
export type OriginFilter = "all" | "system" | "custom";
export type MovementFilter = "all" | "with" | "without";
export type IssueFilter = "all" | "any" | CoaIssueKind;

export interface CoaFilters {
  search: string;
  type: TypeFilter;
  level: "all" | number;
  kind: KindFilter;
  status: StatusFilter;
  section: string; // "all" | reportSection id | "none"
  normal: NormalFilter;
  origin: OriginFilter;
  movement: MovementFilter;
  issue: IssueFilter;
  hideZero: boolean;
}

export const EMPTY_FILTERS: CoaFilters = {
  search: "",
  type: "all",
  level: "all",
  kind: "all",
  status: "all",
  section: "all",
  normal: "all",
  origin: "all",
  movement: "all",
  issue: "all",
  hideZero: false,
};

/** How many filters are narrowing the view (drives the "clear filters" chip). */
export function activeFilterCount(f: CoaFilters): number {
  let n = 0;
  if (f.search.trim()) n += 1;
  if (f.type !== "all") n += 1;
  if (f.level !== "all") n += 1;
  if (f.kind !== "all") n += 1;
  if (f.status !== "all") n += 1;
  if (f.section !== "all") n += 1;
  if (f.normal !== "all") n += 1;
  if (f.origin !== "all") n += 1;
  if (f.movement !== "all") n += 1;
  if (f.issue !== "all") n += 1;
  if (f.hideZero) n += 1;
  return n;
}

export function isDefaultFilters(f: CoaFilters): boolean {
  return activeFilterCount(f) === 0;
}

export interface FilterContext {
  accounts: GlAccount[];
  byParent: Map<string, GlAccount[]>;
  rollups: Map<string, number>;
  health: CoaHealth;
}

/** Does this account survive the current filter set? */
export function accountPasses(account: GlAccount, ctx: FilterContext, f: CoaFilters): boolean {
  if (!accountMatches(account, f.search)) return false;
  if (f.type !== "all" && account.type !== f.type) return false;
  if (f.level !== "all" && account.level !== f.level) return false;

  const hasChildren = (ctx.byParent.get(account.id) ?? []).length > 0;
  const posting = isPostingAccount(account, hasChildren);
  if (f.kind === "posting" && !posting) return false;
  if (f.kind === "control" && posting) return false;

  if (f.status !== "all") {
    // `status` (0028) is richer than `is_active`, but a server that has not
    // surfaced the column yet only ever answers the boolean — so derive it.
    const status = account.status ?? (account.isActive ? "active" : "archived");
    if (f.status === "inactive") {
      if (account.isActive && status === "active") return false;
    } else if (status !== f.status) return false;
  }

  if (f.section !== "all") {
    const section = account.reportSection ?? "";
    if (f.section === "none" ? section !== "" : section !== f.section) return false;
  }

  if (f.normal !== "all" && normalSide(account) !== f.normal) return false;

  if (f.origin !== "all") {
    const system = isSystemRoot(account, ctx.accounts) || account.systemManaged === true;
    if (f.origin === "system" && !system) return false;
    if (f.origin === "custom" && system) return false;
  }

  if (f.movement === "with" && account.movementCount <= 0) return false;
  if (f.movement === "without" && account.movementCount > 0) return false;

  if (f.issue !== "all") {
    const issues = ctx.health.byAccount.get(account.id) ?? [];
    if (f.issue === "any" ? issues.length === 0 : !issues.includes(f.issue)) return false;
  }

  if (f.hideZero) {
    const shown = nodeDisplayBalance(account, account.level - 1, hasChildren, ctx.rollups);
    if (Math.abs(shown) < ZERO_EPSILON) return false;
  }

  return true;
}

/** Ids of every account passing the filters (null when nothing is filtering). */
export function matchingIds(ctx: FilterContext, f: CoaFilters): Set<string> | null {
  if (isDefaultFilters(f)) return null;
  const out = new Set<string>();
  for (const a of ctx.accounts) if (accountPasses(a, ctx, f)) out.add(a.id);
  return out;
}

/** KPI counters for the list header. Computed once over the whole chart. */
export interface CoaKpis {
  total: number;
  control: number;
  posting: number;
  inactive: number;
  issues: number;
  unmapped: number;
  abnormal: number;
}

export function computeKpis(ctx: FilterContext): CoaKpis {
  let control = 0;
  let posting = 0;
  let inactive = 0;
  for (const a of ctx.accounts) {
    const hasChildren = (ctx.byParent.get(a.id) ?? []).length > 0;
    if (isPostingAccount(a, hasChildren)) posting += 1;
    else control += 1;
    const status = a.status ?? (a.isActive ? "active" : "archived");
    if (!a.isActive || status !== "active") inactive += 1;
  }
  return {
    total: ctx.accounts.length,
    control,
    posting,
    inactive,
    issues: ctx.health.totalIssues,
    unmapped: ctx.health.unmapped.length,
    abnormal: ctx.health.abnormal.length,
  };
}

/** Distinct statement sections present in the chart (for the section filter). */
export function sectionOptions(accounts: GlAccount[]): string[] {
  const set = new Set<string>();
  for (const a of accounts) if (a.reportSection) set.add(a.reportSection);
  return [...set].sort();
}

/** Distinct levels present, ascending (for the level filter). */
export function levelOptions(accounts: GlAccount[]): number[] {
  const set = new Set<number>();
  for (const a of accounts) set.add(a.level);
  return [...set].sort((x, y) => x - y);
}

export { isAbnormalBalance };
