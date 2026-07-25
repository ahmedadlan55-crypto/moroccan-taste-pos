'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Geo reference data (countries + cities) for the searchable country/city pickers.
//
// Data source: the `country-state-city` npm package (bundled JSON, MIT license) —
// held in memory on the SERVER only (never shipped to the SPA bundle). Country
// labels are overlaid with Arabic names from ./countryNamesAr.js (fallback: the
// package's English name). City names are the package's Latin/native names
// (the dataset has no Arabic city names), searchable by that text.
//
// All lookups are paginated server-side via the same envelope the frontend
// SearchableEntityCombobox expects: { data:[…], pagination:{page,pageSize,total,totalPages} }.
// ─────────────────────────────────────────────────────────────────────────────
const { Country, City } = require('country-state-city');
const AR = require('./countryNamesAr');

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Countries — built once, sorted by Arabic label.
let _countries = null;
function countries() {
  if (_countries) return _countries;
  _countries = Country.getAllCountries()
    .map((c) => ({ code: c.isoCode, name: AR[c.isoCode] || c.name, nameEn: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return _countries;
}

// Cities per ISO2 — built lazily and cached; duplicate names collapsed.
const _cityCache = new Map();
function citiesOf(code) {
  const iso = String(code || '').trim().toUpperCase();
  if (!iso) return [];
  if (_cityCache.has(iso)) return _cityCache.get(iso);
  const raw = City.getCitiesOfCountry(iso) || [];
  const seen = new Set();
  const list = [];
  for (const c of raw) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    const dk = name.toLowerCase();
    if (seen.has(dk)) continue;
    seen.add(dk);
    list.push({ code: iso + ':' + name, name, region: c.stateCode || '' });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  _cityCache.set(iso, list);
  return list;
}

function paginate(all, q, page, pageSize) {
  const needle = norm(q);
  const filtered = needle
    ? all.filter(
        (x) =>
          norm(x.name).includes(needle) ||
          norm(x.nameEn).includes(needle) ||
          norm(x.code).includes(needle) ||
          norm(x.region).includes(needle),
      )
    : all;
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const total = filtered.length;
  const start = (p - 1) * size;
  return {
    data: filtered.slice(start, start + size),
    pagination: { page: p, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) },
  };
}

function searchCountries({ q, page, pageSize } = {}) {
  return paginate(countries(), q, page, pageSize);
}
function searchCities({ country, q, page, pageSize } = {}) {
  return paginate(citiesOf(country), q, page, pageSize);
}

module.exports = { countries, citiesOf, searchCountries, searchCities };
