'use strict';
/**
 * lib/inventory-ar-dictionary.js — curated ENGLISH→ARABIC dictionary for
 * INVENTORY ITEM names (`inv_items`).
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE EXISTING WORKER
 *
 * `lib/menu-en-dictionary.js` translates Arabic→English for `menu`. This is
 * the mirror image, for a different table and a different defect: the owner's
 * `inv_items` rows carry ENGLISH text in the Arabic-name column (`name`) with
 * `name_en` empty — «Cup Holder 2», «A-31 Cold Drinks 30oz 900ML Laser Logo
 * Black». So the catalogue shows English under «الاسم (عربي)» and a
 * «الاسم الإنجليزي مفقود» badge beside it. The existing worker cannot help:
 * it reads `menu`, and it translates the other way.
 *
 * DESIGN
 *
 * Longest-phrase-first, then single words, then untouched passthrough. A token
 * this dictionary does not know is LEFT IN ENGLISH rather than transliterated:
 * «Cup Holder A-31» must not become «كب هولدر A-31». Half-translated is a
 * legible product name; transliterated is noise that no one can search.
 *
 * MEASUREMENTS, CODES AND COLOURS ARE PRESERVED VERBATIM. `30oz`, `900ML`,
 * `A-31`, `1100` identify the physical SKU on a shelf and in a supplier's
 * catalogue; translating or reformatting them would break the only thing that
 * ties a row to the box it came in.
 *
 * CONTRACT: pure. No DB, no network, no side effects. The caller owns writes.
 */

/** Multi-word phrases — matched first, longest first. */
const PHRASES = [
  ['cup holder', 'حامل أكواب'],
  ['cup carrier', 'حامل أكواب'],
  ['cold drinks', 'مشروبات باردة'],
  ['hot drinks', 'مشروبات ساخنة'],
  ['cold cup', 'كوب بارد'],
  ['hot cup', 'كوب ساخن'],
  ['paper cup', 'كوب ورقي'],
  ['plastic cup', 'كوب بلاستيك'],
  ['double wall', 'جدار مزدوج'],
  ['single wall', 'جدار مفرد'],
  ['laser logo', 'شعار ليزر'],
  ['printed logo', 'شعار مطبوع'],
  ['flat lid', 'غطاء مسطح'],
  ['dome lid', 'غطاء مقبب'],
  ['sip lid', 'غطاء برشفة'],
  ['paper bag', 'كيس ورقي'],
  ['plastic bag', 'كيس بلاستيك'],
  ['carrier bag', 'كيس حمل'],
  ['food container', 'علبة طعام'],
  ['take away', 'سفري'],
  ['takeaway', 'سفري'],
  ['ice cream', 'آيس كريم'],
  ['whipping cream', 'كريمة خفق'],
  ['condensed milk', 'حليب مكثف'],
  ['coffee beans', 'حبوب قهوة'],
  ['green tea', 'شاي أخضر'],
  ['black tea', 'شاي أسود'],
  ['orange juice', 'عصير برتقال'],
  ['mineral water', 'مياه معدنية'],
  ['wooden stirrer', 'محرّك خشبي'],
  ['plastic spoon', 'ملعقة بلاستيك'],
  ['plastic fork', 'شوكة بلاستيك'],
  ['wet wipes', 'مناديل مبللة'],
  ['cleaning powder', 'مسحوق تنظيف'],
  ['dish soap', 'صابون أطباق'],
  ['hand soap', 'صابون يدين'],
  ['trash bag', 'كيس نفايات'],
  ['garbage bag', 'كيس نفايات'],
  ['aluminium foil', 'ورق ألومنيوم'],
  ['aluminum foil', 'ورق ألومنيوم'],
  ['cling film', 'نايلون تغليف'],
  ['stretch film', 'نايلون تغليف'],
  ['gift box', 'علبة هدايا'],
  // Head-final English compounds — see NOUNS below for why these must be
  // phrases rather than two word lookups.
  ['napkin pack', 'عبوة مناديل'],
  ['tissue box', 'علبة مناديل'],
  ['straw pack', 'عبوة شواليم'],
  ['glove box', 'علبة قفازات'],
  ['coffee filter', 'فلتر قهوة'],
  ['water bottle', 'قارورة مياه'],
  ['sugar sachet', 'ظرف سكر'],
  ['salt sachet', 'ظرف ملح'],
  ['spoon pack', 'عبوة ملاعق'],
  ['cup sleeve', 'غلاف أكواب'],
  ['lid pack', 'عبوة أغطية'],
  ['bag roll', 'لفة أكياس'],
  ['foil roll', 'لفة ألومنيوم'],
  ['receipt roll', 'لفة فواتير'],
  ['thermal roll', 'لفة حرارية'],
];

/**
 * Nouns that can head a compound. English is head-FINAL («napkin pack» = a
 * pack of napkins); Arabic is head-INITIAL («عبوة مناديل»). Every entry in
 * PHRASES already bakes that flip in — «cup holder» → «حامل أكواب» — but the
 * single-word fallback translates left-to-right and so emits «منديل عبوة»,
 * which is both words correct and the phrase wrong.
 *
 * Word order cannot be fixed generically without parsing, so instead it is
 * REPORTED: two or more of these arriving via the word path (not a phrase)
 * means the order is unverified, and the caller marks the row for review
 * rather than shipping it as if it were known-good.
 */
const NOUNS = new Set([
  'cup', 'cups', 'holder', 'carrier', 'lid', 'lids', 'straw', 'straws',
  'napkin', 'napkins', 'tissue', 'bag', 'bags', 'box', 'boxes', 'carton',
  'sleeve', 'wrap', 'tray', 'trays', 'plate', 'plates', 'bowl', 'bowls',
  'spoon', 'spoons', 'fork', 'knife', 'stirrer', 'stick', 'roll', 'pack',
  'packet', 'set', 'piece', 'pieces', 'filter', 'cover', 'glove', 'gloves',
  'logo', 'bottle', 'sachet',
]);

/** Single tokens. */
const WORDS = {
  cup: 'كوب', cups: 'أكواب',
  holder: 'حامل', carrier: 'حامل',
  lid: 'غطاء', lids: 'أغطية',
  straw: 'شاليموه', straws: 'شواليم',
  napkin: 'منديل', napkins: 'مناديل', tissue: 'مناديل',
  bag: 'كيس', bags: 'أكياس',
  box: 'علبة', boxes: 'علب', carton: 'كرتون',
  sleeve: 'غلاف', wrap: 'غلاف',
  tray: 'صينية', trays: 'صواني',
  plate: 'طبق', plates: 'أطباق',
  bowl: 'وعاء', bowls: 'أوعية',
  spoon: 'ملعقة', spoons: 'ملاعق',
  fork: 'شوكة', knife: 'سكين',
  stirrer: 'محرّك', stick: 'عود',
  drinks: 'مشروبات', drink: 'مشروب', beverage: 'مشروب',
  coffee: 'قهوة', tea: 'شاي', juice: 'عصير', water: 'مياه', milk: 'حليب',
  sugar: 'سكر', salt: 'ملح', syrup: 'شراب', sauce: 'صلصة',
  chocolate: 'شوكولاتة', vanilla: 'فانيليا', caramel: 'كراميل',
  cream: 'كريمة', cheese: 'جبن', butter: 'زبدة',
  flour: 'دقيق', rice: 'أرز', oil: 'زيت',
  logo: 'شعار', laser: 'ليزر', printed: 'مطبوع', plain: 'سادة',
  paper: 'ورقي', plastic: 'بلاستيك', glass: 'زجاج', wooden: 'خشبي',
  black: 'أسود', white: 'أبيض', blue: 'أزرق', red: 'أحمر', green: 'أخضر',
  brown: 'بني', yellow: 'أصفر', gold: 'ذهبي', silver: 'فضي', clear: 'شفاف',
  small: 'صغير', medium: 'وسط', large: 'كبير', mini: 'صغير', jumbo: 'كبير',
  cold: 'بارد', hot: 'ساخن', frozen: 'مجمّد', fresh: 'طازج',
  cleaning: 'تنظيف', soap: 'صابون', gloves: 'قفازات', glove: 'قفاز',
  cover: 'غطاء', filter: 'فلتر', roll: 'لفة', pack: 'عبوة', packet: 'عبوة',
  set: 'طقم', piece: 'قطعة', pieces: 'قطع',
};

/**
 * A token that must survive UNTRANSLATED: a measurement, a size, a supplier
 * code, or anything containing a digit. `30oz`, `900ML`, `A-31`, `1100`,
 * `12x500`. These are the identity of the physical SKU.
 */
function isPreserved(token) {
  return /\d/.test(token)
    || /^(oz|ml|l|kg|g|gm|cm|mm|pcs|pc|ctn|box|xl|xxl)$/i.test(token);
}

/**
 * Translate an English inventory-item name to Arabic.
 *
 * @returns {{ ar: string, matched: number, tokens: number, untranslated: string[],
 *             wordOrderRisk: boolean }}
 *   `matched` / `tokens` let the caller judge how much real translation
 *   happened, so a mostly-untranslated name can be flagged for review instead
 *   of shipped as if it were correct. `wordOrderRisk` marks a compound whose
 *   ORDER is unverified even though every word was translated — see NOUNS.
 */
function toArabic(englishName) {
  const original = String(englishName == null ? '' : englishName).trim();
  if (!original) return { ar: '', matched: 0, tokens: 0, untranslated: [] };

  let work = ' ' + original.toLowerCase() + ' ';
  const slots = [];

  // 1. Phrases, longest first, into @@n@@ slots that cannot collide with the
  //    digits a real product name contains.
  const byLen = [...PHRASES].sort((a, b) => b[0].length - a[0].length);
  for (const [en, ar] of byLen) {
    const needle = ' ' + en + ' ';
    let i;
    while ((i = work.indexOf(needle)) !== -1) {
      slots.push(ar);
      work = work.slice(0, i) + ' @@' + (slots.length - 1) + '@@ ' + work.slice(i + needle.length);
    }
  }

  // 2. Word-by-word over the ORIGINAL casing, so preserved codes keep it.
  const originalTokens = original.split(/\s+/);
  const lowerWork = work.trim().split(/\s+/);
  const out = [];
  const untranslated = [];
  const wordPathNouns = [];
  let matched = slots.length;
  let oi = 0;

  for (const tok of lowerWork) {
    const slot = /^@@(\d+)@@$/.exec(tok);
    if (slot) {
      out.push(slots[Number(slot[1])]);
      // A phrase consumed 2+ original tokens; advance past them.
      const phraseLen = (byLen.find(([, ar]) => ar === slots[Number(slot[1])]) || ['', ''])[0].split(' ').length;
      oi += phraseLen;
      continue;
    }
    // Recover the token with its original casing when the positions line up.
    const raw = originalTokens[oi] !== undefined && originalTokens[oi].toLowerCase() === tok
      ? originalTokens[oi] : tok;
    oi += 1;

    if (isPreserved(raw)) { out.push(raw); continue; }
    const clean = tok.replace(/[^a-z]/g, '');
    if (WORDS[clean]) {
      out.push(WORDS[clean]);
      matched += 1;
      if (NOUNS.has(clean)) wordPathNouns.push(clean);
      continue;
    }
    out.push(raw);
    if (/[a-z]/i.test(raw)) untranslated.push(raw);
  }

  return {
    ar: out.join(' ').replace(/\s+/g, ' ').trim(),
    matched,
    tokens: lowerWork.length,
    untranslated,
    // Two nouns translated individually = a compound this dictionary does not
    // know, emitted in English order. Every word is right; the phrase may not
    // be. Surfaced, never silently shipped.
    wordOrderRisk: wordPathNouns.length >= 2,
  };
}

/** True when a string carries no Arabic letters — i.e. it is not Arabic text. */
function isLatinOnly(s) {
  const v = String(s == null ? '' : s);
  if (!v.trim()) return false;
  return !/[؀-ۿ]/.test(v) && /[A-Za-z]/.test(v);
}

module.exports = { toArabic, isLatinOnly, PHRASES, WORDS, NOUNS, isPreserved };
