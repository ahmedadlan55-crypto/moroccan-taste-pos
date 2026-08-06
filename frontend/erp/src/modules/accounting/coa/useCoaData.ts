// ── useCoaData — the one derived view of the chart every CoA page shares ────
// Loads the flat account list once (React Query dedupes across the seven
// routes) and derives the parent map, the rollups, the health diagnostics and
// the id index from it. Every page reads the SAME derivation, so the tree, the
// table, the detail hero and the health page can never disagree about what an
// account's rollup or its issues are.

import { useMemo } from "react";
import { useGlAccounts, type GlAccount } from "../api";
import {
  buildChildrenMap,
  computeHealth,
  computeRollups,
  getTreeRoots,
  type CoaHealth,
} from "./coaModel";

export interface CoaData {
  accounts: GlAccount[];
  byId: Map<string, GlAccount>;
  byParent: Map<string, GlAccount[]>;
  rollups: Map<string, number>;
  roots: GlAccount[];
  health: CoaHealth;
  /** True when an as-of date was asked for and the server did not honor it. */
  asOfIgnored: boolean;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useCoaData(asOf?: string | null): CoaData {
  const query = useGlAccounts(asOf);
  const accounts = useMemo(() => query.data?.accounts ?? [], [query.data]);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const byParent = useMemo(() => buildChildrenMap(accounts), [accounts]);
  const rollups = useMemo(() => computeRollups(accounts, byParent), [accounts, byParent]);
  const roots = useMemo(() => getTreeRoots(accounts), [accounts]);
  const health = useMemo(
    () => computeHealth(accounts, byParent, rollups),
    [accounts, byParent, rollups],
  );

  return {
    accounts,
    byId,
    byParent,
    rollups,
    roots,
    health,
    asOfIgnored: query.data?.asOfIgnored ?? false,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
