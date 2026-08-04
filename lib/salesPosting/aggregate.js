'use strict';
/**
 * lib/salesPosting/aggregate.js — turn queue rows into ONE balanced journal.
 *
 * PURE. No DB, no clock, no randomness. It takes rows and returns legs, so the
 * preview the owner approves and the batch that is actually posted come from
 * the same function called twice — not from two implementations that agree
 * today and drift next quarter.
 *
 * ─── THE BUCKETS ────────────────────────────────────────────────────────────
 *
 *   daily    → (business_day, brand, branch)
 *   monthly  → (YYYY-MM of business_day, brand, branch)
 *   invoice  → one bucket per queue row
 *
 * Brand and branch are always part of the key. Merging two branches into one
 * journal would make the dimension columns meaningless and destroy the only
 * per-branch P&L the owner has.
 *
 * The granularity picker RESLICES THE SAME QUEUE. There are not three queues,
 * and every bucket can still enumerate its invoices — which is the owner's
 * non-negotiable: «مع رؤية التفصيل في كل الحالات».
 *
 * ─── THE LEGS ───────────────────────────────────────────────────────────────
 *
 *   Dr  each payment method          (cash, card, transfer, …)
 *   Cr  revenue, grouped by account
 *   Cr  output VAT
 *   Dr  COGS / Cr inventory, per warehouse
 *
 * Returns are ADDITIONAL LINES ON THE SAME ACCOUNTS, never a netting-off. The
 * owner must see sales and returns as two numbers; a single quietly-reduced
 * figure hides whether a bad day was slow trade or heavy refunds.
 *
 * ─── HALALAS, NOT FLOATS ────────────────────────────────────────────────────
 *
 * Everything sums in integer halalas. Money in floating point does not
 * associate: 0.1 + 0.2 !== 0.3, and a journal that is out by 0.01 is rejected
 * outright by postJournal — which, on this path, would reject a whole day of
 * trade rather than one order.
 */

const R = (cents) => Math.round(cents) / 100;
const C = (amount) => Math.round((Number(amount) || 0) * 100);

const GRANULARITIES = Object.freeze(['daily', 'monthly', 'invoice']);

/** YYYY-MM-DD → YYYY-MM, defensively (the value may arrive as a Date). */
function monthOf(day) {
  const s = day instanceof Date ? day.toISOString().slice(0, 10) : String(day || '');
  return s.slice(0, 7);
}
function dayOf(day) {
  return day instanceof Date ? day.toISOString().slice(0, 10) : String(day || '').slice(0, 10);
}

/**
 * The bucket a row belongs to. Brand/branch are normalised to '' rather than
 * null so that two rows with NULL branch land in the SAME bucket — with null
 * they would compare unequal through a Map key built by join().
 */
function bucketKeyOf(row, granularity) {
  const brand = row.brand_id || '';
  const branch = row.branch_id || '';
  if (granularity === 'invoice') return ['invoice', String(row.id), brand, branch].join('|');
  if (granularity === 'monthly') return ['monthly', monthOf(row.business_day), brand, branch].join('|');
  return ['daily', dayOf(row.business_day), brand, branch].join('|');
}

/** The human-facing label for a bucket. */
function bucketLabelOf(row, granularity) {
  if (granularity === 'invoice') return row.invoice_number || String(row.source_id);
  if (granularity === 'monthly') return monthOf(row.business_day);
  return dayOf(row.business_day);
}

function parsePayload(row) {
  if (!row.payload_json) return {};
  if (typeof row.payload_json === 'object') return row.payload_json;   // mysql2 JSON column
  try { return JSON.parse(row.payload_json); } catch (_) { return {}; }
}

/**
 * Group queue rows into buckets.
 * @returns {Array<{key,label,granularity,brandId,branchId,journalDate,rows,totals}>}
 */
function groupIntoBuckets(rows, granularity) {
  if (!GRANULARITIES.includes(granularity)) {
    throw new Error('salesPosting.aggregate: unknown granularity ' + granularity);
  }
  const map = new Map();
  for (const r of rows) {
    const key = bucketKeyOf(r, granularity);
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: bucketLabelOf(r, granularity),
        granularity,
        brandId: r.brand_id || null,
        branchId: r.branch_id || null,
        // The journal carries the LATEST calendar date in the bucket. A batch
        // must never be dated earlier than an event it contains, or it posts
        // into a period that event was not allowed into.
        journalDate: dayOf(r.calendar_date),
        rows: [],
      });
    }
    const b = map.get(key);
    b.rows.push(r);
    const d = dayOf(r.calendar_date);
    if (d > b.journalDate) b.journalDate = d;
  }

  for (const b of map.values()) {
    b.totals = b.rows.reduce((t, r) => ({
      net: t.net + C(r.net_amount),
      tax: t.tax + C(r.tax_amount),
      gross: t.gross + C(r.gross_amount),
      cogs: t.cogs + C(r.cogs_amount),
      sales: t.sales + (r.source_type === 'sale' ? 1 : 0),
      returns: t.returns + (r.source_type !== 'sale' ? 1 : 0),
    }), { net: 0, tax: 0, gross: 0, cogs: 0, sales: 0, returns: 0 });
  }

  // Stable order: by journal date, then by label. Two runs of a preview must
  // list buckets identically or the owner cannot compare them.
  return [...map.values()].sort((a, b) =>
    a.journalDate.localeCompare(b.journalDate) || a.label.localeCompare(b.label));
}

/**
 * Absorb a rounding residual into the largest leg, in halalas.
 *
 * Lifted from the proven per-sale logic in routes/sales.js: round each leg
 * first, then push the difference into the biggest one. Doing it the other way
 * — absorb, then round each leg independently — can re-introduce an imbalance
 * (six even legs on 100 SAR → 6 × 16.67 = 100.02).
 */
function absorbResidual(legs, targetCents, pick) {
  if (!legs.length) return legs;
  const sum = legs.reduce((s, l) => s + pick(l), 0);
  const diff = targetCents - sum;
  if (diff === 0) return legs;
  let big = 0;
  for (let i = 1; i < legs.length; i++) if (Math.abs(pick(legs[i])) > Math.abs(pick(legs[big]))) big = i;
  legs[big].cents = pick(legs[big]) + diff;
  return legs;
}

/**
 * Build the journal legs for one bucket.
 *
 * @param {object} bucket   from groupIntoBuckets
 * @param {object} accounts { revenue, outputVat, cogs, inventory, cashFallback }
 * @returns {{legs:Array, balanced:boolean, debitCents:number, creditCents:number, warnings:string[]}}
 */
function buildLegs(bucket, accounts) {
  const warnings = [];
  const byCode = (bag, code, cents) => {
    if (!code) return;
    bag.set(code, (bag.get(code) || 0) + cents);
  };

  const payments = new Map();     // account code → halalas (debit)
  const revenue = new Map();      // account code → halalas (credit)
  const vat = new Map();
  const cogs = new Map();         // "code|warehouseId" → halalas (debit)
  const inventory = new Map();

  // EVERY amount on a queue row is already signed — the money columns and the
  // payload splits alike (see lib/salesPosting/capture.js#signAll). Nothing
  // here multiplies by a sign again. An earlier version did, and a refund came
  // out as «Dr cash / Cr revenue» — the direction of a sale.
  for (const r of bucket.rows) {
    const p = parsePayload(r);

    // Payments. A row with no split (a legacy or partially-captured event)
    // falls back to a single leg on the cash account so the batch still
    // balances — and says so, because a silently invented payment method is
    // worse than a visible warning.
    const pays = Array.isArray(p.payments) ? p.payments : [];
    if (pays.length) {
      for (const pay of pays) byCode(payments, pay.code, C(pay.amount));
    } else if (C(r.gross_amount) !== 0) {
      byCode(payments, accounts.cashFallback, C(r.gross_amount));
      warnings.push('no payment split for ' + r.source_type + ' ' + r.source_id + ' — posted to ' + accounts.cashFallback);
    }

    // Revenue and VAT. Grouping by the captured account code is what makes a
    // future multi-revenue-account setup work without changing this code; POS
    // sales currently resolve to a single revenue account.
    const revs = Array.isArray(p.revenue) ? p.revenue : [];
    if (revs.length) {
      for (const rv of revs) {
        if (rv.tax) byCode(vat, rv.code, C(rv.amount));
        else byCode(revenue, rv.code, C(rv.amount));
      }
    } else {
      if (C(r.net_amount) !== 0) byCode(revenue, accounts.revenue, C(r.net_amount));
      if (C(r.tax_amount) !== 0) byCode(vat, accounts.outputVat, C(r.tax_amount));
    }

    // COGS / inventory, per warehouse — the grain the inventory credit is
    // posted at, and one `ar_documents` cannot recover because it has no
    // warehouse_id.
    const cw = Array.isArray(p.cogsByWarehouse) ? p.cogsByWarehouse : [];
    if (cw.length) {
      for (const w of cw) {
        const k = (w.cogsCode || accounts.cogs) + '|' + (w.warehouseId || '');
        const ki = (w.inventoryCode || accounts.inventory) + '|' + (w.warehouseId || '');
        cogs.set(k, (cogs.get(k) || 0) + C(w.amount));
        inventory.set(ki, (inventory.get(ki) || 0) + C(w.amount));
      }
    } else if (C(r.cogs_amount) !== 0) {
      const k = accounts.cogs + '|';
      const ki = accounts.inventory + '|';
      cogs.set(k, (cogs.get(k) || 0) + C(r.cogs_amount));
      inventory.set(ki, (inventory.get(ki) || 0) + C(r.cogs_amount));
    }
  }

  const legs = [];
  const push = (code, cents, side, warehouseId, group) => {
    if (cents === 0) return;                      // a zero leg is noise
    // A negative debit is a credit. A net-negative bucket (refunds exceeding
    // sales that day) must flip the side rather than emit a negative amount,
    // which postJournal rejects outright.
    const isDebit = side === 'debit' ? cents > 0 : cents < 0;
    legs.push({
      accountCode: code,
      cents: Math.abs(cents),
      side: isDebit ? 'debit' : 'credit',
      warehouseId: warehouseId || null,
      group,
    });
  };

  for (const [code, cents] of payments) push(code, cents, 'debit', null, 'payment');
  for (const [code, cents] of revenue) push(code, cents, 'credit', null, 'revenue');
  for (const [code, cents] of vat) push(code, cents, 'credit', null, 'vat');
  for (const [k, cents] of cogs) { const [code, wh] = k.split('|'); push(code, cents, 'debit', wh, 'cogs'); }
  for (const [k, cents] of inventory) { const [code, wh] = k.split('|'); push(code, cents, 'credit', wh, 'inventory'); }

  // ── The money check, in halalas ────────────────────────────────────────
  //
  // Σ payments must equal Σ net + Σ tax. A real data invariant, not a
  // rounding question: if it fails, the captured split disagrees with the
  // captured totals, and the honest response is to REFUSE the batch naming
  // the rows — not to plug the difference and post it.
  //
  // Legs are identified by their GROUP, not by account membership: the cash
  // account can legitimately appear on more than one line, and a filter keyed
  // on the account code would sweep the wrong ones into the total.
  //
  // Signed, so a net-negative bucket compares correctly. Taking |Σ| on both
  // sides would let a sign error pass unnoticed.
  const payCents = legs.filter((l) => l.group === 'payment')
    .reduce((s, l) => s + (l.side === 'debit' ? l.cents : -l.cents), 0);
  const expectPay = bucket.totals.net + bucket.totals.tax;
  if (payments.size && payCents !== expectPay) {
    const drift = payCents - expectPay;
    // Up to one halala per row is per-leg rounding; anything larger is a data
    // disagreement that must be seen.
    if (Math.abs(drift) <= Math.max(1, bucket.rows.length)) {
      const payLegs = legs.filter((l) => l.group === 'payment');
      absorbResidual(payLegs, Math.abs(expectPay), (l) => l.cents);
    } else {
      warnings.push('PAYMENT_MISMATCH: payments ' + R(payCents) +
        ' vs net+tax ' + R(expectPay) + ' — ' + bucket.rows.length + ' row(s)');
    }
  }

  const debitCents = legs.filter((l) => l.side === 'debit').reduce((s, l) => s + l.cents, 0);
  const creditCents = legs.filter((l) => l.side === 'credit').reduce((s, l) => s + l.cents, 0);

  return {
    legs: legs.map((l) => ({
      accountCode: l.accountCode,
      debit: l.side === 'debit' ? R(l.cents) : 0,
      credit: l.side === 'credit' ? R(l.cents) : 0,
      warehouseId: l.warehouseId,
    })),
    balanced: debitCents === creditCents,
    debitCents,
    creditCents,
    warnings,
  };
}

/**
 * The whole plan: rows → buckets → legs. What preview renders and what post
 * writes, from one call.
 */
function planBatches(rows, granularity, accounts) {
  const buckets = groupIntoBuckets(rows, granularity);
  return buckets.map((b) => {
    const built = buildLegs(b, accounts);
    return {
      key: b.key,
      label: b.label,
      granularity: b.granularity,
      brandId: b.brandId,
      branchId: b.branchId,
      journalDate: b.journalDate,
      itemCount: b.rows.length,
      salesCount: b.totals.sales,
      returnCount: b.totals.returns,
      net: R(b.totals.net),
      tax: R(b.totals.tax),
      gross: R(b.totals.gross),
      cogs: R(b.totals.cogs),
      queueIds: b.rows.map((r) => r.id),
      sources: b.rows.map((r) => ({
        id: r.id, type: r.source_type, sourceId: r.source_id,
        invoiceNumber: r.invoice_number, gross: R(C(r.gross_amount)),
      })),
      legs: built.legs,
      balanced: built.balanced,
      warnings: built.warnings,
      postable: built.balanced && !built.warnings.some((w) => w.startsWith('PAYMENT_MISMATCH')),
    };
  });
}

module.exports = {
  planBatches,
  groupIntoBuckets,
  buildLegs,
  bucketKeyOf,
  absorbResidual,
  GRANULARITIES,
};
