# scripts/reporting

Read-only verification / reporting scripts. Nothing in this folder ever writes
to the database — every script is pure `SELECT` plus a JSON report under
`artifacts/`.

## verify-catalog-reconciliation.js

Post-check for the W1 legacy-materials reconciliation
(`scripts/reconcile-legacy-materials.js`). Proves:

1. no orphan `warehouse_stock.item_id` (LEFT JOIN to `inv_items` has zero misses)
2. Σqty invariant — the latest `artifacts/reconcile-*.json` per-item qty
   snapshot still matches current `SUM(warehouse_stock.qty)`, no NULL qty,
   every reconciled id exists in `inv_items`
3. no duplicate ids — `inv_items` case-collisions (`GROUP BY LOWER(id)`) and
   duplicate `(warehouse_id, item_id)` pairs in `warehouse_stock`
4. recipe references intact — `recipe.inv_item_id` and
   `bom_lines.component_item_id` all resolve
5. legacy = V2 parity — the `dashboard-summary` aggregate
   (`routes/inventory.js` `_warehousesSummary`) computed as one direct SUM
   equals the per-warehouse GROUP BY summed up; active-items-with-stock count
   matches both ways
6. reversibility — the latest reconcile artifact lists the inserted ids and
   reports how many stock rows a `--revert` would re-orphan (expected)
7. local guard — refuses non-local `DB_HOST`/`DATABASE_URL` unless
   `--allow-remote` is passed

```
node scripts/reporting/verify-catalog-reconciliation.js
```

Writes `artifacts/catalog-verify-<ts>.json`. Exit 0 only when every check
passes (1 = at least one FAIL, 2 = remote-host refusal).
