/** English mirror of the shared tables-kit chrome. Keep the key set identical to
 *  ar/table.ts (enforced by the dictionary parity test). */
export const table = {
  // FilterBar
  searchPlaceholder: "Search…",
  clearFilters: "Clear filters",
  tableActions: "Table actions",
  // Pagination
  showing: "Showing",
  of: "of",
  page: "Page",
  perPage: "{count} / page",
  rowsPerPage: "Rows per page",
  paginationNav: "Pagination",
  prevPage: "Previous page",
  nextPage: "Next page",
  // BulkActionBar
  itemNoun: "item",
  bulkActions: "Bulk actions",
  clearSelection: "Clear selection",
  selectedSuffix: "selected",
  // ColumnsMenu
  columns: "Columns",
  showColumns: "Show columns",
  // DataTable
  exportCsv: "Export CSV",
  selectRow: "Select row",
  selectAllRows: "Select all rows",
  openRowDetails: "Open row details",
  // SavedViews
  savedViews: {
    menu: "Saved views",
    ariaMenu: "Saved views",
    delete: "Delete: {name}",
    saveCurrent: "Save current view…",
    saveTitle: "Save view",
    nameLabel: "View name",
    namePlaceholder: "e.g. Overdue invoices",
  },
} as const;
