export const comboDialog = {
  currency: "SAR",
  actions: {
    cancel: "Cancel",
    addToCart: "Add to cart",
  },
  fixed: {
    alwaysIncludes: "Always includes:",
    separator: ", ",
  },
  emptyCombo: "This combo has no options",
  group: {
    noOptions: "No options available",
  },
  groupRule: {
    chooseUpTo: "Choose up to {max}",
    chooseOne: "Choose one",
    required: "· Required",
    optional: "· Optional",
  },
} as const;
