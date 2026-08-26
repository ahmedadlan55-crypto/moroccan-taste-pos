#!/usr/bin/env node
'use strict';

const assert = require('assert');
const db = require('../db/connection');
const reports = require('../routes/procurement/reports');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ✅', name); }
  catch (error) { console.error('  ❌', name, '\n     ', error.message); throw error; }
}

function handler(path) {
  const layer = reports.stack.find((entry) => entry.route && entry.route.path === path);
  assert(layer, `route ${path} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function responseCapture() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
    setHeader() {},
    send(body) { this.body = body; return body; },
  };
}

async function withQuery(fake, fn) {
  const original = db.query;
  db.query = fake;
  try { return await fn(); }
  finally { db.query = original; }
}

async function withSnapshotConnection(fake, fn) {
  const original = db.getConnection;
  const events = [];
  const connection = {
    async query(sql, params) {
      events.push({ event: 'query', sql, params: [...(params || [])] });
      return fake(sql, params || []);
    },
    async beginTransaction() { events.push({ event: 'begin' }); },
    async commit() { events.push({ event: 'commit' }); },
    async rollback() { events.push({ event: 'rollback' }); },
    release() { events.push({ event: 'release' }); },
  };
  db.getConnection = async () => {
    events.push({ event: 'acquire' });
    return connection;
  };
  try { return await fn(events); }
  finally { db.getConnection = original; }
}

(async () => {
  console.log('\n═══ Procurement report accounting semantics ═══');

  await test('open-order SQL prorates immutable line total by remaining quantity', async () => {
    assert.match(reports.OPEN_ORDER_QTY, /GREATEST/);
    assert.match(reports.OPEN_ORDER_QTY, /base_received_qty/);
    assert.match(reports.OPEN_ORDER_VALUE, /OPEN_ORDER_QTY|GREATEST/);
    assert.match(reports.OPEN_ORDER_VALUE, /pl\.total/);
    assert.match(reports.OPEN_ORDER_VALUE, /base_qty/);
    assert.doesNotMatch(reports.OPEN_ORDER_VALUE, /po\.total_after_vat/);
  });

  await test('open-order response totals the remaining value, never the full PO header', async () => {
    let sqlSeen = '';
    const res = responseCapture();
    await withQuery(async (sql) => {
      sqlSeen = sql;
      return [[{
        id: 'PO-1', total_after_vat: 1000, open_qty: 2.5, remaining_value: 250.126,
      }]];
    }, async () => handler('/open-orders')({
      query: {}, warehouseScope: { all: true },
    }, res));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data[0].remaining_value, 250.13);
    assert.equal(res.body.totals.value, 250.13);
    assert.notEqual(res.body.totals.value, 1000);
    assert.match(sqlSeen, /AS remaining_value/);
    assert(sqlSeen.includes(reports.OPEN_ORDER_VALUE));
  });

  await test('supplier AP statement includes only after-invoice returns in opening and period', async () => {
    const calls = [];
    const res = responseCapture();
    await withSnapshotConnection(async (sql, params) => {
      calls.push({ sql, params: [...params] });
      if (/^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/.test(sql)) return [[], []];
      if (/FROM suppliers WHERE id/.test(sql)) {
        return [[{ id: 'SUP-1', name: 'Supplier One', name_en: 'Supplier One', vat_number: 'VAT-1' }]];
      }
      if (/SUM\(si\.total_amount\)/.test(sql)) return [[{ value: 100 }]];
      if (/SUM\(pa\.allocated_amount\)/.test(sql)) return [[{ value: 20 }]];
      if (/SUM\(pret\.total\)/.test(sql)) {
        return [[{ value: params.includes('after_invoice') ? 30 : 900 }]];
      }
      if (/FROM supplier_invoices si WHERE/.test(sql)) {
        return [[{ id: 'INV-1', code: 'INV-1', date: '2026-08-02', total_amount: 50 }]];
      }
      if (/FROM payment_allocations pa/.test(sql)) {
        return [[{ id: 'PAY-1', payment_id: 'P-1', date: '2026-08-03', allocated_amount: 10, payment_number: 'PAY-1' }]];
      }
      if (/FROM purchase_returns pret WHERE/.test(sql)) {
        return [params.includes('after_invoice')
          ? [{ id: 'RET-A', return_number: 'RET-A', date: '2026-08-04', total: 5 }]
          : [{ id: 'RET-BEFORE', return_number: 'RET-BEFORE', date: '2026-08-04', total: 900 }]];
      }
      throw new Error(`unexpected query: ${sql}`);
    }, async (events) => {
      await handler('/supplier-statement')({
      query: { supplierId: 'SUP-1', from: '2026-08-01', to: '2026-08-31' },
      warehouseScope: { all: true },
      }, res);
      const begin = events.findIndex((entry) => entry.event === 'begin');
      const firstBusinessQuery = events.findIndex((entry) => entry.event === 'query' && /FROM suppliers WHERE id/.test(entry.sql));
      const commit = events.findIndex((entry) => entry.event === 'commit');
      const release = events.findIndex((entry) => entry.event === 'release');
      assert(begin >= 0 && begin < firstBusinessQuery, 'transaction begins before statement reads');
      assert(firstBusinessQuery < commit, 'all statement reads finish before commit');
      assert(commit < release, 'connection is released only after commit');
      assert(!events.some((entry) => entry.event === 'rollback'));
    });

    assert.equal(reports.AP_RETURN_PHASE, 'after_invoice');
    const returnCalls = calls.filter((call) => /purchase_returns pret/.test(call.sql));
    assert.equal(returnCalls.length, 2);
    for (const call of returnCalls) {
      assert.match(call.sql, /pret\.phase = \?/);
      assert(call.params.includes('after_invoice'));
    }
    // opening 100 invoice - 20 payment - 30 AP-affecting return = 50;
    // period +50 invoice -10 payment -5 AP-affecting return = 85.
    assert.equal(res.body.opening, 50);
    assert.equal(res.body.closingBalance, 85);
    assert.deepEqual(res.body.supplier, { id: 'SUP-1', name: 'Supplier One', nameEn: 'Supplier One', vatNumber: 'VAT-1' });
    assert.deepEqual(res.body.snapshot, { complete: true, rowCount: 3, rowLimit: reports.REPORT_SNAPSHOT_LIMIT });
    assert(!res.body.data.some((line) => line.id === 'RET-BEFORE'));
  });

  await test('supplier statement CSV localizes headers and opening row in English', async () => {
    const res = responseCapture();
    const headers = {};
    res.setHeader = (key, value) => { headers[String(key).toLowerCase()] = String(value); };
    await withSnapshotConnection(async (sql) => {
      if (/^SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/.test(sql)) return [[], []];
      if (/FROM suppliers WHERE id/.test(sql)) return [[{
        id: 'SUP-CSV', name: 'مورد', name_en: 'Supplier', vat_number: 'VAT-CSV',
      }]];
      if (/COALESCE\(SUM/.test(sql)) return [[{ value: 0 }]];
      if (/FROM supplier_invoices si WHERE|FROM payment_allocations pa|FROM purchase_returns pret WHERE/.test(sql)) return [[]];
      throw new Error(`unexpected query: ${sql}`);
    }, async () => handler('/supplier-statement')({
      query: {
        supplierId: 'SUP-CSV', from: '2026-08-01', to: '2026-08-31', format: 'csv', lang: 'en',
      },
      warehouseScope: { all: true },
    }, res));

    assert.match(String(res.body), /^﻿Date,Type,Reference,Debit,Credit,Balance\r?\n2026-08-01,Opening,Opening balance/);
    assert.match(headers['content-disposition'], /supplier-statement-SUP-CSV-2026-08-01-2026-08-31\.csv/);
  });

  await test('AP aging uses SQL calendar days and exact 30/60/90 boundaries', async () => {
    const ages = [0, 1, 30, 31, 60, 61, 90, 91];
    let sqlSeen = '';
    let paramsSeen = [];
    const res = responseCapture();
    await withQuery(async (sql, params) => {
      sqlSeen = sql;
      paramsSeen = [...params];
      return [ages.map((age, index) => ({
        id: `INV-${index}`, supplier_id: 'SUP-1', supplier_name: 'Supplier',
        due_date: 'ignored-by-node', age_days: age, total_amount: 10, paid: 0,
      }))];
    }, async () => handler('/ap-aging')({
      query: { asOfDate: '2026-08-12' }, warehouseScope: { all: true },
    }, res));

    assert.match(sqlSeen, /DATEDIFF\(\?, si\.due_date\) AS age_days/);
    assert.doesNotMatch(sqlSeen, /TIMESTAMPDIFF/);
    assert.deepEqual(paramsSeen.slice(0, 2), ['2026-08-12', '2026-08-12']);
    const row = res.body.data[0];
    assert.equal(row.current, 10);   // day 0
    assert.equal(row.d30, 20);      // days 1 and 30
    assert.equal(row.d60, 20);      // days 31 and 60
    assert.equal(row.d90, 20);      // days 61 and 90
    assert.equal(row.d90plus, 10);  // day 91
    assert.equal(row.total, 80);
  });

  await test('AP aging CSV follows the requested English language and dated filename', async () => {
    const res = responseCapture();
    const headers = {};
    res.setHeader = (key, value) => { headers[String(key).toLowerCase()] = String(value); };
    await withQuery(async () => [[{
      id: 'INV-CSV', supplier_id: 'SUP-1', supplier_name: 'Supplier One',
      due_date: '2026-08-01', age_days: 10, total_amount: 25, paid: 0,
    }]], async () => handler('/ap-aging')({
      query: { asOfDate: '2026-08-12', format: 'csv', lang: 'en' },
      warehouseScope: { all: true },
    }, res));

    assert.match(String(res.body), /^﻿Supplier,Current,1-30 days,31-60 days,61-90 days,Over 90 days,Total/);
    assert.match(headers['content-disposition'], /ap-aging-2026-08-12\.csv/);
  });

  console.log(`\nprocurementReportAccounting: ${passed}/${passed} passed`);
})().catch(() => { process.exitCode = 1; });
