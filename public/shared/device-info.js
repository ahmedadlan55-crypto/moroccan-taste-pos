/* ─────────────────────────────────────────────────────────────────
 * v5.12.2 — Device brand/model/OS detector
 *
 * Resolves the calling device into a structured object:
 *   { brand: 'Samsung', model: 'SM-G998B', os: 'Android 13',
 *     ua: '<raw>', mobile: true }
 *
 * Strategy:
 *   1. User-Agent Client Hints (Chromium 90+)  — accurate brand/model on Android.
 *   2. UA regex parser — handles iPhone/iPad, older Android, desktop browsers.
 *
 * Loaded on every login screen + before shift-open so the back-end gets
 * useful information instead of the raw 200-character User-Agent string.
 * ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  function vendorFromModel(model) {
    if (!model) return '';
    var s = String(model).toUpperCase();
    if (/SM-|GT-|GALAXY|SAMSUNG/.test(s))   return 'Samsung';
    if (/REDMI|MI |POCO|XIAOMI/.test(s))    return 'Xiaomi';
    if (/HUAWEI|HONOR|HMA-|ANE-/.test(s))    return 'Huawei';
    if (/OPPO|CPH/.test(s))                  return 'Oppo';
    if (/VIVO/.test(s))                      return 'Vivo';
    if (/ONEPLUS/.test(s))                   return 'OnePlus';
    if (/INFINIX/.test(s))                   return 'Infinix';
    if (/ITEL/.test(s))                      return 'Itel';
    if (/REALME/.test(s))                    return 'Realme';
    if (/PIXEL/.test(s))                     return 'Google';
    if (/IPHONE|IPAD|MAC/.test(s))           return 'Apple';
    if (/NOKIA/.test(s))                     return 'Nokia';
    if (/LG-/.test(s))                       return 'LG';
    return String(model).split(/\s+/)[0] || '';
  }

  function iosVersion(ua) {
    var m = ua.match(/OS\s+(\d+)[_\.](\d+)(?:[_\.](\d+))?/);
    if (!m) return 'iOS';
    return 'iOS ' + m[1] + '.' + m[2] + (m[3] ? '.' + m[3] : '');
  }

  function iosModelGuess(ua) {
    // iOS UA never reveals the exact model; report 'iPhone' / 'iPad'
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua))   return 'iPad';
    if (/iPod/.test(ua))   return 'iPod';
    return 'iOS Device';
  }

  function winVer(ua) {
    if (/Windows NT 10\.0/.test(ua)) return 'Windows 10/11';
    if (/Windows NT 6\.3/.test(ua))  return 'Windows 8.1';
    if (/Windows NT 6\.2/.test(ua))  return 'Windows 8';
    if (/Windows NT 6\.1/.test(ua))  return 'Windows 7';
    return 'Windows';
  }

  function parseUA(ua) {
    if (!ua) return { brand: 'Unknown', model: '', os: '', ua: '', mobile: false };

    // ── iOS family ──
    if (/iPhone|iPad|iPod/.test(ua)) {
      return {
        brand: 'Apple',
        model: iosModelGuess(ua),
        os:    iosVersion(ua),
        ua:    ua,
        mobile: true
      };
    }

    // ── Android ──
    if (/Android/.test(ua)) {
      var android = (ua.match(/Android\s([\d.]+)/) || [, ''])[1];
      // Match "Build/" for older devices, fall back to ";...)" for newer ones
      var modelMatch =
        ua.match(/Android\s[\d.]+;\s*[a-zA-Z\-]+;\s*([^;)]+?)\s+Build/) ||
        ua.match(/Android\s[\d.]+;\s*([^;)]+?)\s+Build/) ||
        ua.match(/Android\s[\d.]+;\s*([^;)]+?)\)/);
      var model = modelMatch ? modelMatch[1].trim() : '';
      // Strip trailing language code like "; en-us" if it slipped in
      model = model.replace(/;\s*[a-z]{2}-[a-z]{2}\s*$/i, '').trim();
      return {
        brand: vendorFromModel(model) || 'Android',
        model: model || 'Android Device',
        os:    'Android' + (android ? ' ' + android : ''),
        ua:    ua,
        mobile: true
      };
    }

    // ── Desktop ──
    if (/Windows/.test(ua))   return { brand: 'PC',    model: 'Windows', os: winVer(ua), ua: ua, mobile: false };
    if (/Macintosh/.test(ua)) return { brand: 'Apple', model: 'Mac',     os: 'macOS',     ua: ua, mobile: false };
    if (/Linux/.test(ua))     return { brand: 'PC',    model: 'Linux',   os: 'Linux',     ua: ua, mobile: false };
    if (/CrOS/.test(ua))      return { brand: 'PC',    model: 'Chromebook', os: 'ChromeOS', ua: ua, mobile: false };

    return { brand: 'Unknown', model: '', os: '', ua: ua, mobile: false };
  }

  // Public API. Always async because UA-CH is a Promise on Chromium.
  window.detectDevice = async function () {
    var ua = navigator.userAgent || '';

    // Path A — UA-CH (Chromium 90+, Edge, Opera, Samsung Internet 16+)
    if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
      try {
        var hints = await navigator.userAgentData.getHighEntropyValues([
          'model', 'platform', 'platformVersion', 'architecture'
        ]);
        var brandList = navigator.userAgentData.brands || [];
        var realBrand = brandList.find(function (b) { return !/Not.A.Brand|Chromium/i.test(b.brand); });
        var resolved = {
          brand:  vendorFromModel(hints.model) || (realBrand && realBrand.brand) || hints.platform || '',
          model:  hints.model || (hints.platform === 'Windows' ? 'Windows PC' : (hints.platform || '')),
          os:     (hints.platform || '') + (hints.platformVersion ? ' ' + hints.platformVersion : ''),
          ua:     ua,
          mobile: !!navigator.userAgentData.mobile
        };
        // If model came back empty (typical on desktop Chromium where UA-CH
        // hides it for privacy), fall back to UA parsing — better than blank.
        if (!resolved.model) {
          var parsed = parseUA(ua);
          resolved.model = parsed.model;
          if (!resolved.brand) resolved.brand = parsed.brand;
          if (!resolved.os)    resolved.os    = parsed.os;
        }
        return resolved;
      } catch (e) { /* fall through to regex */ }
    }

    // Path B — UA regex
    return parseUA(ua);
  };

  // Synchronous fallback for places that can't await (rare).
  window.detectDeviceSync = function () { return parseUA(navigator.userAgent || ''); };

  // Format helper for any UI that wants "Samsung Galaxy S22 — Android 13"
  window.formatDevice = function (brand, model, os) {
    var first = [brand, model].filter(Boolean).join(' ').trim();
    return os ? (first ? first + ' — ' + os : os) : (first || 'Unknown device');
  };
})();
