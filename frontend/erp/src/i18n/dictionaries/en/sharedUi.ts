/** English mirror of the shared UI-kit defaults. Keep the key set identical to
 *  ar/sharedUi.ts (enforced by the dictionary parity test). */
export const sharedUi = {
  currencySymbol: "SAR",
  combobox: {
    placeholder: "Select…",
    empty: "No matching results.",
    clear: "Clear",
    searchPlaceholder: "Search…",
    searchLabel: "Search",
  },
  entityCombobox: {
    placeholder: "Search by name or code…",
    empty: "No matching results.",
    clearSelected: "Clear selection",
    searchLabel: "Search",
    loadError: "Couldn't load results.",
    searching: "Searching…",
    typeToSearch: "Type to search…",
    loadingMore: "Loading more…",
  },
  entityMultiCombobox: {
    placeholder: "Search to add… (multi-select)",
    empty: "No matching results.",
    searchLabel: "Multi search",
    loadError: "Couldn't load results.",
    searching: "Searching…",
    typeToSearch: "Type to search…",
    loadingMore: "Loading more…",
    removeItem: "Remove {label}",
    clearAll: "Clear all ({count})",
    addAllVisible: "Add all visible ({count})",
    selectedCount: "Selected: {count}",
  },
  geo: {
    countryPlaceholder: "Search for a country…",
    cityPlaceholder: "Search for a city…",
    cityPlaceholderNoCountry: "Select a country first",
    countryEmpty: "No matching countries.",
    cityEmpty: "No matching cities.",
    countryLabel: "Select country",
    cityLabel: "Select city",
  },
  fileUploader: {
    hint: "Drag files here or click to choose",
    tooLarge: "The file exceeds the maximum size.",
    empty: "No attachments.",
    remove: "Remove {name}",
  },
  fullPageFlow: {
    workspace: "Workspace",
    back: "Back",
    backAria: "Back to the previous page",
  },
  drawer: {
    eyebrow: "Record details",
  },
  unitQty: {
    qtyLabel: "Quantity",
    unitLabel: "Unit",
    countAria: "{unit} count",
    majorFallback: "the larger unit",
    majorShort: "Larger",
  },
  stepper: {
    progress: "Step {current} of {total}: {label}",
  },
  timeline: {
    empty: "No history yet.",
  },
  pageHeader: {
    actions: "Page actions",
  },
  toast: {
    region: "Notifications",
    close: "Dismiss notification",
  },
  errorBoundary: {
    title: "Something went wrong",
    body: "Sorry for the inconvenience, a temporary glitch occurred in the interface. Try again, and if the problem persists contact technical support.",
    retry: "Retry",
  },
} as const;
