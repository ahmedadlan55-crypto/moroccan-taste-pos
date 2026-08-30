/**
 * PDF rendering endpoint.
 *
 *   GET  /reports/pdf/capability  — can this host render a PDF at all?
 *   POST /reports/pdf             — report HTML in, PDF out.
 *
 * ─── WHY THE CLIENT SENDS THE HTML ──────────────────────────────────────────
 * The alternative is for the server to open the report's own URL in a browser,
 * which means the renderer needs the user's session, their filters, their
 * warehouse scope and their language — a second, parallel implementation of
 * every report, authenticated differently. The client already holds the exact
 * document it prints; sending it means the PDF and the printed page are the
 * same artifact by construction.
 *
 * ─── THE HTML IS NOT TRUSTED ────────────────────────────────────────────────
 * It is rendered in a browser with no network beyond this host, no sandbox
 * escape, and its output is a PDF returned to the SAME user who sent it. It is
 * never stored, never shown to anyone else, and never executed server-side. A
 * caller can therefore only render their own markup to their own file — which
 * is what the print dialog already lets them do.
 *
 * ─── AVAILABILITY IS A FACT, NOT A PROMISE ──────────────────────────────────
 * The browser binary is an OS package. `/capability` exists so the UI can ask
 * BEFORE offering the button, instead of presenting an action that 503s. When
 * it is unavailable the browser print path still produces the same document.
 */
'use strict';

const router = require('express').Router();
const { hasCapability } = require('../../../middleware/requireCapability');
const RE = require('../../../lib/reportErrors');
const PdfService = require('../../../services/reports/PdfService');

/** Anyone who may read a report may render the one they are looking at. */
async function READ(req, res, next) {
  try {
    if (!req.user || !req.user.username) {
      return res.status(401).json({ success: false, code: 'PERMISSION_DENIED', error: 'مطلوب تسجيل الدخول' });
    }
    const allowed = await hasCapability(req.user, 'reports.view') ||
      await hasCapability(req.user, 'finance.reports.view') ||
      await hasCapability(req.user, 'procurement.reports') ||
      await hasCapability(req.user, 'analytics.view');
    if (!allowed) {
      return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية' });
    }
    return next();
  } catch (_) {
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', error: 'صلاحية غير كافية' });
  }
}

router.get('/reports/pdf/capability', READ, (req, res) => {
  const available = PdfService.isAvailable();
  return res.json({
    success: true,
    data: {
      available,
      // Named so the UI can explain rather than just grey a button out.
      reason: available ? null : 'PDF_RENDERER_UNAVAILABLE',
    },
    generatedAt: new Date().toISOString(),
  });
});

router.post('/reports/pdf', READ, async (req, res) => {
  try {
    const body = req.body || {};
    // Loopback: the renderer runs in this process's own container, so the
    // report's stylesheet and Cairo webfont resolve without leaving the host.
    const port = Number(process.env.PORT) || 3000;
    const buffer = await PdfService.render({
      html: body.html,
      title: body.title,
      landscape: body.landscape === true || body.landscape === 'true',
      direction: body.direction,
      baseUrl: `http://127.0.0.1:${port}`,
    });

    const safeName = String(body.filename || body.title || 'report')
      .replace(/[^\w؀-ۿ .-]/g, '_')
      .slice(0, 80);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.pdf"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.status(200).send(buffer);
  } catch (e) {
    // A missing renderer is a 503 with a code the UI understands; anything else
    // goes through the shared sanitiser and never leaks internals.
    return RE.sendReportError(res, e, 'erp/reports/pdf', req);
  }
});

module.exports = router;
