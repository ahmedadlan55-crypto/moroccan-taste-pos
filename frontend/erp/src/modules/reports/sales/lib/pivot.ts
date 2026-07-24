// Sales Analytics Hub — pure pivot-tree math (no React).
//
// buildTree() groups flat API rows by the leading row dimensions into a nested
// group tree; every GROUP node carries subtotal values. v1 contract: rows come
// from POST /analytics/query; when the API ships subtotal rows they WIN (the
// server recomputes derived metrics correctly — a ratio is not a sum), and only
// measures the API left uncovered fall back to a null-safe client-side SUM of
// additive values. flattenTree() renders the tree against an expansion set.
//
// Missing-value contract: null means "not computable / masked" and must render
// as "—". Sums skip nulls; a group whose children are ALL null stays null.

export interface PivotSourceRow {
  /** One key per row dimension, in rowDims order. */
  keys: Array<string | number | null>;
  /** Display labels aligned with keys (falls back to String(key)). */
  labels?: string[];
  /** measureId → value (null = not computable → "—"). */
  values: Record<string, number | null>;
}

export interface PivotNode {
  /** Stable path key (dimension keys joined) — the expansion-set member. */
  key: string;
  /** Path keys down to this node (length = level + 1). */
  keys: Array<string | number | null>;
  /** Path labels aligned with keys. */
  labels: string[];
  /** 0-based depth. */
  level: number;
  /** Leaf = an actual API row; group = an aggregation node. */
  isLeaf: boolean;
  /** Leaf values, or the group's subtotal values. */
  values: Record<string, number | null>;
  children: PivotNode[];
}

export interface FlatPivotRow {
  key: string;
  keys: Array<string | number | null>;
  labels: string[];
  level: number;
  /** true on group (subtotal) rows — rendered bold on a tinted background. */
  isSubtotal: boolean;
  hasChildren: boolean;
  isExpanded: boolean;
  values: Record<string, number | null>;
}

/** Path-key separator — a control char no business key contains. */
const SEP = "\u001f";
/** Placeholder for a null key inside a path (distinct from the string "null"). */
const NULL_KEY = "\u0000";

export function pivotPathKey(keys: Array<string | number | null>): string {
  return keys.map((k) => (k == null ? NULL_KEY : String(k))).join(SEP);
}

/** Null-safe sum: skips nulls; ALL-null → null (never a fake 0). */
function sumMeasure(children: PivotNode[], measure: string): number | null {
  let sum = 0;
  let seen = false;
  for (const child of children) {
    const v = child.values[measure];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      seen = true;
    }
  }
  return seen ? sum : null;
}

/**
 * Index API subtotal rows: a subtotal row for a level-g group carries real keys
 * at 0..g and null beyond. Keyed by `${level}:${pathKey}`.
 */
function indexSubtotals(
  subtotals: PivotSourceRow[] | undefined,
  dimCount: number,
): Map<string, PivotSourceRow> {
  const map = new Map<string, PivotSourceRow>();
  for (const row of subtotals ?? []) {
    // Depth = index of the last non-null key.
    let depth = -1;
    for (let i = 0; i < dimCount; i++) {
      if (row.keys[i] != null) depth = i;
    }
    if (depth < 0 || depth >= dimCount - 1) continue; // total row / malformed
    map.set(`${depth}:${pivotPathKey(row.keys.slice(0, depth + 1))}`, row);
  }
  return map;
}

function labelOf(row: PivotSourceRow, i: number): string {
  const label = row.labels?.[i];
  if (label != null && label !== "") return label;
  const key = row.keys[i];
  return key == null ? "—" : String(key);
}

function buildLevel(
  rows: PivotSourceRow[],
  rowDims: string[],
  measures: string[],
  subtotalIndex: Map<string, PivotSourceRow>,
  level: number,
  prefixKeys: Array<string | number | null>,
  prefixLabels: string[],
): PivotNode[] {
  const isLeafLevel = level >= rowDims.length - 1;

  if (isLeafLevel) {
    return rows.map((row) => {
      const keys = [...prefixKeys, row.keys[level] ?? null];
      return {
        key: pivotPathKey(keys),
        keys,
        labels: [...prefixLabels, labelOf(row, level)],
        level,
        isLeaf: true,
        values: row.values,
        children: [],
      };
    });
  }

  // Group by this level's key, preserving first-seen (API sort) order.
  const groups = new Map<string, { rows: PivotSourceRow[]; label: string; key: string | number | null }>();
  for (const row of rows) {
    const key = row.keys[level] ?? null;
    const mapKey = key == null ? NULL_KEY : String(key);
    const existing = groups.get(mapKey);
    if (existing) existing.rows.push(row);
    else groups.set(mapKey, { rows: [row], label: labelOf(row, level), key });
  }

  return [...groups.values()].map((group) => {
    const keys = [...prefixKeys, group.key];
    const labels = [...prefixLabels, group.label];
    const children = buildLevel(group.rows, rowDims, measures, subtotalIndex, level + 1, keys, labels);
    const apiSubtotal = subtotalIndex.get(`${level}:${pivotPathKey(keys)}`);
    const values: Record<string, number | null> = {};
    for (const m of measures) {
      const fromApi = apiSubtotal?.values[m];
      values[m] = fromApi !== undefined ? fromApi : sumMeasure(children, m);
    }
    return {
      key: pivotPathKey(keys),
      keys,
      labels,
      level,
      isLeaf: false,
      values,
      children,
    };
  });
}

/**
 * Build the nested group tree. With a single row dimension the result is a flat
 * list of leaves (no group layer); with N dims, levels 0..N-2 are groups and
 * level N-1 holds the leaves.
 */
export function buildTree(
  rows: PivotSourceRow[],
  rowDims: string[],
  measures: string[],
  subtotals?: PivotSourceRow[],
): PivotNode[] {
  if (rows.length === 0 || rowDims.length === 0) return [];
  const subtotalIndex = indexSubtotals(subtotals, rowDims.length);
  return buildLevel(rows, rowDims, measures, subtotalIndex, 0, [], []);
}

/**
 * Flatten against an expansion set: every node emits one row; a group's
 * children follow only while it is expanded.
 */
export function flattenTree(tree: PivotNode[], expanded: Set<string>): FlatPivotRow[] {
  const out: FlatPivotRow[] = [];
  const walk = (nodes: PivotNode[]) => {
    for (const node of nodes) {
      const isExpanded = !node.isLeaf && expanded.has(node.key);
      out.push({
        key: node.key,
        keys: node.keys,
        labels: node.labels,
        level: node.level,
        isSubtotal: !node.isLeaf,
        hasChildren: node.children.length > 0,
        isExpanded,
        values: node.values,
      });
      if (isExpanded) walk(node.children);
    }
  };
  walk(tree);
  return out;
}
