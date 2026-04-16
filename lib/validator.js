/**
 * Input Validation — Lightweight schema validation
 * No external dependencies — pure JavaScript
 */

/**
 * Validate an object against a schema
 * @param {object} data - Input data
 * @param {object} schema - Validation schema
 * @returns {object} { valid: boolean, errors: string[], cleaned: object }
 *
 * Schema format:
 * {
 *   fieldName: {
 *     type: 'string' | 'number' | 'boolean' | 'email' | 'date',
 *     required: true/false,
 *     min: number (min length for string, min value for number),
 *     max: number (max length for string, max value for number),
 *     pattern: RegExp,
 *     enum: ['val1', 'val2'],
 *     label: 'Arabic field name for error messages'
 *   }
 * }
 */
function validate(data, schema) {
  var errors = [];
  var cleaned = {};

  Object.keys(schema).forEach(function(field) {
    var rule = schema[field];
    var value = data[field];
    var label = rule.label || field;

    // Required check
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(label + ' مطلوب');
      return;
    }

    // Skip optional empty fields
    if (value === undefined || value === null || value === '') {
      cleaned[field] = rule.type === 'number' ? (rule.default || 0) : (rule.default || '');
      return;
    }

    // Type validation
    switch (rule.type) {
      case 'string':
        value = String(value).trim();
        // Sanitize HTML
        value = value.replace(/[<>]/g, function(c) { return { '<': '&lt;', '>': '&gt;' }[c]; });
        if (rule.min && value.length < rule.min) errors.push(label + ' يجب أن يكون ' + rule.min + ' أحرف على الأقل');
        if (rule.max && value.length > rule.max) errors.push(label + ' يجب أن لا يتجاوز ' + rule.max + ' حرف');
        if (rule.pattern && !rule.pattern.test(value)) errors.push(label + ' غير صالح');
        break;

      case 'number':
        value = Number(value);
        if (isNaN(value)) { errors.push(label + ' يجب أن يكون رقم'); return; }
        if (rule.min !== undefined && value < rule.min) errors.push(label + ' يجب أن يكون ' + rule.min + ' على الأقل');
        if (rule.max !== undefined && value > rule.max) errors.push(label + ' يجب أن لا يتجاوز ' + rule.max);
        break;

      case 'email':
        value = String(value).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(label + ' بريد إلكتروني غير صالح');
        break;

      case 'date':
        if (isNaN(Date.parse(value))) errors.push(label + ' تاريخ غير صالح');
        break;

      case 'boolean':
        value = !!value;
        break;
    }

    // Enum check
    if (rule.enum && rule.enum.indexOf(value) === -1) {
      errors.push(label + ' قيمة غير مسموحة');
    }

    cleaned[field] = value;
  });

  return { valid: errors.length === 0, errors: errors, cleaned: cleaned };
}

/**
 * Express middleware factory for request body validation
 */
function validateBody(schema) {
  return function(req, res, next) {
    var result = validate(req.body, schema);
    if (!result.valid) {
      return res.status(400).json({ success: false, error: result.errors[0], errors: result.errors });
    }
    req.validatedBody = result.cleaned;
    next();
  };
}

// ─── Pre-built Schemas ───
var schemas = {
  employee: {
    firstName: { type: 'string', required: true, min: 2, max: 100, label: 'الاسم الأول' },
    lastName: { type: 'string', max: 100, label: 'اسم العائلة' },
    phone: { type: 'string', max: 20, pattern: /^[\d+\-\s()]+$/, label: 'الجوال' },
    email: { type: 'email', label: 'البريد الإلكتروني' },
    basicSalary: { type: 'number', min: 0, max: 999999, label: 'الراتب الأساسي' },
    nationalId: { type: 'string', max: 20, label: 'رقم الهوية' }
  },
  customer: {
    name: { type: 'string', required: true, min: 2, max: 200, label: 'الاسم' },
    email: { type: 'email', label: 'البريد' },
    phone: { type: 'string', max: 20, label: 'الجوال' },
    creditLimit: { type: 'number', min: 0, max: 9999999, label: 'الحد الائتماني' }
  },
  glJournal: {
    description: { type: 'string', required: true, min: 3, max: 500, label: 'عنوان القيد' },
    journalDate: { type: 'date', required: true, label: 'تاريخ القيد' }
  },
  leaveRequest: {
    employeeId: { type: 'string', required: true, label: 'الموظف' },
    leaveTypeId: { type: 'string', required: true, label: 'نوع الإجازة' },
    startDate: { type: 'date', required: true, label: 'تاريخ البداية' },
    endDate: { type: 'date', required: true, label: 'تاريخ النهاية' }
  }
};

module.exports = { validate, validateBody, schemas };
