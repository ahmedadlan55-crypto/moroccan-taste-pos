// D1 — read-only VAT rate from system settings (settings.VATRate). The item
// cost & accounting section DISPLAYS this; it never hardcodes 15% and never
// edits balances/GL. Returns the rate as a percent number (e.g. 15) or null.
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

type SettingsMap = Record<string, string | null | undefined>;

export function useVatRate() {
  const q = useQuery<SettingsMap>({
    queryKey: ["settings", "map"],
    queryFn: ({ signal }) => apiClient.get<SettingsMap>("/settings", { signal }),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
  const raw = q.data?.VATRate ?? q.data?.vat_rate ?? null;
  const rate = raw == null || raw === "" || Number.isNaN(Number(raw)) ? null : Number(raw);
  return { rate, isLoading: q.isLoading };
}
