// Semantic audit of the CoA tree.
// Walks the entire hierarchy and reports anomalies vs. accounting conventions.
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'coa-template.json'), 'utf8'));
const byCode = {};
data.forEach(a => byCode[a.code] = a);

// Print as indented tree for visual inspection
function lvl(a) { return '  '.repeat((a.level || 1) - 1); }

console.log('═══════════════════════════════════════════════════════════════');
console.log('CoA HIERARCHY DUMP (' + data.length + ' accounts)');
console.log('═══════════════════════════════════════════════════════════════\n');

// Group children by parent so we can print in tree order
const childrenOf = {};
data.forEach(a => {
  const p = a.parentCode || '__root__';
  childrenOf[p] = childrenOf[p] || [];
  childrenOf[p].push(a);
});
Object.keys(childrenOf).forEach(k => {
  childrenOf[k].sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }));
});

function walk(parentCode, depth) {
  (childrenOf[parentCode] || []).forEach(a => {
    const tag = a.kind === 'folder' ? '📁' : '  ';
    const typ = a.type.padEnd(9);
    console.log('  '.repeat(depth) + tag + ' ' + a.code.padEnd(6) + ' [' + typ + '] ' + (a.nameAr || ''));
    walk(a.code, depth + 1);
  });
}
walk('__root__', 0);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('TOP-LEVEL CODE CONVENTION CHECK');
console.log('═══════════════════════════════════════════════════════════════');
const tops = data.filter(a => !a.parentCode).sort((a,b)=>a.code.localeCompare(b.code));
tops.forEach(t => console.log('  ' + t.code + ' = ' + t.nameAr + ' (' + t.type + ')'));
