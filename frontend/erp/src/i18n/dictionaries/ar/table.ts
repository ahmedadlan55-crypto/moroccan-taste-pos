/** Chrome/copy for the shared tables kit (frontend/erp/src/shared/tables/*):
 *  DataTable, Pagination, FilterBar, BulkActionBar, ColumnsMenu, SavedViews.
 *  Data-* attribute contract values (e.g. data-state) stay English and are NOT
 *  here — only visible copy + aria labels. English mirror: en/table.ts. */
export const table = {
  // FilterBar
  searchPlaceholder: "بحث…",
  clearFilters: "مسح عوامل التصفية",
  tableActions: "إجراءات الجدول",
  // Pagination — "showing" / "of" split so the numeric range stays dir=ltr.
  showing: "عرض",
  of: "من",
  page: "صفحة",
  perPage: "{count} / صفحة",
  rowsPerPage: "عدد الصفوف بالصفحة",
  paginationNav: "ترقيم الصفحات",
  prevPage: "الصفحة السابقة",
  nextPage: "الصفحة التالية",
  // BulkActionBar
  itemNoun: "عنصر",
  bulkActions: "إجراءات مجمّعة",
  clearSelection: "إلغاء التحديد",
  selectedSuffix: "محدد",
  // ColumnsMenu
  columns: "الأعمدة",
  showColumns: "إظهار الأعمدة",
  // DataTable
  exportCsv: "تصدير CSV",
  selectRow: "تحديد الصف",
  selectAllRows: "تحديد كل الصفوف",
  openRowDetails: "فتح تفاصيل الصف",
  // SavedViews
  savedViews: {
    menu: "طرق العرض",
    ariaMenu: "طرق العرض المحفوظة",
    delete: "حذف: {name}",
    saveCurrent: "حفظ العرض الحالي…",
    saveTitle: "حفظ طريقة العرض",
    nameLabel: "اسم العرض",
    namePlaceholder: "مثال: الفواتير المتأخرة",
  },
} as const;
