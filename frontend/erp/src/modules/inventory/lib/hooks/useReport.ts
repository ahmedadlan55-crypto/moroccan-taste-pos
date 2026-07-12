import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import { queryKeys } from "@/modules/inventory/lib/query-keys";
import { toReportResult, toReportCatalog, type ReportResult, type ReportCatalogEntry } from "@/modules/inventory/lib/adapters/reports.adapter";
import { ALL_WAREHOUSES } from "@/modules/inventory/lib/warehouse-scope-provider";

export interface ReportFilters {
  from?: string;
  to?: string;
  category?: string;
  status?: string;
  type?: string;
  window?: number;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: string;
}

export function useReport(reportType: string, scope: string, filters: ReportFilters) {
  const warehouseId = scope && scope !== ALL_WAREHOUSES ? scope : undefined;
  const params = {
    warehouseId,
    from: filters.from || undefined,
    to: filters.to || undefined,
    category: filters.category || undefined,
    status: filters.status || undefined,
    type: filters.type || undefined,
    window: filters.window || undefined,
    q: filters.q || undefined,
    page: filters.page || undefined,
    pageSize: filters.pageSize || undefined,
    sort: filters.sort || undefined,
    dir: filters.dir || undefined,
  };
  return useQuery<ReportResult>({
    queryKey: queryKeys.report(reportType, scope, filters as Record<string, unknown>),
    enabled: !!reportType,
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(`/inventory/reports/${reportType}`, { signal, params }).then(toReportResult),
    placeholderData: (prev, prevQuery) => {
      // Keep prior rows during paging/sorting of the SAME report + scope.
      if (prev && prevQuery && prevQuery.queryKey[1] === reportType && prevQuery.queryKey[2] === scope) return prev;
      return undefined;
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}

export function useReportCatalog() {
  return useQuery<ReportCatalogEntry[]>({
    queryKey: queryKeys.reportCatalog(),
    queryFn: ({ signal }) => apiClient.get<unknown>("/inventory/reports/catalog", { signal }).then(toReportCatalog),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}
