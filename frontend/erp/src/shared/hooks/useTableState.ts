import { useCallback, useMemo, useState } from "react";

export type SortDir = "asc" | "desc";
export interface SortState {
  columnId: string;
  dir: SortDir;
}

export interface TableState {
  page: number;
  pageSize: number;
  sort: SortState | null;
  search: string;
  filters: Record<string, unknown>;
  hiddenColumns: string[];
}

/** Persisted slice of the table state (survives reload when a `persistKey` is set). */
interface PersistedTableState {
  pageSize: number;
  sort: SortState | null;
  hiddenColumns: string[];
}

export interface UseTableStateOptions {
  initialPageSize?: number;
  initialSort?: SortState | null;
  initialHidden?: string[];
  /** localStorage id — when set, pageSize/sort/hidden columns persist per table. */
  persistKey?: string;
}

export interface TableStateApi extends TableState {
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  setSearch: (search: string) => void;
  setFilter: (key: string, value: unknown) => void;
  clearFilters: () => void;
  toggleSort: (columnId: string) => void;
  setSort: (sort: SortState | null) => void;
  toggleColumn: (columnId: string) => void;
  setHiddenColumns: (ids: string[]) => void;
  reset: () => void;
}

/**
 * The single source of truth for a table's sort / filter / pagination / column
 * visibility. Feed the returned state to <DataTable> (server mode) or to the
 * client-side sorter/paginator it ships with. Optionally persists the durable
 * bits (pageSize, sort, hidden columns) to localStorage per `persistKey`.
 */
export function useTableState(options: UseTableStateOptions = {}): TableStateApi {
  const {
    initialPageSize = 25,
    initialSort = null,
    initialHidden = [],
    persistKey,
  } = options;

  // The durable slice (pageSize / sort / hidden columns). Persisted to
  // localStorage ONLY when a `persistKey` is given — otherwise it is purely
  // in-memory so two un-keyed tables never share (and corrupt) each other's state.
  const storageKey = persistKey ? `adlan.table.${persistKey}` : null;
  const [persisted, setPersistedRaw] = useState<PersistedTableState>(() => {
    const fallback: PersistedTableState = {
      pageSize: initialPageSize,
      sort: initialSort,
      hiddenColumns: initialHidden,
    };
    if (!storageKey || typeof window === "undefined") return fallback;
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<PersistedTableState>) } : fallback;
    } catch {
      return fallback;
    }
  });
  const setPersisted = useCallback(
    (next: PersistedTableState | ((prev: PersistedTableState) => PersistedTableState)) => {
      setPersistedRaw((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        if (storageKey && typeof window !== "undefined") {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(resolved));
          } catch {
            /* quota / disabled — keep in-memory value */
          }
        }
        return resolved;
      });
    },
    [storageKey],
  );

  const [page, setPage] = useState(1);
  const [search, setSearchRaw] = useState("");
  const [filters, setFilters] = useState<Record<string, unknown>>({});

  const updatePersisted = useCallback(
    (patch: Partial<PersistedTableState>) => setPersisted((p) => ({ ...p, ...patch })),
    [setPersisted],
  );

  const setPageSize = useCallback(
    (size: number) => {
      updatePersisted({ pageSize: size });
      setPage(1);
    },
    [updatePersisted],
  );

  const setSearch = useCallback((value: string) => {
    setSearchRaw(value);
    setPage(1); // a new search resets to the first page
  }, []);

  const setFilter = useCallback((key: string, value: unknown) => {
    setFilters((f) => {
      const next = { ...f };
      if (value === undefined || value === null || value === "") delete next[key];
      else next[key] = value;
      return next;
    });
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({});
    setPage(1);
  }, []);

  const setSort = useCallback((sort: SortState | null) => updatePersisted({ sort }), [updatePersisted]);

  const toggleSort = useCallback(
    (columnId: string) => {
      setPersisted((p) => {
        const cur = p.sort;
        let next: SortState | null;
        if (!cur || cur.columnId !== columnId) next = { columnId, dir: "asc" };
        else if (cur.dir === "asc") next = { columnId, dir: "desc" };
        else next = null; // asc → desc → off
        return { ...p, sort: next };
      });
    },
    [setPersisted],
  );

  const toggleColumn = useCallback(
    (columnId: string) => {
      setPersisted((p) => {
        const hidden = p.hiddenColumns.includes(columnId)
          ? p.hiddenColumns.filter((c) => c !== columnId)
          : [...p.hiddenColumns, columnId];
        return { ...p, hiddenColumns: hidden };
      });
    },
    [setPersisted],
  );

  const setHiddenColumns = useCallback(
    (ids: string[]) => updatePersisted({ hiddenColumns: ids }),
    [updatePersisted],
  );

  const reset = useCallback(() => {
    setPage(1);
    setSearchRaw("");
    setFilters({});
    setPersisted({ pageSize: initialPageSize, sort: initialSort, hiddenColumns: initialHidden });
  }, [initialPageSize, initialSort, initialHidden, setPersisted]);

  return useMemo(
    () => ({
      page,
      pageSize: persisted.pageSize,
      sort: persisted.sort,
      search,
      filters,
      hiddenColumns: persisted.hiddenColumns,
      setPage,
      setPageSize,
      setSearch,
      setFilter,
      clearFilters,
      toggleSort,
      setSort,
      toggleColumn,
      setHiddenColumns,
      reset,
    }),
    [
      page,
      persisted,
      search,
      filters,
      setPageSize,
      setSearch,
      setFilter,
      clearFilters,
      toggleSort,
      setSort,
      toggleColumn,
      setHiddenColumns,
      reset,
    ],
  );
}
