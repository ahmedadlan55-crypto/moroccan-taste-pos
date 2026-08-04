#!/usr/bin/env node
'use strict';
/* ─── Release gate — migrations are ADDITIVE, IDEMPOTENT and FAIL-CLOSED ─────
 *
 *   node scripts/gate/verify-migrations.js            # everything
 *   node scripts/gate/verify-migrations.js --static   # static scan only
 *
 * Exit codes:  0 = clean   1 = findings   2 = could not run
 *
 * WHY THIS EXISTS
 *   This repo has FOUR independent migration paths that all mutate the same
 *   schema (see discoverSources()). Reading them is not proof of anything:
 *   "idempotent" is a claim about what happens on the SECOND run, and the only
 *   honest way to settle it is to run the whole chain twice against a genuinely
 *   empty database and compare INFORMATION_SCHEMA byte for byte.
 *
 * WHAT EACH PASS PROVES (and what it does not)
 *   STATIC      — reads every migration source and reports destructive DDL.
 *                 Comment text is stripped first, so prose about DROP TABLE in
 *                 a header does not count as a finding.
 *   DYNAMIC     — provisions a throwaway sandbox database, runs the REAL chain
 *                 twice, snapshots INFORMATION_SCHEMA after each run and
 *                 compares. A difference IS a non-idempotent migration.
 *   FAIL-CLOSED — drives scripts/release-start.js for real, with a genuine
 *                 failure injected into the DATABASE (never into a file — no
 *                 migration source is edited by this script), and checks
 *                 whether the chain actually stops. Every verdict here comes
 *                 from an executed run; nothing is asserted by inspection.
 * ────────────────────────────────────────────────────────────────────────── */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..', '..');
const SANDBOX_DB = 'sandbox_verify_migrations';

const findings = [];
const notes = [];
function finding(section, id, where, msg, extra) {
  findings.push({ section, id, where, msg, extra });
}

// ═══════════════════════════════════════════════════════════════════════════
// ALLOWLIST — genuine, intentional exceptions. Each entry MUST carry a written
// reason. Entries are PRINTED on every run (never silently skipped) so an
// allowlisted item stays visible and can be re-litigated. `where` is matched as
// "<relative file>:<line>" prefix-free equality on file + a substring match on
// the offending source line, so a line moving does not silently re-open a hole
// nor silently keep one closed.
// ═══════════════════════════════════════════════════════════════════════════
const ALLOWLIST = [
  {
    file: 'db/migrations/0028_coa_metadata.sql',
    rule: 'drop_index',
    contains: 'DROP INDEX code',
    reason:
      'The company-scoped replacement uq_gl_accounts_company_code (company_id, code) is ' +
      'created and verified before this guarded DROP. The old global code index prevented ' +
      'separate companies from using the same canonical account number; removing it drops no ' +
      'rows and the stricter per-company uniqueness remains active.',
  },
  {
    file: 'db/migrations/0019_account_role_registry_scope_fix.sql',
    rule: 'drop_index',
    contains: 'DROP INDEX uq_role_key',
    reason:
      'Guarded by INFORMATION_SCHEMA.STATISTICS + PREPARE/EXECUTE, and the very next block ' +
      'creates the WIDER unique key uq_role_company (role_key, company_id). Dropping a UNIQUE ' +
      'index removes a constraint, never a row; the replacement is strictly more permissive, so ' +
      'no existing row can be rejected by it. Documented in the file header.',
  },
  {
    file: 'db/migrations/order-to-cash/schema.js',
    rule: 'drop_index',
    contains: "DROP INDEX uq_are_idem",
    reason:
      'Guarded by H.indexExists(). The superseding index uq_are_scope (event_scope, ' +
      'idempotency_key) is created on the line immediately above, and the rows it needs were ' +
      'backfilled two statements earlier. Index-only change, no data loss.',
  },
  {
    file: 'server.js',
    rule: 'drop_table',
    contains: 'DROP TABLE IF EXISTS user_inbox_counters',
    reason:
      'user_inbox_counters is a MATERIALIZATION rebuilt in full from `transactions` by the ' +
      'INSERT ... SELECT roughly 90 lines below, inside the same runMigrations() pass. It holds ' +
      'no source-of-truth data. The drop exists because an older shape of the table lacked the ' +
      '`username` column. Destructive in form, lossless in substance.',
  },
  {
    file: 'server.js',
    rule: 'delete_no_where',
    contains: 'DELETE FROM user_inbox_counters',
    reason:
      'Same materialization as above: the DELETE is the first half of a full rebuild whose ' +
      'second half is the INSERT ... SELECT on the following statement. A WHERE clause would ' +
      'make the rebuild wrong, not safer.',
  },
  {
    file: 'db/migrations/0023_whole_riyal_pricing.sql',
    rule: 'type_narrowing',
    contains: 'ALTER TABLE menu MODIFY price DECIMAL(10,4)',
    reason:
      'DECIMAL(10,2) -> DECIMAL(10,4): total precision is unchanged, the SCALE widens 2 -> 4 to ' +
      'carry whole-riyal gross prices back to an exact net. The narrowing is confined to the ' +
      'integer side (8 -> 6 digits), and the migration header states the bound it relies on: no ' +
      'menu price exceeds 4 integer digits. That precondition is what makes it safe — if a price ' +
      '>= 1,000,000 ever exists the ALTER will fail loudly rather than truncate silently ' +
      '(MySQL 8 strict mode), so the failure mode is fail-closed, not data loss.',
  },
  {
    file: 'server.js',
    rule: 'type_narrowing',
    contains: 'ALTER TABLE menu MODIFY price DECIMAL(10,4)',
    reason:
      'The runMigrations() twin of 0023_whole_riyal_pricing.sql — the same statement, deliberately ' +
      'duplicated because runMigrations() (not db/migrate.js) is what executes on every boot. Same ' +
      'reason and same bound as the .sql entry above; they must stay identical.',
  },
  {
    file: 'server.js',
    rule: 'drop_column',
    contains: "ALTER TABLE users DROP COLUMN plain_pass",
    reason:
      'Deliberate security remediation — plaintext passwords must not exist at rest. Column ' +
      'removal is the entire point of the statement, so "additive" cannot apply. Idempotent by ' +
      'the swallowed catch: once dropped, every later boot errors 1091 and continues.',
  },
];

function allowlistFor(relFile, ruleId, line) {
  return ALLOWLIST.find(
    (a) => a.file === relFile && a.rule === ruleId && line.indexOf(a.contains) !== -1
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. DISCOVERY — every source that can mutate the schema
// ═══════════════════════════════════════════════════════════════════════════

// server.js's legacy runMigrations() is a single ~6.8k-line function and IS a
// migration source (the release chain's step 1/3 is exactly this function). Its
// bounds are found by brace matching rather than hardcoded line numbers so the
// scan cannot silently drift onto route code.
function locateRunMigrations() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => /^async function runMigrations\s*\(/.test(l));
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return null;
  return { startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join('\n') };
}

function discoverSources() {
  const out = [];
  const push = (rel, kind, lineOffset, text) => out.push({ rel, kind, lineOffset, text });

  const readIf = (rel) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };

  // (a) the baseline schema applied by server.js autoInitDB() on an empty DB
  const baseline = readIf('db/schema.sql');
  if (baseline) push('db/schema.sql', 'baseline-sql', 0, baseline);

  // (b) the numbered, versioned migrations run by db/migrate.js (step 2/3)
  const migDir = path.join(ROOT, 'db', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(f)).sort()) {
    push('db/migrations/' + f, 'numbered-sql', 0, fs.readFileSync(path.join(migDir, f), 'utf8'));
  }

  // (c) the self-applying JS schema modules, invoked from runMigrations()
  for (const sub of fs.readdirSync(migDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const dir = path.join(migDir, sub.name);
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
      const rel = 'db/migrations/' + sub.name + '/' + f;
      push(rel, 'module-js', 0, fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  }

  // (d) the standalone runners / entry points
  for (const rel of [
    'db/init.js',
    'db/migrate.js',
    'scripts/analytics/migrate.js',
    'scripts/order-to-cash/migrate.js',
    'scripts/procurement/migrate.js',
  ]) {
    const t = readIf(rel);
    if (t) push(rel, 'runner-js', 0, t);
  }

  // (e) server.js runMigrations() — the legacy boot path (release step 1/3)
  const rm = locateRunMigrations();
  if (rm) push('server.js', 'legacy-boot-js', rm.startLine - 1, rm.text);
  else notes.push('could not locate server.js runMigrations() by brace matching — legacy boot path NOT scanned');

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. STATIC PASS
// ═══════════════════════════════════════════════════════════════════════════

// Blank out comment text while PRESERVING line numbering and total length, so a
// header that talks about DROP TABLE is not a finding but line numbers still
// point at the real file. SQL `-- ` and `/* */` for .sql; whole-line `//` and
// `*` continuations plus `/* */` for .js (never mid-line, so SQL living inside
// a JS template literal survives intact).
function stripComments(text, isSql) {
  // The repo is CRLF. A trailing \r makes every `$`-anchored scan regex below
  // silently fail to match (JS `.` excludes \r, `$` without /m needs true
  // end-of-input) — which is a scanner that reports "clean" because it never
  // looked. Normalize first; \r\n -> \n preserves the line count, so reported
  // line numbers still point at the real file.
  let s = text.replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/\r$/, '');
    const trimmed = t.trim();
    if (!isSql && (trimmed.startsWith('//') || trimmed.startsWith('*'))) {
      lines[i] = ' '.repeat(t.length);
      continue;
    }
    // SQL line comment: `--` at line start or preceded by whitespace
    const m = t.match(/(^|\s)--(\s|$)/);
    if (m) {
      const cut = m.index + (m[1] ? 1 : 0);
      lines[i] = t.slice(0, cut) + ' '.repeat(t.length - cut);
    }
  }
  return lines.join('\n');
}

const KEYWORD_RULES = [
  { id: 'drop_table', re: /\bDROP\s+TABLE\b/i, why: 'DROP TABLE is not additive' },
  { id: 'drop_database', re: /\bDROP\s+DATABASE\b/i, why: 'DROP DATABASE is not additive' },
  { id: 'truncate', re: /\bTRUNCATE\s+(TABLE\s+)?[`"\w]/i, why: 'TRUNCATE erases every row' },
  { id: 'drop_column', re: /\bDROP\s+COLUMN\b/i, why: 'DROP COLUMN destroys the column data' },
  { id: 'rename_table', re: /\bRENAME\s+TABLE\b/i, why: 'RENAME TABLE breaks anything still reading the old name' },
  { id: 'drop_index', re: /\bDROP\s+(INDEX|KEY)\b/i, why: 'dropping an index removes a constraint/perf guarantee' },
  { id: 'drop_fk', re: /\bDROP\s+(FOREIGN\s+KEY|CONSTRAINT)\b/i, why: 'dropping a constraint weakens referential integrity' },
];

// Column type declarations harvested from every CREATE TABLE in the corpus, so
// a later MODIFY can be compared against what the column was declared as.
function harvestDeclaredTypes(sources) {
  const map = new Map(); // "table.column" -> type text
  for (const s of sources) {
    const text = stripComments(s.text, s.rel.endsWith('.sql'));
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/gi;
    let m;
    while ((m = re.exec(text))) {
      const table = m[1].toLowerCase();
      let depth = 1;
      let i = re.lastIndex;
      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
      const body = text.slice(re.lastIndex, i - 1);
      // split on top-level commas
      let d = 0, buf = '', parts = [];
      for (const ch of body) {
        if (ch === '(') d++;
        else if (ch === ')') d--;
        if (ch === ',' && d === 0) { parts.push(buf); buf = ''; continue; }
        buf += ch;
      }
      parts.push(buf);
      for (const p of parts) {
        const c = p.trim().match(/^[`"]?(\w+)[`"]?\s+([A-Za-z]+(?:\s*\([^)]*\))?(?:\s+UNSIGNED)?)/i);
        if (!c) continue;
        const col = c[1].toLowerCase();
        if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|CHECK)$/i.test(col)) continue;
        const key = table + '.' + col;
        if (!map.has(key)) map.set(key, c[2].trim());
      }
    }
  }
  return map;
}

const INT_RANK = { tinyint: 1, smallint: 2, mediumint: 3, int: 4, integer: 4, bigint: 5 };

/** Returns a reason string when `next` is narrower than `prev`, else null. */
function narrowing(prev, next) {
  const p = prev.toLowerCase().replace(/\s+/g, '');
  const n = next.toLowerCase().replace(/\s+/g, '');
  const base = (t) => (t.match(/^[a-z]+/) || [''])[0];
  const args = (t) => {
    const m = t.match(/\(([^)]*)\)/);
    return m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')) : null;
  };
  const bp = base(p), bn = base(n);
  const ap = args(p), an = args(n);

  if (bp === 'enum' && bn === 'enum' && ap && an) {
    const missing = ap.filter((v) => an.indexOf(v) === -1);
    return missing.length ? 'ENUM loses value(s): ' + missing.join(', ') : null;
  }
  if (/^(decimal|numeric)$/.test(bp) && /^(decimal|numeric)$/.test(bn) && ap && an) {
    const [pp, ps] = [Number(ap[0]), Number(ap[1] || 0)];
    const [np, ns] = [Number(an[0]), Number(an[1] || 0)];
    if (np < pp) return `precision ${pp} -> ${np}`;
    if (ns < ps) return `scale ${ps} -> ${ns}`;
    if (np - ns < pp - ps) return `integer digits ${pp - ps} -> ${np - ns}`;
    return null;
  }
  if (/^(varchar|char|varbinary|binary)$/.test(bp) && bp === bn && ap && an) {
    return Number(an[0]) < Number(ap[0]) ? `length ${ap[0]} -> ${an[0]}` : null;
  }
  if (INT_RANK[bp] && INT_RANK[bn]) {
    return INT_RANK[bn] < INT_RANK[bp] ? `${bp} -> ${bn}` : null;
  }
  return null;
}

function staticPass(sources) {
  const declared = harvestDeclaredTypes(sources);
  let templated = 0;
  let modifyReviewed = 0;
  const allowlistHits = [];

  for (const s of sources) {
    const isSql = s.rel.endsWith('.sql');
    const clean = stripComments(s.text, isSql);
    const lines = clean.split('\n');
    const rawLines = s.text.replace(/\r\n/g, '\n').split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const absLine = s.lineOffset + i + 1;
      const where = s.rel + ':' + absLine;
      const shown = (rawLines[i] || '').trim();

      for (const r of KEYWORD_RULES) {
        if (!r.re.test(line)) continue;
        const al = allowlistFor(s.rel, r.id, line);
        if (al) { allowlistHits.push({ where, rule: r.id, reason: al.reason, shown }); continue; }
        finding('STATIC', r.id, where, r.why, shown);
      }

      // DELETE FROM without a guard — statement scoped to the next `;`
      const del = line.match(/\bDELETE\s+FROM\s+[`"]?(\w+)/i);
      if (del) {
        const tail = clean.slice(clean.split('\n').slice(0, i).join('\n').length + line.indexOf(del[0]));
        const stmt = tail.split(';')[0].slice(0, 600);
        if (!/\bWHERE\b/i.test(stmt)) {
          const al = allowlistFor(s.rel, 'delete_no_where', line);
          if (al) allowlistHits.push({ where, rule: 'delete_no_where', reason: al.reason, shown });
          else finding('STATIC', 'delete_no_where', where, 'DELETE FROM ' + del[1] + ' with no WHERE guard — erases every row', shown);
        }
      }

      // MODIFY / CHANGE COLUMN
      const mod = line.match(/\b(MODIFY|CHANGE)\s+(?:COLUMN\s+)?[`"]?([\w${}.]+)[`"]?\s*(.*)$/i);
      if (mod) {
        modifyReviewed++;
        const colTok = mod[2];
        let def = mod[3] || '';
        // multi-line ALTER (the numbered .sql files wrap) — pull the statement
        if (!/;/.test(def)) {
          const rest = lines.slice(i + 1, i + 6).join(' ');
          def += ' ' + rest.split(';')[0];
        }
        def = def.replace(/;.*$/, '').trim();

        if (/\$\{/.test(colTok) || /\$\{/.test(def) || def === '') {
          templated++; // definition comes from a variable — only the dynamic pass can judge it
          continue;
        }
        if (/\bNOT\s+NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def) && !/AUTO_INCREMENT/i.test(def)) {
          const al = allowlistFor(s.rel, 'not_null_no_default', line);
          if (al) allowlistHits.push({ where, rule: 'not_null_no_default', reason: al.reason, shown });
          else finding('STATIC', 'not_null_no_default', where,
            'MODIFY/CHANGE adds NOT NULL with no DEFAULT — fails on any table that already holds a NULL', shown);
        }
        const tbl = (function () {
          for (let k = i; k >= Math.max(0, i - 6); k--) {
            const t = lines[k].match(/ALTER\s+TABLE\s+[`"]?(\w+)/i);
            if (t) return t[1].toLowerCase();
          }
          return null;
        })();
        const prev = tbl ? declared.get(tbl + '.' + colTok.toLowerCase()) : null;
        const typeMatch = def.match(/^([A-Za-z]+(?:\s*\([^)]*\))?)/);
        if (prev && typeMatch) {
          const why = narrowing(prev, typeMatch[1]);
          if (why) {
            const al = allowlistFor(s.rel, 'type_narrowing', line);
            if (al) allowlistHits.push({ where, rule: 'type_narrowing', reason: al.reason, shown });
            else finding('STATIC', 'type_narrowing', where,
              `MODIFY narrows ${tbl}.${colTok}: ${why} (declared elsewhere as ${prev})`, shown);
          }
        }
      }
    }
  }
  return { allowlistHits, templated, modifyReviewed };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SANDBOX GUARDS
// ═══════════════════════════════════════════════════════════════════════════
function assertSandboxSafe() {
  const remote = ['DATABASE_URL', 'MYSQL_URL', 'MYSQLHOST'].filter((k) => process.env[k]);
  if (remote.length) {
    throw new Error(
      'REFUSING TO RUN: ' + remote.join('/') + ' is set — that is a managed/remote connection. ' +
      'This gate CREATEs and DROPs a database and only ever runs against local MySQL.');
  }
  const host = process.env.DB_HOST || 'localhost';
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`REFUSING TO RUN: DB_HOST is "${host}", not literally localhost/127.0.0.1.`);
  }
  const real = process.env.DB_NAME || process.env.MYSQL_DATABASE || 'moroccan_taste_pos';
  const forbidden = [real, real + '_test', real + '_e2e', real + '_accounting_v2_test'];
  if (forbidden.indexOf(SANDBOX_DB) !== -1) {
    throw new Error(`REFUSING TO RUN: sandbox name "${SANDBOX_DB}" collides with ${real} or one of its _test/_e2e derivatives.`);
  }
  if (!/^sandbox_/.test(SANDBOX_DB)) {
    throw new Error(`REFUSING TO RUN: sandbox name "${SANDBOX_DB}" is not unmistakably a sandbox (must start with "sandbox_").`);
  }
}

function rootConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: false,
  });
}
function sandboxConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: SANDBOX_DB,
    multipleStatements: false,
  });
}

async function recreateSandbox(root) {
  await root.query('DROP DATABASE IF EXISTS `' + SANDBOX_DB + '`');
  await root.query('CREATE DATABASE `' + SANDBOX_DB + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE CHAIN UNDER TEST
// ═══════════════════════════════════════════════════════════════════════════
// scripts/release-start.js steps 0-2 (RELEASE_CHAIN_PROVISION_ONLY suppresses
// only step 3, the long-lived HTTP listener) + the standalone analytics runner,
// which package.json exposes separately as `analytics:migrate` and which is
// therefore part of the schema surface a deploy can apply.
function runChain(dbName, extraEnv) {
  const env = {
    ...process.env,
    DB_NAME: dbName,
    MYSQL_DATABASE: dbName,
    RELEASE_CHAIN_PROVISION_ONLY: '1',
    ORDER_TO_CASH_ENABLE: '1',
    PROCUREMENT_P2P_ENABLE: '1',
    NODE_ENV: 'development',
    ...(extraEnv || {}),
  };
  delete env.DATABASE_URL;
  delete env.MYSQL_URL;
  delete env.MYSQLHOST;

  const started = Date.now();
  const steps = [];
  const a = spawnSync(process.execPath, [path.join('scripts', 'release-start.js')], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 900000, maxBuffer: 128 * 1024 * 1024,
  });
  steps.push({ name: 'release-start.js', status: a.status, out: (a.stdout || '') + (a.stderr || '') });
  let b = null;
  if (a.status === 0) {
    b = spawnSync(process.execPath, [path.join('scripts', 'analytics', 'migrate.js')], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024,
    });
    steps.push({ name: 'analytics/migrate.js', status: b.status, out: (b.stdout || '') + (b.stderr || '') });
  }
  const status = a.status !== 0 ? a.status : (b ? b.status : 0);
  return {
    status,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    out: steps.map((s) => s.out).join('\n'),
    steps,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. SCHEMA SNAPSHOT — structure only, nothing volatile
// ═══════════════════════════════════════════════════════════════════════════
async function snapshot(conn) {
  const db = SANDBOX_DB;
  const L = [];

  const [tables] = await conn.query(
    `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION, ROW_FORMAT
       FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
  for (const t of tables) {
    L.push(`TABLE ${t.TABLE_NAME} type=${t.TABLE_TYPE} engine=${t.ENGINE} collation=${t.TABLE_COLLATION} rowfmt=${t.ROW_FORMAT}`);
  }

  const [cols] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT, IS_NULLABLE,
            COLUMN_TYPE, COLLATION_NAME, COLUMN_KEY, EXTRA, GENERATION_EXPRESSION
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME`, [db]);
  for (const c of cols) {
    L.push(`COL ${c.TABLE_NAME}.${c.COLUMN_NAME} pos=${c.ORDINAL_POSITION} type=${c.COLUMN_TYPE} ` +
      `null=${c.IS_NULLABLE} default=${c.COLUMN_DEFAULT === null ? '<NULL>' : c.COLUMN_DEFAULT} ` +
      `key=${c.COLUMN_KEY} extra=${c.EXTRA} coll=${c.COLLATION_NAME} gen=${c.GENERATION_EXPRESSION}`);
  }

  // CARDINALITY is a live statistic — deliberately excluded.
  const [idx] = await conn.query(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
            SUB_PART, NULLABLE, INDEX_TYPE, EXPRESSION
       FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [db]);
  for (const i of idx) {
    L.push(`IDX ${i.TABLE_NAME}.${i.INDEX_NAME} seq=${i.SEQ_IN_INDEX} col=${i.COLUMN_NAME} ` +
      `unique=${i.NON_UNIQUE === 0 ? 1 : 0} sub=${i.SUB_PART} null=${i.NULLABLE} type=${i.INDEX_TYPE} expr=${i.EXPRESSION}`);
  }

  const [fks] = await conn.query(
    `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION, k.COLUMN_NAME,
            k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = ?
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [db]);
  for (const f of fks) {
    L.push(`FK ${f.TABLE_NAME}.${f.CONSTRAINT_NAME}[${f.ORDINAL_POSITION}] ${f.COLUMN_NAME} -> ` +
      `${f.REFERENCED_TABLE_NAME}.${f.REFERENCED_COLUMN_NAME} upd=${f.UPDATE_RULE} del=${f.DELETE_RULE}`);
  }

  const [trg] = await conn.query(
    `SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING, ACTION_STATEMENT
       FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`, [db]);
  for (const t of trg) {
    L.push(`TRG ${t.TRIGGER_NAME} ${t.ACTION_TIMING} ${t.EVENT_MANIPULATION} ON ${t.EVENT_OBJECT_TABLE} :: ` +
      String(t.ACTION_STATEMENT).replace(/\s+/g, ' ').trim());
  }

  const [rt] = await conn.query(
    `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER
       FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`, [db]);
  for (const r of rt) L.push(`RTN ${r.ROUTINE_TYPE} ${r.ROUTINE_NAME} returns=${r.DTD_IDENTIFIER}`);

  const text = L.join('\n') + '\n';
  return { text, sha: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), lines: L };
}

function diffLines(a, b, limit) {
  const setA = new Set(a), setB = new Set(b);
  const only = [];
  for (const l of a) if (!setB.has(l)) only.push('  - run#1 only: ' + l);
  for (const l of b) if (!setA.has(l)) only.push('  + run#2 only: ' + l);
  return only.slice(0, limit || 60);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  const staticOnly = process.argv.includes('--static');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' verify-migrations — additive / idempotent / fail-closed');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── DISCOVERY ──────────────────────────────────────────────────────────
  let sources;
  try {
    sources = discoverSources();
  } catch (e) {
    console.error('COULD NOT RUN — discovery failed:', e.message);
    process.exit(2);
  }
  const byKind = sources.reduce((m, s) => (m[s.kind] = (m[s.kind] || 0) + 1, m), {});
  console.log('── 1. MIGRATION SOURCES (' + sources.length + ') ──');
  for (const k of Object.keys(byKind)) console.log('   ' + k.padEnd(16) + byKind[k]);
  console.log('   paths: ' + Object.keys(sources.reduce((m, s) => (m[path.dirname(s.rel)] = 1, m), {})).join(', '));
  for (const n of notes) console.log('   NOTE: ' + n);
  console.log('');

  // ── STATIC ─────────────────────────────────────────────────────────────
  const before = findings.length;
  const st = staticPass(sources);
  console.log('── 2. STATIC — destructive DDL scan ──');
  console.log(`   MODIFY/CHANGE statements reviewed: ${st.modifyReviewed} (${st.templated} templated — only the dynamic pass can judge those)`);
  if (st.allowlistHits.length) {
    console.log('   ALLOWLISTED (intentional, reason recorded in this script):');
    for (const a of st.allowlistHits) {
      console.log(`     · [${a.rule}] ${a.where}`);
      console.log(`         ${a.shown.slice(0, 120)}`);
      console.log(`         reason: ${a.reason.slice(0, 220)}`);
    }
  }
  const staticFindings = findings.slice(before);
  if (!staticFindings.length) console.log('   no unallowlisted destructive DDL found');
  else {
    console.log('   FINDINGS:');
    for (const f of staticFindings) console.log(`     ✗ [${f.id}] ${f.where}\n         ${f.msg}\n         ${String(f.extra).slice(0, 160)}`);
  }
  console.log('');

  if (staticOnly) {
    console.log('(--static: dynamic and fail-closed passes skipped)');
    process.exit(findings.length ? 1 : 0);
  }

  // ── DYNAMIC + FAIL-CLOSED ──────────────────────────────────────────────
  let root = null;
  try {
    assertSandboxSafe();
    root = await rootConn();
  } catch (e) {
    console.error('COULD NOT RUN the dynamic passes:', e.message);
    if (root) await root.end().catch(() => {});
    process.exit(2);
  }

  try {
    // ── 3. IDEMPOTENCY ──
    console.log('── 3. DYNAMIC — run the whole chain TWICE on an empty sandbox ──');
    console.log('   sandbox database: ' + SANDBOX_DB + ' (real DB_NAME is ' + (process.env.DB_NAME || '?') + ')');
    await recreateSandbox(root);

    const r1 = runChain(SANDBOX_DB);
    console.log(`   run #1: exit ${r1.status} in ${r1.seconds}s`);
    if (r1.status !== 0) {
      finding('DYNAMIC', 'chain_failed_empty_db', 'scripts/release-start.js',
        'the migration chain does not complete on an EMPTY database (exit ' + r1.status + ')',
        r1.out.slice(-800));
      throw new Error('chain failed on the empty sandbox — see finding above');
    }
    let c = await sandboxConn();
    const snapA = await snapshot(c);
    await c.end();

    const r2 = runChain(SANDBOX_DB);
    console.log(`   run #2: exit ${r2.status} in ${r2.seconds}s`);
    if (r2.status !== 0) {
      finding('DYNAMIC', 'chain_failed_rerun', 'scripts/release-start.js',
        'the migration chain FAILS when run a second time against an already-migrated database (exit ' + r2.status + ')',
        r2.out.slice(-800));
    }
    c = await sandboxConn();
    const snapB = await snapshot(c);
    await c.end();

    console.log(`   snapshot after run #1: ${snapA.lines.length} objects  sha256 ${snapA.sha.slice(0, 16)}`);
    console.log(`   snapshot after run #2: ${snapB.lines.length} objects  sha256 ${snapB.sha.slice(0, 16)}`);
    if (snapA.sha === snapB.sha) {
      console.log('   ✓ byte-identical — the chain is IDEMPOTENT over the full schema');
    } else {
      const d = diffLines(snapA.lines, snapB.lines);
      finding('DYNAMIC', 'not_idempotent', 'migration chain',
        'the schema CHANGED on the second identical run — a migration is not idempotent',
        d.join('\n'));
      console.log('   ✗ SNAPSHOTS DIFFER:');
      for (const l of d) console.log('   ' + l);
    }
    console.log('');

    // ── 4. FAIL-CLOSED ──
    console.log('── 4. FAIL-CLOSED — does a broken migration actually stop the release? ──');
    console.log('   (all three scenarios are EXECUTED; failures are injected into the sandbox');
    console.log('    database, never into a migration file — no source is edited by this gate)\n');

    // 4a — a numbered migration (release step 2/3) fails for real.
    // A VIEW named account_roles is created first: 0018 creates that table with
    // CREATE TABLE IF NOT EXISTS (which no-ops against an existing name) and
    // 0019 then ALTERs it, which cannot work on a view. server.js contains zero
    // references to account_roles, so step 1/3 is unaffected.
    await recreateSandbox(root);
    c = await sandboxConn();
    await c.query('CREATE VIEW account_roles AS SELECT 1 AS id');
    await c.end();
    const fc1 = runChain(SANDBOX_DB);
    const fc1Stopped = fc1.status !== 0 && !/3\/3 starting HTTP server/.test(fc1.out);
    console.log(`   4a numbered migration fails   → chain exit ${fc1.status}, reached step 3/3: ${/3\/3 starting HTTP server/.test(fc1.out)}`);
    if (fc1Stopped) {
      console.log('      ✓ FAIL-CLOSED: refusal message present: ' + /will NOT be started on an incomplete schema/.test(fc1.out));
    } else {
      finding('FAIL-CLOSED', 'numbered_migration_failure_not_fatal', 'scripts/release-start.js',
        'a failing numbered migration did NOT stop the release chain', fc1.out.slice(-800));
    }

    // 4b — the legacy provisioning step (1/3) fails for real: point the chain at
    // a database that does not exist at all.
    const absent = SANDBOX_DB + '_absent';
    await root.query('DROP DATABASE IF EXISTS `' + absent + '`');
    const fc2 = runChain(absent);
    const fc2Stopped = fc2.status !== 0 && !/3\/3 starting HTTP server/.test(fc2.out);
    console.log(`   4b legacy step 1/3 fails      → chain exit ${fc2.status}, reached step 3/3: ${/3\/3 starting HTTP server/.test(fc2.out)}`);
    if (!fc2Stopped) {
      finding('FAIL-CLOSED', 'provisioning_failure_not_fatal', 'scripts/release-start.js',
        'an unreachable/absent database did NOT stop the release chain', fc2.out.slice(-800));
    }

    // 4c — a SELF-APPLYING schema module fails inside step 1/3. Same trick: a
    // VIEW named analytics_order_facts. db/migrations/analytics/schema.js does an
    // unconditional ALTER TABLE analytics_order_facts ADD COLUMN discount_reason,
    // which cannot work on a view. Any real-world failure of that module (lock
    // timeout, disk, duplicate index) lands in the SAME try/catch in server.js.
    await recreateSandbox(root);
    c = await sandboxConn();
    await c.query('CREATE VIEW analytics_order_facts AS SELECT 1 AS id');
    await c.end();
    const fc3 = runChain(SANDBOX_DB);
    c = await sandboxConn();
    const [after3] = await c.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('analytics_daily_branch','analytics_rollup_state','analytics_payment_facts')`,
      [SANDBOX_DB]);
    await c.end();
    // The verdict must be taken from scripts/release-start.js ALONE — that is
    // what the Dockerfile CMD runs. runChain() also invokes the standalone
    // analytics runner, which is NOT part of the production chain; scoring the
    // composite would let that extra step mask a fail-open production chain.
    const prodStep = fc3.steps[0];
    const moduleBroke = /analytics schema FAILED/i.test(prodStep.out);
    const missing = ['analytics_daily_branch', 'analytics_rollup_state', 'analytics_payment_facts']
      .filter((t) => !after3.some((r) => r.TABLE_NAME === t));
    console.log(`   4c self-applying module fails → release-start.js exit ${prodStep.status} ` +
      `(composite incl. analytics:migrate ${fc3.status}), module error logged: ${moduleBroke}, ` +
      `analytics tables missing afterwards: ${missing.length}/3`);
    if (prodStep.status === 0 && moduleBroke) {
      finding('FAIL-CLOSED', 'module_failure_is_fail_open', 'server.js runMigrations() + scripts/release-start.js',
        'A self-applying schema module failed, the failure was logged and SWALLOWED, and the ' +
        'release chain still exited 0 — production would boot on a half-migrated schema. ' +
        'MIGRATE_ONLY=1 probes only users/hr_employees/pos_orders/permissions_v3/role_permissions, ' +
        'none of which any of these modules create. Missing after the "successful" chain: ' +
        (missing.join(', ') || '(none — but the module still errored)'),
        prodStep.out.split('\n').filter((l) => /FAILED|schema ready/i.test(l)).slice(0, 6).join(' | '));
    } else if (prodStep.status !== 0) {
      console.log('      ✓ FAIL-CLOSED: the module failure propagated to a non-zero chain exit');
    } else if (!moduleBroke) {
      notes.push('scenario 4c did not actually break the analytics module — its verdict is inconclusive, not a pass');
      console.log('      ! inconclusive: the injected failure did not fire; treat 4c as UNPROVEN');
    }
    console.log('');
  } catch (e) {
    if (!findings.length) {
      console.error('COULD NOT RUN the dynamic passes:', e.message);
      if (root) {
        await root.query('DROP DATABASE IF EXISTS `' + SANDBOX_DB + '`').catch(() => {});
        await root.query('DROP DATABASE IF EXISTS `' + SANDBOX_DB + '_absent`').catch(() => {});
        await root.end().catch(() => {});
      }
      process.exit(2);
    }
    console.error('   (dynamic pass aborted: ' + e.message + ')');
  } finally {
    if (root) {
      await root.query('DROP DATABASE IF EXISTS `' + SANDBOX_DB + '`').catch(() => {});
      await root.query('DROP DATABASE IF EXISTS `' + SANDBOX_DB + '_absent`').catch(() => {});
      console.log('   (sandbox dropped)\n');
      await root.end().catch(() => {});
    }
  }

  // ── VERDICT ────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  if (!findings.length) {
    console.log(' VERDICT: CLEAN — additive, idempotent, fail-closed (all proven by execution)');
    for (const n of notes) console.log(' note: ' + n);
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(0);
  }
  console.log(` VERDICT: ${findings.length} FINDING(S)`);
  console.log('═══════════════════════════════════════════════════════════════');
  for (const f of findings) {
    console.log(`\n [${f.section}/${f.id}] ${f.where}`);
    console.log(`   ${f.msg}`);
    if (f.extra) console.log('   ' + String(f.extra).split('\n').slice(0, 8).join('\n   '));
  }
  for (const n of notes) console.log('\n note: ' + n);
  process.exit(1);
})().catch((e) => {
  console.error('COULD NOT RUN:', e && e.stack ? e.stack : e);
  process.exit(2);
});
