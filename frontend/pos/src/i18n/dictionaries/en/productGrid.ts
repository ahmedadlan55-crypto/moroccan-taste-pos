export const productGrid = {
  currency: "SAR",
  badge: {
    combo: "Offer",
    custom: "Custom",
  },
  card: {
    inCartAria: "In cart {name}: {qty}",
    decrementAria: "Decrease {name}",
  },
  search: {
    placeholder: "Search or scan barcode… (F2)",
    aria: "Search items or scan barcode",
    clearAria: "Clear search",
  },
  // The 86 board — warn, never block: the server is the authority and the card
  // stays tappable.
  stock: {
    out: "Out",
    low: "Low",
    outTitle: '"{name}" unavailable — an ingredient ran out',
    // Two numbers that mean different things: portions the recipe can still
    // yield, versus the item's own stock balance. Never one shared wording.
    lowTitle: "Can still make: {count}",
    lowTitleStock: "In stock: {count} {unit}",
    addedOutOfStock: '"{name}" looks unavailable — added anyway; the server is the authority',
  },
  empty: {
    title: "No results",
    hintQuery: "Try another word or scan the barcode again",
    hintCategory: "No active items in this category",
    hintQuick: "No repeat sales yet — sell a few items and they show up here",
  },
} as const;
