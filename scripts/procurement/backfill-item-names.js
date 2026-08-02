#!/usr/bin/env node
'use strict';
/**
 * يملأ اسم الصنف على سطور أوامر الشراء والاستلام التي حُفظت بلا اسم.
 *
 * السبب: `po_lines.item_name` كان يؤخذ من العميل ويقع على '' عند غيابه، و
 * `purchase_receipt_lines` لم يكن فيه عمود اسم أصلًا. فالمستندات القائمة تعرض
 * الكود أو خانة فارغة. الإصلاح في المسارات يمنع تكرار ذلك للجديد، وهذا يعالج
 * ما وقع بالفعل.
 *
 * غير مُتلف: يكتب فقط حيث الاسم فارغ أو NULL، ولا يمسّ اسمًا محفوظًا — فقد
 * يكون لقطة صحيحة لصنف أُعيدت تسميته لاحقًا، وإعادة كتابته تزوير للتاريخ.
 *
 * التشغيل:
 *   node scripts/procurement/backfill-item-names.js            # تقرير فقط
 *   node scripts/procurement/backfill-item-names.js --apply
 */
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const APPLY = process.argv.includes('--apply');
const db = require('../../db/connection');

async function count(sql, params) {
  try { const [r] = await db.query(sql, params || []); return Number(r[0].n); }
  catch (e) { return null; }
}

async function main() {
  console.log(`backfill-item-names — ${APPLY ? 'APPLY' : 'DRY RUN (استخدم --apply للكتابة)'}`);

  const poBlank = await count(
    "SELECT COUNT(*) n FROM po_lines WHERE item_name IS NULL OR TRIM(item_name) = ''");
  console.log(`  po_lines بلا اسم: ${poBlank}`);

  let grnBlank = await count(
    "SELECT COUNT(*) n FROM purchase_receipt_lines WHERE item_name IS NULL OR TRIM(item_name) = ''");
  if (grnBlank === null) {
    console.log('  purchase_receipt_lines.item_name غير موجود — شغّل هجرة المشتريات أولًا');
    process.exit(2);
  }
  console.log(`  purchase_receipt_lines بلا اسم: ${grnBlank}`);

  if (!APPLY) {
    console.log('\nتشغيل جاف — لم يُكتب شيء.');
    process.exit(0);
  }

  // 1) سطور أمر الشراء ← سجلّ الأصناف
  const [r1] = await db.query(
    `UPDATE po_lines l JOIN inv_items i ON i.id = l.item_id
        SET l.item_name = i.name
      WHERE (l.item_name IS NULL OR TRIM(l.item_name) = '') AND i.name IS NOT NULL AND TRIM(i.name) <> ''`);
  console.log(`  po_lines من سجلّ الأصناف: ${r1.affectedRows}`);

  // 2) ما لا صنف له في السجلّ ← الكود، فخانة فارغة أسوأ من كود
  const [r2] = await db.query(
    "UPDATE po_lines SET item_name = item_id WHERE (item_name IS NULL OR TRIM(item_name) = '') AND item_id IS NOT NULL");
  console.log(`  po_lines رجعت للكود: ${r2.affectedRows}`);

  // 3) سطور الاستلام ← سطر أمر الشراء أولًا (لقطة وقت الشراء)
  const [r3] = await db.query(
    `UPDATE purchase_receipt_lines rl JOIN po_lines pl ON pl.id = rl.po_line_id
        SET rl.item_name = pl.item_name
      WHERE (rl.item_name IS NULL OR TRIM(rl.item_name) = '')
        AND pl.item_name IS NOT NULL AND TRIM(pl.item_name) <> ''`);
  console.log(`  purchase_receipt_lines من أمر الشراء: ${r3.affectedRows}`);

  // 4) ثم سجلّ الأصناف، ثم الكود
  const [r4] = await db.query(
    `UPDATE purchase_receipt_lines rl JOIN inv_items i ON i.id = rl.item_id
        SET rl.item_name = i.name
      WHERE (rl.item_name IS NULL OR TRIM(rl.item_name) = '') AND i.name IS NOT NULL AND TRIM(i.name) <> ''`);
  console.log(`  purchase_receipt_lines من سجلّ الأصناف: ${r4.affectedRows}`);
  const [r5] = await db.query(
    "UPDATE purchase_receipt_lines SET item_name = item_id WHERE (item_name IS NULL OR TRIM(item_name) = '') AND item_id IS NOT NULL");
  console.log(`  purchase_receipt_lines رجعت للكود: ${r5.affectedRows}`);

  const poLeft = await count("SELECT COUNT(*) n FROM po_lines WHERE item_name IS NULL OR TRIM(item_name) = ''");
  const grnLeft = await count("SELECT COUNT(*) n FROM purchase_receipt_lines WHERE item_name IS NULL OR TRIM(item_name) = ''");
  console.log(`\nالمتبقّي بلا اسم — po_lines: ${poLeft} | purchase_receipt_lines: ${grnLeft}`);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
