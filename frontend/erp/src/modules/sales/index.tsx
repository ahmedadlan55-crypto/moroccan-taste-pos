// modules/sales — Sales / Order-to-Cash domain (SD3). ONE lazy module chunk backs
// every sales-group manifest item (/sales/orders, /sales/invoices, /sales/returns,
// /sales/payments, /sales/channels, /sales/pricing). The router registers one
// exact route per path (no `/:id`), so this component branches on the pathname to
// pick the section, and on the `?doc=<id>` query param to swap the list for a
// full-page document detail (see lib/use-nav.ts). Create forms open via `?new=1`.
import { useLocation } from "react-router-dom";
import { useDocNav } from "@/modules/sales/lib";
import { OrdersList } from "./orders/OrdersList";
import { OrderDetail } from "./orders/OrderDetail";
import { InvoicesList } from "./invoices/InvoicesList";
import { InvoiceDetail } from "./invoices/InvoiceDetail";
import { PaymentsList } from "./payments/PaymentsList";
import { PaymentDetail } from "./payments/PaymentDetail";
import { ReturnsList } from "./returns/ReturnsList";
import { ReturnDetail } from "./returns/ReturnDetail";
import { ChannelsPage } from "./channels/ChannelsPage";
import { PricingPage } from "./pricing/PricingPage";

type Section = "orders" | "invoices" | "returns" | "payments" | "channels" | "pricing";

function sectionFromPath(pathname: string): Section {
  const seg = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  switch (seg) {
    case "invoices": return "invoices";
    case "returns": return "returns";
    case "payments": return "payments";
    case "channels": return "channels";
    case "pricing": return "pricing";
    case "orders":
    default: return "orders";
  }
}

export default function SalesModule() {
  const { pathname } = useLocation();
  const { doc, sp, closeDoc } = useDocNav();
  const section = sectionFromPath(pathname);

  switch (section) {
    case "orders":
      return doc ? <OrderDetail id={doc} onBack={closeDoc} /> : <OrdersList />;
    case "invoices":
      return doc ? <InvoiceDetail id={doc} onBack={closeDoc} /> : <InvoicesList />;
    case "payments":
      return doc ? <PaymentDetail id={doc} onBack={closeDoc} /> : <PaymentsList presetCustomerId={sp.get("customerId") || undefined} />;
    case "returns":
      return doc ? <ReturnDetail id={doc} onBack={closeDoc} /> : <ReturnsList presetInvoiceId={sp.get("invoiceId") || undefined} />;
    case "channels":
      return <ChannelsPage />;
    case "pricing":
      return <PricingPage />;
  }
}
