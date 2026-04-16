/**
 * API Bridge — replaces google.script.run with fetch() calls
 * Same interface: api.withSuccessHandler(fn).withFailureHandler(fn).functionName(args)
 */
(function() {
  const BASE = '/api';

  // Map GAS function names to REST endpoints
  const ROUTE_MAP = {
    // Auth
    checkLogin:          { method: 'POST', url: '/auth/login', body: (u,p) => ({username:u,password:p}) },
    refreshToken:        { method: 'POST', url: '/auth/refresh-token' },
    getInitialAppData:   { method: 'GET',  url: (u) => '/auth/init/'+u },

    // Menu
    getMenu:             { method: 'GET',  url: '/menu' },
    getMenuAll:          { method: 'GET',  url: '/menu/all' },
    addMenuItem:         { method: 'POST', url: '/menu' },
    updateMenuItem:      { method: 'PUT',  url: (d) => '/menu/'+d.id, body: (d) => d },
    updateMenuPrice:     { method: 'PATCH',url: (id,p) => '/menu/'+id+'/price', body: (id,p) => ({price:p}) },
    deleteMenuItem:      { method: 'DELETE',url: (id) => '/menu/'+id },
    importMenuItems:     { method: 'POST', url: '/menu/import' },
    getRecipes:          { method: 'GET',  url: '/menu/recipes' },
    saveRecipe:          { method: 'POST', url: (menuId,menuName,ings) => '/menu/recipes/'+menuId, body: (menuId,menuName,ings) => ({menuName,ingredients:ings}) },

    // Sales
    saveOrder:           { method: 'POST', url: '/sales', body: (order,user,shift) => ({...order,username:user,shiftId:shift}) },
    getSalesListDetailed:{ method: 'GET',  url: '/sales', query: (p) => p },
    getInvoice:          { method: 'GET',  url: (id) => '/sales/invoice/'+id },
    deleteSale:          { method: 'DELETE', url: (id) => '/sales/' + id },
    bulkDeleteSales:     { method: 'POST', url: '/sales/bulk-delete', body: (ids) => ({ids:ids}) },

    // Shifts
    openShift:           { method: 'POST', url: '/shifts/open', body: (u,d) => Object.assign({username:u}, d||{}) },
    startShift:          { method: 'POST', url: '/shifts/open', body: (u) => ({username:u}) },
    endShiftWithActuals: { method: 'POST', url: '/shifts/close', body: (id,u,c,cd,k) => ({shiftId:id,username:u,cash:c,card:cd,kita:k}) },
    getAllShifts:         { method: 'GET',  url: '/shifts' },
    getShiftDataForClosing: { method: 'GET', url: (id) => '/shifts/closing-data/'+id },

    // Inventory
    getInvItems:         { method: 'GET',  url: '/inventory/items' },
    saveInvItem:         { method: 'POST', url: '/inventory/items' },
    deleteInvItem:       { method: 'DELETE',url: (id) => '/inventory/items/'+id },
    importInvItems:      { method: 'POST', url: '/inventory/items/import' },
    updateStock:         { method: 'POST', url: '/inventory/stock-update', body: (itemId,qty,type,notes,username,reason) => ({itemId,qty,type,notes,username,reason,itemName:''}) },

    // Purchases
    getPurchases:        { method: 'GET',  url: '/purchases', query: (f) => f },
    addPurchaseBatch:    { method: 'POST', url: '/purchases' },
    receivePurchaseBatch:{ method: 'POST', url: (id,u,vat) => '/purchases/receive/'+id, body: (id,u,vat) => ({username:u,includesVAT:vat}) },
    revertReceivePurchase:{ method: 'POST', url: (id,u) => '/purchases/receive/'+id+'/revert', body: (id,u) => ({username:u}) },
    deletePurchase:      { method: 'DELETE',url: (id) => '/purchases/'+id },
    getPurchaseOrders:   { method: 'GET',  url: '/purchases/orders', query: (f) => f },
    createPurchaseOrder: { method: 'POST', url: '/purchases/orders', body: (d,u) => ({...d,username:u}) },
    updatePurchaseOrder: { method: 'PUT',  url: (id,d,u) => '/purchases/orders/'+id, body: (id,d,u) => ({...d,username:u}) },
    approvePurchaseOrder:{ method: 'POST', url: (id,u) => '/purchases/orders/'+id+'/approve', body: (id,u) => ({username:u}) },
    revertPurchaseOrder: { method: 'POST', url: (id,u) => '/purchases/orders/'+id+'/revert', body: (id,u) => ({username:u}) },
    deletePurchaseOrder: { method: 'DELETE', url: (id) => '/purchases/orders/'+id },
    getPOLines:          { method: 'GET',  url: (id) => '/purchases/orders/'+id+'/lines' },

    // Expenses
    getExpenses:         { method: 'GET',  url: '/expenses', query: (f) => f },
    addExpense:          { method: 'POST', url: '/expenses' },
    deleteExpense:       { method: 'DELETE',url: (id) => '/expenses/'+id },

    // Settings
    getCompanySettings:  { method: 'GET',  url: '/settings' },
    updateCompanySettings:{ method: 'PUT', url: '/settings' },
    getPaymentMethods:   { method: 'GET',  url: '/settings/payment-methods' },
    savePaymentMethods:  { method: 'PUT',  url: '/settings/payment-methods' },
    deletePaymentMethod: { method: 'DELETE', url: (id) => '/settings/payment-methods/' + id },
    setKitaServiceFeeRate:{ method: 'PUT', url: '/settings', body: (r) => ({KitaServiceFee:r}) },
    getDiscounts:        { method: 'GET',  url: '/settings/discounts' },
    getDiscountsV2:      { method: 'GET',  url: '/settings/discounts-v2' },
    saveDiscountV2:      { method: 'POST', url: '/settings/discounts-v2' },
    deleteDiscountV2:    { method: 'DELETE', url: (id) => '/settings/discounts-v2/' + id },
    getPaymentMethodsFull:{ method: 'GET', url: '/settings/payment-methods-full' },
    savePaymentMethodFull:{ method: 'POST', url: '/settings/payment-methods-full' },
    recomputeAllCosts:   { method: 'POST', url: '/settings/recompute-costs' },

    // ERP
    getERPDashboardData: { method: 'GET',  url: '/erp/dashboard' },
    getCustomers:        { method: 'GET',  url: '/erp/customers' },
    saveCustomer:        { method: 'POST', url: '/erp/customers' },
    deleteCustomer:      { method: 'DELETE',url: (id) => '/erp/customers/'+id },
    getSuppliers:        { method: 'GET',  url: '/erp/suppliers' },
    saveSupplier:        { method: 'POST', url: '/erp/suppliers' },
    deleteSupplier:      { method: 'DELETE',url: (id) => '/erp/suppliers/'+id },
    getGLAccounts:       { method: 'GET',  url: '/erp/gl/accounts' },
    saveGLAccount:       { method: 'POST', url: '/erp/gl/accounts' },
    deleteGLAccount:     { method: 'DELETE', url: (id) => '/erp/gl/accounts/' + id },
    getGLJournals:       { method: 'GET',  url: '/erp/gl/journals', query: (f) => f },
    createJournalEntry:  { method: 'POST', url: '/erp/gl/journals' },
    getGLEntries:        { method: 'GET',  url: (jid) => '/erp/gl/journals/'+jid+'/entries' },
    deleteGLJournal:     { method: 'DELETE', url: (id) => '/erp/gl/journals/' + id },
    approveGLJournal:    { method: 'POST', url: (id,u) => '/erp/gl/journals/' + id + '/approve', body: (id,u) => ({username:u}) },
    postGLJournal:       { method: 'POST', url: (id,u) => '/erp/gl/journals/' + id + '/post', body: (id,u) => ({username:u}) },
    getVATTransactions:  { method: 'GET',  url: '/erp/vat/transactions', query: (s,e) => ({startDate:s,endDate:e}) },
    postVATJournals:     { method: 'POST', url: '/erp/vat/post', body: (s,e,u) => ({startDate:s,endDate:e,username:u}) },
    closeVATQuarter:     { method: 'POST', url: '/erp/vat/close-quarter' },
    closeFinancialYear:  { method: 'POST', url: '/erp/vat/close-year' },
    getVATSummary:       { method: 'GET',  url: '/erp/vat/summary', query: (f) => f },
    getVATReports:       { method: 'GET',  url: '/erp/vat/reports' },
    createVATReport:     { method: 'POST', url: '/erp/vat/reports' },
    getTrialBalance:     { method: 'GET',  url: '/erp/reports/trial-balance', query: (f) => f },
    getIncomeStatement:  { method: 'GET',  url: '/erp/reports/income', query: (f) => f },
    getBalanceSheet:     { method: 'GET',  url: '/erp/reports/balance-sheet', query: (f) => f },

    // Users
    getAllUsernames:     { method: 'GET',  url: '/auth/users' },
    getUsers:            { method: 'GET',  url: '/auth/users' },
    addUser:             { method: 'POST', url: '/auth/users' },
    updateUser:          { method: 'PUT',  url: (u, d) => '/auth/users/' + u, body: (u, d) => d },
    toggleUserActive:    { method: 'POST', url: (u) => '/auth/users/' + u + '/toggle' },
    deleteUser:          { method: 'DELETE', url: (u) => '/auth/users/' + u },
    resetPassword:       { method: 'POST', url: (u,p) => '/auth/users/' + u + '/reset-password', body: (u,p) => ({password:p}) },
    resetDatabase:       { method: 'POST', url: '/auth/reset-db' },

    // Misc
    getDashboardSummary: { method: 'GET',  url: '/erp/dashboard' },
    testRecipeSaveAndRead: { method: 'GET', url: (id) => '/menu/recipes/debug/'+id },
    debugRecipes:        { method: 'GET',  url: '/menu/recipes/debug' },
    debugSuppliers:      { method: 'GET',  url: '/erp/suppliers/debug' },
    testSuppliers:       { method: 'GET',  url: '/erp/suppliers/debug' },
    seedCafeGLAccounts:  { method: 'POST', url: '/erp/gl/seed' },
    repairGLEntries:     { method: 'POST', url: '/erp/gl/repair' },
    diagnoseGL:          { method: 'GET',  url: '/erp/gl/diagnose' },
    getInventoryMethod:  { method: 'GET',  url: '/erp/inventory-method' },
    setInventoryMethod:  { method: 'POST', url: '/erp/inventory-method' },
    getInventoryValuation:{ method: 'GET', url: '/erp/inventory-valuation' },
    syncInventoryGL:     { method: 'POST', url: '/erp/gl/sync-inventory' },
    getAccountingPeriods:{ method: 'GET',  url: '/erp/periods' },
    getBranches:         { method: 'GET',  url: '/erp/branches' },
    saveBranch:          { method: 'POST', url: '/erp/branches' },
    getAuditLogs:        { method: 'GET',  url: '/erp/audit', query: (f) => f },
    getLiveInventory:    { method: 'GET',  url: '/inventory/live' },
    submitStocktake:     { method: 'POST', url: '/inventory/stocktakes', body: (items,u,n,whId,brId) => ({items:items,username:u,notes:n,warehouseId:whId||'',branchId:brId||''}) },
    getAllStocktakes:     { method: 'GET',  url: '/inventory/stocktakes' },
    getStocktakeDetail:  { method: 'GET',  url: (id) => '/inventory/stocktakes/' + id },
    deleteStocktake:     { method: 'DELETE', url: (id) => '/inventory/stocktakes/' + id },
    submitAdjustment:    { method: 'POST', url: '/inventory/adjustments', body: (d) => d },
    approveAdjustment:   { method: 'POST', url: (id,u) => '/inventory/adjustments/' + id + '/approve', body: (id,u) => ({username:u}) },
    getAllAdjustments:    { method: 'GET',  url: '/inventory/adjustments' },
    getAdjustmentDetail: { method: 'GET',  url: (id) => '/inventory/adjustments/' + id },
    deleteAdjustment:    { method: 'DELETE', url: (id) => '/inventory/adjustments/' + id },
    submitReceiveRequest: { method: 'POST', url: '/inventory/receive-request' },
    getReceiveRequests:  { method: 'GET',  url: '/inventory/receive-requests' },
    approveReceive:      { method: 'POST', url: (id,d) => '/inventory/receive-approve/' + id, body: (id,d) => d },
    createShortageRequest:{ method: 'POST', url: '/inventory/shortage-requests' },
    getShortageRequests: { method: 'GET',  url: '/inventory/shortage-requests' },
    getShortageRequest:  { method: 'GET',  url: (id) => '/inventory/shortage-requests/' + id },
    approveShortage:     { method: 'POST', url: (id,d) => '/inventory/shortage-requests/' + id + '/approve', body: (id,d) => d },
    rejectShortage:      { method: 'POST', url: (id,d) => '/inventory/shortage-requests/' + id + '/reject', body: (id,d) => d },
    convertShortageToPO: { method: 'POST', url: (id,d) => '/inventory/shortage-requests/' + id + '/convert-to-po', body: (id,d) => d },
    updateShortageRequest:{ method: 'PUT', url: (id,d) => '/inventory/shortage-requests/' + id, body: (id,d) => d },
    deleteShortageRequest:{ method: 'DELETE', url: (id) => '/inventory/shortage-requests/' + id },

    // Custody (العهد)
    getCustodyUsers:     { method: 'GET',  url: '/custody/users' },
    saveCustodyUser:     { method: 'POST', url: '/custody/users' },
    toggleCustodyUser:   { method: 'POST', url: (id) => '/custody/users/' + id + '/toggle' },
    getCustodies:        { method: 'GET',  url: '/custody/list' },
    createCustody:       { method: 'POST', url: '/custody/create' },
    getCustodyDetail:    { method: 'GET',  url: (id) => '/custody/' + id },
    topupCustody:        { method: 'POST', url: (id,d) => '/custody/' + id + '/topup', body: (id,d) => d },
    getCustodyExpenses:  { method: 'GET',  url: (id) => '/custody/' + id + '/expenses' },
    addCustodyExpense:   { method: 'POST', url: (id,d) => '/custody/' + id + '/expenses', body: (id,d) => d },
    approveCustodyExp:   { method: 'POST', url: (id,u) => '/custody/expenses/' + id + '/approve', body: (id,u) => ({username:u}) },
    rejectCustodyExp:    { method: 'POST', url: (id,u,r) => '/custody/expenses/' + id + '/reject', body: (id,u,r) => ({username:u,reason:r}) },
    postCustodyExp:      { method: 'POST', url: (id,u) => '/custody/expenses/' + id + '/post', body: (id,u) => ({username:u}) },
    getCustodyReport:    { method: 'GET',  url: (id) => '/custody/' + id + '/report' },
    getCustodyPending:   { method: 'GET',  url: '/custody/approval/pending' },
    getMyCustody:        { method: 'GET',  url: '/custody/my-custody', query: (u) => ({username:u}) },
    deleteCustodyUser:   { method: 'DELETE', url: (id) => '/custody/users/' + id },
    deleteCustody:       { method: 'DELETE', url: (id) => '/custody/' + id },
    closeCustodyRequest: { method: 'POST', url: (id,d) => '/custody/' + id + '/close-request', body: (id,d) => d },
    closeCustodyApprove: { method: 'POST', url: (id,u) => '/custody/' + id + '/close-approve', body: (id,u) => ({username:u}) },
    closeCustodyReject:  { method: 'POST', url: (id,u,r) => '/custody/' + id + '/close-reject', body: (id,u,r) => ({username:u,reason:r}) },
    approveOverrideExp:  { method: 'POST', url: (id,u) => '/custody/expenses/' + id + '/approve-override', body: (id,u) => ({username:u}) },
    deleteCustodyExp:    { method: 'DELETE', url: (id) => '/custody/expenses/' + id },
    returnCustodyExp:    { method: 'POST', url: (id,u,r) => '/custody/expenses/' + id + '/return', body: (id,u,r) => ({username:u,reason:r}) },
    updateCustodyExp:    { method: 'PUT',  url: (id,d) => '/custody/expenses/' + id, body: (id,d) => d },
    getCostCenters:      { method: 'GET',  url: '/erp/cost-centers' },
    saveCostCenter:      { method: 'POST', url: '/erp/cost-centers' },
    deleteCostCenter:    { method: 'DELETE', url: (id) => '/erp/cost-centers/' + id },
    getWarehousesList:   { method: 'GET',  url: '/erp/warehouses-list' },
    saveWarehouse:       { method: 'POST', url: '/erp/warehouses-list' },
    deleteWarehouse:     { method: 'DELETE', url: (id) => '/erp/warehouses-list/' + id },
    getWarehouseStockDetail: { method: 'GET', url: (id) => '/erp/warehouse-stock-detail/' + id },
    getWarehouseTransfers:{ method: 'GET', url: '/erp/warehouse-transfers' },
    createWarehouseTransfer:{ method: 'POST', url: '/erp/warehouse-transfers' },
    approveWarehouseTransfer:{ method: 'POST', url: (id,d) => '/erp/warehouse-transfers/' + id + '/approve', body: (id,d) => d },
    cancelWarehouseTransfer: { method: 'POST', url: (id) => '/erp/warehouse-transfers/' + id + '/cancel' },
    getTransferLines:        { method: 'GET',  url: (id) => '/erp/warehouse-transfer-lines/' + id },
    getBrandsStats:          { method: 'GET',  url: '/erp/brands-stats' },
    getBranchesFull:     { method: 'GET',  url: '/erp/branches-full' },
    saveBranchFull:      { method: 'POST', url: '/erp/branches-full' },
    getBrands:           { method: 'GET',  url: '/erp/brands' },
    saveBrand:           { method: 'POST', url: '/erp/brands' },
    deleteBrand:         { method: 'DELETE', url: (id) => '/erp/brands/' + id },
    getPurchaseReports:  { method: 'GET',  url: '/erp/purchase-reports', query: (f) => f },
    getAdvancedFullReport: { method: 'GET', url: '/sales/report/advanced', query: (f) => f },
    getWarehouses:       { method: 'GET',  url: '/erp/warehouses' },
    saveWarehouseLegacy: { method: 'POST', url: '/erp/warehouses' },
    deleteWarehouseLegacy:{ method: 'DELETE', url: (id) => '/erp/warehouses/' + id },
    getWarehouseStock:   { method: 'GET',  url: '/erp/warehouse-stock', query: (whId) => whId ? { warehouseId: whId } : {} },
    getStockTransfers:   { method: 'GET',  url: '/erp/stock-transfers' },
    createStockTransfer: { method: 'POST', url: '/erp/stock-transfers', body: (d,u) => Object.assign({}, d, {username:u||''}) },
    approveStockTransfer:{ method: 'POST', url: (id,d) => '/erp/stock-transfers/' + id + '/approve', body: (id,d) => ({username:d||''}) },
    cancelStockTransfer: { method: 'POST', url: (id) => '/erp/stock-transfers/' + id + '/cancel' },
    getStockTransferLines:{ method: 'GET', url: (id) => '/erp/stock-transfer-lines/' + id },
    getSupplierStatement:{ method: 'GET',  url: '/erp/supplier-statement', query: (f) => f },
    getCustomerStatement:{ method: 'GET',  url: '/erp/customer-statement', query: (f) => f },
    getARAging:          { method: 'GET',  url: '/erp/ar-aging' },
    getAPAging:          { method: 'GET',  url: '/erp/ap-aging' },
    getCreditNotes:      { method: 'GET',  url: '/erp/credit-notes' },
    getDebitNotes:       { method: 'GET',  url: '/erp/debit-notes' },
    getPaymentsList:     { method: 'GET',  url: '/erp/payments' },
    getReceiptsList:     { method: 'GET',  url: '/erp/receipts' },
    setup2FA:            { method: 'POST', url: '/auth/2fa/setup' },
    verify2FA:           { method: 'POST', url: '/auth/2fa/verify' },
    disable2FA:          { method: 'POST', url: '/auth/2fa/disable' },
    getAccountLedger:    { method: 'GET',  url: (id) => '/erp/gl/account-ledger/' + id },
    // HR Module
    getHrDashboard:      { method: 'GET',  url: '/hr/dashboard' },
    getHrDepartments:    { method: 'GET',  url: '/hr/departments' },
    saveHrDepartment:    { method: 'POST', url: '/hr/departments' },
    deleteHrDepartment:  { method: 'DELETE', url: (id) => '/hr/departments/' + id },
    getHrEmployees:      { method: 'GET',  url: '/hr/employees', query: (f) => f },
    getHrEmployee:       { method: 'GET',  url: (id) => '/hr/employees/' + id },
    saveHrEmployee:      { method: 'POST', url: '/hr/employees' },
    updateHrEmployee:    { method: 'PUT',  url: (id,d) => '/hr/employees/' + id, body: (id,d) => d },
    terminateEmployee:   { method: 'POST', url: (id,d) => '/hr/employees/' + id + '/terminate', body: (id,d) => d },
    suspendEmployee:     { method: 'POST', url: (id) => '/hr/employees/' + id + '/suspend' },
    activateEmployee:    { method: 'POST', url: (id) => '/hr/employees/' + id + '/activate' },
    deleteHrEmployee:    { method: 'DELETE', url: (id) => '/hr/employees/' + id },
    // Employee self-service
    getMyProfile:        { method: 'GET',  url: (u) => '/hr/my-profile?username=' + u },
    getMyAttendance:     { method: 'GET',  url: (u) => '/hr/my-attendance?username=' + u },
    myClock:             { method: 'POST', url: '/hr/my-clock' },
    getMyLeaveBalances:  { method: 'GET',  url: (u) => '/hr/my-leave-balances?username=' + u },
    myLeaveRequest:      { method: 'POST', url: '/hr/my-leave-request' },
    getMyLeaveRequests:  { method: 'GET',  url: (u) => '/hr/my-leave-requests?username=' + u },
    getMyPayslips:       { method: 'GET',  url: (u) => '/hr/my-payslips?username=' + u },
    getHrLeaveTypes:     { method: 'GET',  url: '/hr/leave-types' },
    getHrSchedules:      { method: 'GET',  url: '/hr/schedules' },
    saveHrSchedule:      { method: 'POST', url: '/hr/schedules' },
    getHrAttendance:     { method: 'GET',  url: '/hr/attendance', query: (f) => f },
    importHrAttendance:  { method: 'POST', url: '/hr/attendance/import' },
    clockHrAttendance:   { method: 'POST', url: '/hr/attendance/clock' },
    clockAttendance:     { method: 'POST', url: '/hr/attendance/clock' },
    importAttendance:    { method: 'POST', url: '/hr/attendance/import' },
    editAttendance:      { method: 'PUT',  url: (id,d) => '/hr/attendance/' + id, body: (id,d) => d },
    getAttendanceSummary:{ method: 'GET',  url: '/hr/attendance/summary', query: (f) => f },
    getHrLeaveTypes:     { method: 'GET',  url: '/hr/leave-types' },
    saveHrLeaveType:     { method: 'POST', url: '/hr/leave-types' },
    getLeaveBalances:    { method: 'GET',  url: (empId) => '/hr/leave-balances/' + empId },
    initLeaveBalances:   { method: 'POST', url: '/hr/leave-balances/init' },
    getLeaveRequests:    { method: 'GET',  url: '/hr/leave-requests', query: (f) => f },
    createLeaveRequest:  { method: 'POST', url: '/hr/leave-requests' },
    approveLeaveRequest: { method: 'POST', url: (id,d) => '/hr/leave-requests/' + id + '/approve', body: (id,d) => d },
    rejectLeaveRequest:  { method: 'POST', url: (id,d) => '/hr/leave-requests/' + id + '/reject', body: (id,d) => d },
    getPayrollRuns:      { method: 'GET',  url: '/hr/payroll-runs' },
    createPayrollRun:    { method: 'POST', url: '/hr/payroll-runs' },
    calculatePayroll:    { method: 'POST', url: (id,d) => '/hr/payroll-runs/' + id + '/calculate', body: (id,d) => d },
    approvePayroll:      { method: 'POST', url: (id,d) => '/hr/payroll-runs/' + id + '/approve', body: (id,d) => d },
    getPayrollItems:     { method: 'GET',  url: (id) => '/hr/payroll-runs/' + id + '/items' },
    getPayslip:          { method: 'GET',  url: (runId,empId) => '/hr/payroll-runs/' + runId + '/payslip/' + empId },
    getHrAdvances:       { method: 'GET',  url: '/hr/advances', query: (f) => f },
    createAdvance:       { method: 'POST', url: '/hr/advances' },
    approveAdvance:      { method: 'POST', url: (id,d) => '/hr/advances/' + id + '/approve', body: (id,d) => d },
    rejectAdvance:       { method: 'POST', url: (id,d) => '/hr/advances/' + id + '/reject', body: (id,d) => d },
    getHrDocuments:      { method: 'GET',  url: (empId) => '/hr/documents/' + empId },
    uploadHrDocument:    { method: 'POST', url: '/hr/documents' },
    deleteHrDocument:    { method: 'DELETE', url: (id) => '/hr/documents/' + id },
    updateGLJournal:     { method: 'PUT',  url: (id,d) => '/erp/gl/journals/' + id, body: (id,d) => d },
    getZATCAInvoices:    { method: 'GET',  url: '/erp/zatca' },
    // Workflow Engine
    getWfPositions:      { method: 'GET',  url: '/workflow/positions' },
    saveWfPosition:      { method: 'POST', url: '/workflow/positions' },
    deleteWfPosition:    { method: 'DELETE', url: (id) => '/workflow/positions/' + id },
    getWfTypes:          { method: 'GET',  url: '/workflow/transaction-types' },
    saveWfType:          { method: 'POST', url: '/workflow/transaction-types' },
    getWfDefs:           { method: 'GET',  url: (typeId) => '/workflow/workflow-definitions/' + typeId },
    saveWfDef:           { method: 'POST', url: '/workflow/workflow-definitions' },
    deleteWfDef:         { method: 'DELETE', url: (id) => '/workflow/workflow-definitions/' + id },
    getWfTransactions:   { method: 'GET',  url: '/workflow/transactions', query: (f) => f },
    getWfTransaction:    { method: 'GET',  url: (id) => '/workflow/transactions/' + id },
    createWfTransaction: { method: 'POST', url: '/workflow/transactions' },
    wfTransactionAction: { method: 'POST', url: (id,d) => '/workflow/transactions/' + id + '/action', body: (id,d) => d },
  };

  function buildUrl(route, args) {
    let url = BASE;
    if (typeof route.url === 'function') url += route.url(...args);
    else url += route.url;
    // Add query params for GET requests
    if (route.method === 'GET' && route.query) {
      const params = route.query(...args);
      if (params && typeof params === 'object') {
        const qs = Object.entries(params).filter(([k,v]) => v !== undefined && v !== null && v !== '').map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
        if (qs) url += '?' + qs;
      }
    }
    return url;
  }

  function buildBody(route, args) {
    if (route.method === 'GET' || route.method === 'DELETE') return undefined;
    if (route.body) return JSON.stringify(route.body(...args));
    // Use the first object argument as the body — works for both single-arg
    // calls like fn({...}) and multi-arg calls like fn({...}, currentUser).
    for (var i = 0; i < args.length; i++) {
      if (args[i] && typeof args[i] === 'object') return JSON.stringify(args[i]);
    }
    return undefined;
  }

  // Create the api proxy that mimics google.script.run
  function createApiProxy() {
    let _successFn = function(){};
    let _failureFn = function(e){ console.error('API Error:', e); };

    const proxy = new Proxy({}, {
      get(target, prop) {
        if (prop === 'withSuccessHandler') return function(fn) { _successFn = fn; return proxy; };
        if (prop === 'withFailureHandler') return function(fn) { _failureFn = fn; return proxy; };

        // Function call
        return function() {
          const args = Array.from(arguments);
          const route = ROUTE_MAP[prop];
          const successFn = _successFn;
          const failureFn = _failureFn;
          // Reset handlers for next call
          _successFn = function(){};
          _failureFn = function(e){ console.error('API Error:', e); };

          if (!route) {
            console.warn('API function not mapped:', prop);
            successFn(null);
            return;
          }

          const url = buildUrl(route, args);
          const options = { method: route.method, headers: { 'Content-Type': 'application/json' } };
          const token = localStorage.getItem('pos_token');
          if (token) options.headers['Authorization'] = 'Bearer ' + token;
          const body = buildBody(route, args);
          if (body) options.body = body;

          fetch(url, options)
            .then(r => r.json())
            .then(data => successFn(data))
            .catch(err => failureFn(err));
        };
      }
    });
    return proxy;
  }

  // Replace the global api object
  window._apiBridge = createApiProxy();

  // Also provide google.script.run compatibility
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = createApiProxy();
})();
