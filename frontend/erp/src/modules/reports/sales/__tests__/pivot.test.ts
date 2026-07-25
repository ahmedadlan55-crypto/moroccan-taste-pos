// Sales Analytics Hub — pure pivot math: grouping, null-safe subtotal sums,
// API-subtotal precedence, and expansion-driven flattening.
import { describe, expect, it } from "vitest";
import { buildTree, flattenTree, pivotPathKey, type PivotSourceRow } from "../lib/pivot";

const ROWS: PivotSourceRow[] = [
  { keys: ["b1", "i1"], labels: ["فرع الرياض", "شاورما"], values: { net: 100, qty: 2 } },
  { keys: ["b1", "i2"], labels: ["فرع الرياض", "برجر"], values: { net: 50, qty: 1 } },
  { keys: ["b2", "i1"], labels: ["فرع جدة", "شاورما"], values: { net: 30, qty: null } },
];

describe("buildTree", () => {
  it("groups by the outer dimension and sums subtotals null-safely", () => {
    const tree = buildTree(ROWS, ["branch", "menu_item"], ["net", "qty"]);
    expect(tree).toHaveLength(2);

    const [b1, b2] = tree;
    expect(b1.isLeaf).toBe(false);
    expect(b1.labels).toEqual(["فرع الرياض"]);
    expect(b1.values).toEqual({ net: 150, qty: 3 });
    expect(b1.children).toHaveLength(2);
    expect(b1.children[0].isLeaf).toBe(true);
    expect(b1.children[0].labels).toEqual(["فرع الرياض", "شاورما"]);

    // qty for b2 is null on its only child → subtotal stays null, NEVER 0.
    expect(b2.values).toEqual({ net: 30, qty: null });
  });

  it("prefers API subtotal rows and falls back per-measure", () => {
    const subtotals: PivotSourceRow[] = [
      // Server subtotal for the b1 group: net provided, qty NOT provided.
      { keys: ["b1", null], values: { net: 149 } },
    ];
    const tree = buildTree(ROWS, ["branch", "menu_item"], ["net", "qty"], subtotals);
    const b1 = tree[0];
    expect(b1.values.net).toBe(149); // API value wins (derived metrics aren't sums)
    expect(b1.values.qty).toBe(3); // uncovered measure → client-side sum
  });

  // Mutation gap (PV-06): an API subtotal whose value is EXPLICITLY null means
  // "not computable / masked" and must WIN over the client-side sum — only a
  // measure the API left `undefined` may fall back. `!= null` instead of
  // `!== undefined` would silently replace the server's honest null with a sum.
  it("an explicit null API subtotal wins over the client-side sum (masked stays masked)", () => {
    const subtotals: PivotSourceRow[] = [
      { keys: ["b1", null], values: { net: null } }, // masked on the server
    ];
    const tree = buildTree(ROWS, ["branch", "menu_item"], ["net", "qty"], subtotals);
    const b1 = tree[0];
    expect(b1.values.net).toBeNull(); // NOT 150 — the API's null is authoritative
    expect(b1.values.qty).toBe(3); // undefined on the API row → client sum
  });

  // Mutation gap (PV-11): rows without a `labels` array must fall back to
  // String(key), and a null key must render the "—" placeholder — never leak
  // undefined into the label path.
  it("labels fall back to String(key) when the API sends no labels, and '—' for null keys", () => {
    const unlabeled: PivotSourceRow[] = [
      { keys: ["b1", "i1"], values: { net: 10 } },
      { keys: ["b1", null], values: { net: 5 } },
    ];
    const tree = buildTree(unlabeled, ["branch", "menu_item"], ["net"]);
    expect(tree[0].labels).toEqual(["b1"]); // group label = String(key)
    expect(tree[0].children[0].labels).toEqual(["b1", "i1"]);
    expect(tree[0].children[1].labels).toEqual(["b1", "—"]); // null key placeholder
  });

  it("returns flat leaves for a single row dimension", () => {
    const tree = buildTree(ROWS, ["branch"], ["net"]);
    expect(tree.every((n) => n.isLeaf)).toBe(true);
    expect(tree).toHaveLength(3);
  });

  it("returns [] on no rows or no dims", () => {
    expect(buildTree([], ["branch"], ["net"])).toEqual([]);
    expect(buildTree(ROWS, [], ["net"])).toEqual([]);
  });
});

describe("flattenTree", () => {
  const tree = buildTree(ROWS, ["branch", "menu_item"], ["net", "qty"]);

  it("collapsed: emits only the group (subtotal) rows", () => {
    const flat = flattenTree(tree, new Set());
    expect(flat.map((r) => r.isSubtotal)).toEqual([true, true]);
    expect(flat.map((r) => r.isExpanded)).toEqual([false, false]);
    expect(flat.map((r) => r.hasChildren)).toEqual([true, true]);
  });

  it("expanding a group inserts its children directly after it", () => {
    const b1Key = pivotPathKey(["b1"]);
    const flat = flattenTree(tree, new Set([b1Key]));
    expect(flat.map((r) => [r.isSubtotal, r.labels[r.level]])).toEqual([
      [true, "فرع الرياض"],
      [false, "شاورما"],
      [false, "برجر"],
      [true, "فرع جدة"],
    ]);
    expect(flat[0].isExpanded).toBe(true);
    expect(flat[1].level).toBe(1);
  });

  it("subtotal math survives the flatten (group rows carry the sums)", () => {
    const flat = flattenTree(tree, new Set());
    expect(flat[0].values).toEqual({ net: 150, qty: 3 });
    expect(flat[1].values).toEqual({ net: 30, qty: null });
  });
});
