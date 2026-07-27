/**
 * lib/analytics/registry/facts.js — the catalog of queryable fact sources.
 *
 * A fact is a CONSTANT join graph: a FROM clause string that never changes at
 * runtime. The planner (later wave) composes SELECT/WHERE/GROUP BY around it
 * from the metric + dimension registries; nothing may bolt extra joins onto a
 * fact, and no dimension/metric may reference an alias a fact doesn't expose.
 * That rule is what makes the whole registry statically auditable (see
 * tests/analyticsRegistry.test.js).
 *
 * Alias conventions (referenced by registry/dimensions.js + metrics.js):
 *   f   analytics_order_facts       doc  ar_documents
 *   d   ar_document_lines           p    analytics_payment_facts
 *   m   analytics_modifier_facts    r    sales_returns
 *   rl  sales_return_lines          t    analytics_till_facts
 *   b   analytics_sales_budget
 *
 * dateBases: the column each date basis resolves to for this fact. business_day
 * is the trading-day column (branch close-time aware); calendar_day is the raw
 * local timestamp/date.
 *
 * The `return` fact has NO business_day of its own: sales_returns stores only
 * a DATE (return_date), never a local timestamp, so its business_day basis IS
 * its calendar date. Documented rather than faked.
 */
'use strict';

const FACTS = Object.freeze({
  order: Object.freeze({
    id: 'order',
    alias: 'f',
    from: 'FROM analytics_order_facts f JOIN ar_documents doc ON doc.id = f.document_id',
    aliases: Object.freeze(['f', 'doc']),
    dateBases: Object.freeze({
      business_day: 'f.business_day',
      calendar_day: 'f.occurred_at_local',
      paid_at: 'f.paid_at',
      opened_at: 'f.opened_at',
      closed_at: 'f.closed_at',
    }),
    scopeColumn: 'f.branch_id',
  }),

  line: Object.freeze({
    id: 'line',
    alias: 'd',
    from: 'FROM ar_document_lines d ' +
      'JOIN ar_documents doc ON doc.id = d.document_id ' +
      'JOIN analytics_order_facts f ON f.document_id = doc.id',
    aliases: Object.freeze(['d', 'doc', 'f']),
    dateBases: Object.freeze({
      business_day: 'f.business_day',
      calendar_day: 'f.occurred_at_local',
      paid_at: 'f.paid_at',
    }),
    scopeColumn: 'f.branch_id',
  }),

  modifier: Object.freeze({
    id: 'modifier',
    alias: 'm',
    from: 'FROM analytics_modifier_facts m ' +
      'JOIN analytics_order_facts f ON f.document_id = m.document_id',
    aliases: Object.freeze(['m', 'f']),
    dateBases: Object.freeze({
      business_day: 'f.business_day',
      calendar_day: 'f.occurred_at_local',
    }),
    scopeColumn: 'f.branch_id',
  }),

  payment: Object.freeze({
    id: 'payment',
    alias: 'p',
    from: 'FROM analytics_payment_facts p',
    aliases: Object.freeze(['p']),
    dateBases: Object.freeze({
      business_day: 'p.business_day',
      calendar_day: 'p.occurred_at_local',
      settled_at: 'p.settled_at',
    }),
    scopeColumn: 'p.branch_id',
  }),

  // The status predicate rides in the JOIN on purpose. This fact had NO status
  // filter at all, so a draft a cashier raised and a return someone cancelled
  // counted exactly like a posted one: every returns figure, and every profit
  // figure net of returns, was inflated by paperwork that never moved goods or
  // money. There is no baseWhere hook on a fact and no return_status dimension
  // to filter by, so the predicate belongs here — where it cannot be forgotten
  // by a caller. (tests/analyticsRegistry.test.js parses aliases out of this
  // string; an extra ON condition does not disturb that.)
  return: Object.freeze({
    id: 'return',
    alias: 'rl',
    from: "FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id AND r.status = 'posted'",
    aliases: Object.freeze(['rl', 'r']),
    dateBases: Object.freeze({
      // sales_returns has only a DATE — see header note.
      business_day: 'r.return_date',
      calendar_day: 'r.return_date',
    }),
    scopeColumn: 'r.branch_id',
  }),

  till: Object.freeze({
    id: 'till',
    alias: 't',
    from: 'FROM analytics_till_facts t',
    aliases: Object.freeze(['t']),
    dateBases: Object.freeze({
      business_day: 't.business_day',
      calendar_day: 't.occurred_at_local',
    }),
    scopeColumn: 't.branch_id',
  }),

  budget: Object.freeze({
    id: 'budget',
    alias: 'b',
    from: 'FROM analytics_sales_budget b',
    aliases: Object.freeze(['b']),
    dateBases: Object.freeze({
      // Budgets are monthly — both bases resolve to the month anchor date.
      business_day: 'b.period_month',
      calendar_day: 'b.period_month',
    }),
    scopeColumn: 'b.branch_id',
  }),
});

/** The alias set a SQL expression may reference for a given fact. */
function aliasesOf(factId) {
  const f = FACTS[factId];
  return f ? f.aliases : [];
}

module.exports = { FACTS, aliasesOf };
