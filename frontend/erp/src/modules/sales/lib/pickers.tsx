// Concrete SearchableEntityCombobox instances for the O2C long lists — each opens
// on click showing the first page (searchOnEmpty), searches server-side, and pages
// via the API pagination. Reused across orders / invoices / payments / returns.
// Rewired onto the SHARED combobox (@/shared/ui) — no local picker duplication.
import { SearchableEntityCombobox, type EntityPage } from "@/shared/ui";
import { formatCurrency } from "@/shared/lib";
import { o2cApi } from "./api";
import type { Customer, Invoice } from "./types";

function toPage<T>(data: T[], pagination: { page: number; totalPages: number; total: number } | undefined): EntityPage<T> {
  const p = pagination ?? { page: 1, totalPages: 1, total: data.length };
  return { items: data, total: p.total, nextPage: p.page < p.totalPages ? p.page + 1 : null };
}

export function CustomerPicker({ value, onChange, disabled }: { value: Customer | null; onChange: (c: Customer | null) => void; disabled?: boolean }) {
  return (
    <SearchableEntityCombobox<Customer>
      value={value}
      onChange={onChange}
      disabled={disabled}
      queryKey={["o2c", "customer-picker"]}
      placeholder="ابحث عن عميل بالاسم أو الهاتف أو الرقم الضريبي…"
      ariaLabel="اختيار عميل"
      getKey={(c) => c.id}
      getLabel={(c) => c.name}
      getSublabel={(c) => {
        const bits: string[] = [];
        if (c.phone) bits.push(c.phone);
        if (Number(c.creditLimit) > 0) bits.push(`الحد ${formatCurrency(c.creditLimit)}`);
        const bal = c.derived?.arBalance ?? c.balance;
        if (Number(bal) > 0) bits.push(`الرصيد ${formatCurrency(bal)}`);
        return bits.join(" · ") || undefined;
      }}
      fetcher={async ({ q, page, signal }) => {
        const res = await o2cApi.customerSearch({ q, page, pageSize: 20, active: "true" }, signal);
        return toPage(res.data, res.pagination);
      }}
    />
  );
}

export function OpenInvoicePicker({ customerId, value, onChange, disabled }: { customerId?: string; value: Invoice | null; onChange: (v: Invoice | null) => void; disabled?: boolean }) {
  return (
    <SearchableEntityCombobox<Invoice>
      value={value}
      onChange={onChange}
      disabled={disabled}
      queryKey={["o2c", "open-invoice-picker", customerId ?? ""]}
      placeholder="ابحث عن فاتورة مفتوحة…"
      ariaLabel="اختيار فاتورة"
      getKey={(i) => i.id}
      getLabel={(i) => i.document_number}
      getSublabel={(i) => `${i.customer_name ?? ""} · المتبقّي ${formatCurrency(i.balance_amount)}`}
      fetcher={async ({ q, page, signal }) => {
        const res = await o2cApi.invoices({ q, page, pageSize: 20, status: "issued", customerId }, signal);
        // also include partially_paid — the API filters one status; merge a 2nd call on page 1 only
        let items = res.data;
        if (page === 1) {
          const partial = await o2cApi.invoices({ q, page: 1, pageSize: 20, status: "partially_paid", customerId }, signal);
          items = [...res.data, ...partial.data];
        }
        return toPage(items.filter((i) => Number(i.balance_amount) > 0.01), res.pagination);
      }}
    />
  );
}
