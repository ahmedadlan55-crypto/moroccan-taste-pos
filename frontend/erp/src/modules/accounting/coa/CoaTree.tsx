// ── CoaTree — a REAL accessible tree over the chart of accounts ─────────────
// Presentational: the page owns search, filters, the open-set and selection.
//
// WHAT CHANGED AND WHY IT MATTERS
//
// The previous tree was a nest of `<div role="button" tabIndex={0}>`. To a
// screen reader that is a pile of unrelated buttons — no depth, no parent, no
// "3 of 12", no expanded state — and to a keyboard user it is one Tab stop per
// account, which on production's ~600-account chart means 600 stops to reach
// the bottom. This is the WAI-ARIA tree pattern instead:
//
//   * role="tree" > role="treeitem" > role="group" > role="treeitem" …
//   * aria-level / aria-posinset / aria-setsize / aria-expanded / aria-selected
//   * ONE tab stop for the whole tree (roving tabindex), arrows to move
//   * ArrowUp/ArrowDown/Home/End walk the VISIBLE rows; the expand/collapse
//     arrows are direction-aware, because in RTL "forward" is ArrowLeft.

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import { Badge } from "@/shared/ui";
import { cn } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
import type { GlAccount } from "../api";
import {
  BalanceAmount,
  accountName,
  buildChildrenMap,
  computeRollups,
  getTreeRoots,
  isFolderAccount,
  nodeDisplayBalance,
} from "./coaModel";

export interface CoaTreeProps {
  /** The FULL chart — the tree needs it to resolve parents of matches. */
  accounts: GlAccount[];
  /** Ids passing the page's search + filters; null means "no filtering". */
  matchIds: Set<string> | null;
  /** Search/explicit filters open ancestor chains; a default lifecycle scope does not. */
  forceOpenMatches?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Enter / double-click — open the routed detail page. */
  onActivate?: (id: string) => void;
  openIds: Set<string>;
  onToggle: (id: string) => void;
  /** Hide rows whose displayed balance rounds to zero. */
  hideZero?: boolean;
  className?: string;
  emptyLabel?: string;
}

interface FlatRow {
  account: GlAccount;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  posinset: number;
  setsize: number;
  parentId: string | null;
}

export function CoaTree({
  accounts,
  matchIds,
  forceOpenMatches = true,
  selectedId,
  onSelect,
  onActivate,
  openIds,
  onToggle,
  hideZero = false,
  className,
  emptyLabel,
}: CoaTreeProps) {
  const t = useT();
  const lang = useLang();
  const rtl = lang !== "en";
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const byParent = useMemo(() => buildChildrenMap(accounts), [accounts]);
  const rollups = useMemo(() => computeRollups(accounts, byParent), [accounts, byParent]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const roots = useMemo(() => getTreeRoots(accounts), [accounts]);

  // Filtering keeps every match REACHABLE: the match plus its whole ancestor
  // chain stays visible, and those ancestors are force-open. Hiding a parent
  // would hide the match with it.
  const { visible, forceOpen } = useMemo(() => {
    if (!matchIds) return { visible: null as Set<string> | null, forceOpen: null as Set<string> | null };
    const vis = new Set<string>();
    const open = new Set<string>();
    for (const id of matchIds) {
      vis.add(id);
      let cursor = byId.get(id)?.parentId ?? null;
      let hops = 0;
      while (cursor && hops < 64) {
        if (forceOpenMatches) open.add(cursor);
        if (vis.has(cursor)) break;
        vis.add(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
        hops += 1;
      }
    }
    return { visible: vis, forceOpen: open };
  }, [matchIds, byId, forceOpenMatches]);

  const isOpen = useCallback(
    (id: string) => (forceOpen ? forceOpen.has(id) || openIds.has(id) : openIds.has(id)),
    [forceOpen, openIds],
  );

  // The visible rows in DOM order — one array drives BOTH rendering and every
  // keyboard move, so the two can never disagree about what "next row" means.
  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    const walk = (list: GlAccount[], depth: number, parentId: string | null) => {
      const shown = list.filter((a) => {
        if (visible && !visible.has(a.id)) return false;
        if (hideZero) {
          const kids = (byParent.get(a.id) ?? []).length > 0;
          const bal = nodeDisplayBalance(a, depth, kids, rollups);
          // A zero-balance folder still matters when something under it is not
          // zero, so only leaves are dropped.
          if (Math.abs(bal) < 0.005 && !kids) return false;
        }
        return true;
      });
      shown.forEach((a, i) => {
        const children = byParent.get(a.id) ?? [];
        const hasChildren = children.length > 0;
        const expanded = hasChildren && isOpen(a.id);
        out.push({
          account: a,
          depth,
          hasChildren,
          expanded,
          posinset: i + 1,
          setsize: shown.length,
          parentId,
        });
        if (expanded) walk(children, depth + 1, a.id);
      });
    };
    walk(roots, 0, null);
    return out;
  }, [roots, byParent, visible, isOpen, hideZero, rollups]);

  const order = useMemo(() => rows.map((r) => r.account.id), [rows]);
  // The single tab stop: the selection when it is on screen, else the first row.
  const tabStopId = selectedId && order.includes(selectedId) ? selectedId : (order[0] ?? null);

  const focusRow = useCallback((id: string | undefined) => {
    if (!id) return;
    rowRefs.current.get(id)?.focus();
  }, []);

  // Keydown lives on the TREE, not on each item: a handler per row would fire
  // again on every ancestor as the event bubbles, and a single flat order is
  // the only way Home/End can mean what they say.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const active = document.activeElement as HTMLElement | null;
      const id = active?.getAttribute("data-account-id");
      if (!id) return;
      const idx = order.indexOf(id);
      if (idx < 0) return;
      const row = rows[idx];
      const expandKey = rtl ? "ArrowLeft" : "ArrowRight";
      const collapseKey = rtl ? "ArrowRight" : "ArrowLeft";

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          focusRow(order[Math.min(idx + 1, order.length - 1)]);
          break;
        case "ArrowUp":
          e.preventDefault();
          focusRow(order[Math.max(idx - 1, 0)]);
          break;
        case "Home":
          e.preventDefault();
          focusRow(order[0]);
          break;
        case "End":
          e.preventDefault();
          focusRow(order[order.length - 1]);
          break;
        case expandKey:
          e.preventDefault();
          if (row.hasChildren && !row.expanded) onToggle(id);
          else if (row.hasChildren && row.expanded) focusRow(order[idx + 1]);
          break;
        case collapseKey:
          e.preventDefault();
          if (row.hasChildren && row.expanded) onToggle(id);
          else if (row.parentId) focusRow(row.parentId);
          break;
        case "Enter":
          e.preventDefault();
          onSelect(id);
          onActivate?.(id);
          break;
        case " ":
        case "Spacebar":
          e.preventDefault();
          onSelect(id);
          break;
        default:
          break;
      }
    },
    [order, rows, rtl, onToggle, onSelect, onActivate, focusRow],
  );

  // Drop refs for rows that are gone, so the map cannot grow without bound
  // across filter changes on a large chart.
  useEffect(() => {
    const live = new Set(order);
    for (const key of rowRefs.current.keys()) if (!live.has(key)) rowRefs.current.delete(key);
  }, [order]);

  if (rows.length === 0) {
    return (
      <p className={cn("px-3 py-10 text-center text-sm font-medium text-slate-400", className)}>
        {emptyLabel ?? t("accounting.coa.noMatches")}
      </p>
    );
  }

  // Render NESTED (treeitem > group > treeitem) rather than flat, so assistive
  // tech gets the containment relationship and not just an aria-level number.
  // `rows` is still the flat visible order the keyboard handler walks — one
  // source of truth, two consumers.
  let cursor = 0;
  const renderLevel = (depth: number): JSX.Element[] => {
    const out: JSX.Element[] = [];
    while (cursor < rows.length && rows[cursor].depth === depth) {
      const row = rows[cursor];
      cursor += 1;
      const a = row.account;
      const folder = isFolderAccount(a, row.hasChildren);
      const selected = selectedId === a.id;
      const balance = nodeDisplayBalance(a, row.depth, row.hasChildren, rollups);
      const inactive = !a.isActive || a.status === "archived";
      const children = row.expanded ? renderLevel(depth + 1) : [];

      out.push(
        <div
          key={a.id}
          role="treeitem"
          data-account-id={a.id}
          aria-level={row.depth + 1}
          aria-posinset={row.posinset}
          aria-setsize={row.setsize}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-selected={selected}
          tabIndex={tabStopId === a.id ? 0 : -1}
          ref={(el) => {
            if (el) rowRefs.current.set(a.id, el);
            else rowRefs.current.delete(a.id);
          }}
          // stopPropagation, because a child treeitem is nested INSIDE its
          // parent treeitem: without it one click would select the whole
          // ancestor chain, deepest-last.
          onClick={(e) => {
            e.stopPropagation();
            onSelect(a.id);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onActivate?.(a.id);
          }}
          className="group/item block outline-none"
        >
          <div
            style={{ paddingInlineStart: `${row.depth * 1.15 + 0.25}rem` }}
            className={cn(
              // min-h-11 = the 44px touch target the design system mandates.
              "flex min-h-11 cursor-pointer items-center gap-2 rounded-xl py-2 pe-1 ps-2 transition",
              selected ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-slate-50",
              "group-focus-visible/item:ring-4 group-focus-visible/item:ring-teal-100",
            )}
          >
            {row.hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                aria-label={row.expanded ? t("accounting.coa.collapse") : t("accounting.coa.expand")}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(a.id);
                }}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
              >
                {row.expanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : rtl ? (
                  <ChevronLeft className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
            ) : (
              <span className="h-6 w-6 shrink-0" aria-hidden="true" />
            )}

            <span
              className={cn(
                "grid h-7 w-7 shrink-0 place-items-center rounded-lg",
                folder ? "bg-teal-50 text-teal-700" : "bg-slate-100 text-slate-500",
              )}
              aria-hidden="true"
            >
              {folder ? (
                row.expanded ? (
                  <FolderOpen className="h-4 w-4" />
                ) : (
                  <Folder className="h-4 w-4" />
                )
              ) : (
                <FileText className="h-4 w-4" />
              )}
            </span>

            <span dir="ltr" className="shrink-0 font-mono text-xs font-bold tabular-nums text-slate-400">
              {a.code}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                selected ? "font-extrabold text-teal-800" : "font-bold text-slate-700",
              )}
            >
              {accountName(a, lang)}
            </span>

            {inactive && (
              <Badge tone="neutral" className="shrink-0">
                {t("accounting.common.suspended")}
              </Badge>
            )}
            <BalanceAmount
              account={a}
              value={balance}
              debitLabel={t("accounting.coa.dr")}
              creditLabel={t("accounting.coa.cr")}
              className="shrink-0 text-xs"
            />
          </div>

          {children.length > 0 && (
            <div role="group" aria-label={accountName(a, lang)}>
              {children}
            </div>
          )}
        </div>,
      );
    }
    return out;
  };

  const tree = renderLevel(0);

  return (
    <div
      role="tree"
      aria-label={t("accounting.coa.treeAria")}
      className={cn("min-w-0", className)}
      onKeyDown={onKeyDown}
    >
      {tree}
    </div>
  );
}

export default CoaTree;
