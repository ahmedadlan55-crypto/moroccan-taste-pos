// Comprehensive COA numbering validator.
// Checks:
//   1. Every child stays inside its parent's declared numeric namespace
//   2. Every child's level = parent's level + 1
//   3. parentCode points to an existing account (no orphans)
//   4. No duplicate codes
//   5. Root accounts have empty parentCode + level 1
//   6. Folders contain children; leaves don't
//   7. Account type matches parent type
//   8. Canonical template is bilingual and follows the app's six-digit policy
//   9. Exactly five IFRS presentation classes are present. This is an internal
//      governance policy, not a claim that Saudi regulation mandates a code set.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'db', 'coa-template.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const byCode = {};
const errors = [];

// Pass 1: build index + duplicate detection
data.forEach((a, i) => {
  if (!/^\d{6}$/.test(String(a.code || ''))) {
    errors.push(`[CODE-FORMAT] code "${a.code}" must be exactly six numeric digits in the canonical template`);
  }
  if (!String(a.nameAr || '').trim()) errors.push(`[NAME-AR] "${a.code}" is missing its Arabic name`);
  if (!String(a.nameEn || '').trim()) errors.push(`[NAME-EN] "${a.code}" is missing its English name`);
  if (!Number.isInteger(a.level) || a.level < 1 || a.level > 5) {
    errors.push(`[LEVEL-RANGE] "${a.code}" has level ${a.level}; canonical depth is 1..5`);
  }
  if (byCode[a.code]) {
    errors.push(`[DUP] code "${a.code}" appears at index ${byCode[a.code]._idx} and ${i}`);
  }
  byCode[a.code] = Object.assign({ _idx: i }, a);
});

// Pass 2: parent existence + numeric namespace + level + type. A root owns
// its GG class. Every lower folder must reserve a namespace by ending in at
// least one zero; its children must begin with the significant prefix before
// those zeroes. This catches both a child hung under the wrong sibling group
// and a folder code that leaves no namespace for children.
function _stripTrailingZeros(s) { return String(s || '').replace(/0+$/, ''); }
data.forEach((a, i) => {
  // Root check
  if (!a.parentCode) {
    if (a.level !== 1) errors.push(`[LEVEL] root "${a.code}" has level ${a.level}, expected 1`);
    // Roots must end in all-zeros for the GGMMPP convention
    if (String(a.code).length === 6 && !/^(10|20|30|40|50)0000$/.test(String(a.code))) {
      errors.push(`[ROOT-FORMAT] root "${a.code}" should be GG0000 (10/20/30/40/50 + 0000)`);
    }
    return;
  }
  // Parent must exist
  const p = byCode[a.parentCode];
  if (!p) {
    errors.push(`[ORPHAN] "${a.code}" (${a.nameAr}) parentCode="${a.parentCode}" does NOT exist`);
    return;
  }
  // Root owns its whole GG class; lower folders own their significant prefix.
  const childCode  = String(a.code || '');
  const parentCode = String(a.parentCode || '');
  const namespace = p.level === 1 ? parentCode.slice(0, 2) : _stripTrailingZeros(parentCode);
  if (p.level > 1 && p.kind === 'folder' && namespace === parentCode) {
    errors.push(`[PARENT-NAMESPACE] folder "${p.code}" (${p.nameAr}) reserves no trailing-zero namespace for children`);
  }
  if (namespace && !childCode.startsWith(namespace)) {
    errors.push(`[CHILD-PREFIX] "${a.code}" (${a.nameAr}) is outside parent "${a.parentCode}" namespace "${namespace}"`);
  }
  // Level rule
  if (a.level !== (p.level || 0) + 1) {
    errors.push(`[LEVEL] "${a.code}" has level ${a.level}, parent "${a.parentCode}" level ${p.level} → expected ${p.level + 1}`);
  }
  // Type rule — child type must match parent type
  if (p.type && a.type !== p.type) {
    errors.push(`[TYPE] "${a.code}" (${a.nameAr}) type="${a.type}" but parent "${a.parentCode}" (${p.nameAr}) type="${p.type}"`);
  }
});

// Pass 3: folders with no children + leaves with children
const childrenOf = {};
data.forEach(a => {
  if (a.parentCode) {
    childrenOf[a.parentCode] = (childrenOf[a.parentCode] || 0) + 1;
  }
});
data.forEach(a => {
  const kids = childrenOf[a.code] || 0;
  if (a.kind === 'folder' && kids === 0) {
    errors.push(`[EMPTY-FOLDER] "${a.code}" (${a.nameAr}) declared as folder but has no children`);
  }
  if (a.kind === 'leaf' && kids > 0) {
    errors.push(`[LEAF-WITH-CHILDREN] "${a.code}" (${a.nameAr}) declared as leaf but has ${kids} children`);
  }
});

// Pass 4: this product's code-prefix policy. It is deliberately stated as an
// internal convention: IFRS/SOCPA govern recognition and presentation, not a
// universal Saudi account-numbering sequence.
const typeByFirstDigit = {
  '1': 'asset',
  '2': 'liability',
  '3': 'equity',
  '4': 'revenue',
  '5': 'expense'
};
data.forEach(a => {
  const first = String(a.code).charAt(0);
  const expected = typeByFirstDigit[first];
  if (expected && a.type !== expected) {
    errors.push(`[CONVENTION] "${a.code}" (${a.nameAr}) starts with ${first} → expected type "${expected}" but got "${a.type}"`);
  }
});

// The five roots and their terms are part of this product's accounting
// policy. In particular, "الالتزامات" is used consistently with the
// statement-of-financial-position language instead of the older "الخصوم".
const ROOT_POLICY = {
  '100000': { type: 'asset', nameAr: 'الأصول', nameEn: 'Assets' },
  '200000': { type: 'liability', nameAr: 'الالتزامات', nameEn: 'Liabilities' },
  '300000': { type: 'equity', nameAr: 'حقوق الملكية', nameEn: 'Equity' },
  '400000': { type: 'revenue', nameAr: 'الإيرادات', nameEn: 'Revenue' },
  '500000': { type: 'expense', nameAr: 'المصروفات (تشمل تكلفة المبيعات)', nameEn: 'Expenses (incl. COGS)' },
};
const roots = data.filter((a) => !a.parentCode);
if (roots.length !== 5) errors.push(`[ROOT-COUNT] expected exactly 5 canonical roots, found ${roots.length}`);
for (const [code, wanted] of Object.entries(ROOT_POLICY)) {
  const row = byCode[code];
  if (!row || row.parentCode) {
    errors.push(`[ROOT-POLICY] canonical root ${code} is missing or is not a root`);
    continue;
  }
  for (const key of ['type', 'nameAr', 'nameEn']) {
    if (row[key] !== wanted[key]) {
      errors.push(`[ROOT-POLICY] ${code}.${key} is "${row[key]}"; expected "${wanted[key]}"`);
    }
  }
}

// Output
console.log('═══════════════════════════════════════════════════════════════');
console.log('CoA validation report');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`Accounts:  ${data.length}`);
console.log(`Errors:    ${errors.length}`);
console.log('───────────────────────────────────────────────────────────────');
if (errors.length === 0) {
  console.log('✓ All numbering / hierarchy / type rules pass.');
  process.exit(0);
} else {
  // Group by error class
  const grouped = {};
  errors.forEach(e => {
    const tag = e.match(/^\[([^\]]+)\]/)[1];
    grouped[tag] = grouped[tag] || [];
    grouped[tag].push(e);
  });
  Object.keys(grouped).sort().forEach(k => {
    console.log(`\n── ${k} (${grouped[k].length}) ──`);
    grouped[k].forEach(e => console.log('  ' + e));
  });
  process.exit(1);
}
