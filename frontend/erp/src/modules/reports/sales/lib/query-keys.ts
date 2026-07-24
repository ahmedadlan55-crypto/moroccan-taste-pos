// Sales Analytics Hub — react-query key factory. Query keys embed the
// stableStringify of the body (sorted keys) so two semantically-identical
// bodies share one cache entry regardless of property order.
import { stableStringify, type AnalyticsQueryBody } from "./api";

export const analyticsKeys = {
  all: ["analytics"] as const,
  registry: ["analytics", "registry"] as const,
  query: (segment: string, body: AnalyticsQueryBody) =>
    ["analytics", "query", segment, stableStringify(body)] as const,
};
