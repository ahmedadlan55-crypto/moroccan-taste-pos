// ═══════════════════════════════════════════════════════════════════
// pos-parity-seed.mjs — LOCAL dev data for the POS parity work.
//
// Seeds the LOCAL dev DB directly (no HTTP) with enough volume to prove
// the acceptance criteria that need scale:
//   • 2 brands / 3 branches (so company→brand→branch scoping is testable)
//   • ~2,000 menu items across 14 categories  (grid/virtualisation perf)
//   • ~400 of them carry a real base64 image  (image perf — the current
//     production shape, which the parity work replaces)
//   • cashier / manager / admin users
//   • ~60 customers
//
// Everything is tagged is_deleted=0 + id prefix 'SEED-' so it can be
// removed again with: node scripts/pos-parity-seed.mjs --clean
//
// Usage:  node scripts/pos-parity-seed.mjs [--clean] [--items=N] [--images=N]
// LOCAL ONLY — refuses to run when NODE_ENV=production.
// ═══════════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));

require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('REFUSING: this seed is local-only (NODE_ENV=production).');
  process.exit(1);
}

const db = require(path.join(ROOT, 'db', 'connection'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const CLEAN = process.argv.includes('--clean');
const N_ITEMS = arg('items', 2000);
const N_IMAGES = arg('images', 400);

const PREFIX = 'SEED-';

// ─── a real, valid PNG (not a fake string) so the browser actually decodes it ───
// Builds a w×h PNG by hand: IHDR + IDAT(zlib) + IEND.
// `rgb` is the base colour; `noise` adds per-pixel jitter so the image does NOT
// deflate down to ~400 bytes. A solid-colour PNG is useless for the perf test —
// real product photos are incompressible, and the whole point of this seed is to
// reproduce the weight that base64-in-catalog actually puts on the cashier network.
function pngDataUrl(w, h, rgb, noise = 0) {
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // raw scanlines: each row prefixed with filter byte 0
  // Deterministic PRNG so a re-seed produces byte-identical images (stable ETags).
  let s = 0x2f6e2b1 ^ (w * 31 + h * 17 + rgb[0]);
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) % 256; };
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        const jitter = noise ? ((rnd() - 128) * noise) / 128 : 0;
        raw[o++] = Math.max(0, Math.min(255, Math.round(rgb[c] + jitter * 110)));
      }
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

const CATEGORIES = [
  'المشاوي', 'الطواجن', 'الكسكس', 'السلطات', 'المقبلات', 'الشوربات',
  'السندويتشات', 'البرغر', 'المشروبات الساخنة', 'المشروبات الباردة',
  'العصائر', 'الحلويات', 'المعجنات', 'الإضافات',
];
const NAMES = [
  'دجاج مشوي', 'لحم مفروم', 'طاجين لحم', 'كسكس بالخضار', 'سلطة مغربية', 'حريرة',
  'بسطيلة', 'شاورما', 'برغر لحم', 'شاي بالنعناع', 'قهوة عربية', 'عصير برتقال',
  'كنافة', 'بقلاوة', 'مسمن', 'حرشة', 'زعتر', 'زيتون', 'خبز مغربي', 'أرز بخاري',
];

async function clean() {
  console.log('cleaning previous seed…');
  const tables = [
    ['menu', 'id'], ['customers', 'id'], ['branches', 'id'], ['brands', 'id'],
  ];
  for (const [t, col] of tables) {
    try {
      const [r] = await db.query(`DELETE FROM ${t} WHERE ${col} LIKE ?`, [PREFIX + '%']);
      console.log(`  - ${t}: ${r.affectedRows}`);
    } catch (e) { console.log(`  - ${t}: ${e.code}`); }
  }
  try {
    const [r] = await db.query('DELETE FROM users WHERE username IN (?,?,?)', ['seed_cashier', 'seed_manager', 'seed_admin']);
    console.log(`  - users: ${r.affectedRows}`);
  } catch (e) { console.log('  - users:', e.code); }
}

async function seed() {
  // ── brands ───────────────────────────────────────────────────────
  await db.query(
    `INSERT INTO brands (id, name, code, is_active) VALUES (?,?,?,1), (?,?,?,1)
     ON DUPLICATE KEY UPDATE name=VALUES(name)`,
    [PREFIX + 'BR-1', 'المذاق المغربي', 'MT', PREFIX + 'BR-2', 'نكهة الأطلس', 'ATL']
  );
  console.log('brands: 2');

  // ── branches (3, across 2 brands, so scoping is testable) ────────
  const branches = [
    [PREFIX + 'BRANCH-1', 'الفرع الرئيسي', 'B1', 'الرياض — حي العليا', 'main', PREFIX + 'BR-1', 'مؤسسة المذاق المغربي للتجارة'],
    [PREFIX + 'BRANCH-2', 'فرع الملز', 'B2', 'الرياض — حي الملز', 'branch', PREFIX + 'BR-1', 'مؤسسة المذاق المغربي للتجارة'],
    [PREFIX + 'BRANCH-3', 'فرع جدة', 'B3', 'جدة — حي الروضة', 'branch', PREFIX + 'BR-2', 'شركة نكهة الأطلس'],
  ];
  for (const b of branches) {
    await db.query(
      `INSERT INTO branches (id, name, code, location, type, brand_id, company_name, is_active)
       VALUES (?,?,?,?,?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name)`, b
    );
  }
  console.log('branches: 3');

  // ── users ────────────────────────────────────────────────────────
  const hash = bcrypt.hashSync('Seed#12345', 10);
  const users = [
    ['seed_admin', 'admin'], ['seed_manager', 'manager'], ['seed_cashier', 'cashier'],
  ];
  for (const [username, role] of users) {
    await db.query(
      `INSERT INTO users (username, password, role, active, brand_id, branch_id, default_branch_id, full_name)
       VALUES (?,?,?,1,?,?,?,?)
       ON DUPLICATE KEY UPDATE role=VALUES(role), password=VALUES(password),
         brand_id=VALUES(brand_id), branch_id=VALUES(branch_id), default_branch_id=VALUES(default_branch_id)`,
      [username, hash, role, PREFIX + 'BR-1', PREFIX + 'BRANCH-1', PREFIX + 'BRANCH-1', username]
    );
  }
  console.log('users: 3 (seed_admin / seed_manager / seed_cashier — pw Seed#12345)');

  // ── menu items ───────────────────────────────────────────────────
  const imgCache = new Map();
  const rows = [];
  for (let i = 0; i < N_ITEMS; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const base = NAMES[i % NAMES.length];
    const id = `${PREFIX}ITEM-${String(i + 1).padStart(5, '0')}`;
    const price = Math.round((8 + (i % 90) + (i % 7) * 0.5) * 100) / 100;

    let img = null;
    if (i < N_IMAGES) {
      // ~120×120 solid-colour PNG — realistic thumbnail weight for the
      // CURRENT base64-in-catalog shape this work is meant to replace.
      const key = i % 24;
      if (!imgCache.has(key)) {
        const rgb = [(key * 37) % 256, (key * 91) % 256, (key * 53) % 256];
        imgCache.set(key, pngDataUrl(220, 220, rgb, 1));
      }
      img = imgCache.get(key);
    }

    rows.push([
      id, `${base} ${i + 1}`, price, cat, price * 0.4, 500, 10, 1, 'S',
      `${base} ${i + 1} EN`, 'حبة', PREFIX + 'BR-1', img, 1, 0,
    ]);
  }

  // chunked bulk insert (base64 payload makes single-statement inserts huge)
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO menu
        (id, name, price, category, cost, stock, min_stock, active, tax_category,
         name_en, unit, brand_id, image_data, is_tax_inclusive, is_deleted)
       VALUES ${slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
       ON DUPLICATE KEY UPDATE name=VALUES(name), price=VALUES(price)`,
      slice.flat()
    );
    if ((i / CHUNK) % 5 === 0) process.stdout.write(`\r  menu: ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log(`\rmenu: ${rows.length} items (${N_IMAGES} with images)      `);

  // ── customers ────────────────────────────────────────────────────
  const custCols = await db.query('SHOW COLUMNS FROM customers').then(([r]) => r.map((c) => c.Field));
  const has = (c) => custCols.includes(c);
  for (let i = 0; i < 60; i++) {
    const id = `${PREFIX}CUST-${String(i + 1).padStart(4, '0')}`;
    const cols = ['id', 'name'];
    const vals = [id, `عميل تجريبي ${i + 1}`];
    if (has('phone')) { cols.push('phone'); vals.push('05' + String(10000000 + i)); }
    if (has('is_active')) { cols.push('is_active'); vals.push(1); }
    await db.query(
      `INSERT INTO customers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
       ON DUPLICATE KEY UPDATE name=VALUES(name)`, vals
    );
  }
  console.log('customers: 60');
}

(async () => {
  try {
    if (CLEAN) { await clean(); console.log('\nclean done.'); process.exit(0); }
    await clean();
    await seed();
    const [[m]] = await db.query('SELECT COUNT(*) c FROM menu');
    const [[im]] = await db.query('SELECT COUNT(*) c FROM menu WHERE image_data IS NOT NULL AND image_data<>""');
    const [[avg]] = await db.query('SELECT ROUND(AVG(LENGTH(image_data))) b FROM menu WHERE image_data IS NOT NULL AND image_data<>""');
    console.log(`\n=== SEEDED ===  menu=${m.c}  withImage=${im.c}  avgImageBytes=${avg.b}`);
    process.exit(0);
  } catch (e) {
    console.error('SEED FAILED:', e.message);
    process.exit(1);
  }
})();
