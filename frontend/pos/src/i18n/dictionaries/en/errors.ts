/** ApiError.code → user-facing English string. Consumed via
 *  translateApiError(e, t) (frontend/pos/src/i18n/errorCodes.ts).
 *
 *  RULE: every message tells the cashier what to DO next. A code the cashier
 *  cannot act on is worse than the server's own sentence.
 *
 *  DELIBERATELY ABSENT: VALIDATION_ERROR. It is the server's catch-all bad-input
 *  code (~30 distinct, far more specific messages in routes/pos-v2.js alone —
 *  "the cart is empty", "item X is inactive", "a credit sale needs a customer"…),
 *  and translateApiError prefers `errors.<code>` over `e.message`. Adding a key
 *  here would REPLACE every one of those precise sentences with one vague line.
 */
export const errors = {
  VERSION_CONFLICT: "This item was changed on another device — please reload and try again",
  UNAUTHORIZED: "Your session has expired or is unauthorized — please sign in again",
  SERVER_ERROR: "A server error occurred — please try again later",
  O2C_MODULE_ACTIVE: "This action is currently disabled because the new sales management system is active",
  approval_required: "This action requires manager approval",
  OVER_RETURN: "The requested return quantity exceeds what's available to return",
  SOD_VIOLATION: "You can't perform this action yourself — separation of duties requires another person's approval",

  // ── Offline engine ────────────────────────────────────────────────────────
  // lib/offline.ts calls t("errors.CHECKOUT_PREREQUISITE_FAILED") — the key
  // existed in NEITHER dictionary, so the cashier got the raw dotted path.
  CHECKOUT_PREREQUISITE_FAILED:
    "The order never reached the server, so the payment did not go through — it's open again, take payment once more",

  // ── Checkout / sale (routes/sales.js) ─────────────────────────────────────
  total_mismatch: "Prices changed since these items were added — refresh the menu, then re-enter the order and try again",
  sale_failed: "The sale failed on an internal error — try again, and contact support if it keeps happening",
  PAYMENT_MISMATCH: "The payments don't add up to the order total — adjust the amounts until they match exactly",
  IDEMPOTENCY_UNAVAILABLE:
    "Checkout was stopped to avoid billing this order twice — do not retry on this terminal, tell support now",

  // ── Shift (routes/sales.js:486-511 — re-validated at every sale/replay) ────
  shift_required: "No shift is open — open a shift, then take payment again",
  shift_not_found: "That shift no longer exists — open a new shift, then take payment again",
  shift_closed: "That shift is closed — open a new shift, then take payment again",
  shift_owner_mismatch: "That shift belongs to another user — open a shift in your own name, then take payment again",

  // ── Order lifecycle / catalog data ────────────────────────────────────────
  INVALID_STATE_TRANSITION:
    "The order's current state doesn't allow this — reopen it from Held Orders and start the step again",
  UNIT_CONVERSION_CONFLICT:
    "This item's units changed on the server — refresh the menu, then remove the line and add it again",
  NOT_FOUND: "What you asked for no longer exists on the server — refresh the menu and try again",

  // ── Catalog loading (lib/catalogCache.ts CatalogError.code) ───────────────
  CATALOG_OFFLINE:
    "No connection and no saved menu on this device — connect to the network once, then reopen the register",
  CATALOG_LOAD_FAILED: "The menu could not be loaded — check the connection, then press Retry",
  SESSION_EXPIRED: "Your session has expired — sign in again before you keep selling",
} as const;
