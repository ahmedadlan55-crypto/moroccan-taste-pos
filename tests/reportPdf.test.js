#!/usr/bin/env node
'use strict';
/**
 * Server-side report PDF.
 *
 * ─── WHY CHROMIUM ───────────────────────────────────────────────────────────
 * Arabic is cursive and bidirectional: each letter takes an initial/medial/
 * final/isolated form from its context, and the line runs right-to-left with
 * embedded left-to-right numbers. A JS PDF writer places glyphs at coordinates
 * and does neither shaping nor bidi, so it renders Arabic as disconnected
 * letters in reverse order — a document that LOOKS like a report, is
 * unreadable, and gets signed anyway. Chromium already does both, and already
 * renders this exact print stylesheet.
 *
 * ─── THE PROPERTY THAT MATTERS MOST ─────────────────────────────────────────
 * The browser is an OS package, not an npm dependency. It can be missing on a
 * dev box, in a slim image, or because the image build's `apk add` failed. So:
 *
 *   an ABSENT renderer must degrade ONE BUTTON, never the server.
 *
 * That is what most of this file asserts. A PDF export that takes a report
 * route down with it would be a far worse bug than not having PDF at all.
 */

const path = require('path');
const http = require('http');

let pass = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass += 1; return; }
  failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)));
  console.error('  FAIL ' + name, extra === undefined ? '' : extra);
}
function eq(name, actual, expected) { check(name, actual === expected, { actual, expected }); }

const ROOT = path.join(__dirname, '..');
const PdfService = require(path.join(ROOT, 'services', 'reports', 'PdfService.js'));

// ── The document Chromium is handed ────────────────────────────────────────
{
  const doc = PdfService.buildDocument({
    html: '<table><thead><tr><th>البند</th></tr></thead><tbody><tr><td>قيمة</td></tr></tbody></table>',
    title: 'قائمة الدخل',
    baseUrl: 'http://127.0.0.1:3000',
    direction: 'rtl',
  });

  check('the document declares Arabic and RTL', /lang="ar"/.test(doc) && /dir="rtl"/.test(doc), doc.slice(0, 120));
  // A <base> is what lets the report's own stylesheet and Cairo webfont resolve
  // back to this server, so the PDF matches the screen instead of falling back
  // to a system face.
  check('a base URL is set so assets resolve', /<base href="http:\/\/127\.0\.0\.1:3000\/">/.test(doc));
  // The single most important multi-page property, and the one a naive
  // HTML→PDF always loses.
  check('table headers repeat across pages', /thead \{ display: table-header-group/.test(doc));
  check('rows are not split across a page break', /tr \{ break-inside: avoid/.test(doc));
  check('a real page box is declared', /@page \{ size: A4/.test(doc));
  check('the report body is carried through verbatim', doc.includes('<td>قيمة</td>'));

  // A title is interpolated into markup: it must not be able to open a tag.
  const injected = PdfService.buildDocument({
    html: '<p>x</p>', title: '</title><script>alert(1)</script>', baseUrl: 'http://x', direction: 'ltr',
  });
  check('the title cannot inject markup', !/<script>/.test(injected), injected.slice(0, 200));

  // LTR reports exist too (English), and must not be forced into RTL.
  const ltr = PdfService.buildDocument({ html: '<p>x</p>', title: 't', baseUrl: 'http://x', direction: 'ltr' });
  check('an English report renders left-to-right', /dir="ltr"/.test(ltr) && /lang="en"/.test(ltr));
}

// ── An absent renderer degrades ONE BUTTON ─────────────────────────────────
{
  // Force the "no browser on this host" state, which is also the real state of
  // every dev machine.
  const saved = process.env.PDF_CHROMIUM_PATH;
  process.env.PDF_CHROMIUM_PATH = '/definitely/not/a/browser';
  PdfService.__resetForTests();

  check('availability is reported honestly, not assumed', PdfService.isAvailable() === false);

  (async () => {
    let thrown = null;
    try {
      await PdfService.render({ html: '<p>x</p>', baseUrl: 'http://127.0.0.1:3000' });
    } catch (e) { thrown = e; }
    check('rendering without a browser throws', thrown !== null);
    eq('with a code the UI can branch on', thrown && thrown.code, 'PDF_RENDERER_UNAVAILABLE');
    // 503, not 500: "this host cannot do it, use the print dialog" is a
    // different and more useful statement than "something went wrong".
    eq('and a 503, not a generic failure', thrown && thrown.http, 503);

    // The shared error contract must PASS 503 through rather than flatten it.
    const RE = require(path.join(ROOT, 'lib', 'reportErrors.js'));
    check('the report error contract passes 503 through', RE.KNOWN_HTTP.has(503));

    // ── The route ──────────────────────────────────────────────────────────
    const capPath = require.resolve(path.join(ROOT, 'middleware/requireCapability.js'));
    require.cache[capPath] = {
      id: capPath, filename: capPath, loaded: true,
      exports: Object.assign(() => (_q, _s, n) => n(), { hasCapability: async () => true }),
    };
    const express = require(path.join(ROOT, 'node_modules', 'express'));
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use((req, _res, next) => { req.user = { username: 't' }; req.requestId = 'test'; next(); });
    app.use('/api/erp', require(path.join(ROOT, 'routes', 'erp', 'reports', 'pdf.js')));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));

    const port = server.address().port;
    const get = (p) => new Promise((res2, rej) => {
      http.get({ port, path: p }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; });
        r.on('end', () => res2({ status: r.statusCode, json: JSON.parse(b) }));
      }).on('error', rej);
    });
    const post = (p, payload) => new Promise((res2, rej) => {
      const data = JSON.stringify(payload);
      const rq = http.request({ port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
        let b = ''; r.on('data', (c) => { b += c; });
        r.on('end', () => { try { res2({ status: r.statusCode, json: JSON.parse(b) }); } catch (_) { res2({ status: r.statusCode, json: null }); } });
      });
      rq.on('error', rej); rq.write(data); rq.end();
    });

    try {
      // The probe exists so the UI can ask BEFORE offering a button, instead of
      // presenting an action that 503s when pressed.
      const cap = await get('/api/erp/reports/pdf/capability');
      eq('the capability probe answers 200 even with no browser', cap.status, 200);
      eq('and says it is unavailable', cap.json.data.available, false);
      eq('naming why', cap.json.data.reason, 'PDF_RENDERER_UNAVAILABLE');

      const rendered = await post('/api/erp/reports/pdf', { html: '<p>تقرير</p>', title: 'x' });
      eq('rendering answers 503, not 500', rendered.status, 503);
      eq('with the actionable code', rendered.json.code, 'PDF_RENDERER_UNAVAILABLE');

      // Validation still applies, and is a 4xx of its own.
      const empty = await post('/api/erp/reports/pdf', { html: '   ' });
      check('empty html is rejected as a client error', empty.status >= 400 && empty.status < 500, empty.status);
    } finally {
      server.close();
      if (saved === undefined) delete process.env.PDF_CHROMIUM_PATH;
      else process.env.PDF_CHROMIUM_PATH = saved;
      PdfService.__resetForTests();
    }

    if (failures.length) {
      console.error('\n' + failures.length + ' failure(s):');
      failures.forEach((f) => console.error('  - ' + f));
      process.exit(1);
    }
    console.log('  ✅ PDF via Chromium; an absent browser degrades one button, not the server');
    console.log(pass + '/' + pass + ' passed');
  })();
}
