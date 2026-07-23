/** Sign-in + change-password copy (English) — English mirror of
 *  dictionaries/ar/login.ts. Identical key shape (enforced by the dictionary
 *  parity test). */
export const login = {
  brand: "Moroccan Taste",
  subtitle: "Unified Management — Sign in",
  usernameLabel: "Username",
  passwordLabel: "Password",
  totpLabel: "Two-factor code",
  totpPlaceholder: "000000",
  submit: "Sign in",
  errors: {
    totpRequired: "Enter your two-factor code",
    loginFailed: "Sign-in failed",
    network: "Couldn't reach the server. Please try again.",
  },
  changePassword: {
    title: "Change password",
    subtitle: "Choose a strong password for your account",
    mandatory: "Your account is using a default password. You must change it before continuing.",
    currentLabel: "Current password",
    newLabel: "New password",
    confirmLabel: "Confirm new password",
    reveal: "Show password",
    hide: "Hide password",
    mismatch: "Passwords don't match",
    submit: "Save password",
    back: "Back to Overview",
    genericError: "Couldn't change the password",
    checks: {
      minLength: "At least 12 characters",
      hasLetter: "Contains a letter",
      hasNumber: "Contains a number",
      hasSpecial: "Contains a special character (!@#$…)",
      notCommon: "Not a common password",
    },
    strength: {
      veryWeak: "Very weak",
      weak: "Weak",
      medium: "Medium",
      good: "Good",
      strong: "Strong",
    },
  },
} as const;
