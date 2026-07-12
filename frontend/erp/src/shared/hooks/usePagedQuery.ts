import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";

export interface PagedResult<T> {
  items: T[];
  total: number;
}

export interface PagedQueryArgs {
  page: number;
  pageSize: number;
  search?: string;
  sort?: { columnId: string; dir: "asc" | "desc" } | null;
  filters?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface UsePagedQueryOptions<T> {
  /** Stable base key; the paging/sort/filter args are appended automatically. */
  queryKey: readonly unknown[];
  args: Omit<PagedQueryArgs, "signal">;
  fetcher: (args: PagedQueryArgs) => Promise<PagedResult<T>>;
  enabled?: boolean;
  staleTime?: number;
}

export interface UsePagedQueryResult<T> {
  query: UseQueryResult<PagedResult<T>, Error>;
  rows: T[];
  total: number;
  pageCount: number;
  isEmpty: boolean;
}

/**
 * react-query wrapper for a server-paginated list. Keeps the previous page's
 * data visible while the next page loads (no flash to empty), and derives the
 * page count. Pair with useTableState to drive the args.
 */
export function usePagedQuery<T>(options: UsePagedQueryOptions<T>): UsePagedQueryResult<T> {
  const { queryKey, args, fetcher, enabled = true, staleTime = 10_000 } = options;

  const query = useQuery<PagedResult<T>, Error>({
    queryKey: [...queryKey, args.page, args.pageSize, args.search ?? "", args.sort, args.filters],
    queryFn: ({ signal }) => fetcher({ ...args, signal }),
    enabled,
    staleTime,
    placeholderData: keepPreviousData,
  });

  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, args.pageSize)));

  return {
    query,
    rows,
    total,
    pageCount,
    isEmpty: !query.isLoading && rows.length === 0,
  };
}
