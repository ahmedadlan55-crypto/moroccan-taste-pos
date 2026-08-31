/**
 * Server-side PDF rendering for reports.
 *
 * ─── WHY CHROMIUM AND NOT A PDF LIBRARY ─────────────────────────────────────
 * Arabic is a cursive script: every letter has initial/medial/final/isolated
 * forms chosen by context, and the paragraph runs right-to-left with embedded
 * left-to-right numbers. A JS PDF writer (pdfkit, pdfmake) draws glyphs at
 * coordinates — it does no shaping and no bidi. Feeding it Arabic produces
 * disconnected letters in reverse order: a document that LOOKS like a report
 * and is unreadable, on financial paper somebody signs.
 *
 * Chromium already does shaping and bidi correctly, and it already renders this
 * exact document — the print stylesheet, the page rules, the repeated table
 * headers. Rendering through it means the PDF and the printed page are the same
 * artifact, not two implementations that drift.
 *
 * ─── WHY IT FAILS SOFT ──────────────────────────────────────────────────────
 * The browser binary is an OS package, not an npm dependency: it can be absent
 * on a dev machine, in a slim image, or if the image build's `apk add` was
 * skipped. So this module is loaded LAZILY and every failure is reported as a
 * coded 503 — one export format degrades, the server does not. The browser
 * print path (which produces the same document) stays available throughout.
 *
 * Under no circumstances does an unavailable renderer take down a report.
 */
'use strict';

const CHROMIUM_CANDIDATES = [
  process.env.PDF_CHROMIUM_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

/** CDP handshake budget. The library default is 180s — far too long to hold
 *  a report request open just to learn that the browser never came up. */
const PROTOCOL_TIMEOUT_MS = 25000;

/** Hard ceiling on ONE render, whatever goes wrong inside it. */
const RENDER_TIMEOUT_MS = Number(process.env.PDF_RENDER_TIMEOUT_MS) || 40000;

/** Cache the resolved launcher, and the FAILURE too — probing on every request
 *  would spawn a process per call just to fail. */
let _resolved;

function unavailable(reason) {
  const error = new Error(reason);
  error.code = 'PDF_RENDERER_UNAVAILABLE';
  error.http = 503;
  error.expose = true;
  return error;
}

function resolveLauncher() {
  if (_resolved !== undefined) return _resolved;
  let puppeteer = null;
  try {
    // `puppeteer-core` ships NO browser — it drives one already on the box.
    // eslint-disable-next-line global-require
    puppeteer = require('puppeteer-core');
  } catch (_) {
    _resolved = null;
    return _resolved;
  }
  const fs = require('fs');
  const executablePath = CHROMIUM_CANDIDATES.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
  _resolved = executablePath ? { puppeteer, executablePath } : null;
  return _resolved;
}

/** Is a real PDF renderer usable right now? Used by the capability probe so the
 *  UI can hide a button rather than offer one that 503s. */
function isAvailable() {
  return resolveLauncher() !== null;
}

/** TEST-ONLY: drop the cached probe. */
function __resetForTests() { _resolved = undefined; }

/**
 * Wrap the client's report HTML in a printable document.
 *
 * The stylesheet and fonts are pulled from THIS server over loopback, so the
 * PDF uses Cairo and the same print rules as the screen. A missing asset must
 * not block rendering — Chromium falls back to a system Arabic face, which is
 * still correctly shaped; a hard failure here would trade a slightly different
 * font for no document at all.
 */
function buildDocument({ html, title, baseUrl, direction }) {
  const dir = direction === 'ltr' ? 'ltr' : 'rtl';
  const lang = dir === 'rtl' ? 'ar' : 'en';
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<title>${String(title || 'report').replace(/[<>]/g, '')}</title>
<base href="${baseUrl}/">
<style>
  /* The page box. Chromium honours @page, which is what gives the PDF real
     margins and a paper size instead of a screenshot of a web page. */
  @page { size: A4; margin: 12mm; }
  @page landscape { size: A4 landscape; margin: 10mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  /* Repeat table headers across pages — the single most important property of
     a multi-page report, and the one a naive HTML→PDF always loses. */
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  tr { break-inside: avoid; }
</style>
</head>
<body>${html}</body>
</html>`;
}

/**
 * Render report HTML to a PDF buffer.
 *
 * @param {{html:string,title?:string,landscape?:boolean,baseUrl:string,direction?:string}} spec
 * @returns {Promise<Buffer>}
 */
async function renderUnbounded(spec) {
  // VALIDATE FIRST. A malformed request is malformed on every host; checking
  // the browser first made the same empty payload answer 422 where Chromium was
  // installed and 503 where it was not — one request, two truths, and the
  // caller left guessing which problem to fix.
  const html = String((spec && spec.html) || '');
  if (!html.trim()) {
    const error = new Error('html is required');
    error.code = 'VALIDATION_ERROR';
    error.http = 422;
    error.expose = true;
    throw error;
  }
  const launcher = resolveLauncher();
  if (!launcher) {
    throw unavailable('No Chromium binary is available to render a PDF on this host.');
  }

  let browser = null;
  try {
    browser = await launcher.puppeteer.launch({
      executablePath: launcher.executablePath,
      // Container flags, each one earned on this host:
      //
      //   --no-sandbox / --disable-setuid-sandbox  no user namespaces in the container
      //   --disable-dev-shm-usage                  /dev/shm is 64MB here; Chromium
      //                                            writes its renderer heap there and
      //                                            dies silently when it fills
      //   --disable-gpu / --disable-extensions / --disable-background-networking
      //                                            nothing to draw on, nothing to load
      //   --font-render-hinting=none               deterministic glyph metrics, so the
      //                                            PDF matches the printed page
      //
      // NOT here, deliberately: `--single-process` and `--no-zygote`. They were
      // tried against the first deploy's hang and made it worse in a way that
      // looked better — the browser came up, then died on `Target.setAutoAttach`
      // with TargetCloseError. Puppeteer needs a real target hierarchy to attach
      // to; single-process has no separate renderer target to attach TO. A fast
      // failure is not a fix.
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-extensions', '--disable-background-networking',
        '--font-render-hinting=none',
      ],
      // Default is 180s. A report request must not hold a connection open for
      // three minutes to discover it failed.
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
    });
    const page = await browser.newPage();
    // `domcontentloaded`, not `networkidle0`: the document is self-contained
    // apart from the stylesheet and font, and waiting for the network to fall
    // idle means waiting out every asset that will never arrive.
    await page.setContent(buildDocument(spec), { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Let webfonts land so the whole document renders in one face — but BOUND
    // it. `document.fonts.ready` never settling would hang the request, and a
    // report in a fallback font is infinitely better than no report.
    await Promise.race([
      page.evaluateHandle('document.fonts.ready').catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    const output = await page.pdf({
      format: 'A4',
      landscape: !!(spec && spec.landscape),
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '12mm', right: '12mm', bottom: '14mm', left: '12mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      // Page numbers belong ON the paper: a report that loses its pagination is
      // a stack of sheets nobody can prove is complete.
      footerTemplate:
        '<div style="width:100%;font-size:8pt;color:#52525b;padding:0 12mm;text-align:center;">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    // ALWAYS a Buffer. puppeteer 23 changed `page.pdf()` to return a
    // Uint8Array, and Express's `res.send` takes any non-Buffer object down
    // the JSON path: a 50KB PDF is re-emitted as {"0":37,"1":80,...}, one key
    // per byte, megabytes of it, with Content-Type application/json. That is
    // what the first deploy's "hang" actually was — not a stalled browser, a
    // response being serialised a byte at a time. Normalising here fixes every
    // consumer at once instead of each one rediscovering it.
    return Buffer.isBuffer(output) ? output : Buffer.from(output);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* the process is going away anyway */ }
    }
  }
}

/**
 * The public entry point: `renderUnbounded` under a hard deadline.
 *
 * A hung render is worse than a failed one. It holds a connection, shows the
 * user nothing, and on the first production deploy of this feature it did
 * exactly that — Chromium came up, the CDP handshake stalled in a constrained
 * container, and the request sat there until the client gave up with no
 * message at all. A deadline converts that into a coded 503 the UI can fall
 * back from, in seconds.
 */
async function render(spec) {
  let timer = null;
  try {
    return await Promise.race([
      renderUnbounded(spec),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable(
          `PDF rendering exceeded ${RENDER_TIMEOUT_MS}ms on this host.`,
        )), RENDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Render the smallest possible document, and report what actually happened.
 *
 * `isAvailable` only answers "is there a binary on this box" — and that is
 * exactly the question that shipped a button which hung: the binary was
 * present, the probe said yes, and every render died on the CDP handshake. A
 * probe that cannot distinguish "installed" from "works" is not a probe.
 *
 * Never throws: the whole point is to report the failure, not to become one.
 */
async function selfTest() {
  const startedAt = Date.now();
  try {
    const buffer = await render({
      html: '<p>اختبار</p>',
      title: 'selftest',
      baseUrl: 'about:blank',
    });
    const ok = Buffer.isBuffer(buffer) && buffer.length > 0
      && buffer.slice(0, 4).toString('latin1') === '%PDF';
    return {
      rendered: ok,
      ms: Date.now() - startedAt,
      bytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
      // A buffer that is not a PDF is a different failure from no buffer at all.
      reason: ok ? null : 'PDF_OUTPUT_NOT_A_PDF',
    };
  } catch (error) {
    return {
      rendered: false,
      ms: Date.now() - startedAt,
      bytes: 0,
      reason: (error && error.code) || 'PDF_RENDER_FAILED',
      // The class name, not the message: enough to tell a launch failure from a
      // protocol timeout without putting an internal string in an HTTP body.
      detail: (error && error.constructor && error.constructor.name) || null,
    };
  }
}

module.exports = {
  render, isAvailable, selfTest, buildDocument, __resetForTests,
  CHROMIUM_CANDIDATES, RENDER_TIMEOUT_MS, PROTOCOL_TIMEOUT_MS,
};
