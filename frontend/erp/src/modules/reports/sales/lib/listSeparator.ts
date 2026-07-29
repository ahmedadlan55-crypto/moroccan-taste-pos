// The separator for a list of names inside one sentence.
//
// Three places in this module joined with a hardcoded "، " (U+060C ARABIC
// COMMA): the Group By option sublabels, the dropped-levels notice, and the
// basis-of-preparation scope line. In the English UI those render as
//
//     Dropped grouping levels the chosen metrics cannot support: Payment method، Item
//
// which is not a typo a reader forgives — it reads as a corrupted string, in
// the one part of the screen that exists to explain why something is
// unavailable.
//
// The RTL-literals guard cannot catch this: U+060C is a character, not a
// direction class. So it lives here, is derived from the ACTIVE language, and
// every join in the module goes through it.
import { useLang } from "@/i18n";

/** "، " in Arabic, ", " everywhere else. */
export function useListSeparator(): string {
  return useLang() === "ar" ? "، " : ", ";
}

/** Non-hook form, for code that already knows the language. */
export function listSeparatorFor(lang: string): string {
  return lang === "ar" ? "، " : ", ";
}
