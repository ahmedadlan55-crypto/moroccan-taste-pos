// ── Chart-of-Accounts shared model helpers ─────────────────────────────────
// Small, dependency-free utilities shared by the tree, detail and form. Keeps
// the four screen files lean: tree building from the FLAT account list, rollup
// balances, folder detection and the tri-color money cell all live here.

import { cn } from "@/shared/lib";
import type { GlAccount } from "../api";

/** Top-level account codes (الأصول/الالتزامات/حقوق الملكية/الإيرادات/المصروفات). */
export const ROOT_CODES = new Set(["1", "2", "3", "4", "5"]);

// English-digit, 2-decimal grouping — matches the app-wide numbering policy
// (English numerals inside the RTL layout).
const MONEY_FMT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export function fmtMoney(value: number | null | undefined): string {
  return MONEY_FMT.format(Number(value) || 0);
}

/** Sort by displayOrder (null → last) then code, matching the legacy tree order. */
export function sortAccounts(list: GlAccount[]): GlAccount[] {
  return [...list].sort((a, b) => {
    const ao = a.displayOrder;
    const bo = b.displayOrder;
    if (ao == null && bo != null) return 1;
    if (ao != null && bo == null) return -1;
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    return a.code.localeCompare(b.code);
  });
}

/** Map parentId → sorted children, built from the flat list. */
export function buildChildrenMap(accounts: GlAccount[]): Map<string, GlAccount[]> {
  const byParent = new Map<string, GlAccount[]>();
  for (const a of accounts) {
    if (!a.parentId) continue;
    const bucket = byParent.get(a.parentId);
    if (bucket) bucket.push(a);
    else byParent.set(a.parentId, [a]);
  }
  for (const [key, list] of byParent) byParent.set(key, sortAccounts(list));
  return byParent;
}

/** The tree roots: codes 1..5 → level===1 → parentId==null (in that order). */
export function getRoots(accounts: GlAccount[]): GlAccount[] {
  let roots = accounts.filter((a) => ROOT_CODES.has(a.code));
  if (roots.length === 0) roots = accounts.filter((a) => a.level === 1);
  if (roots.length === 0) roots = accounts.filter((a) => a.parentId == null);
  return sortAccounts(roots);
}

/** A node is a folder when flagged, or a root code, or it has children. */
export function isFolderAccount(account: GlAccount, hasChildren: boolean): boolean {
  return account.isFolder || ROOT_CODES.has(account.code) || hasChildren;
}

/** Rollup balance per account: self.balance + Σ descendants.balance (memoized). */
export function computeRollups(
  accounts: GlAccount[],
  byParent: Map<string, GlAccount[]>,
): Map<string, number> {
  const memo = new Map<string, number>();
  const roll = (account: GlAccount, stack: Set<string>): number => {
    const cached = memo.get(account.id);
    if (cached != null) return cached;
    if (stack.has(account.id)) return Number(account.balance) || 0; // cycle guard
    stack.add(account.id);
    let sum = Number(account.balance) || 0;
    for (const child of byParent.get(account.id) ?? []) sum += roll(child, stack);
    stack.delete(account.id);
    memo.set(account.id, sum);
    return sum;
  };
  for (const a of accounts) roll(a, new Set());
  return memo;
}

/** All descendant ids of an account (excluding itself) — used to forbid cycles. */
export function descendantIds(id: string, byParent: Map<string, GlAccount[]>): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const child of byParent.get(pid) ?? []) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/**
 * The balance to SHOW for a node: rollup for folders at depth ≤ 2, own balance
 * for leaves (and deeper folders). `depth` is 0 for roots.
 */
export function nodeDisplayBalance(
  account: GlAccount,
  depth: number,
  hasChildren: boolean,
  rollups: Map<string, number>,
): number {
  if (isFolderAccount(account, hasChildren) && depth <= 2) {
    return rollups.get(account.id) ?? account.balance;
  }
  return Number(account.balance) || 0;
}

/** True when the query matches the account's Arabic name or code (case-insensitive). */
export function accountMatches(account: GlAccount, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    account.nameAr.toLowerCase().includes(q) || account.code.toLowerCase().includes(q)
  );
}

/** Signed money cell: LTR + tabular, positive → emerald, negative → rose, ~0 → slate. */
export function Money({
  value,
  className,
  strong = false,
}: {
  value: number | null | undefined;
  className?: string;
  strong?: boolean;
}) {
  const n = Number(value) || 0;
  const tone =
    Math.abs(n) < 0.005 ? "text-slate-400" : n > 0 ? "text-emerald-600" : "text-rose-600";
  return (
    <span
      dir="ltr"
      className={cn("tabular-nums", strong ? "font-extrabold" : "font-semibold", tone, className)}
    >
      {fmtMoney(n)}
    </span>
  );
}
