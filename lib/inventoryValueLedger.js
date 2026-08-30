/**
 * The valued movement ledger — projector and valuation rules.
 *
 * ─── THE PROBLEM IT SOLVES ──────────────────────────────────────────────────
 * `inventory_movements` records QUANTITY and nothing else.
 * `warehouse_stock.avg_cost` is TODAY's average. So a quantity that moved in
 * March can only be priced at today's cost, and every "historical" valuation is
 * really today's cost wearing an old date. The error is invisible: it looks
 * like a rounding difference and grows the further back you look.
 *
 * ─── WHY A PROJECTOR ────────────────────────────────────────────────────────
 * `INSERT INTO inventory_movements` appears at 36 sites in 10 files. Wiring a
 * ledger write into each one makes completeness depend on every future
 * contributor remembering — and a valued ledger with holes is worse than none,
 * because it is trusted exactly when it is wrong.
 *
 * Projecting from `inventory_movements.seq` (monotonic auto-increment) makes
 * completeness structural instead: whatever path wrote the movement, the
 * projector sees it. `uq_ivl_movement_seq` makes replay idempotent, so the
 * recovery procedure is simply "run it again".
 *
 * ─── FORWARD-ONLY ───────────────────────────────────────────────────────────
 * Nothing before activation is back-filled. The cost at the time is not
 * recoverable and inventing it would be the fabrication this ledger exists to
 * end. `activated_at` is published so a report can REFUSE an earlier date
 * rather than return a partial period that looks whole.
 */
'use strict';

const crypto = require('crypto');

const STATE_ID = 'default';
/** Rows per projector tick. Bounded so one tick cannot hold the event loop. */
const BATCH_SIZE = 500;

/**
 * How a unit cost was established, strongest first. Stored per row: a ledger
 * that records a number without recording where it came from cannot be
 * audited, and these are not equally strong.
 */
const COST_BASIS = Object.freeze({
  /** The warehouse's own weighted average at projection time. */
  WAREHOUSE_WAC: 'warehouse_wac',
  /** The item's global cost — no per-warehouse average existed. */
  ITEM_COST: 'item_cost',
  /** Neither existed. The row is written with 0 and says so. */
  UNKNOWN: 'unknown',
});

function round(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, digits == null ? 2 : digits);
  return Math.round(n * f) / f;
}

/**
 * Choose the unit cost for a movement, and say which rule produced it.
 *
 * A missing cost is recorded as UNKNOWN with a zero value rather than skipped:
 * dropping the row would leave a hole in a ledger whose entire value is that it
 * has none. A zero that announces itself can be found and corrected; an absent
 * row cannot even be counted.
 */
function resolveUnitCost(row) {
  const wac = Number(row && row.warehouse_avg_cost);
  if (Number.isFinite(wac) && wac > 0) return { unitCost: wac, basis: COST_BASIS.WAREHOUSE_WAC };
  const item = Number(row && row.item_cost);
  if (Number.isFinite(item) && item > 0) return { unitCost: item, basis: COST_BASIS.ITEM_COST };
  return { unitCost: 0, basis: COST_BASIS.UNKNOWN };
}

/** `YYYY-MM` of the movement, frozen at projection time. */
function accountingPeriod(movementAt) {
  const d = movementAt instanceof Date ? movementAt : new Date(movementAt);
  if (Number.isNaN(d.getTime())) return '0000-00';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Turn one movement row into one ledger row.
 *
 * `extended_value` is ALWAYS positive and the direction carries the sign. A
 * signed value plus a direction column is the same fact twice, and the day they
 * disagree there is no way to tell which one is right.
 */
function toLedgerRow(movement) {
  const { unitCost, basis } = resolveUnitCost(movement);
  const quantity = Math.abs(Number(movement.qty) || 0);
  const direction = String(movement.type).toLowerCase() === 'in' ? 'in' : 'out';
  return {
    id: 'IVL-' + crypto.createHash('sha1')
      .update(String(movement.seq)).digest('hex').slice(0, 24),
    movement_seq: Number(movement.seq),
    movement_id: String(movement.id),
    movement_at: movement.movement_date,
    accounting_period: accountingPeriod(movement.movement_date),
    item_id: String(movement.item_id || ''),
    warehouse_id: movement.warehouse_id || null,
    direction,
    quantity: round(quantity, 4),
    unit_cost: round(unitCost, 6),
    extended_value: round(quantity * unitCost, 2),
    cost_basis: basis,
    source_type: movement.reference_type || null,
    source_id: movement.reference_id || null,
    // A reversal is linked by the caller that knows it is one; the projector
    // cannot infer intent from a quantity's sign.
    reverses_ledger_id: null,
    actor: movement.username || null,
  };
}

async function readState(db) {
  const [rows] = await db.query(
    'SELECT id, activated_seq, activated_at, cursor_seq FROM inventory_value_ledger_state WHERE id = ?',
    [STATE_ID],
  );
  return rows && rows[0] ? rows[0] : null;
}

/**
 * Project one batch. Returns { projected, cursor, done }.
 *
 * NEVER throws for a single bad row — a projector that dies on one movement
 * stops the whole ledger, and a stopped ledger silently stops being complete.
 */
async function projectBatch(db, limit) {
  const state = await readState(db);
  if (!state) return { projected: 0, cursor: 0, done: true, reason: 'not_activated' };

  const size = Number(limit) || BATCH_SIZE;
  const [movements] = await db.query(
    `SELECT m.seq, m.id, m.movement_date, m.item_id, m.type, m.qty, m.warehouse_id,
            m.reference_type, m.reference_id, m.username,
            ws.avg_cost AS warehouse_avg_cost,
            i.cost      AS item_cost
       FROM inventory_movements m
       LEFT JOIN warehouse_stock ws
              ON ws.warehouse_id = m.warehouse_id AND ws.item_id = m.item_id
       LEFT JOIN inv_items i ON i.id = m.item_id
      WHERE m.seq > ?
      ORDER BY m.seq ASC
      LIMIT ?`,
    [state.cursor_seq, size],
  );

  if (!movements.length) return { projected: 0, cursor: Number(state.cursor_seq), done: true };

  let projected = 0;
  let cursor = Number(state.cursor_seq);
  for (const movement of movements) {
    const row = toLedgerRow(movement);
    try {
      // INSERT IGNORE, not REPLACE: a row already projected must not be
      // rewritten. The ledger is immutable — replay is a no-op, not an update.
      const [result] = await db.query(
        `INSERT IGNORE INTO inventory_value_ledger
           (id, movement_seq, movement_id, movement_at, accounting_period, item_id,
            warehouse_id, direction, quantity, unit_cost, extended_value, cost_basis,
            source_type, source_id, reverses_ledger_id, actor)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.id, row.movement_seq, row.movement_id, row.movement_at, row.accounting_period,
          row.item_id, row.warehouse_id, row.direction, row.quantity, row.unit_cost,
          row.extended_value, row.cost_basis, row.source_type, row.source_id,
          row.reverses_ledger_id, row.actor],
      );
      if (result && result.affectedRows) projected += 1;
    } catch (error) {
      // Log and CARRY ON. One malformed movement must not freeze the watermark
      // — a stuck projector stops the ledger being complete without ever
      // saying so, which is the failure this design exists to avoid.
      console.error('[inventory-value-ledger] seq', movement.seq, error && error.message);
    }
    cursor = Number(movement.seq);
  }

  await db.query(
    'UPDATE inventory_value_ledger_state SET cursor_seq = ? WHERE id = ? AND cursor_seq < ?',
    [cursor, STATE_ID, cursor],
  );
  return { projected, cursor, done: movements.length < size };
}

/** Drain the backlog. Bounded so a cold start cannot spin forever. */
async function runProjector(db, options) {
  const maxBatches = Number((options || {}).maxBatches) || 20;
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const step = await projectBatch(db, (options || {}).batchSize);
    total += step.projected;
    if (step.done) break;
  }
  return { projected: total };
}

/**
 * The date before which this ledger knows nothing.
 *
 * A report MUST refuse an earlier `from` rather than return a partial period.
 * A half-covered month looks exactly like a quiet month.
 */
async function reportingStartsAt(db) {
  const state = await readState(db);
  return state ? state.activated_at : null;
}

module.exports = {
  STATE_ID,
  BATCH_SIZE,
  COST_BASIS,
  round,
  resolveUnitCost,
  accountingPeriod,
  toLedgerRow,
  readState,
  projectBatch,
  runProjector,
  reportingStartsAt,
};
