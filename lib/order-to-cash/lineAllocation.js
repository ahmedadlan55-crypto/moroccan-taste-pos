/**
 * lib/order-to-cash/lineAllocation.js — per-line money allocation for the eager
 * POS→O2C projection (routes/sales.js → InvoiceService.linkPosSale).
 *
 * WHY THIS EXISTS
 * The checkout never computes post-discount per-line money. Its VAT loop
 * (routes/sales.js:492-508) produces PRE-discount line net/vat and immediately
 * discards them into accumulators; the discount is then applied at the HEADER
 * in gross space (:533-536) and reconciled per CATEGORY, not per line
 * (:619-642). So a projected line's net/vat/discount do not exist anywhere —
 * they must be derived, and derived so they tie EXACTLY to what was recorded.
 *
 * THE CONTRACT
 * The header figures are authoritative; lines are fitted to them, never the
 * reverse. `tax_subtotals_json` is what the ZATCA UBL XML sums and what the GL
 * posted, so a per-category bucket is binding and a line may not disagree with
 * its bucket even by one halala.
 *
 * WHY INTEGER HALALAS
 * Float sums do not close. `Σ(0.1) × 3 !== 0.3`, and the repo already carries
 * THREE divergent rounding contracts (lib/pricing.js::_round2 with no epsilon
 * vs calculations.js::round with 1e-9) that disagree at .005 boundaries. This
 * module does all arithmetic in integer minor units so closure is exact by
 * construction rather than by luck, and adds no fourth contract.
 *
 * WHY TWO INDEPENDENT ALLOCATIONS
 * Σ(category net + vat) already equals total_final, because the reconciliation
 * at routes/sales.js:634-641 forces the buckets to sum to net/vat and :568-569
 * forces net + vat === invTotal. So allocating net and vat per category makes
 * the line grosses tie to the header for free.
 *
 * Discount CANNOT ride on that. The whole-SAR rounding delta (:564) means
 *   Σ(preGross) − Σ(postGross) === appliedDiscount − _roundDelta
 * so deriving each line's discount as (preGross − postGross) would silently
 * fold a rounding artifact into the discount and miss the stated invariant by
 * the delta. Discount is therefore allocated separately against the real
 * applied figure. A rounding artifact is not a discount.
 *
 * WHY _roundDelta IS NOT AN INPUT
 * It is already absorbed into `net` (:568) and therefore already inside the
 * reconciled buckets (:635-639). Passing it in as well would double-count it.
 *
 * This module is pure: no DB, no clock, no config. Same inputs → same output.
 */
'use strict';

/** Bumped when the allocation algorithm changes in a way that alters output. */
const PROJECTION_VERSION = 1;

/**
 * SAR → integer halalas. Every caller-supplied amount has already been rounded
 * to 2dp by the checkout, so this is exact rather than a re-rounding.
 */
function toMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Integer halalas → SAR. */
function fromMinor(minor) {
  return minor / 100;
}

/**
 * Distribute `target` across `weights` proportionally so the parts sum EXACTLY
 * to `target`. All values are integers; the arithmetic never leaves integers.
 *
 * Largest-remainder (Hare quota): floor every exact share, then hand the
 * leftover units to the largest fractional remainders. Ties break on `keys`
 * ascending, which is what makes a re-run bit-identical — without it, two lines
 * with equal remainders would take the leftover halala in whatever order the
 * sort happened to settle on.
 *
 * A zero weight sum with a non-zero target has no proportional answer, so it
 * falls back to equal weights rather than inventing one or dropping the target.
 */
function largestRemainder(target, weights, keys) {
  const n = weights.length;
  if (n === 0) return [];

  // Allocate on the magnitude and re-sign at the end: Math.trunc would push
  // negative remainders the wrong way and break the leftover count.
  const sign = target < 0 ? -1 : 1;
  const mag = Math.abs(target);

  let w = weights;
  let sumW = 0;
  for (let i = 0; i < n; i++) sumW += w[i];
  if (sumW === 0) {
    w = new Array(n).fill(1);
    sumW = n;
  }

  const parts = new Array(n);
  const remainders = new Array(n);
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const exact = mag * w[i];
    const q = Math.floor(exact / sumW);
    parts[i] = q;
    remainders[i] = exact - q * sumW;
    assigned += q;
  }

  // Σremainders is always an exact multiple of sumW, so leftover < n.
  const leftover = mag - assigned;
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => {
    if (remainders[b] !== remainders[a]) return remainders[b] - remainders[a];
    const ka = String(keys[a]);
    const kb = String(keys[b]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (let k = 0; k < leftover; k++) parts[order[k]] += 1;

  if (sign < 0) for (let i = 0; i < n; i++) parts[i] = -parts[i];
  return parts;
}

function fail(message, detail) {
  const e = new Error(message);
  e.code = 'ALLOCATION_INVARIANT';
  if (detail !== undefined) e.detail = detail;
  return e;
}

/**
 * Fit per-line snapshots to the recorded header figures.
 *
 * @param {object}   input
 * @param {Array}    input.lines           PRE-discount, in cart order:
 *                                         { sourceLineId, cat, rate, net, vat }
 *                                         (net/vat exactly as routes/sales.js:501-502)
 * @param {object}   input.taxSubtotals    FINAL post-discount buckets, i.e. the
 *                                         reconciled tax_subtotals_json:
 *                                         { [cat]: { net, vat, rate } }
 * @param {number}   input.appliedDiscount lineDiscCapped + invDiscCapped — the
 *                                         discount actually applied, NOT the raw
 *                                         body value.
 * @param {number}   input.totalFinal      invTotal (whole SAR).
 * @returns {{ lines: Array, projectionVersion: number }}
 * @throws  {Error}  code ALLOCATION_INVARIANT if any invariant fails. This runs
 *          inside checkout's fatal path, where a rollback is strictly better
 *          than a snapshot that silently disagrees with the GL.
 */
function allocateSaleLines({ lines, taxSubtotals, appliedDiscount, totalFinal }) {
  if (!Array.isArray(lines) || lines.length === 0) throw fail('allocateSaleLines: no lines');
  if (!taxSubtotals || typeof taxSubtotals !== 'object') throw fail('allocateSaleLines: no taxSubtotals');

  const seen = new Set();
  const pre = lines.map((l) => {
    const sourceLineId = String(l.sourceLineId);
    if (seen.has(sourceLineId)) throw fail('allocateSaleLines: duplicate sourceLineId', sourceLineId);
    seen.add(sourceLineId);
    const netMinor = toMinor(l.net);
    const vatMinor = toMinor(l.vat);
    return {
      sourceLineId,
      cat: l.cat,
      rate: Number(l.rate) || 0,
      netMinor,
      vatMinor,
      grossMinor: netMinor + vatMinor,
    };
  });

  const out = pre.map((p) => ({
    sourceLineId: p.sourceLineId,
    cat: p.cat,
    rate: p.rate,
    netMinor: 0,
    vatMinor: 0,
    grossMinor: 0,
    discountMinor: 0,
  }));
  const byId = {};
  out.forEach((o, i) => { byId[o.sourceLineId] = i; });

  // ── 1. net + vat, per category, bound to the reconciled buckets ──────────
  const cats = Object.keys(taxSubtotals);
  for (const cat of cats) {
    const bucket = taxSubtotals[cat];
    const targetNet = toMinor(bucket.net);
    const targetVat = toMinor(bucket.vat);
    const members = pre.filter((p) => p.cat === cat);

    if (members.length === 0) {
      // A bucket with money but no lines cannot be allocated; a 0/0 bucket is
      // merely empty and harmless.
      if (targetNet !== 0 || targetVat !== 0) {
        throw fail(`allocateSaleLines: bucket ${cat} has money but no lines`, { targetNet, targetVat });
      }
      continue;
    }

    const keys = members.map((m) => m.sourceLineId);
    const netParts = largestRemainder(targetNet, members.map((m) => m.netMinor), keys);
    const vatParts = largestRemainder(targetVat, members.map((m) => m.vatMinor), keys);

    members.forEach((m, i) => {
      const o = out[byId[m.sourceLineId]];
      o.netMinor = netParts[i];
      o.vatMinor = vatParts[i];
      o.grossMinor = netParts[i] + vatParts[i];
    });
  }

  // Every line must belong to a bucket, or its money silently vanishes.
  for (const p of pre) {
    if (!Object.prototype.hasOwnProperty.call(taxSubtotals, p.cat)) {
      throw fail('allocateSaleLines: line has no tax bucket', { sourceLineId: p.sourceLineId, cat: p.cat });
    }
  }

  // ── 2. discount, across all lines, bound to the APPLIED figure ───────────
  const targetDiscount = toMinor(appliedDiscount);
  const discParts = largestRemainder(
    targetDiscount,
    pre.map((p) => p.grossMinor),
    pre.map((p) => p.sourceLineId)
  );
  pre.forEach((p, i) => { out[byId[p.sourceLineId]].discountMinor = discParts[i]; });

  // ── 3. invariants — assert, never assume ────────────────────────────────
  for (const cat of cats) {
    const members = out.filter((o) => o.cat === cat);
    if (members.length === 0) continue;
    const sumNet = members.reduce((s, o) => s + o.netMinor, 0);
    const sumVat = members.reduce((s, o) => s + o.vatMinor, 0);
    if (sumNet !== toMinor(taxSubtotals[cat].net)) {
      throw fail(`allocateSaleLines: net does not tie for bucket ${cat}`, { sumNet, target: toMinor(taxSubtotals[cat].net) });
    }
    if (sumVat !== toMinor(taxSubtotals[cat].vat)) {
      throw fail(`allocateSaleLines: vat does not tie for bucket ${cat}`, { sumVat, target: toMinor(taxSubtotals[cat].vat) });
    }
  }

  const sumGross = out.reduce((s, o) => s + o.grossMinor, 0);
  const targetTotal = toMinor(totalFinal);
  if (sumGross !== targetTotal) {
    throw fail('allocateSaleLines: lines do not sum to total_final', { sumGross, targetTotal });
  }

  const sumDisc = out.reduce((s, o) => s + o.discountMinor, 0);
  if (sumDisc !== targetDiscount) {
    throw fail('allocateSaleLines: discount allocations do not sum to the applied discount', { sumDisc, targetDiscount });
  }

  return {
    projectionVersion: PROJECTION_VERSION,
    lines: out.map((o) => ({
      sourceLineId: o.sourceLineId,
      cat: o.cat,
      rate: o.rate,
      netMinor: o.netMinor,
      vatMinor: o.vatMinor,
      grossMinor: o.grossMinor,
      discountMinor: o.discountMinor,
      net: fromMinor(o.netMinor),
      vat: fromMinor(o.vatMinor),
      gross: fromMinor(o.grossMinor),
      discount: fromMinor(o.discountMinor),
    })),
  };
}

module.exports = {
  PROJECTION_VERSION,
  allocateSaleLines,
  largestRemainder,
  toMinor,
  fromMinor,
};
