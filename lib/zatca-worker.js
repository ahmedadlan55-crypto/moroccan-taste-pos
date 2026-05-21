/**
 * lib/zatca-worker.js — Background worker that submits queued sales +
 * credit notes to the ZATCA Fatoora portal.
 *
 * Architecture:
 *   1. routes/sales.js enqueues a row in zatca_submission_queue after
 *      every COMMITted sale or credit-note transaction.
 *   2. This worker polls the queue every 30 seconds. For each pending
 *      row whose next_attempt_at <= NOW():
 *        a) Loads the original document (sales or credit_notes).
 *        b) Re-builds the UBL XML.
 *        c) Signs it with the company's CSID private key.
 *        d) Submits to the appropriate ZATCA endpoint (reporting for
 *           simplified, clearance for standard, compliance for sandbox).
 *        e) On success: marks the doc as 'accepted', writes signed XML
 *           + response cache, marks queue row 'done'.
 *        f) On failure: increments attempt_count, schedules next retry
 *           with exponential backoff. After 5 failed attempts marks
 *           'failed' + logs to audit_log.
 *   3. Concurrent workers (multi-instance deploy) are safe via
 *      SELECT ... FOR UPDATE SKIP LOCKED — only one worker grabs each row.
 *
 * Graceful no-op when:
 *   - companies.zatca_csid_status != 'compliance' and != 'production'
 *     (i.e. owner hasn't onboarded yet — sales still save, just not sent)
 *   - ZATCA_DISABLE_WORKER=1 env (for local dev / tests)
 *
 * v6.1.0 — Wave E.6
 */

const db = require('../db/connection');
const zatca = require('./zatca');
const zatcaUbl = require('./zatca-ubl');
const zatcaSigner = require('./zatca-signer');
const zatcaClient = require('./zatca-client');
const encryption = require('./encryption');

const BACKOFF_SECS = [60, 300, 1800, 7200, 28800];   // 1m → 5m → 30m → 2h → 8h
const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 30 * 1000;
const BATCH_SIZE = 5;

let _started = false;
let _pollTimer = null;

/**
 * Start the worker. Idempotent — safe to call multiple times.
 */
function start() {
  if (_started) return;
  if (process.env.ZATCA_DISABLE_WORKER === '1') {
    console.log('[zatca-worker] disabled via env');
    return;
  }
  _started = true;
  console.log('[zatca-worker] started, polling every ' + (POLL_INTERVAL_MS / 1000) + 's');
  // Stagger the first run by 5s so we don't race with server boot
  setTimeout(_tick, 5000);
}

function stop() {
  _started = false;
  if (_pollTimer) clearTimeout(_pollTimer);
  _pollTimer = null;
}

async function _tick() {
  if (!_started) return;
  try {
    await _processBatch();
  } catch (e) {
    console.warn('[zatca-worker] tick error:', e.message);
  } finally {
    if (_started) _pollTimer = setTimeout(_tick, POLL_INTERVAL_MS);
  }
}

/**
 * Public: enqueue a document for submission. Called from
 * routes/sales.js right after the COMMIT of the sale / credit-note tx.
 *
 * No-op if the company isn't onboarded (zatca_csid_status='none').
 */
async function enqueue(docType, docId) {
  if (!docType || !docId) return;
  try {
    // Check whether we even have credentials — if not, skip enqueue (the
    // doc still gets a Phase 1 QR via the existing stampSale).
    const [c] = await db.query(
      "SELECT zatca_csid_status FROM companies WHERE id='CO-MAIN' LIMIT 1"
    );
    if (!c.length || (c[0].zatca_csid_status !== 'compliance' &&
                       c[0].zatca_csid_status !== 'production')) {
      return;
    }
    const id = 'ZQ-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    await db.query(
      'INSERT INTO zatca_submission_queue (id, doc_type, doc_id, next_attempt_at, status) ' +
      'VALUES (?, ?, ?, NOW(), ?)',
      [id, docType, docId, 'pending']
    );
  } catch (e) {
    console.warn('[zatca-worker] enqueue skipped (' + docType + ' ' + docId + '): ' + e.message);
  }
}

async function _processBatch() {
  let rows = [];
  try {
    const result = await db.withTransaction(async (conn) => {
      // Pick up to BATCH_SIZE pending rows ready for retry
      const [pending] = await conn.query(
        `SELECT id, doc_type, doc_id, attempt_count
         FROM zatca_submission_queue
         WHERE status = 'pending' AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at ASC
         LIMIT ? FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );
      // Mark as running so concurrent workers skip them
      for (const r of pending) {
        await conn.query("UPDATE zatca_submission_queue SET status='running' WHERE id = ?", [r.id]);
      }
      return pending;
    });
    rows = result;
  } catch (e) {
    // FOR UPDATE SKIP LOCKED not supported on older MySQL — fall back to
    // a plain SELECT + best-effort update.
    const [pending] = await db.query(
      `SELECT id, doc_type, doc_id, attempt_count
       FROM zatca_submission_queue
       WHERE status = 'pending' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC LIMIT ?`,
      [BATCH_SIZE]
    );
    for (const r of pending) {
      await db.query("UPDATE zatca_submission_queue SET status='running' WHERE id = ? AND status='pending'", [r.id]);
    }
    rows = pending;
  }
  if (!rows.length) return;

  // Load credentials once per batch
  const creds = await _loadCredentials();
  if (!creds) {
    // Onboarding lost — release the rows back to pending
    for (const r of rows) {
      await db.query("UPDATE zatca_submission_queue SET status='pending', next_attempt_at = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?", [r.id]);
    }
    return;
  }

  for (const row of rows) {
    try {
      await _submitOne(row, creds);
      await db.query(
        "UPDATE zatca_submission_queue SET status='done', last_error=NULL WHERE id = ?",
        [row.id]
      );
    } catch (e) {
      const newCount = row.attempt_count + 1;
      const failed = newCount >= MAX_ATTEMPTS;
      const next = failed ? null :
        new Date(Date.now() + BACKOFF_SECS[newCount - 1] * 1000);
      await db.query(
        `UPDATE zatca_submission_queue
         SET status = ?,
             attempt_count = ?,
             next_attempt_at = ?,
             last_error = ?
         WHERE id = ?`,
        [
          failed ? 'failed' : 'pending',
          newCount,
          next || new Date(),
          String(e.message || e).slice(0, 1000),
          row.id
        ]
      );
      if (failed) {
        try {
          await db.query(
            "INSERT INTO audit_log (id, username, action, table_name, record_id, device_info) VALUES (?, 'system', 'zatca_submission_failed', ?, ?, ?)",
            ['AUD-' + Date.now() + '-zw', row.doc_type, row.doc_id, String(e.message || '').slice(0, 500)]
          );
        } catch (_) {}
      }
    }
  }
}

async function _loadCredentials() {
  try {
    const [c] = await db.query(`
      SELECT name, tax_number, zatca_csid_status,
             zatca_binary_token_encrypted, zatca_secret_encrypted, zatca_private_key_encrypted
      FROM companies WHERE id='CO-MAIN' LIMIT 1`);
    if (!c.length) return null;
    const r = c[0];
    if (r.zatca_csid_status !== 'compliance' && r.zatca_csid_status !== 'production') return null;
    return {
      sellerName: r.name || '',
      sellerVat: r.tax_number || '',
      csidStatus: r.zatca_csid_status,
      binaryToken: encryption.decrypt(r.zatca_binary_token_encrypted),
      secret:      encryption.decrypt(r.zatca_secret_encrypted),
      privateKey:  encryption.decrypt(r.zatca_private_key_encrypted)
    };
  } catch (e) {
    console.warn('[zatca-worker] _loadCredentials failed:', e.message);
    return null;
  }
}

async function _submitOne(row, creds) {
  // 1. Load the document
  const docTable = row.doc_type === 'sale' ? 'sales' : 'credit_notes';
  const [docs] = await db.query('SELECT * FROM ' + docTable + ' WHERE id = ? LIMIT 1', [row.doc_id]);
  if (!docs.length) throw new Error('doc-not-found:' + row.doc_id);
  const doc = docs[0];

  // 2. Build UBL XML
  const seller = {
    name: creds.sellerName,
    vatNumber: creds.sellerVat,
    crNumber: process.env.COMPANY_CR || '',
    address: {
      street:   process.env.COMPANY_STREET   || '',
      buildingNumber: process.env.COMPANY_BUILDING || '0000',
      district: process.env.COMPANY_DISTRICT || '',
      city:     process.env.COMPANY_CITY     || 'Riyadh',
      postalCode: process.env.COMPANY_POSTAL || '00000'
    }
  };
  const lines = JSON.parse(doc.items_json || '[]').map(it => ({
    name: it.name, qty: it.qty, unitPrice: it.price, taxCategory: 'S'
  }));
  const total = Number(doc.total_final) || 0;
  const vat = Math.round((total - total / 1.15) * 100) / 100;
  const ksaNow = zatca.nowInRiyadh(new Date(doc.created_at || doc.order_date || Date.now()));
  const taxSubtotals = doc.tax_subtotals_json
    ? JSON.parse(doc.tax_subtotals_json)
    : { S: { net: total - vat, vat: vat, rate: 15 } };

  let xml;
  if (row.doc_type === 'sale') {
    xml = zatcaUbl.buildSimplifiedInvoiceXml({
      sale: {
        id: doc.id, orderId: doc.id,
        invoiceUuid: doc.invoice_uuid,
        previousInvoiceHash: doc.previous_invoice_hash,
        issueDate: ksaNow.date, issueTime: ksaNow.time,
        total, vatAmount: vat,
        paymentMethod: doc.payment_method,
        taxSubtotals
      },
      seller, lines, taxSubtotals
    });
  } else {
    // Credit note
    xml = zatcaUbl.buildCreditNoteXml({
      creditNote: {
        id: doc.id,
        uuid: doc.invoice_uuid,
        previousInvoiceHash: doc.previous_invoice_hash,
        originalInvoiceNumber: doc.original_sale_id,
        originalInvoiceUuid: doc.original_invoice_uuid,
        issueDate: ksaNow.date, issueTime: ksaNow.time,
        totalFinal: total, vatAmount: vat,
        reason: doc.reason, reasonCode: doc.reason_code,
        paymentMethod: doc.payment_method
      },
      seller, lines, taxSubtotals
    });
  }

  // 3. Sign
  const canonical = zatcaUbl.canonicalize(xml);
  const signResult = zatcaSigner.signInvoiceXml({
    ublXml: xml,
    canonicalXml: canonical,
    privateKeyPem: creds.privateKey,
    certPem: '',
    certBase64: creds.binaryToken,
    issuerName: 'CN=ZATCA',
    serialNumber: '1'
  });

  // 4. Submit
  const endpoint = (creds.csidStatus === 'production')
    ? (row.doc_type === 'sale' ? 'reportInvoice' : 'reportInvoice')
    : 'complianceInvoiceUpload';
  const submitFn = zatcaClient[endpoint];
  const submitResult = await submitFn({
    invoiceHash: signResult.invoiceHash,
    uuid: doc.invoice_uuid,
    invoiceXmlBase64: Buffer.from(signResult.signedXml, 'utf8').toString('base64'),
    binaryToken: creds.binaryToken,
    secret: creds.secret
  });

  // 5. Persist response
  const ok = (submitResult.status === 200 || submitResult.status === 202);
  await db.query(
    'UPDATE ' + docTable + ' SET zatca_xml_signed = ?, zatca_response_json = ?, zatca_status = ?, zatca_submitted_at = NOW() WHERE id = ?',
    [signResult.signedXml, JSON.stringify(submitResult.body || {}), ok ? 'accepted' : 'rejected', doc.id]
  );

  if (!ok) {
    throw new Error('ZATCA rejected: HTTP ' + submitResult.status + ' ' + JSON.stringify(submitResult.body || {}).slice(0, 500));
  }
}

module.exports = { start, stop, enqueue };
