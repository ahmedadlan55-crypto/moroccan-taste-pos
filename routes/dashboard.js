const router = require('express').Router();
const db = require('../db/connection');
// Unified Sales Analytics — leg resolution + method fold for the payment-mix
// fallback (un-backfilled DBs). Tolerant require: absence degrades the
// fallback only, never the dashboard.
let _projection = null;
try { _projection = require('../services/analytics/ProjectionService'); } catch (_) { /* facts-only */ }

// ═══════════════════════════════════════════════════════════════════
// Enterprise Command Center — single-call aggregator
// GET /api/dashboard/overview?brandId=&branchId=&from=YYYY-MM-DD&to=YYYY-MM-DD
//   &preset=today|yesterday|thisWeek|lastWeek|last7|last14|last30|last90
//          |thisMonth|lastMonth|thisQuarter|lastQuarter|thisYear|lastYear
//   &compare=previous|yearAgo|none
// ═══════════════════════════════════════════════════════════════════

function _ymd(d) { return d.toISOString().slice(0, 10); }

function _startOfWeek(d) {  // Saturday as week start (Arabic / Middle-East convention)
  const nd = new Date(d);
  const dow = nd.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 1) % 7; // Sat=6 → 0, Sun=0 → 1, etc.
  nd.setDate(nd.getDate() - diff);
  nd.setHours(0,0,0,0);
  return nd;
}

function _resolvePeriod(query) {
  const now = new Date();
  const today = _ymd(now);
  let from = query.from || today;
  let to   = query.to   || today;

  const p = (query.preset || '').toLowerCase();
  const yyyy = now.getFullYear();
  const mm   = now.getMonth();
  const dd   = now.getDate();

  switch (p) {
    case 'today':       from = to = today; break;
    case 'yesterday': {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      from = to = _ymd(y); break;
    }
    case 'thisweek': {
      const s = _startOfWeek(now);
      from = _ymd(s); to = today; break;
    }
    case 'lastweek': {
      const s = _startOfWeek(now); s.setDate(s.getDate() - 7);
      const e = new Date(s); e.setDate(e.getDate() + 6);
      from = _ymd(s); to = _ymd(e); break;
    }
    case 'last7':   { const d = new Date(now); d.setDate(d.getDate() - 6);   from = _ymd(d); to = today; break; }
    case 'last14':  { const d = new Date(now); d.setDate(d.getDate() - 13);  from = _ymd(d); to = today; break; }
    case 'last30':  { const d = new Date(now); d.setDate(d.getDate() - 29);  from = _ymd(d); to = today; break; }
    case 'last90':  { const d = new Date(now); d.setDate(d.getDate() - 89);  from = _ymd(d); to = today; break; }
    case 'thismonth':   { from = _ymd(new Date(yyyy, mm, 1));             to = today; break; }
    case 'lastmonth': {
      const s = new Date(yyyy, mm - 1, 1);
      const e = new Date(yyyy, mm, 0);
      from = _ymd(s); to = _ymd(e); break;
    }
    case 'thisquarter': { const qs = Math.floor(mm/3)*3; from = _ymd(new Date(yyyy, qs, 1)); to = today; break; }
    case 'lastquarter': {
      const qs = Math.floor(mm/3)*3;
      const s = new Date(yyyy, qs - 3, 1);
      const e = new Date(yyyy, qs, 0);
      from = _ymd(s); to = _ymd(e); break;
    }
    case 'thisyear':    { from = _ymd(new Date(yyyy, 0, 1)); to = today; break; }
    case 'lastyear': {
      const s = new Date(yyyy - 1, 0, 1);
      const e = new Date(yyyy - 1, 11, 31);
      from = _ymd(s); to = _ymd(e); break;
    }
    case 'week':  { const d = new Date(now); d.setDate(d.getDate() - 6);   from = _ymd(d); to = today; break; } // legacy alias
    case 'month': { from = _ymd(new Date(yyyy, mm, 1)); to = today; break; }                                    // legacy alias
    case 'quarter':{ const qs = Math.floor(mm/3)*3; from = _ymd(new Date(yyyy, qs, 1)); to = today; break; }    // legacy alias
    case 'year':  { from = _ymd(new Date(yyyy, 0, 1)); to = today; break; }                                     // legacy alias
  }
  return { from, to, preset: p };
}

function _computeCompareWindow(from, to, compareMode) {
  const fromD = new Date(from + 'T00:00:00');
  const toD   = new Date(to   + 'T00:00:00');
  const rangeDays = Math.max(1, Math.round((toD - fromD) / 86400000) + 1);

  if (compareMode === 'none') return { from: null, to: null, rangeDays, mode: 'none' };
  if (compareMode === 'yearago') {
    const s = new Date(fromD); s.setFullYear(s.getFullYear() - 1);
    const e = new Date(toD);   e.setFullYear(e.getFullYear() - 1);
    return { from: _ymd(s), to: _ymd(e), rangeDays, mode: 'yearAgo' };
  }
  // default: immediately previous window of the same length
  const prevTo   = new Date(fromD); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (rangeDays - 1));
  return { from: _ymd(prevFrom), to: _ymd(prevTo), rangeDays, mode: 'previous' };
}

function _pctChange(curr, prev) {
  if (!prev || prev === 0) return curr > 0 ? 100 : 0;
  return ((curr - prev) / prev) * 100;
}

router.get('/overview', async (req, res) => {
  try {
    const { brandId, branchId } = req.query;
    const { from, to } = _resolvePeriod(req.query);
    const compareMode = (req.query.compare || 'previous').toLowerCase();
    const prev = _computeCompareWindow(from, to, compareMode);

    // Filter fragments: apply brand+branch to EVERY table that has those columns
    // Each table's owner appends its own alias to AND-clauses (we inline them
    // below per-query since fragments differ by alias).
    const hasBrand  = !!brandId;
    const hasBranch = !!branchId;

    // Helper to add filters for a given alias (e.g. 's' for sales, 'p' for purchases)
    function flt(alias) {
      let sql = '';
      const p = [];
      if (hasBrand)  { sql += ` AND ${alias}.brand_id = ?`;  p.push(brandId); }
      if (hasBranch) { sql += ` AND ${alias}.branch_id = ?`; p.push(branchId); }
      return { sql, p };
    }

    const sF = flt('s');  // sales
    const eF = flt('e');  // expenses
    const pF = flt('p');  // purchases
    const fF = flt('f');  // analytics_payment_facts (has brand_id + branch_id)
    const dF = flt('d');  // analytics_daily_branch rollups (brand_id + branch_id)

    // Runner: executes the per-period queries for a given date window
    async function periodQueries(f, t) {
      const [sales, expenses, purchases, orders] = await Promise.all([
        db.query(
          `SELECT COALESCE(SUM(s.total_final),0) AS v, COUNT(*) AS c
           FROM sales s WHERE DATE(s.order_date) BETWEEN ? AND ? ${sF.sql}`,
          [f, t, ...sF.p]),
        db.query(
          `SELECT COALESCE(SUM(e.amount),0) AS v FROM expenses e
           WHERE DATE(e.expense_date) BETWEEN ? AND ? ${eF.sql}`,
          [f, t, ...eF.p]),
        db.query(
          `SELECT COALESCE(SUM(p.total_price),0) AS v FROM purchases p
           WHERE DATE(p.purchase_date) BETWEEN ? AND ? ${pF.sql}`,
          [f, t, ...pF.p]),
        db.query(
          `SELECT COUNT(*) AS c FROM sales s WHERE DATE(s.order_date) BETWEEN ? AND ? ${sF.sql}`,
          [f, t, ...sF.p])
      ]);
      return {
        salesV: Number(sales[0][0].v || 0),
        salesC: Number(sales[0][0].c || 0),
        expV:   Number(expenses[0][0].v || 0),
        purV:   Number(purchases[0][0].v || 0),
        ordersC:Number(orders[0][0].c || 0)
      };
    }

    const currP = await periodQueries(from, to);
    const prevP = prev.from
      ? await periodQueries(prev.from, prev.to)
      : { salesV:0, salesC:0, expV:0, purV:0, ordersC:0 };

    // Non-period queries — run in parallel
    const [
      dailySales, hourlyToday, topItems, topCashiers, topBrands, topBranches,
      lowStock, expiringSoon,
      openTxns, pendingPayments, overdueAR, overdueAP,
      openShifts, cashPosition, bankBalances,
      suppliersCnt, customersCnt, brandsCnt, branchesCnt,
      paymentMixQ, cogsAgg
    ] = await Promise.all([
      // Daily sales trend (for chart)
      db.query(
        `SELECT DATE(s.order_date) AS d,
                COALESCE(SUM(s.total_final),0) AS total,
                COUNT(*) AS cnt
         FROM sales s WHERE DATE(s.order_date) BETWEEN ? AND ? ${sF.sql}
         GROUP BY DATE(s.order_date) ORDER BY d`,
        [from, to, ...sF.p]),
      // Hourly chart — aggregates sales by HOUR across the selected date
      // range (was previously hard-pinned to CURDATE() which depends on the
      // MySQL server timezone — in UTC, "today" could lag the user's local
      // day by 3h on a fresh morning. Using the same `from/to` filter as
      // the rest of the dashboard is both more consistent AND gives a
      // useful "peak hour of day" pattern across multiple days, matching
      // what Foodics / Square / Toast do). v5.10.53.
      db.query(
        `SELECT HOUR(s.order_date) AS h, COALESCE(SUM(s.total_final),0) AS total
         FROM sales s WHERE DATE(s.order_date) BETWEEN ? AND ? ${sF.sql}
         GROUP BY HOUR(s.order_date) ORDER BY h`,
        [from, to, ...sF.p])
        .catch(e => { console.error('[dashboard.hourly]', e.message); return [[]]; }),
      // Top items in range (brand-filtered via the parent sale).
      // v5.10.53 — three SQL errors fixed:
      //   1) table  sale_items   → sales_items   (schema uses plural)
      //   2) column si.sale_id   → si.order_id   (FK column name)
      //   3) column si.line_total → si.total      (price-total column)
      // The previous `.catch(() => [[]])` was silently swallowing the SQL
      // error — that's why the section was empty with no console clue.
      db.query(
        `SELECT si.item_name AS name, SUM(si.qty) AS qty, SUM(si.total) AS rev
         FROM sales_items si JOIN sales s ON s.id = si.order_id
         WHERE DATE(s.order_date) BETWEEN ? AND ? ${sF.sql}
         GROUP BY si.item_name ORDER BY rev DESC LIMIT 10`,
        [from, to, ...sF.p])
        .catch(e => { console.error('[dashboard.topItems]', e.message); return [[]]; }),
      // Top cashiers
      db.query(
        `SELECT s.username, COUNT(*) AS orders, COALESCE(SUM(s.total_final),0) AS total
         FROM sales s WHERE DATE(s.order_date) BETWEEN ? AND ? ${sF.sql}
         GROUP BY s.username ORDER BY total DESC LIMIT 5`,
        [from, to, ...sF.p]),
      // Top brands (purchases + sales combined per brand)
      db.query(
        `SELECT b.id, b.name,
                COALESCE((SELECT SUM(total_price) FROM purchases p2
                          WHERE p2.brand_id = b.id
                            AND DATE(p2.purchase_date) BETWEEN ? AND ?),0) AS purchases_total,
                COALESCE((SELECT SUM(total_final) FROM sales s2
                          WHERE s2.brand_id = b.id
                            AND DATE(s2.order_date) BETWEEN ? AND ?),0) AS sales_total,
                COALESCE((SELECT COUNT(*) FROM purchases p3 WHERE p3.brand_id = b.id
                          AND DATE(p3.purchase_date) BETWEEN ? AND ?),0) AS purchase_count
         FROM brands b
         ORDER BY (sales_total + purchases_total) DESC LIMIT 5`,
        [from, to, from, to, from, to]).catch(() => [[]]),
      // Top branches (by sales)
      db.query(
        `SELECT br.id, br.name, COALESCE(SUM(s.total_final),0) AS total, COUNT(s.id) AS cnt
         FROM branches br LEFT JOIN sales s ON s.branch_id = br.id
           AND DATE(s.order_date) BETWEEN ? AND ?
         GROUP BY br.id, br.name ORDER BY total DESC LIMIT 5`,
        [from, to]).catch(() => [[]]),
      // Low stock items
      db.query(
        `SELECT id, name, stock, min_stock, unit FROM inv_items
         WHERE active = 1 AND stock <= min_stock ORDER BY (min_stock - stock) DESC LIMIT 10`),
      // Expiring within 30 days
      db.query(
        `SELECT item_name AS name, batch_number, expiry_date, qty
         FROM inv_batches WHERE expiry_date IS NOT NULL
           AND expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
           AND qty > 0 ORDER BY expiry_date ASC LIMIT 10`).catch(() => [[]]),
      // Open workflow transactions
      db.query(
        `SELECT COUNT(*) AS c FROM transactions
         WHERE status IN ('pending','in_progress','approved_pending_payment')`).catch(() => [[{c:0}]]),
      // Pending payments
      db.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(amount),0) AS v FROM payment_records
         WHERE status IN ('requested','authorized')`).catch(() => [[{c:0, v:0}]]),
      // AR outstanding (customers owing)
      db.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(balance),0) AS v FROM customers
         WHERE balance > 0 AND is_active = 1`).catch(() => [[{c:0, v:0}]]),
      // AP outstanding (suppliers we owe)
      db.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(balance),0) AS v FROM suppliers
         WHERE balance > 0 AND is_active = 1 ${hasBrand?'AND brand_id = ?':''}`,
        hasBrand ? [brandId] : []).catch(() => [[{c:0, v:0}]]),
      // Open shifts
      db.query(`SELECT COUNT(*) AS c FROM shifts WHERE status='OPEN'`),
      // Cash position — the old query read a phantom sale-payments table that
      // has NEVER existed in this schema; its .catch reported cash=0 forever.
      // The REAL unified tender-leg store is analytics_payment_facts (one row
      // per leg, split sales included): today's cash-in minus cash-out
      // (refunds), minus today's cash expenses (same expenses clause as
      // before). Kept pinned to "today" like the original — this is a cash
      // POSITION, not a period metric.
      db.query(`SELECT
          (SELECT COALESCE(SUM(CASE WHEN f.direction = 'in' THEN f.amount ELSE -f.amount END),0)
            FROM analytics_payment_facts f
            WHERE f.method_norm = 'cash' AND f.business_day = CURDATE() ${fF.sql})
          -
          (SELECT COALESCE(SUM(amount),0) FROM expenses e
            WHERE DATE(e.expense_date) = CURDATE() AND e.payment_method = 'cash' ${eF.sql})
          AS cash`,
        [...fF.p, ...eF.p]).catch(e => { console.error('[dashboard.cashPosition]', e.message); return [[{cash:0}]]; }),
      // Bank balances
      db.query(
        `SELECT account_name, bank_name, current_balance FROM bank_accounts
         WHERE is_active = 1 ORDER BY current_balance DESC LIMIT 10`).catch(() => [[]]),
      // Counts
      db.query(`SELECT COUNT(*) AS c FROM suppliers WHERE is_active = 1 ${hasBrand?'AND brand_id = ?':''}`, hasBrand?[brandId]:[]),
      db.query(`SELECT COUNT(*) AS c FROM customers WHERE is_active = 1`),
      db.query(`SELECT COUNT(*) AS c FROM brands`).catch(() => [[{c:0}]]),
      db.query(`SELECT COUNT(*) AS c FROM branches`).catch(() => [[{c:0}]]),
      // Payment mix over the SELECTED period — analytics_payment_facts is the
      // unified store (split legs are separate rows, so a split sale counts
      // once per tender, never once per sale). direction='in' only: refunds
      // must not contaminate the mix. Same from/to window as the rest of the
      // dashboard (business_day is the branch-local attribution).
      db.query(
        `SELECT COALESCE(f.method_norm,'other') AS method,
                COALESCE(SUM(f.amount),0) AS amount, COUNT(*) AS cnt
           FROM analytics_payment_facts f
          WHERE f.direction = 'in' AND f.business_day BETWEEN ? AND ? ${fF.sql}
          GROUP BY COALESCE(f.method_norm,'other')
          ORDER BY amount DESC`,
        [from, to, ...fF.p]).catch(e => { console.error('[dashboard.paymentMix]', e.message); return [[]]; }),
      // Real COGS for the margin KPI — analytics_daily_branch rollups over the
      // same period. When empty (un-backfilled / rollup not yet run) the
      // response falls back to the historical (sales − purchases) proxy and
      // SAYS SO via kpi.grossMargin.marginBasis.
      db.query(
        `SELECT COALESCE(SUM(d.cogs),0) AS cogs, COALESCE(SUM(d.net_ex_vat),0) AS net
           FROM analytics_daily_branch d
          WHERE d.business_day BETWEEN ? AND ? ${dF.sql}`,
        [from, to, ...dF.p]).catch(e => { console.error('[dashboard.cogs]', e.message); return [[{cogs:0, net:0}]]; })
    ]);

    const salesV = currP.salesV;
    const ordersC = currP.ordersC;
    const expV = currP.expV;
    const purV = currP.purV;
    const salesVPrev  = prevP.salesV;
    const ordersCPrev = prevP.ordersC;
    const expVPrev    = prevP.expV;
    const purVPrev    = prevP.purV;

    // ── Payment mix: facts first, honest fallback second ──────────────────
    // On an un-backfilled DB the facts table has no rows for the window while
    // sales exist. Rather than showing an empty (lying) mix, derive the legs
    // from the sales rows themselves using the SAME resolution + method fold
    // ProjectionService uses (split_details_json object/array, the
    // "Cash:80/Mada:20" string, or the single label) — so the buckets are
    // IDENTICAL to what backfill would project. basis says which path fed it.
    let paymentMixRows = paymentMixQ[0] || [];
    let paymentMixBasis = 'facts';
    if (!paymentMixRows.length && _projection) {
      try {
        const [srows] = await db.query(
          `SELECT s.id, s.total_final, s.payment_method, s.split_details_json
             FROM sales s WHERE DATE(s.order_date) BETWEEN ? AND ? ${sF.sql}`,
          [from, to, ...sF.p]);
        if (srows.length) {
          const agg = new Map();
          for (const s of srows) {
            // posOrder=null → no per-sale queries; a detail-less bare 'split'
            // degrades to one 'other' leg (the projection's own last resort).
            const { legs } = await _projection._resolvePaymentLegs(db, s, null);
            for (const leg of legs) {
              const m = _projection.normalizeMethod(leg.label);
              const cur = agg.get(m) || { amount: 0, cnt: 0 };
              cur.amount += Number(leg.amount) || 0;
              cur.cnt += 1;
              agg.set(m, cur);
            }
          }
          paymentMixRows = [...agg.entries()]
            .map(([method, v]) => ({ method, amount: Math.round(v.amount * 100) / 100, cnt: v.cnt }))
            .sort((a, b) => b.amount - a.amount);
          paymentMixBasis = 'derived';
        }
      } catch (e) { console.error('[dashboard.paymentMix.fallback]', e.message); }
    }

    // ── Margin: real COGS when the rollups have it, labeled proxy otherwise ──
    const cogsV   = Number(cogsAgg[0][0].cogs || 0);
    const cogsNet = Number(cogsAgg[0][0].net || 0);
    const marginBasis = cogsV > 0 ? 'cogs' : 'proxy';
    const grossMarginValue = marginBasis === 'cogs'
      ? (cogsNet > 0 ? ((cogsNet - cogsV) / cogsNet) * 100 : 0)
      : (salesV > 0 ? ((salesV - purV) / salesV) * 100 : 0);

    res.json({
      period: {
        from, to,
        rangeDays: prev.rangeDays,
        prevFrom: prev.from, prevTo: prev.to, compareMode: prev.mode
      },
      filters: { brandId: brandId || '', branchId: branchId || '' },

      // Executive KPIs
      kpi: {
        sales:      { value: salesV,    prev: salesVPrev,  delta: _pctChange(salesV, salesVPrev) },
        orders:     { value: ordersC,   prev: ordersCPrev, delta: _pctChange(ordersC, ordersCPrev) },
        avgTicket:  { value: ordersC ? salesV / ordersC : 0, prev: ordersCPrev ? salesVPrev / ordersCPrev : 0,
                      delta: _pctChange(ordersC ? salesV/ordersC : 0, ordersCPrev ? salesVPrev/ordersCPrev : 0) },
        expenses:   { value: expV,      prev: expVPrev,    delta: _pctChange(expV, expVPrev) },
        purchases:  { value: purV,      prev: purVPrev,    delta: _pctChange(purV, purVPrev) },
        netIncome:  { value: salesV - expV, prev: salesVPrev - expVPrev,
                      delta: _pctChange(salesV - expV, salesVPrev - expVPrev) },
        // marginBasis: 'cogs' → (net_ex_vat − COGS) / net_ex_vat from the
        // analytics_daily_branch rollups; 'proxy' → the historical
        // (sales − purchases) / sales approximation. The UI can label it;
        // existing consumers read only .value (additive, non-breaking).
        grossMargin:{ value: grossMarginValue, marginBasis }
      },

      // Operational pulse
      ops: {
        openShifts:      Number(openShifts[0][0].c || 0),
        openTransactions:Number(openTxns[0][0].c || 0),
        pendingPayments: { count: Number(pendingPayments[0][0].c || 0), amount: Number(pendingPayments[0][0].v || 0) },
        arOutstanding:   { count: Number(overdueAR[0][0].c || 0), amount: Number(overdueAR[0][0].v || 0) },
        apOutstanding:   { count: Number(overdueAP[0][0].c || 0), amount: Number(overdueAP[0][0].v || 0) },
        cashInHand:      Number(cashPosition[0][0].cash || 0),
        lowStockCount:   lowStock[0].length,
        expiringCount:   expiringSoon[0].length
      },

      // Entity counters
      counts: {
        suppliers: Number(suppliersCnt[0][0].c || 0),
        customers: Number(customersCnt[0][0].c || 0),
        brands:    Number(brandsCnt[0][0].c || 0),
        branches:  Number(branchesCnt[0][0].c || 0)
      },

      // Payment mix (period-scoped, tender legs, direction 'in' only).
      // basis: 'facts' = analytics_payment_facts; 'derived' = recomputed from
      // sales.payment_method / split_details_json (un-backfilled DB fallback).
      paymentMix: {
        basis: paymentMixBasis,
        methods: paymentMixRows.map(r => ({
          method: r.method,
          amount: Number(r.amount) || 0,
          count: Number(r.cnt) || 0
        }))
      },

      // Charts
      charts: {
        dailySales:   dailySales[0].map(r => ({ date: _ymd(new Date(r.d)), total: Number(r.total), count: Number(r.cnt) })),
        hourlyToday:  hourlyToday[0].map(r => ({ hour: Number(r.h), total: Number(r.total) })),
        topItems:     topItems[0].map(r => ({ name: r.name, qty: Number(r.qty), revenue: Number(r.rev) })),
        topCashiers:  topCashiers[0].map(r => ({ name: r.username, orders: Number(r.orders), total: Number(r.total) })),
        topBrands:    topBrands[0].map(r => ({ id: r.id, name: r.name,
                         total: Number(r.purchases_total) + Number(r.sales_total),
                         purchases: Number(r.purchases_total),
                         sales: Number(r.sales_total),
                         count: Number(r.purchase_count) })),
        topBranches:  topBranches[0].map(r => ({ id: r.id, name: r.name, total: Number(r.total), count: Number(r.cnt) }))
      },

      // Alerts lists
      alerts: {
        lowStock: lowStock[0].map(r => ({
          id: r.id, name: r.name,
          stock: Number(r.stock || 0),
          minStock: Number(r.min_stock || 0),
          unit: r.unit || 'وحدة',
          shortfall: Math.max(0, Number(r.min_stock || 0) - Number(r.stock || 0))
        })),
        expiringSoon: expiringSoon[0].map(r => ({
          name: r.name, batchNumber: r.batch_number,
          expiryDate: r.expiry_date ? _ymd(new Date(r.expiry_date)) : null,
          qty: Number(r.qty || 0),
          daysLeft: r.expiry_date ? Math.ceil((new Date(r.expiry_date) - new Date()) / 86400000) : null
        })),
        bankBalances: bankBalances[0].map(r => ({
          name: r.account_name || r.bank_name,
          bank: r.bank_name,
          balance: Number(r.current_balance || 0)
        }))
      }
    });
  } catch (e) {
    console.error('Dashboard overview error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
