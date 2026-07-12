// modules/customers — Customers domain (SD3). ONE lazy chunk backs the single
// manifest item (/customers). The router registers the exact path only, so this
// component swaps the list for the full-page customer 360 detail based on the
// `?doc=<id>` query param (URL-addressable, back/refresh safe). Create/edit open
// as drawers. The order-to-cash domain lib is shared from modules/sales/lib.
import { useDocNav } from "@/modules/sales/lib";
import { CustomersList } from "./CustomersList";
import { CustomerDetail } from "./CustomerDetail";

export default function CustomersModule() {
  const { doc, closeDoc } = useDocNav();
  return doc ? <CustomerDetail id={doc} onBack={closeDoc} /> : <CustomersList />;
}
