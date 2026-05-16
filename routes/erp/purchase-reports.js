// ═══════════════════════════════════════════════════════════════════
// /api/erp/purchase-reports — Purchase analytics
//
// Aggregates received purchases by ?reportType=:
//   • bySupplier      — per supplier: invoice count + total qty + total amount
//   • byItem          — per item: total qty + total amount + avg price + supplier count
//   • bySupplierItem  — per (supplier, item) pair
//   • detailed        — flat list of every purchased line
//
// Optional filters: ?startDate=, ?endDate=, ?supplierId=, ?itemId=.
// Only purchases with status='received' are included.
// ═══════════════════════════════════════════════════════════════════
const router = require('express').Router();
const db = require('../../db/connection');

router.get('/purchase-reports', async (req, res) => {
  try {
    const { startDate, endDate, supplierId, itemId, reportType } = req.query;
    let where = "p.status = 'received'";
    const params = [];
    if (startDate) { where += ' AND DATE(p.purchase_date) >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND DATE(p.purchase_date) <= ?'; params.push(endDate); }
    if (supplierId) { where += ' AND p.supplier_id = ?'; params.push(supplierId); }

    const [purchases] = await db.query(
      `SELECT p.id, p.purchase_date, p.supplier_name, p.supplier_id, p.total_price, p.items_json
       FROM purchases p WHERE ${where} ORDER BY p.purchase_date DESC`, params
    );

    // Parse items from each purchase
    const allItems = [];
    purchases.forEach(function(p) {
      const items = JSON.parse(p.items_json || '[]');
      items.forEach(function(it) {
        if (itemId && (it.id || it.itemId) !== itemId) return;
        allItems.push({
          date: p.purchase_date, supplierId: p.supplier_id, supplierName: p.supplier_name,
          itemId: it.id || it.itemId || '', itemName: it.name || it.itemName || '',
          qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice || it.price) || 0,
          total: (Number(it.qty)||0) * (Number(it.unitPrice || it.price)||0),
          unit: it.unit || ''
        });
      });
    });

    let result = {};
    const type = reportType || 'bySupplier';

    if (type === 'bySupplier') {
      const grouped = {};
      allItems.forEach(function(it) {
        if (!grouped[it.supplierName]) grouped[it.supplierName] = { supplier: it.supplierName, totalQty: 0, totalAmount: 0, invoiceCount: 0, items: [] };
        grouped[it.supplierName].totalQty += it.qty;
        grouped[it.supplierName].totalAmount += it.total;
        grouped[it.supplierName].items.push(it);
      });
      // Count unique purchase dates per supplier
      Object.values(grouped).forEach(function(g) {
        g.invoiceCount = new Set(g.items.map(function(i) { return String(i.date).substring(0,10); })).size;
      });
      result = { type: 'bySupplier', rows: Object.values(grouped), totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    } else if (type === 'byItem') {
      const grouped = {};
      allItems.forEach(function(it) {
        if (!grouped[it.itemName]) grouped[it.itemName] = { itemName: it.itemName, unit: it.unit, totalQty: 0, totalAmount: 0, avgPrice: 0, suppliers: new Set() };
        grouped[it.itemName].totalQty += it.qty;
        grouped[it.itemName].totalAmount += it.total;
        grouped[it.itemName].suppliers.add(it.supplierName);
      });
      Object.values(grouped).forEach(function(g) { g.avgPrice = g.totalQty > 0 ? g.totalAmount / g.totalQty : 0; g.supplierCount = g.suppliers.size; delete g.suppliers; });
      result = { type: 'byItem', rows: Object.values(grouped), totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    } else if (type === 'bySupplierItem') {
      const grouped = {};
      allItems.forEach(function(it) {
        var key = it.supplierName + '|' + it.itemName;
        if (!grouped[key]) grouped[key] = { supplierName: it.supplierName, itemName: it.itemName, unit: it.unit, totalQty: 0, totalAmount: 0 };
        grouped[key].totalQty += it.qty;
        grouped[key].totalAmount += it.total;
      });
      result = { type: 'bySupplierItem', rows: Object.values(grouped), totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    } else {
      // detailed — all items with date
      result = { type: 'detailed', rows: allItems, totalAmount: allItems.reduce(function(s,i){return s+i.total;},0) };
    }

    res.json(result);
  } catch(e) { res.json({ type: 'error', rows: [], totalAmount: 0, error: e.message }); }
});

module.exports = router;
