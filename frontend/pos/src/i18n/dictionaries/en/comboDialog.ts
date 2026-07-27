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
  /** The combo cannot be completed from the options that are still active —
   *  "Add to cart" stays locked instead of building a cart the sync will reject. */
  unsellable: "This combo is unavailable right now — some of its required options are inactive. Pick another combo.",
  group: {
    noOptions: "No options available",
    /** The group HAS options, but every one of them is deactivated. */
    allInactive: "Every option in this group is currently inactive",
    /** Some options survive, but fewer than the group's required minimum. */
    cannotMeetMinimum: "Fewer options available than required ({min}) — some are inactive",
  },
  groupRule: {
    chooseUpTo: "Choose up to {max}",
    chooseOne: "Choose one",
    required: "· Required",
    optional: "· Optional",
  },
} as const;
