#!/usr/bin/env node
/**
 * translate-menu-en.js — populate menu.name_en / menu.category_en (and
 * optionally inv_items.name_en) with English names for the English POS UI.
 *
 * WHY: the cashier UI now defaults to English (with an Arabic toggle). Menu
 * items display `name_en` when present, falling back to the Arabic `name`. This
 * script fills `name_en` for the whole catalogue in one pass using a curated
 * Moroccan/Saudi restaurant dictionary plus an Arabic→Latin transliteration
 * fallback for anything unmapped, so every item shows a Latin-script name.
 *
 * SAFE BY DEFAULT: only rows whose English name is EMPTY are touched. Nothing
 * that already has an English name is overwritten unless you pass --force.
 * The Arabic `name` (used on the ZATCA receipt) is NEVER modified.
 *
 * USAGE (from the project root, with the app's .env pointing at the target DB):
 *   node scripts/translate-menu-en.js            # fill empty name_en/category_en
 *   node scripts/translate-menu-en.js --dry-run  # preview, write nothing
 *   node scripts/translate-menu-en.js --force     # overwrite existing English too
 *   node scripts/translate-menu-en.js --inv       # also translate inv_items.name_en
 *
 * Review the preview (--dry-run) first, then run for real. You can always edit
 * any name afterwards in the ERP menu admin.
 */
const db = require('../db/connection');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run') || argv.includes('-n');
const FORCE = argv.includes('--force') || argv.includes('-f');
const DO_INV = argv.includes('--inv');

// ── Category dictionary (exact match on the whole category string) ───────────
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

// ── Phrase dictionary (multi-word; applied longest-first before word lookup) ──
const PHRASES = {
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
  'عصير برتقال': 'Orange Juice',
  'عصير ليمون': 'Lemon Juice',
  'عصير مانجو': 'Mango Juice',
  'عصير فراولة': 'Strawberry Juice',
  'عصير رمان': 'Pomegranate Juice',
  'عصير افوكادو': 'Avocado Juice',
  'عصير أفوكادو': 'Avocado Juice',
  'عصير تفاح': 'Apple Juice',
  'عصير كوكتيل': 'Cocktail Juice',
  'عصير ليمون نعناع': 'Lemon Mint Juice',
  'ليمون نعناع': 'Lemon Mint',
  'مشروب غازي': 'Soft Drink',
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
  'كسكس لحم': 'Meat Couscous',
  'كسكس دجاج': 'Chicken Couscous',
  'كسكس خضار': 'Vegetable Couscous',
  'البوكس المغربي': 'Moroccan Box',
  'بوكس مغربي': 'Moroccan Box',
  'مشروب الطبيعة': 'Nature Drink',
  'عصير سانتي': 'Santé Juice',
  'سلطة خضراء': 'Green Salad',
  'سلطة سيزر': 'Caesar Salad',
};

// ── Word dictionary ──────────────────────────────────────────────────────────
const WORDS = {
  // drinks
  'شاي': 'Tea', 'قهوة': 'Coffee', 'كرك': 'Karak', 'نسكافيه': 'Nescafé',
  'كابتشينو': 'Cappuccino', 'لاتيه': 'Latte', 'اسبريسو': 'Espresso',
  'شوكولاتة': 'Chocolate', 'شوكولا': 'Chocolate', 'حليب': 'Milk', 'لبن': 'Laban',
  'زبادي': 'Yogurt', 'عصير': 'Juice', 'برتقال': 'Orange', 'ليمون': 'Lemon',
  'مانجو': 'Mango', 'فراولة': 'Strawberry', 'رمان': 'Pomegranate',
  'افوكادو': 'Avocado', 'أفوكادو': 'Avocado', 'تفاح': 'Apple', 'موز': 'Banana',
  'اناناس': 'Pineapple', 'أناناس': 'Pineapple', 'كوكتيل': 'Cocktail',
  'ماء': 'Water', 'مياه': 'Water', 'بيبسي': 'Pepsi', 'كولا': 'Cola',
  'سفن': '7Up', 'ميرندا': 'Mirinda', 'سبرايت': 'Sprite', 'ريد': 'Red',
  'بول': 'Bull', 'نعناع': 'Mint', 'زعفران': 'Saffron', 'قرفة': 'Cinnamon',
  'زنجبيل': 'Ginger', 'هيل': 'Cardamom',
  // proteins / mains
  'دجاج': 'Chicken', 'لحم': 'Meat', 'لحمة': 'Meat', 'غنم': 'Lamb',
  'شاورما': 'Shawarma', 'برجر': 'Burger', 'برغر': 'Burger', 'بيتزا': 'Pizza',
  'ساندوتش': 'Sandwich', 'سندويتش': 'Sandwich', 'ساندويتش': 'Sandwich',
  'شطيرة': 'Sandwich', 'كباب': 'Kebab', 'كفتة': 'Kofta', 'ريش': 'Ribs',
  'مشوي': 'Grilled', 'مشويات': 'Grills', 'مقلي': 'Fried', 'شيش': 'Shish',
  'طاووق': 'Tawook', 'فيليه': 'Fillet', 'ستيك': 'Steak', 'اسكالوب': 'Escalope',
  // rice / grains
  'ارز': 'Rice', 'أرز': 'Rice', 'بخاري': 'Bukhari', 'كبسة': 'Kabsa',
  'مندي': 'Mandi', 'مضغوط': 'Madghout', 'برياني': 'Biryani', 'مظبي': 'Madhbi',
  'كسكس': 'Couscous', 'كسكسي': 'Couscous', 'طاجن': 'Tagine', 'طاجين': 'Tagine',
  'برغل': 'Bulgur', 'فريك': 'Freekeh', 'مقلوبة': 'Maqluba',
  // soups / salads / appetizers
  'شوربة': 'Soup', 'حساء': 'Soup', 'حريرة': 'Harira', 'عدس': 'Lentil',
  'سلطة': 'Salad', 'فتوش': 'Fattoush', 'تبولة': 'Tabbouleh', 'زيتون': 'Olives',
  'حمص': 'Hummus', 'متبل': 'Mutabbal', 'بابا': 'Baba', 'غنوج': 'Ghanoush',
  'مقبلات': 'Appetizers', 'كبة': 'Kibbeh', 'سمبوسة': 'Samosa', 'فطاير': 'Fatayer',
  'بطاطس': 'Fries', 'بطاطا': 'Potato',
  // pastries / desserts
  'بقلاوة': 'Baklava', 'كنافة': 'Kunafa', 'حرشة': 'Harcha', 'مسمن': 'Msemen',
  'بغرير': 'Baghrir', 'شباكية': 'Chebakia', 'حلوى': 'Sweets', 'حلويات': 'Desserts',
  'كيك': 'Cake', 'كعك': 'Cake', 'معجنات': 'Pastries', 'فطيرة': 'Pie',
  'كريب': 'Crêpe', 'وافل': 'Waffle', 'ايس': 'Ice', 'كريم': 'Cream',
  'ايسكريم': 'Ice Cream', 'مهلبية': 'Mahalabia', 'ارز بحليب': 'Rice Pudding',
  'خبز': 'Bread', 'رغيف': 'Loaf',
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
  'اخضر': 'Green', 'أخضر': 'Green', 'احمر': 'Red', 'أحمر': 'Red',
  'ابيض': 'White', 'أبيض': 'White', 'اسود': 'Black', 'أسود': 'Black',
  'طبيعي': 'Natural', 'طبيعة': 'Nature', 'الطبيعة': 'Nature', 'سانتي': 'Santé',
  'اضافة': 'Add-on', 'إضافة': 'Add-on', 'صوص': 'Sauce', 'جبن': 'Cheese',
  'جبنة': 'Cheese', 'بيض': 'Egg', 'خضار': 'Vegetables', 'دايت': 'Diet',
  // stopwords → English connectors
  'مع': 'with', 'بدون': 'without', 'و': '&', 'او': 'or', 'أو': 'or',
  'من': 'of', 'في': 'in', 'ال': '',
};

// Arabic → Latin transliteration (fallback for unmapped words). Diacritics and
// tatweel are stripped first; hamza/ta-marbuta handled pragmatically.
const TRANSLIT = {
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'aa', 'ب': 'b', 'ت': 't', 'ث': 'th',
  'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z',
  'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a',
  'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'و': 'w', 'ي': 'y', 'ى': 'a', 'ة': 'a', 'ء': '', 'ؤ': 'u',
  'ئ': 'e', 'پ': 'p', 'چ': 'ch', 'ژ': 'zh', 'گ': 'g',
};

const DIACRITICS = /[ً-ْٰـ]/g; // harakat + tatweel
function normalizeAr(s) {
  return String(s || '').replace(DIACRITICS, '').trim();
}
const AR_RE = /[؀-ۿ]/;

function transliterateWord(w) {
  let out = '';
  for (const ch of w) out += TRANSLIT[ch] != null ? TRANSLIT[ch] : (AR_RE.test(ch) ? '' : ch);
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : w;
}

function titleCase(s) {
  return s.replace(/\s+/g, ' ').trim().split(' ')
    .map((w) => (w && /[a-z]/.test(w[0]) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Translate one Arabic menu/category string to English. */
function translate(raw) {
  let s = normalizeAr(raw);
  if (!s) return '';
  if (!AR_RE.test(s)) return s; // already Latin/numeric — keep as-is

  // 1) phrase pass (longest first) → protect with placeholders
  const protectedParts = [];
  const phrases = Object.keys(PHRASES).sort((a, b) => b.length - a.length);
  for (const ph of phrases) {
    const nph = normalizeAr(ph);
    if (s.includes(nph)) {
      const token = `${protectedParts.length}`;
      protectedParts.push(PHRASES[ph]);
      s = s.split(nph).join(` ${token} `);
    }
  }

  // 2) word pass
  const words = s.split(/\s+/).filter(Boolean).map((w) => {
    if (/^\d+$/.test(w)) return w;         // protected phrase
    if (!AR_RE.test(w)) return w;                       // number / Latin token
    const key = normalizeAr(w);
    if (WORDS[key] != null) return WORDS[key];
    // strip leading definite article "ال"
    if (key.startsWith('ال') && WORDS[key.slice(2)] != null) return WORDS[key.slice(2)];
    return transliterateWord(key);
  });

  // 3) restore protected phrases
  let out = words.join(' ').replace(/(\d+)/g, (_, i) => protectedParts[Number(i)]);
  return titleCase(out).replace(/\s*&\s*/g, ' & ').replace(/\s{2,}/g, ' ').trim();
}

function isEmpty(v) {
  return v == null || String(v).trim() === '';
}

async function hasColumn(table, col) {
  const [c] = await db.query(
    'SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, col]);
  return c[0].n > 0;
}

async function run() {
  console.log(`translate-menu-en — ${DRY ? 'DRY RUN (no writes)' : 'LIVE'}${FORCE ? ', --force (overwrite existing)' : ''}`);

  // Ensure the columns exist (server startup adds them, but the script may run
  // standalone before the server has booted against this DB). In a real run this
  // adds them; in --dry-run it only reports — so the SELECT below is built from
  // the columns that ACTUALLY exist to stay valid either way.
  await ensureColumn('menu', 'name_en', 'VARCHAR(200) DEFAULT NULL');
  await ensureColumn('menu', 'category_en', 'VARCHAR(100) DEFAULT NULL');

  const hasNameEn = await hasColumn('menu', 'name_en');
  const hasCatEn = await hasColumn('menu', 'category_en');
  const sel = [
    'id', 'name', hasNameEn ? 'name_en' : 'NULL AS name_en',
    'category', hasCatEn ? 'category_en' : 'NULL AS category_en',
  ].join(', ');
  const [rows] = await db.query(`SELECT ${sel} FROM menu WHERE COALESCE(is_deleted,0)=0`);
  let nameCount = 0, catCount = 0, sample = 0;
  for (const r of rows) {
    const updates = {};
    if (FORCE || isEmpty(r.name_en)) {
      const en = translate(r.name);
      if (en && en !== r.name) { updates.name_en = en; nameCount++; }
    }
    if (FORCE || isEmpty(r.category_en)) {
      const cat = r.category || 'عام';
      const catEn = CATEGORIES[normalizeAr(cat)] || translate(cat);
      if (catEn && catEn !== cat) updates.category_en = catEn;
    }
    if (Object.keys(updates).length) {
      if (updates.category_en) catCount++;
      if (sample < 20) { console.log(`  ${r.name}  →  ${updates.name_en || r.name_en || '(kept)'}   [${r.category} → ${updates.category_en || '(kept)'}]`); sample++; }
      if (!DRY) {
        const sets = Object.keys(updates).map((k) => `${k}=?`).join(', ');
        await db.query(`UPDATE menu SET ${sets} WHERE id=?`, [...Object.values(updates), r.id]);
      }
    }
  }
  console.log(`menu: ${nameCount} names, ${catCount} categories ${DRY ? 'would be' : ''} set (of ${rows.length} rows).`);

  if (DO_INV) {
    await ensureColumn('inv_items', 'name_en', 'VARCHAR(200) DEFAULT NULL');
    const invSel = (await hasColumn('inv_items', 'name_en')) ? 'id, name, name_en' : 'id, name, NULL AS name_en';
    const [inv] = await db.query(`SELECT ${invSel} FROM inv_items`);
    let invCount = 0;
    for (const r of inv) {
      if (!(FORCE || isEmpty(r.name_en))) continue;
      const en = translate(r.name);
      if (en && en !== r.name) {
        invCount++;
        if (!DRY) await db.query('UPDATE inv_items SET name_en=? WHERE id=?', [en, r.id]);
      }
    }
    console.log(`inv_items: ${invCount} names ${DRY ? 'would be' : ''} set (of ${inv.length} rows).`);
  }

  console.log('Done. Review in the ERP menu admin; edit any name as needed.');
}

async function ensureColumn(table, col, ddl) {
  const [c] = await db.query(
    'SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
    [table, col]);
  if (!c[0].n) {
    if (DRY) { console.log(`  (would add ${table}.${col})`); return; }
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    console.log(`  added ${table}.${col}`);
  }
}

// Export the pure translator for tests/reuse.
module.exports = { translate, CATEGORIES, PHRASES, WORDS };

if (require.main === module) {
  run().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
