export const categoryRail = {
  all: "All",
  aria: {
    tablist: "Categories",
  },
  // Known DB category names (Arabic) → English. Unknown categories fall back
  // to the raw Arabic string in the component.
  categoryLabels: {
    "الإضافات": "Add-ons",
    "البرغر": "Burgers",
    "الحلويات": "Desserts",
    "السلطات": "Salads",
    "السندويتشات": "Sandwiches",
    "الشوربات": "Soups",
    "الطواجن": "Tagines",
    "العصائر": "Juices",
    "الكسكس": "Couscous",
    "المشاوي": "Grills",
    "المشروبات الباردة": "Cold Drinks",
    "المشروبات الساخنة": "Hot Drinks",
    "المعجنات": "Pastries",
    "المقبلات": "Appetizers",
    "عام": "General",
  },
} as const;
