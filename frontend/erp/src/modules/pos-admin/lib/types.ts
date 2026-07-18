// POS-administration domain row shapes. These mirror the EXACT JSON the legacy
// backend returns (public/js/erp.js erpLoadPaymentMethodsV3 / erpLoadShiftClose
// Admin, public/js/app.js loadDashShifts) — field names are preserved so the same
// endpoints keep working unchanged under the unified ADLAN Back-Office.

/** payment_methods row — /api/settings/payment-methods-full (GET, bare array). */
export interface PaymentMethod {
  id: string | number;
  name: string;
  nameAr: string;
  icon?: string;
  color?: string;
  isActive?: boolean;
  sortOrder?: number;
  /** cash | electronic | voucher | loyalty | transfer | other */
  groupType?: string;
  /** none | percent | fixed */
  serviceFeeType?: string;
  serviceFeeValue?: number;
  serviceFeeRate?: number;
  glAccountId?: string | null;
  costCenterId?: string | null;
  showInShiftClose?: boolean;
  showInReports?: boolean;
  requireReference?: boolean;
  requireTransactionNumber?: boolean;
  requireTerminal?: boolean;
  allowRefund?: boolean;
  allowCancel?: boolean;
  allowManualTotal?: boolean;
  description?: string;
}

/** The POST body for creating/updating a payment method. id=null → INSERT. */
export interface PaymentMethodInput {
  id: string | number | null;
  name: string;
  nameAr: string;
  icon?: string;
  color?: string;
  isActive: boolean;
  sortOrder: number;
  groupType: string;
  serviceFeeType: string;
  serviceFeeValue: number;
  serviceFeeRate: number;
  glAccountId?: string | null;
  costCenterId?: string | null;
  showInShiftClose: boolean;
  showInReports: boolean;
  requireReference: boolean;
  requireTransactionNumber: boolean;
  requireTerminal: boolean;
  allowRefund: boolean;
  allowCancel: boolean;
  allowManualTotal: boolean;
  description: string;
}

/** Generic legacy mutation envelope: { success, error }. */
export interface SaveResult {
  success?: boolean;
  error?: string;
  id?: string | number;
}

/** shift row — /api/shifts/ (GET, bare array). */
export interface Shift {
  id: string | number;
  startTime?: string | null;
  endTime?: string | null;
  username?: string;
  displayName?: string;
  /** OPEN | CLOSED (case-insensitive in the legacy data). */
  status?: string;
  /** Opening float (الرصيد الافتتاحي) — real cash the drawer started with,
   *  recorded at open time. Returned by GET /api/shifts/ (openingFloat). */
  openingFloat?: number;
  totalTheoretical?: number;
  theoreticalCash?: number;
  theoreticalCard?: number;
  theoreticalKita?: number;
  actualCash?: number;
  actualCard?: number;
  actualKita?: number;
  diffCash?: number;
  diffCard?: number;
  diffKita?: number;
  geoAddress?: string;
  deviceInfo?: string;
}

/** One payment-method line inside a shift's closing breakdown. */
export interface ShiftClosingMethod {
  name?: string;
  nameAr?: string;
  groupType?: string;
  icon?: string;
  color?: string;
  expectedAmount?: number;
}

/** /api/shifts/closing-data-v3/:shiftId (GET). */
export interface ShiftClosingData {
  methods?: ShiftClosingMethod[];
  expectedTotal?: number;
  orderCount?: number;
}

/** Server-side filter params accepted by /api/shifts/. */
export interface ShiftFilters {
  startDate?: string;
  endDate?: string;
  username?: string;
  status?: string;
}
