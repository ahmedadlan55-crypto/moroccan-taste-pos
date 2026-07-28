// English dictionary — ItemMultiPicker, the shared open-on-focus multi-select
// used by the stocktake and shortage-request dialogs. Arabic twin:
// ../ar/itemMultiPicker.ts — identical key set and identical leaf TYPES (all
// strings; no function leaves), enforced by i18n/__tests__/dictionary.test.ts.
export const itemMultiPicker = {
  search: {
    // The affordance lives in the placeholder on purpose: the owner's complaint
    // was that nothing appears until you type.
    placeholder: "Tap to see every item… or type to search",
    ariaLabel: "Choose items — tap to show the full list",
  },

  list: {
    ariaLabel: "Item list",
    loading: "Loading items…",
    empty: "No items",
    noResults: "No matching results",
    // Two variables ⇒ MUST be a {placeholder} template, never a function leaf
    // (i18n/makeT.ts:52-72 calls a function leaf with a plain number).
    showingOf: "Showing {shown} of {total} — type to filter",
  },

  chips: {
    ariaLabel: "Selected items",
    removeAria: "Remove {name}",
  },

  actions: {
    selectAllShown: "Select all shown",
    clearAll: "Clear selection",
  },

  selectedCount: "Selected: {count}",
} as const;
