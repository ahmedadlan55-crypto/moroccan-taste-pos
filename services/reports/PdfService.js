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
async function render(spec) {
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
      // Required in a container: no sandbox namespaces, and /dev/shm is tiny.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
    const page = await browser.newPage();
    // `setContent` with a <base> lets relative asset URLs resolve back to this
    // server, so the document gets the real stylesheet and the real font.
    await page.setContent(buildDocument(spec), { waitUntil: 'networkidle0', timeout: 20000 });
    // Give webfonts a chance to land; without this the first page can render in
    // a fallback face while later pages use Cairo.
    await page.evaluateHandle('document.fonts.ready');
    return await page.pdf({
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
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* the process is going away anyway */ }
    }
  }
}

module.exports = { render, isAvailable, buildDocument, __resetForTests, CHROMIUM_CANDIDATES };
