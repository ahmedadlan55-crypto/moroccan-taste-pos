/**
 * Simple `{token}` interpolation — no external library. Unknown tokens are
 * left untouched (e.g. a stray `{foo}` in a template with no `foo` var stays
 * literal rather than vanishing), which makes missing-var bugs visible
 * instead of silently swallowing text.
 *
 * Ported verbatim from the POS i18n system (frontend/pos/src/i18n/interpolate.ts).
 */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, token: string) => {
    const val = vars[token];
    return val === undefined || val === null ? match : String(val);
  });
}
