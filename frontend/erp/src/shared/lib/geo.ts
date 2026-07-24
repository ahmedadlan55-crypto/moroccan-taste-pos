// Geo (country/city) fetchers + helpers for the searchable pickers. Data comes
// from the server-side /api/geo endpoints (country-state-city + Arabic country
// overlay) and is consumed by the shared SearchableEntityCombobox. Countries are
// labelled in Arabic (English as sublabel); cities carry their native/Latin name.
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";
import type { EntityFetcher, EntityPage } from "@/shared/ui/searchable-entity-combobox";

export interface GeoHit {
  /** ISO2 for a country, "<ISO2>:<name>" for a city — stable option key. */
  code: string;
  /** Display label — Arabic for countries, native/Latin for cities. */
  name: string;
  nameEn?: string;
  region?: string;
}

interface GeoPage {
  data: GeoHit[];
  pagination?: { page: number; totalPages: number; total: number };
}

function toPage(r: GeoPage): EntityPage<GeoHit> {
  if (r == null || typeof r !== "object" || !Array.isArray(r.data)) throw new Error("GEO_CONTRACT_INVALID");
  const pg = r.pagination;
  return {
    items: r.data,
    nextPage: pg && pg.page < pg.totalPages ? pg.page + 1 : null,
    total: pg?.total ?? r.data.length,
  };
}

export const countryFetcher: EntityFetcher<GeoHit> = ({ q, page, signal }) =>
  apiClient.get<GeoPage>("/geo/countries", { signal, params: { q, page, pageSize: 30 } }).then(toPage);

export function makeCityFetcher(country: string): EntityFetcher<GeoHit> {
  return ({ q, page, signal }) =>
    apiClient.get<GeoPage>("/geo/cities", { signal, params: { country, q, page, pageSize: 30 } }).then(toPage);
}

/**
 * Resolve a stored ISO2 country code → its GeoHit (Arabic label) once, so an
 * edit form can show "المملكة العربية السعودية" instead of the raw "SA".
 * Falls back to a code-labelled hit if the lookup misses.
 */
export function useCountryHit(code?: string | null) {
  return useQuery({
    enabled: !!code,
    queryKey: ["geo", "country-by-code", code ?? ""],
    staleTime: 60 * 60 * 1000,
    queryFn: async ({ signal }): Promise<GeoHit> => {
      const r = await apiClient.get<GeoPage>("/geo/countries", { signal, params: { q: code, pageSize: 50 } });
      const hit = (r.data || []).find((c) => c.code === code);
      return hit ?? { code: code as string, name: code as string };
    },
  });
}

/** Build a display-only GeoHit for a stored free-text city name (edit forms). */
export function cityHitFromName(country: string | null | undefined, name: string | null | undefined): GeoHit | null {
  if (!name) return null;
  return { code: `${country || ""}:${name}`, name };
}
