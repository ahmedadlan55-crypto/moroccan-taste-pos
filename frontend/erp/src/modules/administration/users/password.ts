// Client-side password strength check — MIRRORS the server rule enforced in
// routes/auth.js (POST /users ~691 and POST /users/:username/reset-password
// ~1055) byte-for-byte so the operator gets instant feedback instead of a
// round-trip rejection. The server stays authoritative; this is UX only.
//
// Rule: ≥ 6 chars AND at least one letter AND one digit AND one special char.
//
// i18n: this pure helper can't call useT(); it returns a stable `code` and the
// React call sites translate it via t("administration.users.pwd.<code>").
export type PasswordErrorCode = "tooShort" | "noLetter" | "noDigit" | "noSpecial";
export interface PasswordCheck {
  ok: boolean;
  code?: PasswordErrorCode;
}

const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"|,.<>/?]/;

export function checkPasswordStrength(pw: string): PasswordCheck {
  if (!pw || pw.length < 6) {
    return { ok: false, code: "tooShort" };
  }
  if (!/[a-zA-Z]/.test(pw)) {
    return { ok: false, code: "noLetter" };
  }
  if (!/[0-9]/.test(pw)) {
    return { ok: false, code: "noDigit" };
  }
  if (!SPECIAL.test(pw)) {
    return { ok: false, code: "noSpecial" };
  }
  return { ok: true };
}
