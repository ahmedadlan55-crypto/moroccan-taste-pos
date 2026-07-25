/**
 * English dictionary — PosLogin (the POS's own sign-in screen: brand heading,
 * username/password/2FA fields, submit button, error copy, and the link back
 * to the main system's login).
 * Arabic mirror: frontend/pos/src/i18n/dictionaries/ar/login.ts
 *
 * NOTE: the language-toggle button on this screen reuses header.
 * languageToggle.* verbatim — see that namespace's own note (language names
 * are never translated between dictionaries, so the toggle stays
 * recognisable regardless of current UI language).
 */
export const login = {
  brand: "Moroccan Taste — Cashier",
  title: "Sign in",
  usernameLabel: "Username",
  passwordLabel: "Password",
  totpLabel: "Two-factor code",
  totpPlaceholder: "000000",
  submit: "Sign in",
  backToSystem: "Sign in from the main system instead",
  errors: {
    totpRequired: "Enter the two-factor code",
    loginFailed: "Sign-in failed",
    roleNotAllowed: "This account is not authorized to access the till. Contact your administrator.",
    networkError: "Could not reach the server. Please try again.",
  },
  // Forced first-login password change, IN the cashier app. It used to hop to
  // /app/change-password — a cross-portal navigation that had to be removed
  // when the cashier was isolated from the back office.
  changePassword: {
    title: "Change password",
    mandatoryNote: "You must replace the temporary password before using the till.",
    currentLabel: "Current password",
    newLabel: "New password",
    confirmLabel: "Confirm new password",
    mismatch: "The two passwords do not match",
    submit: "Save and continue",
    genericError: "Could not change the password",
  },
} as const;
