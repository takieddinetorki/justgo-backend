export const SUPPLIER_REGISTERED = 'suppliers.SupplierRegistered';
export interface SupplierRegisteredV1 {
  supplierId: string;
  ownerAccountId: string;
  verticalKey: string;
  name: string;
}
