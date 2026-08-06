// Sales Analytics Hub — the two data hooks every hub page uses.
//
//   useAnalyticsRegistry() — the metric/dimension catalog (static per session,
//     staleTime Infinity).
//   useAnalyticsQuery(segment, body, { enabled }) — one POST /analytics/query
//     round-trip. keepPreviousData keeps the previous table on screen while a
//     filter tweak refetches (no loading flash); the AbortSignal is threaded so
//     a superseded request is actually cancelled.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLang } from "@/i18n";
import {
  fetchAnalyticsRegistry,
  runAnalyticsQuery,
  type AnalyticsQueryBody,
  type AnalyticsRegistry,
  type AnalyticsResult,
} from "./api";
import { analyticsKeys } from "./query-keys";

export function useAnalyticsRegistry() {
  return useQuery<AnalyticsRegistry>({
    queryKey: analyticsKeys.registry,
    queryFn: ({ signal }) => fetchAnalyticsRegistry(signal),
    staleTime: Infinity,
  });
}

export function useAnalyticsQuery(
  segment: string,
  body: AnalyticsQueryBody,
  opts?: { enabled?: boolean },
) {
  const lang = useLang();
  const localizedBody: AnalyticsQueryBody = { ...body, lang };
  return useQuery<AnalyticsResult>({
    queryKey: analyticsKeys.query(segment, localizedBody),
    queryFn: ({ signal }) => runAnalyticsQuery(localizedBody, signal),
    enabled: opts?.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}
