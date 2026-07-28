// English dictionary — StocktakeDialog, incl. buildCountSheetHtml's print-only
// "countSheet" namespace (imported directly by that function — NOT via useT(),
// since it is a plain string-building function, not a React component).
export const stocktakeDialog = {
  title: "Stocktake",
  doneTitle: "Stocktake sent for approval",

  offline: {
    title: "Stocktake requires a connection",
    hint: "Try again once the server connection is back — your draft sheet is saved on this device",
  },

  /** Saved stocktake templates — a named set of the materials counted on a
   *  cycle: built once, then picked and edited instead of re-finding thirty
   *  items by hand every time. */
  templates: {
    label: "Saved count sheet",
    placeholder: "Choose a template…",
    none: "No template",
    apply: "Load",
    save: "Save as template",
    update: "Update template",
    remove: "Delete",
    namePrompt: "Template name",
    nameRequired: "Give the template a name",
    emptyCart: "Add materials first, then save them as a template",
    saved: "Saved template “{name}”",
    updated: "Updated template “{name}”",
    deleted: "Template deleted",
    applied: "Loaded {count} materials from the template",
    loadFailed: "Templates could not be loaded",
    saveFailed: "The template could not be saved",
    confirmDelete: "Delete this template?",
    itemCount: "{count} materials",
  },
  search: {
    placeholder: "Search for a raw material to add to the sheet…",
    ariaLabel: "Search for a material",
    resultsAriaLabel: "Search results",
    noResults: "No matching results",
  },

  cart: {
    emptyTitle: "Count sheet is empty",
    emptyHint: "Search for a material, add it, then enter the actual counted quantity",
  },

  table: {
    item: "Item",
    bigQty: "Large quantity",
    bigUnit: "Large unit",
    smallQty: "Small quantity",
    smallUnit: "Small unit",
    system: "System",
    variance: "Variance",
    // delete column header reuses common.delete (exact match) — see footer.
    bigQtyAria: "Large quantity — {name}",
    smallQtyAria: "Small quantity — {name}",
    deleteAria: "Delete {name}",
  },

  notes: {
    placeholder: "Stocktake notes (optional)",
    ariaLabel: "Stocktake notes",
  },

  review: {
    summaryPrefix: "Review the sheet before sending —",
    countedSuffix: "items counted",
    ignoredHint: "{count} items with no quantity will be skipped",
    blindNotice: "The sheet is sent to your warehouse for management approval — the variance is calculated and reviewed after submission (blind count).",
  },

  done: {
    submittedTitle: "Stocktake sheet sent for approval",
    numberLabel: "Sheet number:",
    pendingNotice: "Awaiting management review and approval — no further action needed from you.",
    printButton: "Print count sheet / PDF",
  },

  footer: {
    clearCart: "Clear sheet",
    clearCartTitle: "Clear the entire sheet",
    autoSaveHint: "Draft is saved automatically",
    reviewAndSend: "Review & send",
    backToEdit: "Back to editing",
    sendForApproval: "Send for approval",
    // close button reuses common.close (exact match, per i18n dedup rule).
  },

  toasts: {
    cartCleared: "Sheet cleared",
    addAtLeastOneItem: "Add at least one item",
    enterQtyAtLeastOne: "Enter the actual quantity for at least one item",
    noWarehouse: "Couldn't determine the cashier's warehouse — no default warehouse is linked to your account. Check with management before counting.",
    submittedForApproval: "Stocktake sheet sent for approval",
  },

  errors: {
    noDocumentNumber: "The server did not return a stocktake sheet number",
    countsNotSaved: "Couldn't save the counted quantities — no item was frozen for this warehouse",
    stockMovementConflict: "A stock movement occurred while counting — please try again",
    printBlocked: "The browser blocked the print window",
  },

  misc: {
    defaultNotesPrefix: "Stocktake by {username}",
  },

  // Used ONLY by buildCountSheetHtml (imported directly, not via useT()).
  countSheet: {
    docTitle: "Stocktake Sheet",
    heading: "Inventory Stocktake Sheet",
    numberLabel: "Sheet No.:",
    cashierLabel: "Cashier:",
    pendingApprovalBadge: "Sent for approval — awaiting management review",
    notesLabel: "Notes:",
    printButton: "🖨 Print / PDF",
    colIndex: "#",
    colItem: "Item",
    colUnit: "Unit",
    colCounted: "Counted Qty",
    totalCountedLabel: "Items counted:",
  },
} as const;
