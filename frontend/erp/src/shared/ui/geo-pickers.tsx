// Country + City searchable pickers — thin wrappers over SearchableEntityCombobox
// (portal + virtualization + RTL) fed by the /api/geo endpoints. The city picker
// is disabled until a country is chosen; the caller resets the city when the
// country changes. Both are single-select; values are GeoHit objects (persist
// country = hit.code (ISO2), city = hit.name).
import { useMemo } from "react";
import { SearchableEntityCombobox } from "./searchable-entity-combobox";
import { useTx } from "./i18n";
import { countryFetcher, makeCityFetcher, type GeoHit } from "@/shared/lib/geo";

export function CountryPicker({
  value,
  onChange,
  disabled,
  id,
}: {
  value: GeoHit | null;
  onChange: (v: GeoHit | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTx();
  return (
    <SearchableEntityCombobox<GeoHit>
      value={value}
      onChange={onChange}
      fetcher={countryFetcher}
      queryKey={["geo", "countries"]}
      getKey={(c) => c.code}
      getLabel={(c) => c.name}
      getSublabel={(c) => c.nameEn || undefined}
      placeholder={t("sharedUi.geo.countryPlaceholder")}
      ariaLabel={t("sharedUi.geo.countryLabel")}
      emptyText={t("sharedUi.geo.countryEmpty")}
      disabled={disabled}
      id={id}
    />
  );
}

export function CityPicker({
  countryCode,
  value,
  onChange,
  disabled,
  id,
}: {
  countryCode: string | null;
  value: GeoHit | null;
  onChange: (v: GeoHit | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTx();
  const fetcher = useMemo(() => makeCityFetcher(countryCode || ""), [countryCode]);
  return (
    <SearchableEntityCombobox<GeoHit>
      // keep the query cache per-country so switching countries refetches
      key={countryCode || "none"}
      value={value}
      onChange={onChange}
      fetcher={fetcher}
      queryKey={["geo", "cities", countryCode || ""]}
      getKey={(c) => c.code}
      getLabel={(c) => c.name}
      getSublabel={(c) => c.region || undefined}
      placeholder={countryCode ? t("sharedUi.geo.cityPlaceholder") : t("sharedUi.geo.cityPlaceholderNoCountry")}
      ariaLabel={t("sharedUi.geo.cityLabel")}
      emptyText={t("sharedUi.geo.cityEmpty")}
      disabled={disabled || !countryCode}
      id={id}
    />
  );
}
