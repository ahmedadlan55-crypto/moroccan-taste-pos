/**
 * lib/menu-en-dictionary.js — curated Arabic→English dictionary for MENU ITEM
 * NAMES, used by lib/name-en-backfill-worker.js.
 *
 * WHY THIS EXISTS: the backfill worker's only fallback was a letter-by-letter
 * transliteration, which produces Latin script but NOT English —
 * "شاي بالنعناع" → "Shay Baln'Na'", "عصير برتقال" → "'Syr Brtqal". A cashier
 * reading the English UI needs "Mint Tea" and "Orange Juice". This module
 * translates the terms a Saudi/Moroccan restaurant menu actually uses, and
 * leaves anything unknown to the caller's transliteration (so output is always
 * Latin script, never half-Arabic).
 *
 * CONTRACT: pure. No DB, no network, no side effects — the worker owns all
 * writes. Nothing here can touch `menu`.
 *
 * Matching order (longest-first so specific beats generic):
 *   1. PHRASES — multi-word terms ("شاورما دجاج" → "Chicken Shawarma"),
 *      replaced with an @@n@@ slot that cannot collide with digits already in
 *      the name (item names legitimately contain numbers, e.g. "بقلاوة 1134" —
 *      a bare-number placeholder would be clobbered by the real number).
 *   2. WORDS   — single tokens, with a leading "ال" stripped as a fallback.
 *   3. Unknown Arabic tokens → the caller's transliterate function.
 *
 * `matched` in the result tells the caller how much real translation happened,
 * so it can label name_en_source honestly ('machine_translation' vs
 * 'transliteration').
 */
'use strict';

const { GENERATED_PHRASES, GENERATED_WORDS } = require('./menu-en-dictionary.data');

// ── Multi-word phrases (matched before single words) ────────────────────────
// Hand-curated; merged OVER the generated set below so a correction here always
// wins over the generated vocabulary.
const CURATED_PHRASES = {
  'شاي بالنعناع': 'Mint Tea',
  'شاي مغربي': 'Moroccan Tea',
  'شاي أخضر': 'Green Tea',
  'شاي اخضر': 'Green Tea',
  'شاي إنجليزي': 'English Tea',
  'شاي انجليزي': 'English Tea',
  'شاي احمر': 'Black Tea',
  'شاي أحمر': 'Black Tea',
  'قهوة عربية': 'Arabic Coffee',
  'قهوة تركية': 'Turkish Coffee',
  'قهوة سعودية': 'Saudi Coffee',
  'كرك زعفران': 'Saffron Karak',
  'كرك حليب': 'Milk Karak',
  'عصير ليمون نعناع': 'Lemon Mint Juice',
  'عصير برتقال': 'Orange Juice',
  'عصير ليمون': 'Lemon Juice',
  'عصير مانجو': 'Mango Juice',
  'عصير فراولة': 'Strawberry Juice',
  'عصير رمان': 'Pomegranate Juice',
  'عصير افوكادو': 'Avocado Juice',
  'عصير أفوكادو': 'Avocado Juice',
  'عصير تفاح': 'Apple Juice',
  'عصير كوكتيل': 'Cocktail Juice',
  'عصير سانتي': 'Santé Juice',
  'ليمون نعناع': 'Lemon Mint',
  'مشروب غازي': 'Soft Drink',
  'مشروب الطبيعة': 'Nature Drink',
  'ماء معدني': 'Mineral Water',
  'مياه معدنية': 'Mineral Water',
  'أرز بخاري': 'Bukhari Rice',
  'ارز بخاري': 'Bukhari Rice',
  'كبسة دجاج': 'Chicken Kabsa',
  'كبسة لحم': 'Meat Kabsa',
  'مندي دجاج': 'Chicken Mandi',
  'مندي لحم': 'Meat Mandi',
  'شاورما دجاج': 'Chicken Shawarma',
  'شاورما لحم': 'Meat Shawarma',
  'برجر دجاج': 'Chicken Burger',
  'برغر دجاج': 'Chicken Burger',
  'برجر لحم': 'Beef Burger',
  'برغر لحم': 'Beef Burger',
  'دجاج مشوي': 'Grilled Chicken',
  'نص دجاج': 'Half Chicken',
  'ربع دجاج': 'Quarter Chicken',
  'صدر دجاج': 'Chicken Breast',
  'طاجن دجاج': 'Chicken Tagine',
  'طاجين دجاج': 'Chicken Tagine',
  'طاجن لحم': 'Meat Tagine',
  'طاجين لحم': 'Meat Tagine',
  'كسكس لحم': 'Meat Couscous',
  'كسكس دجاج': 'Chicken Couscous',
  'كسكس خضار': 'Vegetable Couscous',
  'كسكس بالخضار': 'Vegetable Couscous',
  'البوكس المغربي': 'Moroccan Box',
  'بوكس مغربي': 'Moroccan Box',
  'سلطة خضراء': 'Green Salad',
  'سلطة سيزر': 'Caesar Salad',
  'سلطة مغربية': 'Moroccan Salad',
  'خبز مغربي': 'Moroccan Bread',
  'لحم مفروم': 'Minced Meat',
};

// ── Single words ────────────────────────────────────────────────────────────
const CURATED_WORDS = {
  // drinks
  'شاي': 'Tea', 'قهوة': 'Coffee', 'كرك': 'Karak', 'نسكافيه': 'Nescafé',
  'كابتشينو': 'Cappuccino', 'لاتيه': 'Latte', 'اسبريسو': 'Espresso',
  'شوكولاتة': 'Chocolate', 'شوكولا': 'Chocolate', 'حليب': 'Milk', 'لبن': 'Laban',
  'زبادي': 'Yogurt', 'عصير': 'Juice', 'برتقال': 'Orange', 'ليمون': 'Lemon',
  'مانجو': 'Mango', 'فراولة': 'Strawberry', 'رمان': 'Pomegranate',
  'افوكادو': 'Avocado', 'أفوكادو': 'Avocado', 'تفاح': 'Apple', 'موز': 'Banana',
  'اناناس': 'Pineapple', 'أناناس': 'Pineapple', 'كوكتيل': 'Cocktail',
  'ماء': 'Water', 'مياه': 'Water', 'بيبسي': 'Pepsi', 'كولا': 'Cola',
  'نعناع': 'Mint', 'زعفران': 'Saffron', 'قرفة': 'Cinnamon',
  'زنجبيل': 'Ginger', 'هيل': 'Cardamom', 'سانتي': 'Santé',
  // proteins / mains
  'دجاج': 'Chicken', 'لحم': 'Meat', 'لحمة': 'Meat', 'غنم': 'Lamb',
  'شاورما': 'Shawarma', 'برجر': 'Burger', 'برغر': 'Burger', 'بيتزا': 'Pizza',
  'ساندوتش': 'Sandwich', 'سندويتش': 'Sandwich', 'ساندويتش': 'Sandwich',
  'شطيرة': 'Sandwich', 'كباب': 'Kebab', 'كفتة': 'Kofta', 'ريش': 'Ribs',
  'مشوي': 'Grilled', 'مشويات': 'Grills', 'مقلي': 'Fried', 'شيش': 'Shish',
  'طاووق': 'Tawook', 'فيليه': 'Fillet', 'ستيك': 'Steak', 'اسكالوب': 'Escalope',
  'مفروم': 'Minced',
  // rice / grains
  'ارز': 'Rice', 'أرز': 'Rice', 'بخاري': 'Bukhari', 'كبسة': 'Kabsa',
  'مندي': 'Mandi', 'مضغوط': 'Madghout', 'برياني': 'Biryani', 'مظبي': 'Madhbi',
  'كسكس': 'Couscous', 'كسكسي': 'Couscous', 'طاجن': 'Tagine', 'طاجين': 'Tagine',
  'برغل': 'Bulgur', 'فريك': 'Freekeh', 'مقلوبة': 'Maqluba',
  // soups / salads / appetizers
  'شوربة': 'Soup', 'حساء': 'Soup', 'حريرة': 'Harira', 'عدس': 'Lentil',
  'سلطة': 'Salad', 'فتوش': 'Fattoush', 'تبولة': 'Tabbouleh', 'زيتون': 'Olives',
  'حمص': 'Hummus', 'متبل': 'Mutabbal', 'مقبلات': 'Appetizers',
  'كبة': 'Kibbeh', 'سمبوسة': 'Samosa', 'فطاير': 'Fatayer', 'بسطيلة': 'Pastilla',
  'بطاطس': 'Fries', 'بطاطا': 'Potato', 'زعتر': 'Zaatar',
  // pastries / desserts
  'بقلاوة': 'Baklava', 'كنافة': 'Kunafa', 'حرشة': 'Harcha', 'مسمن': 'Msemen',
  'بغرير': 'Baghrir', 'شباكية': 'Chebakia', 'حلوى': 'Sweets', 'حلويات': 'Desserts',
  'كيك': 'Cake', 'كعك': 'Cake', 'معجنات': 'Pastries', 'فطيرة': 'Pie',
  'كريب': 'Crêpe', 'وافل': 'Waffle', 'ايسكريم': 'Ice Cream',
  'مهلبية': 'Mahalabia', 'خبز': 'Bread', 'رغيف': 'Loaf',
  // descriptors / sizes
  'كبير': 'Large', 'كبيرة': 'Large', 'وسط': 'Medium', 'متوسط': 'Medium',
  'صغير': 'Small', 'صغيرة': 'Small', 'عائلي': 'Family', 'فردي': 'Single',
  'مزدوج': 'Double', 'حار': 'Spicy', 'حاره': 'Spicy', 'بارد': 'Cold',
  'ساخن': 'Hot', 'طازج': 'Fresh', 'خاص': 'Special', 'كلاسيك': 'Classic',
  'دبل': 'Double', 'جامبو': 'Jumbo', 'ميني': 'Mini', 'ربع': 'Quarter',
  'نص': 'Half', 'نصف': 'Half', 'كامل': 'Full', 'قطعة': 'Piece', 'حبة': 'Piece',
  'علبة': 'Box', 'بوكس': 'Box', 'وجبة': 'Meal', 'كومبو': 'Combo', 'عرض': 'Combo',
  // adjectives / origin
  'مغربي': 'Moroccan', 'مغربية': 'Moroccan', 'عربي': 'Arabic', 'عربية': 'Arabic',
  'سعودي': 'Saudi', 'عراقي': 'Iraqi', 'شامي': 'Levantine', 'تركي': 'Turkish',
  'انجليزي': 'English', 'إنجليزي': 'English', 'ايطالي': 'Italian',
  'اخضر': 'Green', 'أخضر': 'Green', 'خضراء': 'Green', 'احمر': 'Red', 'أحمر': 'Red',
  'ابيض': 'White', 'أبيض': 'White', 'اسود': 'Black', 'أسود': 'Black',
  'طبيعي': 'Natural', 'طبيعة': 'Nature',
  'اضافة': 'Add-on', 'إضافة': 'Add-on', 'اضافات': 'Add-ons', 'إضافات': 'Add-ons',
  'صوص': 'Sauce', 'جبن': 'Cheese', 'جبنة': 'Cheese', 'بيض': 'Egg',
  'خضار': 'Vegetables', 'دايت': 'Diet', 'مشروب': 'Drink', 'مشروبات': 'Drinks',
  // connectors
  'مع': 'with', 'بدون': 'without', 'و': '&', 'او': 'or', 'أو': 'or',
};

// Generated vocabulary first, hand-curated LAST so a curated correction always
// overrides the generated entry for the same Arabic key.
const PHRASES = Object.assign({}, GENERATED_PHRASES, CURATED_PHRASES);
const WORDS = Object.assign({}, GENERATED_WORDS, CURATED_WORDS);

// ── Category labels (for menu.category / category_en if ever backfilled) ────
const CATEGORIES = {
  'عام': 'General',
  'الإضافات': 'Add-ons',
  'الاضافات': 'Add-ons',
  'البرغر': 'Burgers',
  'البرجر': 'Burgers',
  'الحلويات': 'Desserts',
  'السلطات': 'Salads',
  'السندويتشات': 'Sandwiches',
  'السندوتشات': 'Sandwiches',
  'الشوربات': 'Soups',
  'الطواجن': 'Tagines',
  'العصائر': 'Juices',
  'الكسكس': 'Couscous',
  'المشاوي': 'Grills',
  'المشروبات الباردة': 'Cold Drinks',
  'المشروبات الساخنة': 'Hot Drinks',
  'المعجنات': 'Pastries',
  'المقبلات': 'Appetizers',
  'المشروبات': 'Drinks',
  'الوجبات': 'Meals',
  'العروض': 'Combos',
  'الأرز': 'Rice',
  'المقليات': 'Fried',
};

// English words that are ADJECTIVES in menu names. Arabic writes them after the
// noun; English before. Used only to re-order single-word lookups (see below) —
// keep this list to genuine descriptors, never nouns.
const ADJECTIVES = new Set([
  'Large', 'Medium', 'Small', 'Family', 'Single', 'Double', 'Jumbo', 'Mini',
  'Half', 'Quarter', 'Full', 'Spicy', 'Hot', 'Cold', 'Iced', 'Frozen', 'Fresh',
  'Special', 'Classic', 'Grilled', 'Fried', 'Roasted', 'Baked', 'Smoked',
  'Crispy', 'Mixed', 'Natural', 'Diet', 'Moroccan', 'Arabic', 'Saudi', 'Iraqi',
  'Levantine', 'Turkish', 'English', 'Italian', 'Indian', 'Green', 'Red',
  'White', 'Black', 'Minced',
]);

const DIACRITICS = /[ً-ْٰـ]/g; // harakat + tatweel
const AR_RE = /[؀-ۿ]/;
// NUL-delimited slot: item names legitimately contain digits ("بقلاوة 1134"),
// so a bare-number placeholder would be clobbered by the real number.
const SLOT_RE = /@@(\d+)@@/g;
const SLOT_TOKEN_RE = /^@@\d+@@$/;
const slotFor = (idx) => ' @@' + idx + '@@ ';

function normalizeAr(s) {
  return String(s == null ? '' : s).replace(DIACRITICS, '').replace(/\s+/g, ' ').trim();
}

// Phrase keys pre-normalized and sorted longest-first (specific beats generic).
const PHRASE_ENTRIES = Object.keys(PHRASES)
  .map((k) => [normalizeAr(k), PHRASES[k]])
  .sort((a, b) => b[0].length - a[0].length);

function titleCase(s) {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w && /[a-z]/.test(w[0]) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Translate one Arabic menu item name to English.
 *
 * @param {string} raw                 the Arabic name (menu.name)
 * @param {(w:string)=>string} [translit]  fallback for unknown Arabic tokens
 * @returns {{text:string, matched:number, total:number}}
 *          text    — the English name (Latin script; '' when raw is empty)
 *          matched — how many terms the DICTIONARY resolved
 *          total   — translatable terms seen (matched + transliterated)
 */
function translateMenuName(raw, translit) {
  const s0 = normalizeAr(raw);
  if (!s0) return { text: '', matched: 0, total: 0 };
  if (!AR_RE.test(s0)) return { text: s0, matched: 0, total: 0 }; // already Latin

  let s = s0;
  const slots = [];
  for (const [key, val] of PHRASE_ENTRIES) {
    if (key && s.includes(key)) {
      const idx = slots.length;
      slots.push(val);
      s = s.split(key).join(slotFor(idx));
    }
  }
  let matched = slots.length;
  let total = slots.length;

  const parts = s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (SLOT_TOKEN_RE.test(w)) return { text: w, adj: false }; // phrase placeholder
      if (!AR_RE.test(w)) return { text: w, adj: false }; // number / already-Latin token
      total++;
      if (WORDS[w] != null) {
        matched++;
        return { text: WORDS[w], adj: ADJECTIVES.has(WORDS[w]) };
      }
      // definite article fallback: "الدجاج" → "دجاج"
      if (w.startsWith('ال') && WORDS[w.slice(2)] != null) {
        matched++;
        const v = WORDS[w.slice(2)];
        return { text: v, adj: ADJECTIVES.has(v) };
      }
      return { text: typeof translit === 'function' ? translit(w) : w, adj: false };
    });

  // Arabic puts the adjective AFTER the noun ("حريرة مغربية", "شاورما صغير");
  // English puts it before. Move trailing single-word adjectives to the front,
  // preserving their relative order → "Moroccan Harira", "Small Shawarma".
  // Only words resolved from the single-word dictionary are eligible, so a
  // multi-word phrase translation is never re-ordered.
  const lead = [];
  while (parts.length > 1 && parts[parts.length - 1].adj) lead.unshift(parts.pop());
  const ordered = lead.concat(parts);

  const out = ordered
    .map((p) => p.text)
    .join(' ')
    .replace(SLOT_RE, (_, i) => slots[Number(i)])
    .replace(/\s*&\s*/g, ' & ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // menu.name_en is VARCHAR(200) — never propose something that cannot fit.
  return { text: titleCase(out).slice(0, 200), matched, total };
}

/** English label for an Arabic category, or null when unknown. */
function translateCategory(raw) {
  const key = normalizeAr(raw);
  return CATEGORIES[key] || null;
}

module.exports = { translateMenuName, translateCategory, PHRASES, WORDS, CATEGORIES };
