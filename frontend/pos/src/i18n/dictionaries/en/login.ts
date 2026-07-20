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
} as const;
