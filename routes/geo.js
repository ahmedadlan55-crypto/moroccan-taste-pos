'use strict';
// /api/geo — read-only reference data for the searchable country/city pickers.
// Behind the global JWT gate (like every other /api route). No capability check:
// this is public reference data (country/city names), not tenant data.
//   GET /api/geo/countries?q=&page=&pageSize=
//   GET /api/geo/cities?country=CC&q=&page=&pageSize=
// Response envelope matches the SearchableEntityCombobox fetcher contract:
//   { success, data:[…], pagination:{ page, pageSize, total, totalPages } }
const express = require('express');
const router = express.Router();
const geo = require('../lib/geo');

const EMPTY = { page: 1, pageSize: 20, total: 0, totalPages: 1 };

router.get('/countries', (req, res) => {
  try {
    const out = geo.searchCountries({ q: req.query.q, page: req.query.page, pageSize: req.query.pageSize });
    return res.json({ success: true, data: out.data, pagination: out.pagination });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message, data: [], pagination: EMPTY });
  }
});

router.get('/cities', (req, res) => {
  try {
    const country = String(req.query.country || '').trim();
    if (!country) return res.json({ success: true, data: [], pagination: EMPTY });
    const out = geo.searchCities({ country, q: req.query.q, page: req.query.page, pageSize: req.query.pageSize });
    return res.json({ success: true, data: out.data, pagination: out.pagination });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message, data: [], pagination: EMPTY });
  }
});

module.exports = router;
