/**
 * Force every native date/time input in the app to render in ENGLISH.
 *
 * WHY THIS IS GLOBAL AND NOT A PROP
 *
 * A native `<input type="date">` draws its visible text, its placeholder and
 * its calendar popup using the ELEMENT's language, which inherits from
 * `<html lang="ar">`. On an Arabic page browsers therefore render Arabic month
 * names — and on several platforms Arabic-Indic digits and a Hijri calendar —
 * inside filters that feed financial reports.
 *
 * `shared/ui/date-picker.tsx` sets `lang` on itself, but roughly thirty date
 * filters across accounting, banking and inventory use a bare `<input
 * type="date">` or the generic `<Input>` and bypass it entirely. Editing all of
 * them would fix today and lose tomorrow: the next date field anyone adds would
 * silently be Arabic again. This applies the policy once, at the root, to every
 * such input — including ones React mounts later — so it holds by construction.
 *
 * It only changes what is DISPLAYED. The element's value is an ISO
 * "YYYY-MM-DD" string either way, so no request payload, no stored date and no
 * report contract is affected.
 */

const DATE_INPUT_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time']);
const LOCALE = 'en-GB';

function applyTo(root: ParentNode | Element): void {
  if (root instanceof HTMLInputElement) {
    if (DATE_INPUT_TYPES.has(root.type) && root.lang !== LOCALE) root.lang = LOCALE;
    return;
  }
  const inputs = (root as ParentNode).querySelectorAll?.('input');
  inputs?.forEach((el) => {
    const input = el as HTMLInputElement;
    if (DATE_INPUT_TYPES.has(input.type) && input.lang !== LOCALE) input.lang = LOCALE;
  });
}

/**
 * Start the observer. Returns a disposer.
 *
 * Safe to call in a non-DOM environment (SSR, vitest node pool): it no-ops and
 * returns a disposer that does nothing, so importing this never breaks a test.
 */
export function enforceEnglishDateInputs(): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }

  applyTo(document);

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'attributes' && rec.target instanceof HTMLInputElement) {
        // `type` can change after mount (a field that toggles between text and
        // date). Re-check rather than assume the type it had when it appeared.
        applyTo(rec.target);
        continue;
      }
      rec.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement) applyTo(n);
      });
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type'],
  });

  return () => observer.disconnect();
}
