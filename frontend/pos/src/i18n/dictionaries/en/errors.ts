/** ApiError.code → user-facing English string. Consumed via
 *  translateApiError(e, t) (frontend/pos/src/i18n/errorCodes.ts). */
export const errors = {
  VERSION_CONFLICT: "This item was changed on another device — please reload and try again",
  UNAUTHORIZED: "Your session has expired or is unauthorized — please sign in again",
  SERVER_ERROR: "A server error occurred — please try again later",
  O2C_MODULE_ACTIVE: "This action is currently disabled because the new sales management system is active",
  approval_required: "This action requires manager approval",
  OVER_RETURN: "The requested return quantity exceeds what's available to return",
  SOD_VIOLATION: "You can't perform this action yourself — separation of duties requires another person's approval",
} as const;
