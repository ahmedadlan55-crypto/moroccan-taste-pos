// Client-side password strength check — MIRRORS the server rule enforced in
// routes/auth.js (POST /users ~691 and POST /users/:username/reset-password
// ~1055) byte-for-byte so the operator gets instant feedback instead of a
// round-trip rejection. The server stays authoritative; this is UX only.
//
// Rule: ≥ 6 chars AND at least one letter AND one digit AND one special char.
export interface PasswordCheck {
  ok: boolean;
  error?: string;
}

const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"|,.<>/?]/;

export function checkPasswordStrength(pw: string): PasswordCheck {
  if (!pw || pw.length < 6) {
    return { ok: false, error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" };
  }
  if (!/[a-zA-Z]/.test(pw)) {
    return { ok: false, error: "كلمة المرور يجب أن تحتوي على حروف" };
  }
  if (!/[0-9]/.test(pw)) {
    return { ok: false, error: "كلمة المرور يجب أن تحتوي على أرقام" };
  }
  if (!SPECIAL.test(pw)) {
    return { ok: false, error: "كلمة المرور يجب أن تحتوي على رمز خاص (!@#$...)" };
  }
  return { ok: true };
}
