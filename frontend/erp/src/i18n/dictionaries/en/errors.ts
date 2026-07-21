/** ApiError.code → user-facing English string. Consumed via
 *  translateApiError(e, t) (frontend/erp/src/i18n/errorCodes.ts).
 *
 *  Seeded with the common backend codes the Express routes emit
 *  (VERSION_CONFLICT / PERMISSION_DENIED / NOT_FOUND / RATE_LIMITED — see
 *  routes/*.js) plus the SERVER_ERROR / UNAUTHORIZED / VALIDATION_ERROR
 *  fallbacks translateApiError relies on. Other agents append module-specific
 *  codes as they translate each screen. */
export const errors = {
  SERVER_ERROR: "A server error occurred — please try again later",
  UNAUTHORIZED: "Your session has expired or is unauthorized — please sign in again",
  VALIDATION_ERROR: "Please check the entered data and try again",
  VERSION_CONFLICT: "This item was changed elsewhere — please reload and try again",
  PERMISSION_DENIED: "You don't have permission to perform this action",
  NOT_FOUND: "The requested item was not found or has been removed",
  RATE_LIMITED: "Too many attempts — please wait a moment and try again",
  // Menu D2/D3 — a manual cost write was refused because the item's cost is
  // recipe-derived; the product page surfaces this as an "unlock to edit" flow.
  COST_LOCKED_BY_RECIPE: "This cost is recipe-derived — unlock it on the product page to set it manually",
} as const;
