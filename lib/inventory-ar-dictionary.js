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

  // Food compounds. Same head-final/head-initial flip: «chicken breast» is a
  // BREAST of chicken, so Arabic leads with the cut — «صدور دجاج», not
  // «دجاج صدور». Word-by-word cannot know that.
  ['chicken breast', 'صدور دجاج'],
  ['chicken thigh', 'أفخاذ دجاج'],
  ['chicken thighs', 'أفخاذ دجاج'],
  ['chicken wings', 'أجنحة دجاج'],
  ['chicken wing', 'أجنحة دجاج'],
  ['chicken fillet', 'فيليه دجاج'],
  ['chicken liver', 'كبد دجاج'],
  ['chicken stock', 'مرقة دجاج'],
  ['whole chicken', 'دجاج كامل'],
  ['beef cubes', 'مكعبات لحم بقري'],
  ['beef mince', 'لحم بقري مفروم'],
  ['minced beef', 'لحم بقري مفروم'],
  ['ground beef', 'لحم بقري مفروم'],
  ['beef burger', 'برجر لحم'],
  ['lamb shank', 'موزة ضأن'],
  ['lamb chops', 'ريش ضأن'],
  ['tomato paste', 'معجون طماطم'],
  ['tomato sauce', 'صلصة طماطم'],
  ['olive oil', 'زيت زيتون'],
  ['corn oil', 'زيت ذرة'],
  ['sunflower oil', 'زيت دوار الشمس'],
  ['vegetable oil', 'زيت نباتي'],
  ['frying oil', 'زيت قلي'],
  ['sesame oil', 'زيت سمسم'],
  ['soy sauce', 'صلصة صويا'],
  ['hot sauce', 'صلصة حارة'],
  ['bbq sauce', 'صلصة باربكيو'],
  ['garlic sauce', 'صلصة ثوم'],
  ['baking powder', 'بيكنج بودر'],
  ['baking soda', 'بيكربونات الصوديوم'],
  ['bread crumbs', 'بقسماط'],
  ['french fries', 'بطاطس مقلية'],
  ['potato fries', 'بطاطس مقلية'],
  ['basmati rice', 'أرز بسمتي'],
  ['white rice', 'أرز أبيض'],
  ['egyptian rice', 'أرز مصري'],
  ['brown sugar', 'سكر بني'],
  ['icing sugar', 'سكر بودرة'],
  ['powdered sugar', 'سكر بودرة'],
  ['mozzarella cheese', 'جبن موزاريلا'],
  ['cheddar cheese', 'جبن شيدر'],
  ['cream cheese', 'جبن كريمي'],
  ['feta cheese', 'جبن فيتا'],
  ['cooking cream', 'كريمة طبخ'],
  ['fresh milk', 'حليب طازج'],
  ['powder milk', 'حليب بودرة'],
  ['milk powder', 'حليب بودرة'],
  ['green pepper', 'فلفل أخضر'],
  ['red pepper', 'فلفل أحمر'],
  ['black pepper', 'فلفل أسود'],
  ['bell pepper', 'فلفل رومي'],
  ['spring onion', 'بصل أخضر'],
  ['green onion', 'بصل أخضر'],
  ['lemon juice', 'عصير ليمون'],
  ['orange juice', 'عصير برتقال'],
  ['mineral water', 'مياه معدنية'],
  ['coffee beans', 'حبوب قهوة'],
  ['coffee powder', 'قهوة مطحونة'],
  ['ground coffee', 'قهوة مطحونة'],
  ['tea bags', 'أكياس شاي'],
  ['ice cubes', 'مكعبات ثلج'],

  // From the production log — compounds the head-noun flip cannot infer.
  ['dry lemon', 'لومي'],
  ['iced tea', 'شاي مثلج'],
  ['hot chocolate', 'شوكولاتة ساخنة'],
  ['green tea', 'شاي أخضر'],
  ['cinnamon powder', 'قرفة مطحونة'],
  ['ginger powder', 'زنجبيل مطحون'],
  ['garlic powder', 'ثوم مطحون'],
  ['onion powder', 'بصل مطحون'],
  ['cocoa powder', 'كاكاو بودرة'],
  ['peanut butter', 'زبدة فول سوداني'],
  ['passion fruit', 'باشن فروت'],
  ['blue berry', 'توت أزرق'],
  ['face mask', 'كمامة'],
  ['floor cleaner', 'منظّف أرضيات'],
  ['dish washing', 'غسيل أطباق'],
  ['hand wash', 'غسيل يدين'],
  ['dine in', 'صالة'],
  ['take out', 'سفري'],
  ['low fat', 'قليل الدسم'],
  ['full fat', 'كامل الدسم'],
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
  // containers and disposables
  'cup', 'cups', 'holder', 'carrier', 'lid', 'lids', 'straw', 'straws',
  'napkin', 'napkins', 'tissue', 'bag', 'bags', 'box', 'boxes', 'carton',
  'sleeve', 'wrap', 'tray', 'trays', 'plate', 'plates', 'bowl', 'bowls',
  'spoon', 'spoons', 'fork', 'knife', 'stirrer', 'stick', 'roll', 'pack',
  'packet', 'set', 'piece', 'pieces', 'filter', 'cover', 'glove', 'gloves',
  'logo', 'bottle', 'sachet', 'container', 'jar', 'can', 'tin', 'sack',
  // food heads — «chicken breast» has the same shape as «napkin pack»
  'breast', 'thigh', 'thighs', 'wing', 'wings', 'fillet', 'filet',
  'cube', 'cubes', 'strips', 'slice', 'slices', 'mince', 'patty',
  'liver', 'ribs', 'shank', 'bone', 'stock', 'broth', 'paste', 'puree',
  'sauce', 'oil', 'powder', 'juice', 'syrup', 'jam', 'crumbs',
  'block', 'slab', 'flakes',
]);

/**
 * Single tokens, grouped by domain.
 *
 * The first production run translated only 24 of 194 items fully: 115 came out
 * partial and 48 untranslated. The dictionary knew PACKAGING because that is
 * what the owner's screenshot happened to show — but the catalogue is a
 * restaurant's, and most of it is food. These groups are that correction.
 */
const WORD_GROUPS = [

  // ── Packaging and disposables ──────────────────────────────────────────
  {
    cup: 'كوب', cups: 'أكواب',
    holder: 'حامل', carrier: 'حامل',
    lid: 'غطاء', lids: 'أغطية',
    straw: 'شاليموه', straws: 'شواليم',
    napkin: 'منديل', napkins: 'مناديل', tissue: 'مناديل', tissues: 'مناديل',
    bag: 'كيس', bags: 'أكياس', sack: 'جوال',
    box: 'علبة', boxes: 'علب', carton: 'كرتون', cartons: 'كراتين',
    sleeve: 'غلاف', wrap: 'غلاف', wrapper: 'غلاف', film: 'نايلون',
    foil: 'ألومنيوم', cling: 'لاصق',
    tray: 'صينية', trays: 'صواني',
    plate: 'طبق', plates: 'أطباق',
    bowl: 'وعاء', bowls: 'أوعية',
    spoon: 'ملعقة', spoons: 'ملاعق',
    fork: 'شوكة', forks: 'شوك', knife: 'سكين', knives: 'سكاكين',
    stirrer: 'محرّك', stick: 'عود', sticks: 'أعواد', skewer: 'سيخ',
    container: 'علبة', containers: 'علب', jar: 'برطمان', tin: 'علبة',
    can: 'علبة', cans: 'علب', bottle: 'قارورة', bottles: 'قوارير',
    sachet: 'ظرف', sachets: 'أظرف', pouch: 'كيس',
    cover: 'غطاء', filter: 'فلتر', roll: 'لفة', rolls: 'لفات',
    pack: 'عبوة', packet: 'عبوة', packs: 'عبوات',
    set: 'طقم', piece: 'قطعة', pieces: 'قطع', unit: 'وحدة',
    label: 'ملصق', sticker: 'ملصق', receipt: 'فاتورة', thermal: 'حراري',
  },

  // ── Meat and poultry ───────────────────────────────────────────────────
  {
    chicken: 'دجاج', beef: 'لحم بقري', lamb: 'لحم ضأن', mutton: 'لحم غنم',
    veal: 'لحم عجل', meat: 'لحم', poultry: 'دواجن', turkey: 'ديك رومي',
    breast: 'صدور', thigh: 'أفخاذ', thighs: 'أفخاذ', wing: 'أجنحة',
    wings: 'أجنحة', drumstick: 'أوصال', drumsticks: 'أوصال',
    fillet: 'فيليه', filet: 'فيليه', mince: 'مفروم', minced: 'مفروم',
    // `ground` is deliberately NOT here. It means «مفروم» for meat and
    // «مطحون» for coffee and spices; both senses are covered by phrases
    // (`ground beef`, `ground coffee`), and the bare word is defined once
    // among the adjectives as the commoner «مطحون».
    cube: 'مكعبات', cubes: 'مكعبات', strips: 'شرائح',
    slice: 'شريحة', slices: 'شرائح', sliced: 'مشرّح',
    shawarma: 'شاورما', kofta: 'كفتة', kebab: 'كباب', sausage: 'نقانق',
    burger: 'برجر', patty: 'قرص', nugget: 'ناجت', nuggets: 'ناجت',
    bone: 'عظم', boneless: 'بلا عظم', skinless: 'بلا جلد', whole: 'كامل',
    liver: 'كبد', ribs: 'ريش', shank: 'موزة',
  },

  // ── Seafood ────────────────────────────────────────────────────────────
  {
    fish: 'سمك', shrimp: 'روبيان', prawn: 'روبيان', prawns: 'روبيان',
    tuna: 'تونة', salmon: 'سلمون', calamari: 'كاليماري', squid: 'حبار',
    crab: 'سلطعون', seafood: 'مأكولات بحرية', hammour: 'هامور',
  },

  // ── Vegetables and herbs ───────────────────────────────────────────────
  {
    onion: 'بصل', onions: 'بصل', tomato: 'طماطم', tomatoes: 'طماطم',
    potato: 'بطاطس', potatoes: 'بطاطس', carrot: 'جزر', carrots: 'جزر',
    garlic: 'ثوم', lettuce: 'خس', cucumber: 'خيار', cucumbers: 'خيار',
    pepper: 'فلفل', peppers: 'فلفل', capsicum: 'فلفل رومي',
    zucchini: 'كوسا', courgette: 'كوسا', eggplant: 'باذنجان',
    aubergine: 'باذنجان', cabbage: 'ملفوف', cauliflower: 'قرنبيط',
    broccoli: 'بروكلي', spinach: 'سبانخ', okra: 'بامية', peas: 'بازلاء',
    corn: 'ذرة', mushroom: 'فطر', mushrooms: 'فطر', olive: 'زيتون',
    olives: 'زيتون', pickle: 'مخلل', pickles: 'مخلل',
    parsley: 'بقدونس', coriander: 'كزبرة', cilantro: 'كزبرة',
    mint: 'نعناع', dill: 'شبت', rocket: 'جرجير', celery: 'كرفس',
    leek: 'كراث', beetroot: 'شمندر', turnip: 'لفت', pumpkin: 'يقطين',
    vegetable: 'خضار', vegetables: 'خضار', salad: 'سلطة',
  },

  // ── Fruit ──────────────────────────────────────────────────────────────
  {
    apple: 'تفاح', orange: 'برتقال', banana: 'موز', lemon: 'ليمون',
    lime: 'ليمون أخضر', strawberry: 'فراولة', mango: 'مانجو',
    pineapple: 'أناناس', grape: 'عنب', grapes: 'عنب', peach: 'خوخ',
    apricot: 'مشمش', pomegranate: 'رمان', watermelon: 'بطيخ',
    melon: 'شمام', kiwi: 'كيوي', date: 'تمر', dates: 'تمر',
    raisin: 'زبيب', raisins: 'زبيب', fig: 'تين', fruit: 'فواكه',
    berry: 'توت', berries: 'توت', coconut: 'جوز الهند', avocado: 'أفوكادو',
  },

  // ── Grains, bread, pasta ───────────────────────────────────────────────
  {
    rice: 'أرز', basmati: 'بسمتي', couscous: 'كسكس', bulgur: 'برغل',
    freekeh: 'فريكة', vermicelli: 'شعيرية', pasta: 'معكرونة',
    spaghetti: 'سباغيتي', noodles: 'نودلز', macaroni: 'مكرونة',
    flour: 'دقيق', semolina: 'سميد', starch: 'نشا', yeast: 'خميرة',
    bread: 'خبز', bun: 'صامولي', buns: 'صواميل', pita: 'خبز عربي',
    tortilla: 'تورتيلا', toast: 'توست', croissant: 'كرواسون',
    dough: 'عجين', pastry: 'معجنات', crumbs: 'بقسماط',
    oat: 'شوفان', oats: 'شوفان', wheat: 'قمح', barley: 'شعير',
    lentil: 'عدس', lentils: 'عدس', chickpea: 'حمص', chickpeas: 'حمص',
    bean: 'فول', beans: 'فاصوليا',
  },

  // ── Dairy and eggs ─────────────────────────────────────────────────────
  {
    milk: 'حليب', cheese: 'جبن', mozzarella: 'موزاريلا', cheddar: 'شيدر',
    feta: 'فيتا', halloumi: 'حلوم', kashkaval: 'قشقوان',
    cream: 'كريمة', yogurt: 'زبادي', yoghurt: 'زبادي', labneh: 'لبنة',
    butter: 'زبدة', ghee: 'سمن', margarine: 'مارجرين',
    egg: 'بيض', eggs: 'بيض', mayonnaise: 'مايونيز', mayo: 'مايونيز',
  },

  // ── Spices and seasoning ───────────────────────────────────────────────
  {
    salt: 'ملح', cumin: 'كمون', turmeric: 'كركم', paprika: 'بابريكا',
    cinnamon: 'قرفة', cardamom: 'هيل', ginger: 'زنجبيل', saffron: 'زعفران',
    clove: 'قرنفل', cloves: 'قرنفل', nutmeg: 'جوزة الطيب',
    oregano: 'أوريجانو', thyme: 'زعتر', rosemary: 'إكليل الجبل',
    basil: 'ريحان', bay: 'غار', sumac: 'سماق', sesame: 'سمسم',
    chili: 'شطة', chilli: 'شطة', curry: 'كاري', masala: 'ماسالا',
    spice: 'بهارات', spices: 'بهارات', seasoning: 'توابل',
    anise: 'يانسون', fennel: 'شمر', mustard: 'خردل',
  },

  // ── Sauces, oils, condiments ───────────────────────────────────────────
  {
    sauce: 'صلصة', ketchup: 'كاتشب', tahini: 'طحينة', harissa: 'هريسة',
    vinegar: 'خل', soy: 'صويا', paste: 'معجون', puree: 'بيوريه',
    oil: 'زيت', sunflower: 'دوار الشمس', frying: 'قلي', shortening: 'دهن نباتي',
    honey: 'عسل', jam: 'مربى', molasses: 'دبس', syrup: 'شراب',
    stock: 'مرقة', broth: 'مرقة', bouillon: 'مرقة', gravy: 'صلصة',
  },

  // ── Sweets, nuts, bakery ───────────────────────────────────────────────
  {
    sugar: 'سكر', chocolate: 'شوكولاتة', cocoa: 'كاكاو', vanilla: 'فانيليا',
    caramel: 'كراميل', custard: 'كاسترد', pudding: 'مهلبية',
    almond: 'لوز', almonds: 'لوز', walnut: 'جوز', walnuts: 'جوز',
    pistachio: 'فستق', cashew: 'كاجو', peanut: 'فول سوداني',
    hazelnut: 'بندق', nut: 'مكسرات', nuts: 'مكسرات',
    cake: 'كيك', biscuit: 'بسكوت', cookie: 'كوكيز', wafer: 'ويفر',
    baking: 'خبز', powder: 'بودرة', gelatin: 'جيلاتين',
  },

  // ── Beverages ──────────────────────────────────────────────────────────
  {
    drinks: 'مشروبات', drink: 'مشروب', beverage: 'مشروب', beverages: 'مشروبات',
    coffee: 'قهوة', espresso: 'إسبريسو', latte: 'لاتيه',
    cappuccino: 'كابتشينو', mocha: 'موكا', americano: 'أمريكانو',
    tea: 'شاي', juice: 'عصير', water: 'مياه', soda: 'مياه غازية',
    cola: 'كولا', concentrate: 'مركّز', ice: 'ثلج',
    decaf: 'منزوع الكافيين', instant: 'سريع الذوبان', brewed: 'مخمّر',
  },

  // ── Cleaning and consumables ───────────────────────────────────────────
  {
    cleaning: 'تنظيف', cleaner: 'منظّف', detergent: 'منظّف',
    soap: 'صابون', bleach: 'مبيّض', sanitizer: 'معقّم',
    disinfectant: 'مطهّر', degreaser: 'مزيل دهون',
    gloves: 'قفازات', glove: 'قفاز', apron: 'مريلة', hairnet: 'شبكة شعر',
    mop: 'ممسحة', broom: 'مكنسة', sponge: 'إسفنجة', scourer: 'ليفة',
    towel: 'منشفة', towels: 'مناشف', garbage: 'نفايات', trash: 'نفايات',
    waste: 'نفايات', refill: 'تعبئة', dishwash: 'غسيل أطباق',
    dishwashing: 'غسيل أطباق', handwash: 'غسيل يدين', liquid: 'سائل',
    foam: 'رغوة', spray: 'بخاخ', wipes: 'مناديل مبللة',
  },

  // ── Adjectives, colours, sizes, states ─────────────────────────────────
  {
    logo: 'شعار', laser: 'ليزر', printed: 'مطبوع', plain: 'سادة',
    paper: 'ورقي', plastic: 'بلاستيك', glass: 'زجاج', wooden: 'خشبي',
    metal: 'معدني', steel: 'ستيل', aluminium: 'ألومنيوم', aluminum: 'ألومنيوم',
    black: 'أسود', white: 'أبيض', blue: 'أزرق', red: 'أحمر', green: 'أخضر',
    brown: 'بني', yellow: 'أصفر', gold: 'ذهبي', silver: 'فضي',
    clear: 'شفاف', transparent: 'شفاف', natural: 'طبيعي',
    small: 'صغير', medium: 'وسط', large: 'كبير', mini: 'صغير',
    jumbo: 'كبير', regular: 'عادي', extra: 'إضافي', double: 'مزدوج',
    single: 'مفرد', long: 'طويل', short: 'قصير', thick: 'سميك', thin: 'رفيع',
    cold: 'بارد', hot: 'ساخن', frozen: 'مجمّد', chilled: 'مبرّد',
    fresh: 'طازج', dried: 'مجفف', dry: 'جاف', canned: 'معلّب',
    raw: 'خام', cooked: 'مطبوخ', smoked: 'مدخّن', roasted: 'محمّص',
    grilled: 'مشوي', fried: 'مقلي', crushed: 'مجروش', chopped: 'مقطّع',
    peeled: 'مقشّر', seedless: 'بلا بذور', organic: 'عضوي',
    sweet: 'حلو', sour: 'حامض', spicy: 'حار', salted: 'مملّح',
    unsalted: 'بلا ملح', light: 'خفيف', heavy: 'ثقيل',
    imported: 'مستورد', local: 'محلي', premium: 'ممتاز',
    block: 'قالب', slab: 'قالب', bulk: 'سائب', shredded: 'مبشور',
    grated: 'مبشور', ground: 'مطحون', granulated: 'محبب', flakes: 'رقائق',
  },

  // ── From the production log ────────────────────────────────────────────
  // The _v2 run printed the 84 words it could not translate. Most were BRAND
  // names — Davinci, Sante, Solo, Bounty, Kinza, Foody's — which correctly
  // stay English and are deliberately absent here. These are the rest.
  {
    // flavours and confectionery seen in the catalogue
    blueberry: 'توت أزرق', strawberry: 'فراولة', strwberry: 'فراولة',
    passion: 'باشن', hazelnut: 'بندق', pecan: 'بيكان',
    halawa: 'حلاوة', kunafa: 'كنافة', sahlab: 'سحلب', karak: 'كرك',
    karkadeh: 'كركديه', tart: 'تارت', waffle: 'وافل', wafer: 'ويفر',
    cookies: 'كوكيز', cookie: 'كوكيز', whipped: 'مخفوق', iced: 'مثلج',
    // the catalogue spells cheese both ways; both map to the same word, and
    // mergeWordGroups allows identical repeats
    cheese: 'جبن', chesse: 'جبن',
    // descriptors
    flavor: 'نكهة', flavour: 'نكهة', flavored: 'بنكهة', flavoured: 'بنكهة',
    classic: 'كلاسيك', crunchy: 'مقرمش', fine: 'ناعم', coarse: 'خشن',
    low: 'قليل', fat: 'دسم', fiber: 'ألياف', round: 'دائري',
    turkish: 'تركي', spanish: 'إسباني', french: 'فرنسي', italian: 'إيطالي',
    arabic: 'عربي', belgian: 'بلجيكي', english: 'إنجليزي',
    leaf: 'أوراق', leaves: 'أوراق', empty: 'فارغ', disposable: 'استخدام مرة',
    // equipment and non-food consumables
    dustpan: 'جاروف', cloth: 'قماش', mask: 'كمامة', face: 'وجه',
    printer: 'طابعة', sandwich: 'ساندويتش', fajita: 'فاهيتا',
    balls: 'كرات', ball: 'كرة', bites: 'قطع صغيرة', floor: 'أرضيات',
    // connectors — «Wafer roll coconut and chocolate» left an English `and`
    // sitting inside an otherwise Arabic name
    and: 'و', with: 'مع', per: 'لكل', plus: 'زائد',
  },
];

/**
 * Merge the groups into one lookup, REFUSING a silent overwrite.
 *
 * The groups were first written as arguments to Object.assign, where the last
 * duplicate quietly wins. `bean` was defined as «فول» under grains and again
 * as «حبة» under beverages, and every bean in the catalogue would have become
 * a coffee bean. Nothing would have reported it. A conflicting key is a
 * mistake in the dictionary, so it fails loudly at module load instead.
 *
 * Identical repeats are allowed — the same word legitimately belongs to two
 * domains — and only a DIFFERENT translation for the same key is an error.
 */
function mergeWordGroups(groups) {
  const out = Object.create(null);
  const clashes = [];
  for (const g of groups) {
    for (const k of Object.keys(g)) {
      if (k in out && out[k] !== g[k]) clashes.push(`${k}: «${out[k]}» vs «${g[k]}»`);
      out[k] = g[k];
    }
  }
  if (clashes.length) {
    throw new Error('inventory-ar-dictionary: conflicting word entries — ' + clashes.join(' · '));
  }
  return out;
}

const WORDS = mergeWordGroups(WORD_GROUPS);

/**
 * A token that must survive UNTRANSLATED: a measurement, a size, a supplier
 * code, or anything containing a digit. `30oz`, `900ML`, `A-31`, `1100`,
 * `12x500`. These are the identity of the physical SKU.
 */
function isPreserved(token) {
  return /\d/.test(token)
    // `box` was once in this list and so «Gathering Box» kept an English Box
    // in the middle of an Arabic name. A unit abbreviation only — never a word
    // that is also a real product noun.
    || /^(oz|ml|mls|l|ltr|ltrs|kg|kgs|g|gm|gr|grm|mg|cm|mm|pcs|pc|ctn|ctns|pkt|pkts|sch|schs|doz|xl|xxl)$/i.test(token);
}

/**
 * Nouns that head a compound and therefore must come FIRST in Arabic.
 *
 * A subset of NOUNS: these are the form/container words — «Pistachio Sauce»,
 * «Mango Juice», «Aluminium Foil Roll». English puts them last, Arabic puts
 * them first, and unlike an arbitrary noun pair the flip is mechanical, so
 * toArabic performs it rather than merely reporting it.
 *
 * Deliberately NOT every noun. «Chicken Breast» is also head-final, but which
 * of the two words is the head is a fact about meat, not about grammar, so
 * those stay in PHRASES where a human decided.
 */
const HEAD_NOUNS = new Set([
  'sauce', 'syrup', 'juice', 'puree', 'powder', 'paste', 'jam', 'stock',
  'broth', 'oil', 'roll', 'rolls', 'bag', 'bags', 'box', 'boxes',
  'bottle', 'bottles', 'can', 'cans', 'tin', 'jar', 'sachet', 'sachets',
  'pack', 'packs', 'packet', 'slice', 'slices', 'sleeve', 'cover', 'lid',
  'lids', 'tray', 'trays', 'plate', 'plates', 'bowl', 'bowls', 'cup',
  'cups', 'container', 'containers', 'block', 'flakes', 'crumbs',
  'set', 'refill', 'spray', 'liquid',
]);

/**
 * Tokens that join two SEPARATE things rather than modify one.
 *
 * «Pet Bottle & Cover» is a bottle AND a cover — two products in one row, not
 * a compound — so hoisting «cover» to the front produced «Pet غطاء قارورة &»,
 * which reads as a bottle-cover and strands the ampersand. A coordinator
 * between the first translated word and the trailing head means the structure
 * is unknown, so the flip stands down.
 */
const COORDINATORS = new Set([
  '&', '+', '/', ',', 'and', 'or', 'و', 'أو',
  // A standalone dash separates two segments of a name the same way — see
  // «Gathering Box - Aluminum Refill Bags», where hoisting the last head noun
  // across the dash produced «Gathering أكياس علبة - ...». A dash INSIDE a
  // token («A-31») is untouched: those are preserved codes, not tokens here.
  '-', '–', '—', '|',
]);

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

  // Track which emitted slots are translations (vs preserved codes and
  // untouched brand names), so the head-noun flip below can find them.
  const translatedAt = [];      // indices into `out`
  let trailingHead = null;      // index of a trailing head noun, if any
  let trailingNoun = false;
  let coordinatorAfterFirst = false;   // «X & Y» is two things, not a compound

  for (const tok of lowerWork) {
    const slot = /^@@(\d+)@@$/.exec(tok);
    if (slot) {
      translatedAt.push(out.length);
      out.push(slots[Number(slot[1])]);
      // A phrase consumed 2+ original tokens; advance past them.
      const phraseLen = (byLen.find(([, ar]) => ar === slots[Number(slot[1])]) || ['', ''])[0].split(' ').length;
      oi += phraseLen;
      trailingHead = null;      // a later phrase means the head is not trailing
      continue;
    }
    // Recover the token with its original casing when the positions line up.
    const raw = originalTokens[oi] !== undefined && originalTokens[oi].toLowerCase() === tok
      ? originalTokens[oi] : tok;
    oi += 1;

    if (isPreserved(raw)) { out.push(raw); continue; }   // measurements don't move
    const clean = tok.replace(/[^a-z]/g, '');
    if (translatedAt.length && (COORDINATORS.has(tok) || COORDINATORS.has(clean))) {
      coordinatorAfterFirst = true;
    }
    if (WORDS[clean]) {
      const hadTranslatedBefore = translatedAt.length > 0;
      translatedAt.push(out.length);
      if (NOUNS.has(clean)) {
        wordPathNouns.push(clean);
        if (hadTranslatedBefore) trailingNoun = true;
      }
      trailingHead = (hadTranslatedBefore && HEAD_NOUNS.has(clean)) ? out.length : null;
      out.push(WORDS[clean]);
      matched += 1;
      continue;
    }
    out.push(raw);
    trailingHead = null;
    if (/[a-z]/i.test(raw)) untranslated.push(raw);
  }

  // ── The head-noun flip ──────────────────────────────────────────────────
  // English is head-final, Arabic head-initial: «Pistachio Sauce» is a SAUCE
  // of pistachio, so Arabic leads with «صلصة». Move a trailing head noun to
  // the front of the translated run.
  //
  // In front of the TRANSLATED run, not of the whole name — «Sante Mango
  // Juice» must stay «Sante عصير مانجو». Hoisting past the brand would read
  // as if the juice were the brand.
  //
  // Measurements never move: they were skipped when `trailingHead` was set,
  // so «Pistachio Sauce 1kg» → «صلصة فستق 1kg».
  let reordered = false;
  if (trailingHead !== null && !coordinatorAfterFirst &&
      translatedAt.length >= 2 && trailingHead > translatedAt[0]) {
    const [head] = out.splice(trailingHead, 1);
    out.splice(translatedAt[0], 0, head);
    reordered = true;
  }

  return {
    ar: out.join(' ').replace(/\s+/g, ' ').trim(),
    matched,
    tokens: lowerWork.length,
    untranslated,
    reordered,
    // A noun that arrived through the single-word path and sits AFTER other
    // translated content is the shape of an unknown compound emitted in
    // English order: «Aluminium Foil Roll» → «ورق ألومنيوم لفة», where Arabic
    // wants «لفة ورق ألومنيوم».
    //
    // An earlier version required TWO word-path nouns, which missed exactly
    // this case — the phrase «aluminium foil» supplied the first noun, so only
    // one came through the word path and nothing was flagged. Position, not
    // count, is the signal.
    //
    // The flag stays set even when the flip above fired: reordering is a
    // heuristic about grammar, and a human reading 23 rows is cheap next to
    // shipping a wrong product name as if it were verified.
    wordOrderRisk: trailingNoun,
  };
}

/** True when a string carries no Arabic letters — i.e. it is not Arabic text. */
function isLatinOnly(s) {
  const v = String(s == null ? '' : s);
  if (!v.trim()) return false;
  return !/[؀-ۿ]/.test(v) && /[A-Za-z]/.test(v);
}

module.exports = {
  toArabic, isLatinOnly, isPreserved,
  PHRASES, WORDS, WORD_GROUPS, NOUNS, mergeWordGroups,
};
