// POS-administration API surface — thin typed wrappers over the SHARED apiClient
// (@/shared/api). BARE paths (the client prepends /api). Endpoints, request shapes
// and business logic are UNCHANGED from the legacy erp.js/app.js implementations:
//
//   GET    /api/settings/payment-methods-full        erpLoadPaymentMethodsV3
//   POST   /api/settings/payment-methods-full        _v3SavePm (id=null → insert)
//   DELETE /api/settings/payment-methods-full/:id     erpDeletePmV3
//   GET    /api/shifts/                               loadDashShifts / erpLoadShiftCloseAdmin
//   GET    /api/shifts/closing-data-v3/:shiftId       erpViewShiftDetail
import { apiClient, type RequestOptions } from "@/shared/api";
import type {
  PaymentMethod,
  PaymentMethodInput,
  SaveResult,
  Shift,
  ShiftClosingData,
  ShiftFilters,
} from "./types";

type Params = RequestOptions["params"];

const PM = "/settings/payment-methods-full";
const SHIFTS = "/shifts/";

export const posAdminApi = {
  // ── payment methods (drive the register) ──
  paymentMethods: (signal?: AbortSignal) => apiClient.get<PaymentMethod[]>(PM, { signal }),
  savePaymentMethod: (body: PaymentMethodInput) => apiClient.post<SaveResult>(PM, body),
  deletePaymentMethod: (id: string | number) =>
    apiClient.delete<SaveResult>(`${PM}/${encodeURIComponent(String(id))}`),

  // ── shifts ──
  shifts: (filters: ShiftFilters, signal?: AbortSignal) =>
    apiClient.get<Shift[]>(SHIFTS, { params: filters as Params, signal }),
  shiftClosing: (shiftId: string | number, signal?: AbortSignal) =>
    apiClient.get<ShiftClosingData>(
      `/shifts/closing-data-v3/${encodeURIComponent(String(shiftId))}`,
      { signal },
    ),
};
