// Org chart — types + tree assembly, kept pure so the hierarchy logic is
// unit-tested rather than trusted.
//
// Why cycle detection is not optional: `hr_employees.manager_id` is a
// self-reference with NO foreign key, and until v4 the API validated nothing —
// A→A and A→B→A were both storable. The server now refuses to CREATE a cycle,
// but it cannot un-store one that predates the guard, and nothing walks the
// chain recursively server-side (AssigneeResolverService takes a single hop), so
// a cycle has never been fatal there. Rendering real nesting IS a recursive walk.
// Unguarded, one bad row would hang the browser.

export interface OrgPermissions {
  create: boolean; approve: boolean; reject: boolean;
  return: boolean; forward: boolean; close: boolean;
}

/** One row of GET /workflow/org-tree. NOTE: that endpoint answers a BARE ARRAY —
 *  no {success} envelope — unlike the write paths beside it. */
export interface OrgEmployee {
  id: string;
  empNumber: string;
  fullName: string;
  username: string;
  jobTitle: string;
  managerId: string;
  workflowLevel: number;
  branchId: string; branchName: string; branchCode: string;
  deptId: string; deptName: string; deptCode: string;
  positionId: string; positionName: string;
  permissions: OrgPermissions;
}

export interface OrgNode {
  employee: OrgEmployee;
  children: OrgNode[];
  depth: number;
}

export interface OrgTree {
  /** Employees with no manager — the real roots. */
  roots: OrgNode[];
  /** Employees whose managerId points at somebody who isn't in the list
   *  (inactive/deleted manager). They'd vanish from a naive tree, so they are
   *  surfaced rather than silently dropped. */
  orphans: OrgNode[];
  /** Ids involved in a manager cycle. Rendered as a flat, flagged list — never
   *  walked recursively. */
  cycleIds: string[];
}

export const PERMISSION_LABELS: Record<keyof OrgPermissions, string> = {
  create: "إنشاء",
  approve: "اعتماد",
  reject: "رفض",
  return: "إرجاع",
  forward: "تحويل",
  close: "إقفال",
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as Array<keyof OrgPermissions>;

/**
 * Find every id that sits on a manager cycle.
 *
 * Iterative walk with a per-start visited set — bounded by the row count, so it
 * terminates on any input including a fully cyclic graph.
 */
export function findCycles(employees: OrgEmployee[]): string[] {
  const parentOf = new Map<string, string>();
  employees.forEach((e) => { if (e.managerId) parentOf.set(e.id, e.managerId); });

  const onCycle = new Set<string>();
  const settled = new Set<string>();   // ids proven NOT to be on a cycle

  for (const start of employees) {
    if (settled.has(start.id) || onCycle.has(start.id)) continue;
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = start.id;

    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      path.push(cursor);
      cursor = parentOf.get(cursor);
      if (cursor && (onCycle.has(cursor) || settled.has(cursor))) break;
    }

    if (cursor && seen.has(cursor)) {
      // Closed a loop: everything from the first sighting of `cursor` onward.
      const from = path.indexOf(cursor);
      path.slice(from).forEach((id) => onCycle.add(id));
      path.slice(0, from).forEach((id) => settled.add(id));
    } else {
      path.forEach((id) => settled.add(id));
    }
  }
  return [...onCycle];
}

/**
 * Assemble the nesting. Employees on a cycle are excluded from the tree and
 * reported separately — a cycle has no root, so it cannot be rendered as one.
 */
export function buildOrgTree(employees: OrgEmployee[]): OrgTree {
  const cycleIds = findCycles(employees);
  const cycleSet = new Set(cycleIds);
  const safe = employees.filter((e) => !cycleSet.has(e.id));
  const byId = new Map(safe.map((e) => [e.id, e]));

  const childrenOf = new Map<string, OrgEmployee[]>();
  const roots: OrgEmployee[] = [];
  const orphaned: OrgEmployee[] = [];

  for (const e of safe) {
    if (!e.managerId) { roots.push(e); continue; }
    if (!byId.has(e.managerId)) { orphaned.push(e); continue; }  // manager not in the active set
    const list = childrenOf.get(e.managerId) ?? [];
    list.push(e);
    childrenOf.set(e.managerId, list);
  }

  const attach = (e: OrgEmployee, depth: number): OrgNode => ({
    employee: e,
    depth,
    children: (childrenOf.get(e.id) ?? [])
      .sort((a, b) => (b.workflowLevel - a.workflowLevel) || a.fullName.localeCompare(b.fullName, "ar"))
      .map((c) => attach(c, depth + 1)),
  });

  const byLevel = (a: OrgEmployee, b: OrgEmployee) =>
    (b.workflowLevel - a.workflowLevel) || a.fullName.localeCompare(b.fullName, "ar");

  return {
    roots: roots.sort(byLevel).map((e) => attach(e, 0)),
    orphans: orphaned.sort(byLevel).map((e) => attach(e, 0)),
    cycleIds,
  };
}

/** Flatten for rendering, honouring collapse state. */
export function flattenTree(nodes: OrgNode[], collapsed: Set<string>): OrgNode[] {
  const out: OrgNode[] = [];
  const walk = (list: OrgNode[]) => {
    for (const n of list) {
      out.push(n);
      if (!collapsed.has(n.employee.id)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Does `q` match this employee? Name / username / employee no / job title / dept / branch. */
export function matchesQuery(e: OrgEmployee, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.fullName, e.username, e.empNumber, e.jobTitle, e.positionName, e.deptName, e.branchName]
    .some((f) => String(f || "").toLowerCase().includes(needle));
}

/**
 * Ids that may be offered as a manager for `employeeId` — excludes self and
 * every descendant, because either choice closes a loop the server would refuse.
 */
export function eligibleManagers(employees: OrgEmployee[], employeeId: string): OrgEmployee[] {
  const descendants = new Set<string>([employeeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of employees) {
      if (e.managerId && descendants.has(e.managerId) && !descendants.has(e.id)) {
        descendants.add(e.id);
        grew = true;
      }
    }
  }
  return employees.filter((e) => !descendants.has(e.id));
}
