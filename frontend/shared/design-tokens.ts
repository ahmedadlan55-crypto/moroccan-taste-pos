/**
 * ADLAN — Tailwind bridge for the single design-token source.
 * ────────────────────────────────────────────────────────────────
 * This module is the ONLY bridge from the single source of truth
 * (frontend/shared/design-tokens.css) into the Tailwind themes of the
 * three React apps (frontend/warehouse, frontend/sales, frontend/pos).
 *
 * It is loaded by Tailwind (via jiti) at build time AND type-checked
 * by each app's strict tsc, so it must stay dependency-free: node
 * builtins only, no npm imports (not even tailwindcss types — the
 * exports are typed structurally).
 *
 * Hex literals are FORBIDDEN in this file and in the three
 * tailwind.config.ts files (enforced by scripts/check-design-tokens.mjs).
 * Every value must be read from the CSS token file through tok().
 * Edit the token values in frontend/shared/design-tokens.css — never here.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const TOKENS_CSS_PATH = path.resolve(__dirname, "design-tokens.css");

/* ── Parsing ─────────────────────────────────────────────────── */

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract the body of the FIRST `:root { ... }` block. */
function extractRootBlock(css: string): string {
  const match = /:root\s*\{([^}]*)\}/.exec(css);
  if (match === null || match[1] === undefined) {
    throw new Error(`[design-tokens] No :root{...} block found in ${TOKENS_CSS_PATH}`);
  }
  return match[1];
}

/** Parse every `--name: value;` declaration (values may span lines). */
function parseDeclarations(block: string): Map<string, string> {
  const vars = new Map<string, string>();
  const decl = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(block)) !== null) {
    const name = m[1];
    const value = m[2];
    if (name !== undefined && value !== undefined) {
      vars.set(name, value.replace(/\s+/g, " ").trim());
    }
  }
  return vars;
}

const rawVars: Map<string, string> = parseDeclarations(
  extractRootBlock(stripComments(stripBom(fs.readFileSync(TOKENS_CSS_PATH, "utf8")))),
);

/* ── var() resolution ────────────────────────────────────────── */

/** Lowercase pure-hex values so output matches the historic Tailwind config. */
function normalizeHex(value: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value.toLowerCase() : value;
}

const resolvedCache = new Map<string, string>();

/** Resolve a token name (e.g. "--mt-accent") to its concrete value. */
function resolveName(name: string, stack: readonly string[]): string {
  const cached = resolvedCache.get(name);
  if (cached !== undefined) return cached;
  if (stack.includes(name)) {
    throw new Error(`[design-tokens] Circular var() reference: ${[...stack, name].join(" -> ")}`);
  }
  const raw = rawVars.get(name);
  if (raw === undefined) {
    throw new Error(
      `[design-tokens] Unknown token "${name}" referenced via var() in ${TOKENS_CSS_PATH} — the Tailwind build cannot continue.`,
    );
  }
  const value = normalizeHex(substituteVars(raw, [...stack, name]));
  resolvedCache.set(name, value);
  return value;
}

/** Replace every `var(--x)` / `var(--x, fallback)` in a value, recursively. */
function substituteVars(value: string, stack: readonly string[]): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("var(", i);
    if (at === -1) {
      out += value.slice(i);
      return out;
    }
    out += value.slice(i, at);
    // Walk to the matching close paren (fallbacks may contain nested parens).
    let depth = 1;
    let j = at + 4;
    while (j < value.length && depth > 0) {
      const ch = value.charAt(j);
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      j += 1;
    }
    if (depth !== 0) {
      throw new Error(`[design-tokens] Unbalanced parentheses in value: ${value}`);
    }
    const inner = value.slice(at + 4, j - 1);
    // Split on the first TOP-LEVEL comma: var(<name>[, <fallback>]).
    let comma = -1;
    let d = 0;
    for (let k = 0; k < inner.length; k += 1) {
      const c = inner.charAt(k);
      if (c === "(") d += 1;
      else if (c === ")") d -= 1;
      else if (c === "," && d === 0) {
        comma = k;
        break;
      }
    }
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    if (!name.startsWith("--")) {
      throw new Error(`[design-tokens] Malformed var() reference "var(${inner})" in ${TOKENS_CSS_PATH}`);
    }
    if (rawVars.has(name)) {
      out += resolveName(name, stack);
    } else if (fallback !== null) {
      out += substituteVars(fallback, stack);
    } else {
      throw new Error(
        `[design-tokens] Unknown token "${name}" referenced via var() in ${TOKENS_CSS_PATH} — the Tailwind build cannot continue.`,
      );
    }
    i = j;
  }
}

/* ── Public API ──────────────────────────────────────────────── */

/**
 * Read one design token (accepts "mt-text" or "--mt-text"), fully resolved.
 * Throws — failing the Tailwind build loudly — when the token is missing.
 */
export function tok(name: string): string {
  const key = name.startsWith("--") ? name : `--${name}`;
  if (!rawVars.has(key)) {
    throw new Error(
      `[design-tokens] Missing token "${key}" in frontend/shared/design-tokens.css — add it there; the Tailwind build cannot continue.`,
    );
  }
  return resolveName(key, []);
}

/**
 * Convert a px token to rem (root 16px) so Tailwind utilities keep scaling
 * with the user's browser font-size preference — parity with the historic
 * rem-based configs (10px -> 0.625rem, 14px -> 0.875rem, 44px -> 2.75rem).
 * Non-px values pass through unchanged.
 */
function pxToRem(value: string): string {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(value);
  if (m === null || m[1] === undefined) return value;
  return `${Number(m[1]) / 16}rem`;
}

/** Parse a CSS font-family stack into an array of family names. */
function parseFontStack(value: string): string[] {
  return value
    .split(",")
    .map((family) => family.trim().replace(/^["']/, "").replace(/["']$/, ""))
    .filter((family) => family.length > 0);
}

type ThemeScale = Record<string, string>;

export interface AdlanPresetExtend {
  fontFamily: { sans: string[] };
  colors: {
    ink: string;
    canvas: string;
    navy: string;
    teal: ThemeScale;
    saffron: ThemeScale;
  };
  borderRadius: ThemeScale;
  boxShadow: ThemeScale;
  minHeight: ThemeScale;
  minWidth: ThemeScale;
  zIndex: ThemeScale;
  transitionDuration: ThemeScale;
}

export interface AdlanPreset {
  theme: { extend: AdlanPresetExtend };
}

/**
 * The shared Tailwind preset for every ADLAN React app.
 * Token names (teal / saffron / ink / canvas / navy) are kept stable so the
 * existing utility classes adopt brand changes with zero component edits.
 */
export const adlanPreset: AdlanPreset = {
  theme: {
    extend: {
      fontFamily: {
        sans: parseFontStack(tok("mt-font")),
      },
      colors: {
        ink: tok("mt-text"), // primary text / dark chrome
        canvas: tok("mt-bg"), // app background
        navy: tok("mt-primary"), // ADLAN dark-navy app chrome (sidebars, topbar chips)
        // Primary accent — ADLAN petrol. Mapped onto `teal` so every existing
        // bg-teal-*/text-teal-*/ring-teal-* utility adopts it unchanged.
        teal: {
          50: tok("mt-accent-50"),
          100: tok("mt-accent-100"),
          200: tok("mt-accent-200"),
          500: tok("mt-accent-500"),
          600: tok("mt-accent-600"),
          700: tok("mt-accent-700"),
        },
        // Secondary highlight mapped onto `saffron` (ADLAN warm amber).
        saffron: {
          50: tok("mt-warm-50"),
          100: tok("mt-warm-soft"),
          500: tok("mt-warm"),
          600: tok("mt-warm-2"),
        },
      },
      borderRadius: {
        xl: pxToRem(tok("mt-r-btn")), // buttons/controls (0.625rem = 10px)
        "2xl": pxToRem(tok("mt-r-card")), // cards/surfaces (0.875rem = 14px)
      },
      boxShadow: {
        soft: tok("mt-shadow-sm"),
        lift: tok("mt-shadow-md"),
      },
      minHeight: {
        "11": pxToRem(tok("mt-touch-target")), // 2.75rem = 44px touch target
      },
      minWidth: {
        "11": pxToRem(tok("mt-touch-target")),
      },
      zIndex: {
        popover: tok("mt-z-popover"),
        drawer: tok("mt-z-drawer"),
        modal: tok("mt-z-modal"),
        palette: tok("mt-z-palette"),
      },
      transitionDuration: {
        fast: tok("mt-dur-fast"),
        base: tok("mt-dur-base"),
        slow: tok("mt-dur-slow"),
      },
    },
  },
};
