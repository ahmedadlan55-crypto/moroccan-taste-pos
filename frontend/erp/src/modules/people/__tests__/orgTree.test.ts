import { describe, it, expect } from "vitest";
import {
  buildOrgTree, eligibleManagers, findCycles, flattenTree, matchesQuery, type OrgEmployee,
} from "../lib/orgTree";

function emp(id: string, managerId = "", extra: Partial<OrgEmployee> = {}): OrgEmployee {
  return {
    id, empNumber: id, fullName: id, username: id.toLowerCase(), jobTitle: "",
    managerId, workflowLevel: 1,
    branchId: "", branchName: "", branchCode: "",
    deptId: "", deptName: "", deptCode: "",
    positionId: "", positionName: "",
    permissions: { create: false, approve: false, reject: false, return: false, forward: false, close: false },
    ...extra,
  };
}

describe("findCycles", () => {
  it("finds nothing in a clean hierarchy", () => {
    expect(findCycles([emp("A"), emp("B", "A"), emp("C", "B")])).toEqual([]);
  });

  it("catches a self-managing employee (A→A)", () => {
    expect(findCycles([emp("A", "A")])).toEqual(["A"]);
  });

  it("catches a two-hop cycle (A→B→A)", () => {
    expect(findCycles([emp("A", "B"), emp("B", "A")]).sort()).toEqual(["A", "B"]);
  });

  it("catches a longer cycle and excludes the clean tail hanging off it", () => {
    // A→B→C→A is a cycle; D reports to A but is not itself on the cycle.
    const found = findCycles([emp("A", "B"), emp("B", "C"), emp("C", "A"), emp("D", "A")]);
    expect(found.sort()).toEqual(["A", "B", "C"]);
    expect(found).not.toContain("D");
  });

  it("terminates on a fully cyclic graph", () => {
    const all = [emp("A", "B"), emp("B", "C"), emp("C", "A")];
    expect(findCycles(all).sort()).toEqual(["A", "B", "C"]);
  });

  it("handles two independent cycles", () => {
    const found = findCycles([emp("A", "B"), emp("B", "A"), emp("X", "Y"), emp("Y", "X"), emp("Z")]);
    expect(found.sort()).toEqual(["A", "B", "X", "Y"]);
  });
});

describe("buildOrgTree", () => {
  it("nests children under their manager", () => {
    const t = buildOrgTree([emp("CEO"), emp("VP", "CEO"), emp("Eng", "VP")]);
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0].employee.id).toBe("CEO");
    expect(t.roots[0].children[0].employee.id).toBe("VP");
    expect(t.roots[0].children[0].children[0].employee.id).toBe("Eng");
    expect(t.roots[0].children[0].children[0].depth).toBe(2);
  });

  it("treats managerless employees as roots", () => {
    const t = buildOrgTree([emp("A"), emp("B")]);
    expect(t.roots.map((r) => r.employee.id).sort()).toEqual(["A", "B"]);
  });

  it("surfaces an employee whose manager is not in the active set, instead of dropping them", () => {
    // A naive tree would silently lose B — the row exists but never renders.
    const t = buildOrgTree([emp("A"), emp("B", "GONE")]);
    expect(t.roots.map((r) => r.employee.id)).toEqual(["A"]);
    expect(t.orphans.map((o) => o.employee.id)).toEqual(["B"]);
  });

  it("excludes cyclic employees from the tree and reports them", () => {
    const t = buildOrgTree([emp("A"), emp("X", "Y"), emp("Y", "X")]);
    expect(t.cycleIds.sort()).toEqual(["X", "Y"]);
    expect(t.roots.map((r) => r.employee.id)).toEqual(["A"]);
    const ids = flattenTree(t.roots, new Set()).map((n) => n.employee.id);
    expect(ids).not.toContain("X");
  });

  it("does not hang when EVERY employee is on a cycle", () => {
    const t = buildOrgTree([emp("A", "B"), emp("B", "A")]);
    expect(t.roots).toEqual([]);
    expect(t.cycleIds.sort()).toEqual(["A", "B"]);
  });

  it("orders siblings by workflow level descending", () => {
    const t = buildOrgTree([
      emp("Boss"),
      emp("Junior", "Boss", { workflowLevel: 1 }),
      emp("Senior", "Boss", { workflowLevel: 5 }),
    ]);
    expect(t.roots[0].children.map((c) => c.employee.id)).toEqual(["Senior", "Junior"]);
  });

  it("every employee appears exactly once across roots+orphans+cycles", () => {
    const all = [emp("A"), emp("B", "A"), emp("C", "GONE"), emp("X", "Y"), emp("Y", "X")];
    const t = buildOrgTree(all);
    const rendered = [...flattenTree(t.roots, new Set()), ...flattenTree(t.orphans, new Set())]
      .map((n) => n.employee.id);
    expect([...rendered, ...t.cycleIds].sort()).toEqual(["A", "B", "C", "X", "Y"]);
  });
});

describe("flattenTree", () => {
  const tree = buildOrgTree([emp("A"), emp("B", "A"), emp("C", "B")]);

  it("returns the whole chain when nothing is collapsed", () => {
    expect(flattenTree(tree.roots, new Set()).map((n) => n.employee.id)).toEqual(["A", "B", "C"]);
  });

  it("hides descendants of a collapsed node", () => {
    expect(flattenTree(tree.roots, new Set(["A"])).map((n) => n.employee.id)).toEqual(["A"]);
    expect(flattenTree(tree.roots, new Set(["B"])).map((n) => n.employee.id)).toEqual(["A", "B"]);
  });
});

describe("eligibleManagers", () => {
  it("excludes self", () => {
    const ids = eligibleManagers([emp("A"), emp("B")], "A").map((e) => e.id);
    expect(ids).toEqual(["B"]);
  });

  it("excludes descendants — picking one would close a loop the server refuses", () => {
    const all = [emp("Boss"), emp("Mid", "Boss"), emp("Low", "Mid")];
    const ids = eligibleManagers(all, "Boss").map((e) => e.id);
    expect(ids).toEqual([]);          // both others report up to Boss
    expect(eligibleManagers(all, "Low").map((e) => e.id).sort()).toEqual(["Boss", "Mid"]);
  });
});

describe("matchesQuery", () => {
  const e = emp("E1", "", { fullName: "أحمد عدلان", username: "ahmed", jobTitle: "محاسب", deptName: "المالية" });
  it("matches on name, username, job title and department", () => {
    expect(matchesQuery(e, "أحمد")).toBe(true);
    expect(matchesQuery(e, "AHMED")).toBe(true);
    expect(matchesQuery(e, "محاسب")).toBe(true);
    expect(matchesQuery(e, "المالية")).toBe(true);
  });
  it("returns everything for an empty query and nothing for a miss", () => {
    expect(matchesQuery(e, "  ")).toBe(true);
    expect(matchesQuery(e, "zzz")).toBe(false);
  });
});
