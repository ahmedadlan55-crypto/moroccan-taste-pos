// Comprehensive COA numbering validator.
// Checks:
//   1. Every child's code starts with its parent's code (strict hierarchy)
//   2. Every child's level = parent's level + 1
//   3. parentCode points to an existing account (no orphans)
//   4. No duplicate codes
//   5. Root accounts have empty parentCode + level 1
//   6. Folders contain children; leaves don't
//   7. Account type matches parent type
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'db', 'coa-template.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const byCode = {};
const errors = [];

// Pass 1: build index + duplicate detection
data.forEach((a, i) => {
  if (byCode[a.code]) {
    errors.push(`[DUP] code "${a.code}" appears at index ${byCode[a.code]._idx} and ${i}`);
  }
  byCode[a.code] = Object.assign({ _idx: i }, a);
});

// Pass 2: parent existence + prefix + level + type
data.forEach((a, i) => {
  // Root check
  if (!a.parentCode) {
    if (a.level !== 1) errors.push(`[LEVEL] root "${a.code}" has level ${a.level}, expected 1`);
    return;
  }
  // Parent must exist
  const p = byCode[a.parentCode];
  if (!p) {
    errors.push(`[ORPHAN] "${a.code}" (${a.nameAr}) parentCode="${a.parentCode}" does NOT exist`);
    return;
  }
  // Prefix rule — child code must start with parent code
  if (!String(a.code).startsWith(String(a.parentCode))) {
    errors.push(`[PREFIX] "${a.code}" (${a.nameAr}) is under parent "${a.parentCode}" (${p.nameAr}) but code does not start with parent's code`);
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

// Pass 4: code prefix sanity for top-level numbering convention
// Standard: 1=Assets, 2=Liabilities, 3=Equity, 4=Revenue, 5=COGS, 6=OpEx
const typeByFirstDigit = {
  '1': 'asset',
  '2': 'liability',
  '3': 'equity',
  '4': 'revenue',
  '5': 'expense',  // COGS
  '6': 'expense',  // OpEx
  '7': 'expense'   // Other (or revenue)
};
data.forEach(a => {
  const first = String(a.code).charAt(0);
  const expected = typeByFirstDigit[first];
  if (expected && a.type !== expected && !(first === '7')) {
    errors.push(`[CONVENTION] "${a.code}" (${a.nameAr}) starts with ${first} → expected type "${expected}" but got "${a.type}"`);
  }
});

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
