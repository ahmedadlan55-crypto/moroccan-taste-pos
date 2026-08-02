/**
 * lib/procurement/config.js — small runtime config reads for procurement.
 */
'use strict';

let _vatCache = null;
let _vatAt = 0;

/** Standard VAT rate from settings.VATRate (default 15), cached 60s. */
async function standardVatRate(db) {
  const now = Date.now();
  if (_vatCache != null && now - _vatAt < 60000) return _vatCache;
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'VATRate' LIMIT 1");
    const v = rows.length ? Number(rows[0].setting_value) : 15;
    _vatCache = Number.isFinite(v) ? v : 15;
  } catch (_) {
    _vatCache = 15;
  }
  _vatAt = now;
  return _vatCache;
}

function makerCheckerEnabled() {
  const v = String(process.env.PROCUREMENT_MAKER_CHECKER || '1').toLowerCase();
  return /^(1|true|on|yes)$/.test(v);
}

function p2pEnabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.PROCUREMENT_P2P_ENABLE || '').trim());
}

// ── فصل المهام عند اعتماد أمر الشراء (سياسة مخزَّنة في جدول settings) ────────
/**
 * مفتاح السياسة في جدول `settings` — نفس أسلوب routes/security-policies.js
 * (قيمة JSON في صف واحد، تُقرأ عند الحاجة ولا تُنشأ إلا عند أول حفظ).
 *
 *   { enabled: boolean, thresholdAmount: number }
 *
 * enabled          — عند التفعيل يُمنع مُنشئ/مُرسل أمر الشراء من اعتماده بنفسه.
 * thresholdAmount  — إجمالي أمر الشراء (شامل الضريبة) الذي يبدأ عنده المنع؛
 *                    0 = يشمل كل الأوامر. نفس شكل O2C_MAKER_CHECKER_THRESHOLD
 *                    في lib/order-to-cash/config.js (المقارنة بـ >=).
 */
const SELF_APPROVAL_KEY = 'ProcurementSelfApprovalPolicy';

/**
 * القيمة الافتراضية حين لا يوجد صف مخزَّن: سلوك اليوم حرفيًا — أي متغيّر البيئة
 * PROCUREMENT_MAKER_CHECKER (افتراضيًا مُفعّل) وبلا حد أدنى. هكذا لا يتغيّر أي
 * سلوك عند الترقية، ولا تُلغى إعدادات بيئة قائمة، حتى يحفظ المالك السياسة.
 */
function defaultSelfApprovalPolicy() {
  return { enabled: makerCheckerEnabled(), thresholdAmount: 0 };
}

/** يدمج قيمة مخزَّنة (قد تكون ناقصة أو تالفة) فوق الافتراضي. */
function normalizeSelfApprovalPolicy(raw, fallback) {
  const base = fallback || defaultSelfApprovalPolicy();
  const o = (raw != null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const amount = Number(o.thresholdAmount);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    thresholdAmount: Number.isFinite(amount) && amount >= 0 ? amount : base.thresholdAmount,
  };
}

/**
 * يقرأ السياسة السارية. `dbLike` أي كائن فيه query() — مرِّر اتصال المعاملة
 * ليقرأ ضمن نفس المعاملة. بلا cache: اعتماد أمر الشراء عملية بشرية نادرة،
 * وقراءة صف واحد بمفتاحه أرخص بكثير من احتمال تطبيق سياسة قديمة بعد تعديلها.
 * أي خطأ قراءة ⇐ الافتراضي (fail-closed: يبقى فصل المهام مُفعّلًا).
 */
async function selfApprovalPolicy(dbLike) {
  const fallback = defaultSelfApprovalPolicy();
  try {
    const [rows] = await dbLike.query('SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1', [SELF_APPROVAL_KEY]);
    if (rows.length && rows[0].setting_value) return normalizeSelfApprovalPolicy(JSON.parse(rows[0].setting_value), fallback);
  } catch (_) { /* غير مضبوطة أو غير قابلة للتحليل ⇐ الافتراضي */ }
  return fallback;
}

module.exports = {
  standardVatRate, makerCheckerEnabled, p2pEnabled,
  SELF_APPROVAL_KEY, defaultSelfApprovalPolicy, normalizeSelfApprovalPolicy, selfApprovalPolicy,
};
