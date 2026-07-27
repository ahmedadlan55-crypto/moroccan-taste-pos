export const comboDialog = {
  currency: "ر.س",
  actions: {
    cancel: "إلغاء",
    addToCart: "أضف للسلة",
  },
  fixed: {
    alwaysIncludes: "يشمل دائماً:",
    separator: "، ",
  },
  emptyCombo: "هذا العرض بلا خيارات",
  /** The combo cannot be completed from the options that are still active —
   *  «أضف للسلة» stays locked instead of building a cart the sync will reject. */
  unsellable: "هذا العرض غير متاح حالياً — بعض خياراته الأساسية موقوفة. اختر عرضاً آخر.",
  group: {
    noOptions: "لا خيارات متاحة",
    /** The group HAS options, but every one of them is deactivated. */
    allInactive: "كل خيارات هذه المجموعة موقوفة حالياً",
    /** Some options survive, but fewer than the group's required minimum. */
    cannotMeetMinimum: "الخيارات المتاحة أقل من المطلوب ({min}) — بعضها موقوف",
  },
  groupRule: {
    chooseUpTo: "اختر حتى {max}",
    chooseOne: "اختر واحداً",
    required: "· مطلوب",
    optional: "· اختياري",
  },
} as const;
