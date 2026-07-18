// The user row shape returned by GET /api/auth/users (routes/auth.js ~581).
// Only the fields the Administration › Users screen reads/edits are declared.
export interface User {
  username: string;
  displayName: string;
  role: string;
  active: boolean;
  email: string;
  phone: string;
  isDeveloper?: boolean;
  brandId?: string;
  brandName?: string;
  branchId?: string;
  branchName?: string;
  defaultWarehouseId?: string;
  defaultWarehouseName?: string;
  canChangeBranch?: boolean;
  employeePortal?: boolean;
  custodyPortal?: boolean;
}
