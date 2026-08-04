// ── Chart-of-Accounts shared model helpers ─────────────────────────────────
// Dependency-free utilities shared by the tree, the table, the detail, the
// health page and the forms. Tree building from the FLAT account list, rollup
// balances at every depth, root/folder detection, the natural-balance (Dr/Cr)
// money cell and the structural diagnostics all live here.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
//  1. A ROOT IS A FLAG, NOT A CODE. `is_system_root` (migration 0028) is the
//     authority. The 1..5 code set survives ONLY as a fallback for a server
//     that has not surfaced the column yet — in production the roots are
//     100000..500000, so a hardcoded set hides the entire chart.
//
//  2. EVERY ACCOUNT IS REACHABLE. A parentless account that is not a system
//     root, and an account whose parentId resolves to nothing, are both real
//     defects. They render at the top of the tree carrying an issue badge
//     rather than vanishing — an invisible account cannot be fixed.
//
//  3. SIGN IS NOT A VERDICT. A liability with a credit balance is normal and a
//     contra asset with a credit balance is normal; both are NEGATIVE in the
//     raw debit-minus-credit figure the server sends. Colour follows
//     `isAbnormalBalance`, never the raw sign.

import { cn } from "@/shared/lib";
import { GL_TYPE_NATURE, type GlAccount, type StatementSection } from "../api";

/**
 * Legacy top-level account codes (الأصول/الالتزامات/حقوق الملكية/الإيرادات/
 * المصروفات). FALLBACK ONLY — see rule 1 above. Correct in the dev chart,
 * wrong in production, which is why `is_system_root` outranks it everywhere.
 */
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

/** Below this a balance is treated as zero (money is stored to 2 decimals). */
export const ZERO_EPSILON = 0.005;

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

/**
 * True when this chart states its own roots — i.e. at least one row carries
 * `is_system_root`. Distinguishing "no row has the flag" (fall back) from
 * "rows have the flag and it is false here" (believe it) is the whole point of
 * the column being OPTIONAL in the GlAccount type.
 */
export function hasSystemRootFlag(accounts: GlAccount[]): boolean {
  return accounts.some((a) => a.isSystemRoot === true);
}

/** Is this account one of the five protected class roots? */
export function isSystemRoot(account: GlAccount, accounts?: GlAccount[]): boolean {
  if (account.isSystemRoot === true) return true;
  // Only trust the legacy code set while NOTHING in the chart carries the flag.
  if (accounts && hasSystemRootFlag(accounts)) return false;
  if (account.isSystemRoot === false) return false;
  return ROOT_CODES.has(account.code);
}

/**
 * The five SYSTEM roots: flagged rows when the column is present, else the
 * legacy code set → level 1 → parentless (in that order).
 */
export function getRoots(accounts: GlAccount[]): GlAccount[] {
  const flagged = accounts.filter((a) => a.isSystemRoot === true);
  if (flagged.length > 0) return sortAccounts(flagged);
  let roots = accounts.filter((a) => ROOT_CODES.has(a.code));
  if (roots.length === 0) roots = accounts.filter((a) => a.level === 1);
  if (roots.length === 0) roots = accounts.filter((a) => a.parentId == null);
  return sortAccounts(roots);
}

/**
 * Everything that must render at depth 0: the system roots PLUS every stray
 * root (parentless, not a system root) and every orphan (parentId pointing at
 * an account that does not exist). Rule 2 — the tree shows the chart it HAS,
 * not the chart it wishes it had.
 */
export function getTreeRoots(accounts: GlAccount[]): GlAccount[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const system = getRoots(accounts);
  const systemIds = new Set(system.map((a) => a.id));
  const extras = accounts.filter(
    (a) => !systemIds.has(a.id) && (a.parentId == null || !byId.has(a.parentId)),
  );
  return [...system, ...sortAccounts(extras)];
}

/** A node is a folder when flagged, or a system root, or it has children. */
export function isFolderAccount(account: GlAccount, hasChildren: boolean): boolean {
  return account.isFolder || ROOT_CODES.has(account.code) || account.isSystemRoot === true || hasChildren;
}

/**
 * Can journal entries be posted here? `is_postable` (0028) when the server
 * states it; otherwise the historical rule — not a folder and no children.
 */
export function isPostingAccount(account: GlAccount, hasChildren: boolean): boolean {
  if (account.isPostable !== undefined) return account.isPostable;
  return !isFolderAccount(account, hasChildren);
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
 * The balance to SHOW for a node: the ROLLUP for every folder at EVERY depth,
 * the own balance for posting leaves.
 *
 * This used to read `depth <= 2`, which meant a level-3 group silently showed
 * its own (usually zero) balance while its children carried the money — the
 * deeper the chart, the more of it read as empty. Production's six-digit chart
 * is four and five levels deep, so the cutoff hid most of the totals.
 */
export function nodeDisplayBalance(
  account: GlAccount,
  _depth: number,
  hasChildren: boolean,
  rollups: Map<string, number>,
): number {
  if (isFolderAccount(account, hasChildren)) {
    return rollups.get(account.id) ?? Number(account.balance) ?? 0;
  }
  return Number(account.balance) || 0;
}

// ── Natural balance (Dr/Cr) ─────────────────────────────────────────────────

export type BalanceSide = "debit" | "credit";

function flipSide(side: BalanceSide): BalanceSide {
  return side === "debit" ? "credit" : "debit";
}

/**
 * The side this account NATURALLY sits on.
 *
 * `normal_balance` in 0028 is seeded straight from `type`, so it knows nothing
 * about contra accounts — accumulated depreciation is typed `asset` (debit)
 * yet naturally carries a credit. `is_contra` therefore flips the answer, and
 * that flip is exactly what stops every contra account from being reported as
 * abnormal.
 */
export function normalSide(account: GlAccount): BalanceSide {
  const declared = account.normalBalance;
  const base: BalanceSide =
    declared === "debit" || declared === "credit"
      ? declared
      : (GL_TYPE_NATURE[account.type] ?? "debit");
  return account.isContra ? flipSide(base) : base;
}

/**
 * Convert the server's signed figure (Σ debit − credit) into the amount as the
 * account naturally reads it: positive means "the expected side".
 */
export function naturalAmount(account: GlAccount, signed: number): number {
  return normalSide(account) === "debit" ? signed : -signed;
}

/** A balance is abnormal only when it sits on the side the account never should. */
export function isAbnormalBalance(account: GlAccount, signed: number): boolean {
  return naturalAmount(account, signed) < -ZERO_EPSILON;
}

/** The side a balance ACTUALLY sits on (flipped from normal when abnormal). */
export function actualSide(account: GlAccount, signed: number): BalanceSide {
  const side = normalSide(account);
  return naturalAmount(account, signed) < -ZERO_EPSILON ? flipSide(side) : side;
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * True when the query matches the Arabic name, the ENGLISH name, or the code.
 *
 * nameEn was missing here, so an English-speaking user searching "Cash" got
 * "no matching accounts" on a chart that contains it — while the very same
 * screen was rendering that English name in the tree.
 */
export function accountMatches(account: GlAccount, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    account.nameAr.toLowerCase().includes(q) ||
    account.nameEn.toLowerCase().includes(q) ||
    account.code.toLowerCase().includes(q)
  );
}

/** The name to render for a language, degrading to the other when blank. */
export function accountName(account: GlAccount, lang: string): string {
  if (lang === "en") return account.nameEn || account.nameAr;
  return account.nameAr || account.nameEn;
}

// ── Structural + classification diagnostics ────────────────────────────────

export type CoaIssueKind =
  | "strayRoot"
  | "orphan"
  | "unmapped"
  | "abnormal"
  | "cycle"
  | "missingEnglish"
  | "invalidCode"
  | "nonCanonicalCode"
  | "codeClassMismatch"
  | "levelMismatch"
  | "folderFlagMismatch"
  | "typeMismatch"
  | "statementSectionInvalid"
  | "statementSectionTypeMismatch";

export interface CoaHealth {
  /** Parentless accounts that are not system roots. */
  strayRoots: GlAccount[];
  /** Accounts whose parentId points at an account that does not exist. */
  orphans: GlAccount[];
  /** Posting accounts with no statement section — reports have to guess. */
  unmapped: GlAccount[];
  /** Accounts whose balance sits on the wrong side (contra-aware). */
  abnormal: GlAccount[];
  /** Accounts that are their own ancestor. */
  cycles: GlAccount[];
  /** Accounts that cannot be presented bilingually. */
  missingEnglish: GlAccount[];
  /** Codes outside the governed numeric 1..5 class namespace. */
  invalidCodes: GlAccount[];
  /** Historical numeric codes that remain valid but are not the six-digit house format. */
  nonCanonicalCodes: GlAccount[];
  /** Code prefix disagrees with the account's structural root. */
  codeClassMismatches: GlAccount[];
  /** Stored level disagrees with the parent chain. */
  levelMismatches: GlAccount[];
  /** A row has children but is not explicitly marked as a folder/control. */
  folderFlagMismatches: GlAccount[];
  /** Account type disagrees with its structural root/parent class. */
  typeMismatches: GlAccount[];
  /** Stored report_section is absent from the authoritative catalog. */
  invalidStatementSections: GlAccount[];
  /** Stored report_section belongs to another account type. */
  statementSectionTypeMismatches: GlAccount[];
  /** accountId → the issues it has (drives the tree/table badges). */
  byAccount: Map<string, CoaIssueKind[]>;
  /** Distinct accounts carrying at least one issue. */
  totalIssues: number;
}

/**
 * Every diagnostic in one pass. Deliberately NOT hidden behind a toggle — the
 * screen surfaces the count in the KPI row and badges the rows themselves.
 */
export function computeHealth(
  accounts: GlAccount[],
  byParent: Map<string, GlAccount[]>,
  rollups: Map<string, number>,
  statementSections: StatementSection[] = [],
): CoaHealth {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const systemIds = new Set(getRoots(accounts).map((a) => a.id));

  const strayRoots: GlAccount[] = [];
  const orphans: GlAccount[] = [];
  const unmapped: GlAccount[] = [];
  const abnormal: GlAccount[] = [];
  const cycles: GlAccount[] = [];
  const missingEnglish: GlAccount[] = [];
  const invalidCodes: GlAccount[] = [];
  const nonCanonicalCodes: GlAccount[] = [];
  const codeClassMismatches: GlAccount[] = [];
  const levelMismatches: GlAccount[] = [];
  const folderFlagMismatches: GlAccount[] = [];
  const typeMismatches: GlAccount[] = [];
  const invalidStatementSections: GlAccount[] = [];
  const statementSectionTypeMismatches: GlAccount[] = [];
  const byAccount = new Map<string, CoaIssueKind[]>();

  const flag = (a: GlAccount, kind: CoaIssueKind) => {
    const list = byAccount.get(a.id);
    if (list) {
      if (!list.includes(kind)) list.push(kind);
    } else byAccount.set(a.id, [kind]);
  };

  for (const a of accounts) {
    const hasChildren = (byParent.get(a.id) ?? []).length > 0;

    if (!a.nameEn.trim()) {
      missingEnglish.push(a);
      flag(a, "missingEnglish");
    }
    if (!/^[1-5][0-9]{0,19}$/.test(a.code)) {
      invalidCodes.push(a);
      flag(a, "invalidCode");
    } else if (!/^[1-5][0-9]{5}$/.test(a.code)) {
      // Existing short/long codes remain readable and postable until a
      // governed migration manifest is approved; this is a warning, not an
      // invalid-account verdict and never triggers automatic renumbering.
      nonCanonicalCodes.push(a);
      flag(a, "nonCanonicalCode");
    }
    if (hasChildren && !a.isFolder) {
      folderFlagMismatches.push(a);
      flag(a, "folderFlagMismatch");
    }

    if (a.parentId == null) {
      if (!systemIds.has(a.id)) {
        strayRoots.push(a);
        flag(a, "strayRoot");
      }
    } else if (!byId.has(a.parentId)) {
      orphans.push(a);
      flag(a, "orphan");
    }

    // Cycle: walk up; if we come back to ourselves the chart is self-referential.
    let cursor: string | null | undefined = a.parentId;
    const seen = new Set<string>([a.id]);
    let hops = 0;
    let computedLevel = 1;
    let structuralRoot = a;
    while (cursor && hops < 64) {
      if (cursor === a.id || seen.has(cursor)) {
        cycles.push(a);
        flag(a, "cycle");
        break;
      }
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      computedLevel += 1;
      structuralRoot = parent;
      cursor = parent.parentId ?? null;
      hops += 1;
    }

    if (!byAccount.get(a.id)?.includes("cycle") && Number(a.level) !== computedLevel) {
      levelMismatches.push(a);
      flag(a, "levelMismatch");
    }

    if (!byAccount.get(a.id)?.includes("cycle") && structuralRoot) {
      const expectedClass =
        structuralRoot.classCode ||
        ({ asset: "1", liability: "2", equity: "3", revenue: "4", expense: "5" } as const)[
          structuralRoot.type
        ];
      if (expectedClass && a.code[0] !== expectedClass) {
        codeClassMismatches.push(a);
        flag(a, "codeClassMismatch");
      }
      if (a.type !== structuralRoot.type) {
        typeMismatches.push(a);
        flag(a, "typeMismatch");
      }
    }

    if (isPostingAccount(a, hasChildren) && !a.reportSection) {
      unmapped.push(a);
      flag(a, "unmapped");
    }

    if (a.reportSection && statementSections.length > 0) {
      const aliases: Record<string, string> = {
        vat_input: "input_vat",
        vat_output: "output_vat",
        prepaid: "prepayments",
        customer_deposits: "customer_advances",
        retained: "retained_earnings",
      };
      const sectionId = aliases[a.reportSection] || a.reportSection;
      const section = statementSections.find((item) => item.id === sectionId);
      if (!section) {
        invalidStatementSections.push(a);
        flag(a, "statementSectionInvalid");
      } else {
        let expectedType: GlAccount["type"] | null = null;
        if (section.statement === "income_statement") {
          expectedType = section.group === "revenue" ? "revenue" : "expense";
        } else if (section.statement === "balance_sheet") {
          if (/Assets$/i.test(section.group)) expectedType = "asset";
          else if (/Liabilities$/i.test(section.group)) expectedType = "liability";
          else if (section.group === "equity") expectedType = "equity";
        }
        if (expectedType && a.type !== expectedType) {
          statementSectionTypeMismatches.push(a);
          flag(a, "statementSectionTypeMismatch");
        }
      }
    }

    const shown = nodeDisplayBalance(a, a.level - 1, hasChildren, rollups);
    if (isAbnormalBalance(a, shown)) {
      abnormal.push(a);
      flag(a, "abnormal");
    }
  }

  return {
    strayRoots,
    orphans,
    unmapped,
    abnormal,
    cycles,
    missingEnglish,
    invalidCodes,
    nonCanonicalCodes,
    codeClassMismatches,
    levelMismatches,
    folderFlagMismatches,
    typeMismatches,
    invalidStatementSections,
    statementSectionTypeMismatches,
    byAccount,
    totalIssues: byAccount.size,
  };
}

// ── Money cells ────────────────────────────────────────────────────────────

/**
 * Raw signed amount — LTR + tabular, deliberately TONE-NEUTRAL.
 *
 * It used to paint positive emerald and negative rose, which reported every
 * liability, every equity account and all of revenue as a problem: those are
 * credit-natured, so their normal balance IS negative in Σ(debit − credit).
 * Judging a balance is `BalanceAmount`'s job; this one just prints a number
 * (running ledger balances, debit/credit columns).
 */
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
  return (
    <span
      dir="ltr"
      className={cn(
        "tabular-nums",
        strong ? "font-extrabold" : "font-semibold",
        Math.abs(n) < ZERO_EPSILON ? "text-slate-400" : "text-slate-700",
        className,
      )}
    >
      {fmtMoney(n)}
    </span>
  );
}

export interface BalanceAmountProps {
  account: GlAccount;
  /** The server's signed figure, Σ(debit − credit). */
  value: number | null | undefined;
  /** Localized "Dr" / "Cr" labels — the caller owns t(). */
  debitLabel: string;
  creditLabel: string;
  className?: string;
  strong?: boolean;
  /** Hide the Dr/Cr tag (dense tree rows). */
  hideSide?: boolean;
}

/**
 * The natural balance cell: magnitude + the side it sits on. Rose ONLY when
 * the balance is genuinely abnormal for this account (contra-aware), never for
 * the raw sign.
 */
export function BalanceAmount({
  account,
  value,
  debitLabel,
  creditLabel,
  className,
  strong = false,
  hideSide = false,
}: BalanceAmountProps) {
  const signed = Number(value) || 0;
  const natural = naturalAmount(account, signed);
  const abnormal = isAbnormalBalance(account, signed);
  const zero = Math.abs(natural) < ZERO_EPSILON;
  const side = actualSide(account, signed);
  const tone = abnormal ? "text-rose-600" : zero ? "text-slate-400" : "text-slate-700";

  return (
    <span className={cn("inline-flex items-baseline gap-1", className)}>
      <span
        dir="ltr"
        className={cn("tabular-nums", strong ? "font-extrabold" : "font-semibold", tone)}
      >
        {fmtMoney(Math.abs(natural))}
      </span>
      {!hideSide && !zero && (
        <span
          className={cn(
            "text-[10px] font-extrabold uppercase tracking-wide",
            abnormal ? "text-rose-500" : "text-slate-400",
          )}
        >
          {side === "debit" ? debitLabel : creditLabel}
        </span>
      )}
    </span>
  );
}
