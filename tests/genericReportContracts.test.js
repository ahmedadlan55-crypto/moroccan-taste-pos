#!/usr/bin/env node
'use strict';

// Security/completeness gate for the registry-driven Operations reports.
// The audit route is exercised through HTTP; the larger workflow/shifts
// routers are source-pinned so their operational side effects are not loaded
// into this small, database-free gate.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

process.chdir(path.join(__dirname, '..'));

const db = require('../db/connection');
const originalQuery = db.query;
let server;
let port;
let pass = 0;

function check(name, condition) {
  assert.ok(condition, name);
  pass++;
  console.log('  ✓ ' + name);
}

function request(pathname, user) {
  return new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, path: pathname, headers: {} };
    if (user) options.headers['x-test-user'] = JSON.stringify(user);
    http.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(new Error('non-JSON response: ' + body.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers['x-test-user']) req.user = JSON.parse(req.headers['x-test-user']);
    next();
  });
  app.use('/api/erp', require('../routes/erp/audit-logs'));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  let response = await request('/api/erp/audit-logs?report=1');
  check('anonymous audit report is 401', response.status === 401 && response.body.code === 'PERMISSION_DENIED');

  db.query = async () => [[]];
  response = await request('/api/erp/audit-logs?report=1', { username: 'cashier', role: 'cashier' });
  check('audit report without administration.audit is 403', response.status === 403 && response.body.code === 'PERMISSION_DENIED');

  db.query = async (sql) => {
    if (/FROM permissions_v3/.test(String(sql))) return [[{ by_role: 1, override_type: null }]];
    return [[]];
  };
  response = await request('/api/erp/audit-logs?report=1&from=2026-08-10&to=2026-08-01', { username: 'auditor', role: 'auditor' });
  check('audit report rejects a reversed period', response.status === 400 && response.body.code === 'INVALID_DATE_RANGE');

  const audit = fs.readFileSync('routes/erp/audit-logs.js', 'utf8');
  const workflow = fs.readFileSync('routes/workflow.js', 'utf8');
  const shifts = fs.readFileSync('routes/shifts.js', 'utf8');
  const registry = fs.readFileSync('frontend/erp/src/modules/reports/operations/registry.ts', 'utf8');
  const seeds = JSON.parse(fs.readFileSync('db/migrations/capability-seeds/g-operational-reports.json', 'utf8'));

  check('audit endpoint is guarded by administration.audit', /get\('\/audit-logs', requireCapability\('administration\.audit'\)/.test(audit));
  check('audit report uses the canonical user_username column', /AND user_username = \?/.test(audit) && /username: r\.user_username/.test(audit));
  check('audit report rejects overflow instead of truncating', /AUDIT_REPORT_MAX_ROWS \+ 1/.test(audit) && /status\(413\)/.test(audit));
  check('workflow report is separately guarded by workflow.audit.view', /get\('\/reports\/transaction-log', requireCapability\('workflow\.audit\.view'\)/.test(workflow));
  check('workflow report rejects overflow instead of using workspace LIMIT 200', /WORKFLOW_REPORT_MAX_ROWS \+ 1/.test(workflow) && /REPORT_TOO_LARGE/.test(workflow));
  check('shift report mode checks pos.shifts.view', /hasCapability\(req\.user, 'pos\.shifts\.view'\)/.test(shifts));
  check('shift report rejects overflow instead of using workspace LIMIT 200', /reportMode \? reportMaxRows \+ 1 : 200/.test(shifts) && /status\(413\)/.test(shifts));
  check('registry requests only complete report contracts', /report: 1, startDate/.test(registry) && /report: 1, from/.test(registry) && /\/workflow\/reports\/transaction-log/.test(registry));
  check('all three registry capabilities are installed in backend RBAC',
    ['administration.audit', 'workflow.audit.view', 'pos.shifts.view'].every((id) => seeds.some((capability) => capability.id === id)));

  console.log(`\n${pass} passed, 0 failed`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => {
  db.query = originalQuery;
  if (server) await new Promise((resolve) => server.close(resolve));
  try { await db.end(); } catch (_) {}
});
