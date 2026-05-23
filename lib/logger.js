/**
 * ─── Structured Logger ────────────────────────────────────────────
 *
 * Single entry point for all log output. Emits ONE JSON object per line
 * to stdout, with consistent fields the log aggregator (Railway,
 * CloudWatch, etc.) can parse without regex.
 *
 * Design goals:
 *   1. Zero new runtime dependencies. If `pino` is installed we use it;
 *      otherwise we fall back to console with the same call signature
 *      so callers don't care which backend is active.
 *   2. Same API as pino: `logger.info({event,actor},msg)`. The first
 *      argument is structured context, the second is a human-readable
 *      message. Either is optional.
 *   3. Level filtering via LOG_LEVEL env var (debug|info|warn|error).
 *      Defaults to 'info' in production, 'debug' when NODE_ENV=development.
 *   4. Child loggers with bound context — `logger.child({module:'wf'})`
 *      so per-module context propagates without repetition.
 *
 * Usage:
 *   const logger = require('./lib/logger');
 *   logger.info({event:'login',user:'admin'}, 'login success');
 *   const child = logger.child({module:'workflow'});
 *   child.warn({event:'sla_breach',txnId:'...'}, 'sla breached');
 *
 * v6.8.0 — Phase 0 Foundation
 */
'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const DEFAULT_LEVEL = process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'development' ? 'debug' : 'info');

// ─── Try to load pino (optional dependency) ──────────────────────────
let pino = null;
try { pino = require('pino'); } catch (_) { /* fallback to console */ }

function _makePinoLogger() {
  const base = pino({
    level: DEFAULT_LEVEL,
    base: { svc: 'moroccan-taste-pos' },
    // ISO timestamps are more grep-friendly than epoch ms
    timestamp: pino.stdTimeFunctions.isoTime,
    // Strip pid + hostname (already in Railway envelope, just noise)
    formatters: {
      bindings: () => ({})
    }
  });
  return base;
}

// ─── Fallback console logger with the same API as pino ──────────────
function _makeConsoleLogger(boundCtx) {
  boundCtx = boundCtx || {};
  const levelNum = LEVELS[DEFAULT_LEVEL] || LEVELS.info;

  function _emit(level, ctx, msg) {
    if ((LEVELS[level] || 0) < levelNum) return;
    const out = {
      level,
      time: new Date().toISOString(),
      svc: 'moroccan-taste-pos',
      ...boundCtx,
      ...(typeof ctx === 'object' && ctx !== null ? ctx : { extra: ctx }),
    };
    if (msg !== undefined) out.msg = msg;
    // Use the right console method so colour/severity gets propagated
    const line = JSON.stringify(out);
    if (level === 'error' || level === 'fatal') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  function _call(level, a, b) {
    // Mimic pino: (ctxObj, msg) or (msg) or (ctxObj)
    if (typeof a === 'string') return _emit(level, {}, a);
    return _emit(level, a, b);
  }

  return {
    debug: (a, b) => _call('debug', a, b),
    info:  (a, b) => _call('info',  a, b),
    warn:  (a, b) => _call('warn',  a, b),
    error: (a, b) => _call('error', a, b),
    fatal: (a, b) => _call('fatal', a, b),
    child: (extra) => _makeConsoleLogger({ ...boundCtx, ...extra }),
    level: DEFAULT_LEVEL,
  };
}

// ─── Export the chosen backend ──────────────────────────────────────
const logger = pino ? _makePinoLogger() : _makeConsoleLogger();
logger._backend = pino ? 'pino' : 'console-fallback';

module.exports = logger;
