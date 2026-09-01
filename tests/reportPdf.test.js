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

// FAIL BY DEFAULT. Every assertion below lives inside one async IIFE, so if an
// awaited promise never settles — exactly what a missing render deadline does —
// and nothing is holding the event loop open, node simply LEAVES: exit code 0,
// no output, a green run that asserted nothing. The last line of the file earns
// the zero; reaching it is itself the final assertion.
process.exitCode = 1;

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

  // ── The stylesheet ───────────────────────────────────────────────────────
  // The captured HTML is class names and nothing else, because the product
  // styles with utility classes. Without the SPA stylesheet the PDF is a wall
  // of unstyled text that still says 'report' at the top — which is exactly
  // what shipped, twice:
  //
  //   1. buildDocument linked NOTHING, while the comment above it claimed the
  //      stylesheet was 'pulled over loopback'. A <base> resolves relative
  //      URLs in markup that HAS links; it does not add one.
  //   2. Linking it and letting the renderer fetch it back over loopback
  //      produced a byte-for-byte IDENTICAL PDF with and without the link —
  //      the fetch never arrived, and `waitUntil: load` fires for a
  //      subresource that failed, so the page rendered unstyled in silence.
  //
  // So the server reads the file it is already serving, off its own disk.
  {
    const css = PdfService.appStylesheet();
    check('the built stylesheet is found on disk', css.length > 1000, css.length);
    // If this class ever stops being defined there, `.no-print` chrome starts
    // printing and nobody finds out from a passing test.
    check('and it is the real SPA stylesheet', css.includes('no-print'));

    const doc = PdfService.buildDocument({
      html: '<div class="no-print">x</div>', title: 't',
      baseUrl: 'http://127.0.0.1:3000', direction: 'rtl',
    });
    check('the document carries the stylesheet inline, not as a link',
      doc.includes('no-print') && doc.length > css.length, doc.length);
    check('and fetches no stylesheet over the network',
      !doc.includes('<link rel="stylesheet"'), doc.slice(0, 300));
  }
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

    // The self-test must REPORT the failure, never become one — it is the
    // thing an operator calls when the export is already broken.
    {
      let threw = null, st = null;
      try { st = await PdfService.selfTest(); } catch (e) { threw = e; }
      check('the self-test never throws', threw === null, threw && threw.message);
      eq('and reports that nothing rendered', st && st.rendered, false);
      eq('naming the reason', st && st.reason, 'PDF_RENDERER_UNAVAILABLE');
    }

    // The shared error contract must PASS 503 through rather than flatten it.
    const RE = require(path.join(ROOT, 'lib', 'reportErrors.js'));
    check('the report error contract passes 503 through', RE.KNOWN_HTTP.has(503));

    // ── A render can never hang ────────────────────────────────────────
    // Production proved this the hard way on the first deploy: Chromium came
    // up, the CDP handshake stalled in a constrained container, and the
    // request sat open until the client gave up — no status, no message,
    // nothing in the UI. A hung request is worse than a failed one.
    check('there is a hard render deadline', PdfService.RENDER_TIMEOUT_MS > 0 && PdfService.RENDER_TIMEOUT_MS <= 60000,
      PdfService.RENDER_TIMEOUT_MS);
    // And the CDP handshake gets its own, well under it — the library default
    // is 180 seconds.
    check('the CDP handshake is bounded well inside that',
      PdfService.PROTOCOL_TIMEOUT_MS < PdfService.RENDER_TIMEOUT_MS, 
      { protocol: PdfService.PROTOCOL_TIMEOUT_MS, render: PdfService.RENDER_TIMEOUT_MS });

    // The deadline must FIRE, not merely be declared. A constant nobody
    // enforces is documentation, and documentation does not end a hung
    // request.
    {
      const savedTimeout = process.env.PDF_RENDER_TIMEOUT_MS;
      process.env.PDF_RENDER_TIMEOUT_MS = "300";
      // A launch that never settles IS the stalled-handshake case.
      const corePath = require.resolve('puppeteer-core');
      const savedCore = require.cache[corePath];
      let launchOptions = null;
      require.cache[corePath] = {
        id: corePath, filename: corePath, loaded: true,
        exports: { launch: (opts) => { launchOptions = opts; return new Promise(() => {}); } },
      };
      // Point at a path that exists so the launcher resolves and we reach the
      // hang rather than the "no browser" branch.
      process.env.PDF_CHROMIUM_PATH = __filename;
      const freshPath = require.resolve(path.join(ROOT, 'services/reports/PdfService.js'));
      const savedSelf = require.cache[freshPath];
      delete require.cache[freshPath];
      const Fresh = require(freshPath);

      const startedAt = Date.now();
      let hangError = null;
      try {
        await Fresh.render({ html: '<p>x</p>', baseUrl: 'http://127.0.0.1:3000' });
      } catch (e) { hangError = e; }
      const elapsed = Date.now() - startedAt;

      check('a stalled browser rejects instead of hanging', hangError !== null);
      eq('with the fallback code the UI understands', hangError && hangError.code, 'PDF_RENDERER_UNAVAILABLE');
      check('and it gives up promptly', elapsed < 3000, elapsed);

      // The flags this container actually needs. No user namespaces, so the
      // sandbox cannot start; and /dev/shm is 64MB, where Chromium puts its
      // renderer heap and then dies silently when it fills.
      const args = (launchOptions && launchOptions.args) || [];
      for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']) {
        check('launch keeps ' + flag, args.includes(flag), args);
      }
      // And the two that must STAY OUT. They were added against the first
      // deploy's hang and appeared to help — the request stopped hanging
      // because the browser now died immediately instead, on
      // Target.setAutoAttach with TargetCloseError: puppeteer attaches to a
      // renderer target that single-process mode never creates. Turning a hang
      // into a crash reads like progress in a log and is none.
      for (const flag of ['--single-process', '--no-zygote']) {
        check('launch does NOT pass ' + flag, !args.includes(flag), args);
      }
      check('the CDP handshake is bounded at launch',
        launchOptions && launchOptions.protocolTimeout === PdfService.PROTOCOL_TIMEOUT_MS,
        launchOptions && launchOptions.protocolTimeout);

      if (savedCore) require.cache[corePath] = savedCore; else delete require.cache[corePath];
      if (savedSelf) require.cache[freshPath] = savedSelf; else delete require.cache[freshPath];
      if (savedTimeout === undefined) delete process.env.PDF_RENDER_TIMEOUT_MS;
      else process.env.PDF_RENDER_TIMEOUT_MS = savedTimeout;
      process.env.PDF_CHROMIUM_PATH = '/definitely/not/a/browser';
    }

    // ── A render that reaches the browser ──────────────────────────────
    // Everything above stops at `launch`. This drives the whole path with a
    // fake browser, because the things that only happen AFTER launch are the
    // ones that cost real money when they are wrong: a leaked Chromium per
    // request, and paper with no page numbers on it.
    {
      const corePath = require.resolve('puppeteer-core');
      const savedCore = require.cache[corePath];
      const savedChromium = process.env.PDF_CHROMIUM_PATH;

      let pdfOptions = null, contentOptions = null, closed = 0, html = '';
      const makeBrowser = (pdfImpl) => ({
        newPage: async () => ({
          setContent: async (doc, opts) => { html = doc; contentOptions = opts; },
          // A webfont promise that NEVER settles. Real: a font request that
          // hangs leaves `document.fonts.ready` pending forever.
          evaluateHandle: () => new Promise(() => {}),
          pdf: async (opts) => { pdfOptions = opts; return pdfImpl(); },
        }),
        close: async () => { closed += 1; },
      });
      const install = (pdfImpl) => {
        require.cache[corePath] = { id: corePath, filename: corePath, loaded: true,
          exports: { launch: async () => makeBrowser(pdfImpl) } };
        process.env.PDF_CHROMIUM_PATH = __filename; // exists, so the launcher resolves
        const fp = require.resolve(path.join(ROOT, 'services/reports/PdfService.js'));
        delete require.cache[fp];
        return require(fp);
      };

      // puppeteer 23 returns a Uint8Array, NOT a Buffer. A fake that hands
      // back a Buffer tests a wire shape the library stopped producing, and
      // that gap is exactly what reached production.
      const PDF_BYTES = () => new Uint8Array(Buffer.from('%PDF-1.4 fake'));
      const Ok = install(PDF_BYTES);
      const startedAt = Date.now();
      const buf = await Ok.render({ html: '<p>تقرير</p>', title: 'ت', baseUrl: 'http://127.0.0.1:3000', landscape: true });
      const elapsed = Date.now() - startedAt;

      // Express sends a Buffer as bytes; ANY other object goes down the JSON
      // path and the PDF is re-emitted as {"0":37,"1":80,...}, one key per
      // byte. So the type here is not a detail — it is the difference between
      // a PDF and megabytes of JSON claiming to be one.
      check('a Uint8Array from the browser is normalised to a Buffer', Buffer.isBuffer(buf), buf && buf.constructor && buf.constructor.name);
      eq('and it is really a PDF', buf && buf.slice(0, 4).toString('latin1'), '%PDF');
      // The webfont promise never settles, so ONLY the inner bound can end this.
      // Unbounded, it would sit here until the 40s deadline — a report that
      // takes 40 seconds to admit a font was slow is a report nobody waits for.
      check('a webfont that never loads does not stall the render', elapsed < 8000, elapsed);
      eq('the browser is closed', closed, 1);

      // Page numbers belong ON the paper: a report that loses its pagination is
      // a stack of sheets nobody can prove is complete.
      check('the footer carries page x of y',
        !!pdfOptions && pdfOptions.displayHeaderFooter === true
        && /class="pageNumber"/.test(pdfOptions.footerTemplate || '')
        && /class="totalPages"/.test(pdfOptions.footerTemplate || ''), pdfOptions);
      check('landscape is honoured for wide reports', pdfOptions && pdfOptions.landscape === true);
      check('the CSS page box wins over the format default', pdfOptions && pdfOptions.preferCSSPageSize === true);
      check('backgrounds print, so shaded totals rows survive', pdfOptions && pdfOptions.printBackground === true);
      // `load`, not `domcontentloaded`: the document LINKS the page stylesheet,
      // and DOMContentLoaded does not wait for one — rendering early gives an
      // unstyled first paint, which is the exact thing linking it prevents.
      // Not `networkidle0` either: that waits out every asset that is never
      // going to arrive. The outer deadline bounds a stylesheet that hangs.
      eq('content waits for the stylesheet, not for the network to fall idle',
        contentOptions && contentOptions.waitUntil, 'load');
      check('the report body reached the page', html.includes('<p>تقرير</p>'));

      // The probe that tells the truth. `isAvailable` only answers "is a binary
      // on this box" — the question that shipped a button which hung: the
      // binary WAS there, the probe said yes, and every render died on the CDP
      // handshake. So the self-test must run a real render.
      const stOk = await Ok.selfTest();
      eq('a self-test on a working host reports rendered', stOk.rendered, true);
      check('and times it', stOk.ms >= 0 && stOk.bytes > 0, stOk);

      // A browser that returns bytes which are not a PDF is a DIFFERENT
      // failure from a browser that will not start, and a probe that reports
      // both as success is how a corrupt export reaches a user.
      const Liar = install(() => Buffer.from('<html>not a pdf</html>'));
      const stLie = await Liar.selfTest();
      eq('output that is not a PDF is not a pass', stLie.rendered, false);
      eq('and is named as its own failure', stLie.reason, 'PDF_OUTPUT_NOT_A_PDF');

      // THE LEAK. Without a finally, every failed render strands a Chromium
      // process; a handful of those exhausts a small instance and the next
      // request cannot launch at all — the report path dies of its own errors.
      const Boom = install(() => { throw new Error('render exploded'); });
      let boomError = null;
      try {
        await Boom.render({ html: '<p>x</p>', baseUrl: 'http://127.0.0.1:3000' });
      } catch (e) { boomError = e; }
      check('a failing render still surfaces the failure', boomError !== null);
      eq('and the browser is closed anyway, so nothing leaks', closed, 4);

      if (savedCore) require.cache[corePath] = savedCore; else delete require.cache[corePath];
      delete require.cache[require.resolve(path.join(ROOT, 'services/reports/PdfService.js'))];
      process.env.PDF_CHROMIUM_PATH = savedChromium === undefined ? '/definitely/not/a/browser' : savedChromium;
    }

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

    // ── The bytes that actually go over the wire ───────────────────────
    // Every assertion so far checked a return value INSIDE the process. The
    // defect that reached production lived in the gap between that value and
    // the HTTP response: `page.pdf()` returns a Uint8Array, `res.send` takes
    // any non-Buffer object down the JSON path, and the client received
    // {"0":37,"1":80,...} — one key per byte, megabytes of it, with
    // Content-Type application/json. Every in-process check passed while the
    // download was garbage. So this drives the real route and reads the RAW
    // BYTES back.
    {
      const corePath = require.resolve('puppeteer-core');
      const savedCore = require.cache[corePath];
      const savedChromium = process.env.PDF_CHROMIUM_PATH;
      const svcPath = require.resolve(path.join(ROOT, 'services/reports/PdfService.js'));
      const routePath = require.resolve(path.join(ROOT, 'routes/erp/reports/pdf.js'));

      require.cache[corePath] = { id: corePath, filename: corePath, loaded: true,
        exports: { launch: async () => ({
          newPage: async () => ({
            setContent: async () => {},
            evaluateHandle: async () => null,
            // The real library's return type, not a convenient one.
            pdf: async () => new Uint8Array(Buffer.from('%PDF-1.4 ' + 'x'.repeat(400))),
          }),
          close: async () => {},
        }) } };
      process.env.PDF_CHROMIUM_PATH = __filename;
      delete require.cache[svcPath];
      delete require.cache[routePath];

      const app2 = express();
      app2.use(express.json({ limit: '5mb' }));
      app2.use((req, _res, next) => { req.user = { username: 't' }; next(); });
      app2.use('/api/erp', require(routePath));
      const srv2 = app2.listen(0);
      await new Promise((r) => srv2.once('listening', r));
      const port2 = srv2.address().port;

      const raw = await new Promise((res2, rej) => {
        const data = JSON.stringify({ html: '<p>تقرير</p>', title: 'تقرير' });
        const rq = http.request({ port: port2, path: '/api/erp/reports/pdf', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => res2({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
        });
        rq.on('error', rej); rq.write(data); rq.end();
      });

      eq('a successful render answers 200', raw.status, 200);
      eq('as a PDF, not as JSON', raw.headers['content-type'], 'application/pdf');
      check('and the bytes really are a PDF', raw.body.slice(0, 4).toString('latin1') === '%PDF',
        raw.body.slice(0, 40).toString('latin1'));
      // The JSON path inflates every byte into a key; the length alone exposes it.
      eq('Content-Length matches the real document', Number(raw.headers['content-length']), raw.body.length);
      check('the download is a file, not a page', /attachment/.test(raw.headers['content-disposition'] || ''),
        raw.headers['content-disposition']);

      srv2.close();
      if (savedCore) require.cache[corePath] = savedCore; else delete require.cache[corePath];
      delete require.cache[svcPath]; delete require.cache[routePath];
      process.env.PDF_CHROMIUM_PATH = savedChromium === undefined ? '/definitely/not/a/browser' : savedChromium;
    }

    if (failures.length) {
      console.error('\n' + failures.length + ' failure(s):');
      failures.forEach((f) => console.error('  - ' + f));
      process.exit(1);
    }
    console.log('  ✅ PDF via Chromium; an absent browser degrades one button, not the server');
    console.log(pass + '/' + pass + ' passed');
    process.exitCode = 0; // reached the end with everything asserted
  })();
}
