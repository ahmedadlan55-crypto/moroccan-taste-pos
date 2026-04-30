// ═══════════════════════════════════════════════════════════════════
// V5.7.13 — Translation proxy (server-side)
// ═══════════════════════════════════════════════════════════════════
// Proxies translation requests to Google Translate's free public endpoint.
// Why a server-side proxy?
//   • Google's `translate.googleapis.com/translate_a/single?client=gtx`
//     does not return reliable CORS headers in every region (Saudi
//     Arabia / mobile carriers in particular). Direct browser calls were
//     failing silently — content stayed in Arabic even after the user
//     toggled to English.
//   • Server-to-server has no CORS issue. The Express server fetches
//     the translation, returns plain JSON to the client.
//   • Bonus: we can swap providers (Google → MyMemory → DeepL → …)
//     without touching the frontend.
//
// Endpoint:
//   POST /api/i18n/translate
//   Body: { q: string | string[], source?: 'ar', target: 'en' }
//   Returns: { translations: string[], provider: 'google' }
// ═══════════════════════════════════════════════════════════════════

const router = require('express').Router();

// SENTINEL kept in sync with /public/shared/dynamic-i18n.js
const SENTINEL = '\n¶¶\n';
const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
// MyMemory is the fallback when Google fails (rate-limited or geo-blocked).
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

// In-memory LRU cache (simple object cap) so identical queries don't
// re-hit Google for every cashier on every device. Cap: 5000 entries
// (~MB-scale memory footprint, plenty for restaurant POS strings).
const _cache = new Map();
const CACHE_MAX = 5000;
function _cacheGet(key) {
  if (!_cache.has(key)) return null;
  // touch — move to end for LRU
  const v = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, v);
  return v;
}
function _cacheSet(key, val) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, val);
  if (_cache.size > CACHE_MAX) {
    // delete the oldest entry
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first);
  }
}

// ── Google translate (free public endpoint) ──
async function _translateGoogle(texts, source, target) {
  const joined = texts.join(SENTINEL);
  const url = GOOGLE_URL +
    '?client=gtx' +
    '&sl=' + encodeURIComponent(source) +
    '&tl=' + encodeURIComponent(target) +
    '&dt=t&q=' + encodeURIComponent(joined);

  const r = await fetch(url, {
    method: 'GET',
    headers: {
      // Identify as a normal browser — Google sometimes blocks raw curl/UA-less
      'User-Agent': 'Mozilla/5.0 (compatible; MoroccanTastePOS/5.7.13) Chrome/120.0',
      'Accept': '*/*'
    }
  });
  if (!r.ok) throw new Error('google ' + r.status);
  const data = await r.json();
  let out = '';
  if (Array.isArray(data) && Array.isArray(data[0])) {
    for (let i = 0; i < data[0].length; i++) {
      if (data[0][i] && data[0][i][0]) out += data[0][i][0];
    }
  }
  const parts = out.split(SENTINEL);
  if (parts.length !== texts.length) throw new Error('google split mismatch');
  return parts;
}

// ── MyMemory translate (fallback — works without keys, rate-limited) ──
async function _translateMyMemory(texts, source, target) {
  // MyMemory takes one query at a time; loop with small concurrency.
  // Free tier: 5K chars/day per IP (50K with email). Plenty for POS use.
  const lp = source + '|' + target;
  const out = [];
  for (const t of texts) {
    try {
      const url = MYMEMORY_URL + '?q=' + encodeURIComponent(t) + '&langpair=' + encodeURIComponent(lp);
      const r = await fetch(url);
      if (!r.ok) { out.push(t); continue; }
      const j = await r.json();
      const tr = (j && j.responseData && j.responseData.translatedText) || t;
      out.push(tr);
    } catch (_) {
      out.push(t);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// POST /api/i18n/translate
// ────────────────────────────────────────────────────────────────────
router.post('/translate', async (req, res) => {
  try {
    const { q, source, target } = req.body || {};
    const sl = String(source || 'ar');
    const tl = String(target || 'en');
    let texts = [];
    if (Array.isArray(q)) texts = q.map(String);
    else if (typeof q === 'string') texts = [q];
    else return res.status(400).json({ error: 'q (string|string[]) is required' });
    if (!texts.length) return res.json({ translations: [], provider: 'noop' });

    // Resolve from cache where possible
    const cacheKey = (s) => sl + '|' + tl + '|' + s;
    const out = new Array(texts.length);
    const missingIdx = [];
    const missingTexts = [];
    texts.forEach((t, i) => {
      const cached = _cacheGet(cacheKey(t));
      if (cached != null) out[i] = cached;
      else { missingIdx.push(i); missingTexts.push(t); }
    });

    let provider = 'cache';
    if (missingTexts.length) {
      let translated = null;
      // Try Google first
      try {
        translated = await _translateGoogle(missingTexts, sl, tl);
        provider = 'google';
      } catch (e1) {
        // Fall back to MyMemory
        try {
          translated = await _translateMyMemory(missingTexts, sl, tl);
          provider = 'mymemory';
        } catch (e2) {
          // Neither worked — return originals (graceful degradation)
          translated = missingTexts.slice();
          provider = 'fallback-original';
        }
      }
      missingIdx.forEach((idx, k) => {
        const t = translated[k] || missingTexts[k];
        out[idx] = t;
        _cacheSet(cacheKey(missingTexts[k]), t);
      });
    }

    res.json({ translations: out, provider });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lightweight health check the frontend uses to verify the proxy works
router.get('/ping', (req, res) => {
  res.json({ ok: true, providers: ['google', 'mymemory'], cache_size: _cache.size });
});

module.exports = router;
