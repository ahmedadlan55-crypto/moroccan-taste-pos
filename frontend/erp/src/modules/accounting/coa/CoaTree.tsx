// ── CoaTree — the left pane: type chips + search + a collapsible account tree ─
// Builds the tree from the FLAT account list (parentId), shows a rollup balance
// on folders, and keeps matches reachable (matches + ancestors, auto-expanded)
// while searching. The page owns selection / filter / search state.

import { useEffect, useMemo, useRef } from "react";
import { ChevronDown, ChevronLeft, FileText, Folder, FolderOpen, Search } from "lucide-react";
import { Badge, Card, Input } from "@/shared/ui";
import { useLocalStorage } from "@/shared/hooks";
import { cn } from "@/shared/lib";
import {
  GL_ACCOUNT_TYPES,
  GL_TYPE_LABEL,
  type GlAccount,
  type GlAccountType,
} from "../api";
import {
  Money,
  accountMatches,
  buildChildrenMap,
  computeRollups,
  getRoots,
  isFolderAccount,
  nodeDisplayBalance,
} from "./coaModel";

type TypeFilter = GlAccountType | "all";

export interface CoaTreeProps {
  accounts: GlAccount[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  typeFilter: TypeFilter;
  onTypeFilter: (value: TypeFilter) => void;
  search: string;
  onSearch: (value: string) => void;
}

interface NodeCtx {
  byParent: Map<string, GlAccount[]>;
  rollups: Map<string, number>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  searching: boolean;
  visible: Set<string>;
}

export function CoaTree({
  accounts,
  selectedId,
  onSelect,
  typeFilter,
  onTypeFilter,
  search,
  onSearch,
}: CoaTreeProps) {
  const byParent = useMemo(() => buildChildrenMap(accounts), [accounts]);
  const rollups = useMemo(() => computeRollups(accounts, byParent), [accounts, byParent]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const roots = useMemo(() => {
    const all = getRoots(accounts);
    return typeFilter === "all" ? all : all.filter((r) => r.type === typeFilter);
  }, [accounts, typeFilter]);

  // Per-type counts for the filter chips.
  const counts = useMemo(() => {
    const map = new Map<TypeFilter, number>();
    map.set("all", accounts.length);
    for (const t of GL_ACCOUNT_TYPES) map.set(t, 0);
    for (const a of accounts) map.set(a.type, (map.get(a.type) ?? 0) + 1);
    return map;
  }, [accounts]);

  // Search → matches + their ancestors are visible; ancestors are force-open.
  const searching = search.trim().length > 0;
  const { visible, forceOpen } = useMemo(() => {
    const vis = new Set<string>();
    const open = new Set<string>();
    if (!searching) return { visible: vis, forceOpen: open };
    for (const a of accounts) {
      if (!accountMatches(a, search)) continue;
      vis.add(a.id);
      let cur: GlAccount | undefined = a;
      while (cur?.parentId) {
        const parent = byId.get(cur.parentId);
        if (!parent || vis.has(parent.id)) {
          if (parent) open.add(parent.id);
          break;
        }
        vis.add(parent.id);
        open.add(parent.id);
        cur = parent;
      }
    }
    return { visible: vis, forceOpen: open };
  }, [accounts, byId, search, searching]);

  // Persisted open-set; seed with the roots on first load so the tree opens expanded.
  const [openArr, setOpenArr] = useLocalStorage<string[]>("erp.coa.open", []);
  const openSet = useMemo(() => new Set(openArr), [openArr]);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || accounts.length === 0) return;
    seeded.current = true;
    if (openArr.length === 0) setOpenArr(getRoots(accounts).map((r) => r.id));
  }, [accounts, openArr.length, setOpenArr]);

  const ctx: NodeCtx = {
    byParent,
    rollups,
    selectedId,
    onSelect,
    isOpen: (id) => (searching ? forceOpen.has(id) : openSet.has(id)),
    toggle: (id) =>
      setOpenArr((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    searching,
    visible,
  };

  const visibleRoots = searching ? roots.filter((r) => visible.has(r.id)) : roots;

  const chips: Array<{ key: TypeFilter; label: string }> = [
    { key: "all", label: "الكل" },
    ...GL_ACCOUNT_TYPES.map((t) => ({ key: t as TypeFilter, label: GL_TYPE_LABEL[t] })),
  ];

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-slate-100 p-4">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {chips.map((c) => {
            const active = typeFilter === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => onTypeFilter(c.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
                  active
                    ? "border-teal-200 bg-teal-50 text-teal-700"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700",
                )}
                aria-pressed={active}
              >
                {c.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] font-extrabold tabular-nums",
                    active ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-500",
                  )}
                >
                  {counts.get(c.key) ?? 0}
                </span>
              </button>
            );
          })}
        </div>
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="بحث بالاسم أو الرمز…"
          leading={<Search className="h-4 w-4" />}
          aria-label="بحث في دليل الحسابات"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visibleRoots.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm font-medium text-slate-400">
            {searching || typeFilter !== "all" ? "لا توجد حسابات مطابقة." : "لا توجد حسابات بعد."}
          </p>
        ) : (
          visibleRoots.map((root) => <CoaNode key={root.id} node={root} depth={0} ctx={ctx} />)
        )}
      </div>
    </Card>
  );
}

function CoaNode({ node, depth, ctx }: { node: GlAccount; depth: number; ctx: NodeCtx }) {
  const children = ctx.byParent.get(node.id) ?? [];
  const hasChildren = children.length > 0;
  const visibleChildren = ctx.searching
    ? children.filter((c) => ctx.visible.has(c.id))
    : children;
  const folder = isFolderAccount(node, hasChildren);
  const open = ctx.isOpen(node.id);
  const selected = ctx.selectedId === node.id;
  const balance = nodeDisplayBalance(node, depth, hasChildren, ctx.rollups);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => ctx.onSelect(node.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            ctx.onSelect(node.id);
          }
        }}
        style={{ paddingInlineStart: `${depth * 1.15 + 0.25}rem` }}
        className={cn(
          "group flex cursor-pointer items-center gap-2 rounded-xl py-2 pl-2 pr-1 transition",
          selected ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-slate-50",
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? "طيّ" : "توسيع"}
            onClick={(e) => {
              e.stopPropagation();
              ctx.toggle(node.id);
            }}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600"
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
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
            open && hasChildren ? (
              <FolderOpen className="h-4 w-4" />
            ) : (
              <Folder className="h-4 w-4" />
            )
          ) : (
            <FileText className="h-4 w-4" />
          )}
        </span>

        <span dir="ltr" className="shrink-0 font-mono text-xs font-bold text-slate-400 tabular-nums">
          {node.code}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            selected ? "font-extrabold text-teal-800" : "font-bold text-slate-700",
          )}
        >
          {node.nameAr}
        </span>

        {!node.isActive && (
          <Badge tone="neutral" className="shrink-0">
            متوقّف
          </Badge>
        )}
        <Money value={balance} className="shrink-0 text-xs" />
      </div>

      {open && hasChildren && (
        <div>
          {visibleChildren.map((child) => (
            <CoaNode key={child.id} node={child} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

export default CoaTree;
