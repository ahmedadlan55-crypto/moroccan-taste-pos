/**
 * V4 — Runtime JSON Schema validation for Transaction inputs
 * Pure-function (no DB dependency). Returns { valid, errors }.
 *
 * Used by routes/workflow.js BEFORE any database write to reject
 * malformed payloads with a clear 400 response.
 */

'use strict';

const SM = require('./transactionStateMachine');

// ─── Schema definitions ──────────────────────────────────────────────────

const TRANSACTION_CREATE_SCHEMA = {
  required: ['transactionTypeId', 'subject', 'username'],
  properties: {
    transactionTypeId: { type: 'string', minLength: 1, maxLength: 60 },
    subject:           { type: 'string', minLength: 5, maxLength: 300 },
    title:             { type: 'string', minLength: 5, maxLength: 300 },
    contentHtml:       { type: 'string', maxLength: 50000 },
    description:       { type: 'string', maxLength: 10000 },
    amount:            { type: 'number', min: 0, max: 999999999999 },
    importance:        { enum: ['low', 'medium', 'high', 'critical'] },
    scope:             { enum: ['internal', 'external'] },
    branchId:          { type: 'string', maxLength: 50 },
    deptId:            { type: 'string', maxLength: 50 },
    brandId:           { type: 'string', maxLength: 50 },
    accountId:         { type: 'string', maxLength: 50 },
    costCenterId:      { type: 'string', maxLength: 50 },
    recipientUsername: { type: 'string', maxLength: 100 },
    recipients:        { type: 'array', maxLength: 50 },
    attachment:        { type: 'string', maxLength: 14000000 }, // ~10MB base64
    slaHours:          { type: 'integer', min: 1, max: 8760 },  // up to 1 year
    contentSecrecy:    { enum: ['normal', 'confidential', 'secret', 'top_secret'] },
    attachmentsSecrecy:{ enum: ['normal', 'confidential', 'secret', 'top_secret'] },
    saveAsDraft:       { type: 'boolean' },
    username:          { type: 'string', minLength: 1, maxLength: 100 }
  }
};

const ACTION_SCHEMA = {
  required: ['action', 'username'],
  properties: {
    action:          { enum: ['approve','reject','return','forward','close','open'] },
    username:        { type: 'string', minLength: 1, maxLength: 100 },
    note:            { type: 'string', maxLength: 5000 },
    attachment:      { type: 'string', maxLength: 14000000 },
    newAmount:       { type: 'number', min: 0, max: 999999999999 },
    forwardTo:       { type: 'string', maxLength: 100 },
    expectedVersion: { type: 'integer', min: 0 }
  }
};

const REPLY_SCHEMA = {
  required: ['replyText', 'username'],
  properties: {
    replyText:       { type: 'string', minLength: 1, maxLength: 5000 },
    attachment:      { type: 'string', maxLength: 14000000 },
    attachmentName:  { type: 'string', maxLength: 255 },
    attachmentMime:  { type: 'string', maxLength: 100 },
    isInternal:      { type: 'boolean' },
    username:        { type: 'string', minLength: 1, maxLength: 100 },
    // V4.2: when true AND user is current assignee → reply also advances workflow
    andAdvance:      { type: 'boolean' },
    // V4.5: explicit recipient (overrides the next-workflow-step routing)
    // When provided + andAdvance=true + user is current assignee → forward to this user
    forwardTo:       { type: 'string', maxLength: 100 }
  }
};

const RESUBMIT_SCHEMA = {
  required: ['username'],
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 100 },
    note:     { type: 'string', maxLength: 5000 }
  }
};

const FORCE_DELETE_SCHEMA = {
  required: ['confirm', 'reason'],
  properties: {
    confirm:  { enum: ['DELETE-FOREVER'] },
    reason:   { type: 'string', minLength: 5, maxLength: 500 },
    username: { type: 'string', minLength: 1, maxLength: 100 }
  }
};

// ─── Validator ───────────────────────────────────────────────────────────

/**
 * Validates a payload against a schema.
 * Returns { valid: boolean, errors: Array<string> }
 */
function validate(payload, schema) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['payload is required and must be an object'] };
  }

  // Required fields
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
        errors.push(`field "${key}" is required`);
      }
    }
  }

  // Per-property validation
  for (const [key, def] of Object.entries(schema.properties || {})) {
    const value = payload[key];
    if (value === undefined || value === null) continue;   // optional

    // Type check
    if (def.type) {
      const expected = def.type;
      const actual = Array.isArray(value) ? 'array' : typeof value;
      if (expected === 'integer') {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push(`field "${key}" must be an integer, got ${actual}`);
          continue;
        }
      } else if (actual !== expected) {
        errors.push(`field "${key}" must be ${expected}, got ${actual}`);
        continue;
      }
    }

    // ENUM check
    if (Array.isArray(def.enum) && !def.enum.includes(value)) {
      errors.push(`field "${key}" must be one of [${def.enum.join(', ')}], got "${value}"`);
    }

    // String length
    if (def.type === 'string') {
      if (def.minLength != null && value.length < def.minLength) {
        errors.push(`field "${key}" must be at least ${def.minLength} chars, got ${value.length}`);
      }
      if (def.maxLength != null && value.length > def.maxLength) {
        errors.push(`field "${key}" must be at most ${def.maxLength} chars, got ${value.length}`);
      }
    }

    // Numeric range
    if (def.type === 'number' || def.type === 'integer') {
      if (def.min != null && value < def.min) {
        errors.push(`field "${key}" must be >= ${def.min}, got ${value}`);
      }
      if (def.max != null && value > def.max) {
        errors.push(`field "${key}" must be <= ${def.max}, got ${value}`);
      }
    }

    // Array length
    if (Array.isArray(value) && def.maxLength != null && value.length > def.maxLength) {
      errors.push(`field "${key}" must be at most ${def.maxLength} items, got ${value.length}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Express middleware factory: returns 400 with errors if validation fails.
 */
function validateBody(schema) {
  return function(req, res, next) {
    const { valid, errors } = validate(req.body, schema);
    if (!valid) {
      return res.status(400).json({
        success: false,
        error: 'بيانات غير صحيحة: ' + errors.join('; '),
        validationErrors: errors,
        code: 'VALIDATION_FAILED'
      });
    }
    next();
  };
}

module.exports = {
  validate,
  validateBody,
  schemas: {
    create: TRANSACTION_CREATE_SCHEMA,
    action: ACTION_SCHEMA,
    reply: REPLY_SCHEMA,
    resubmit: RESUBMIT_SCHEMA,
    forceDelete: FORCE_DELETE_SCHEMA
  }
};
