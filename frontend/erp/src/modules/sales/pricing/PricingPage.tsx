import { Tags } from "lucide-react";
import { PageHeader, EmptyState } from "@/shared/ui";

// New manifest item (sl-pricing → sales module). No O2C source screen existed;
// SD3 leaves a reachable, non-broken placeholder until price-lists & discounts
// are implemented.
export function PricingPage() {
  return (
    <div>
      <PageHeader eyebrow="المبيعات" title="قوائم الأسعار والخصومات" subtitle="قوائم الأسعار حسب القناة والعميل، وقواعد الخصومات والعروض." />
      <EmptyState
        icon={<Tags className="h-6 w-6" />}
        title="قيد الإعداد"
        body="ستتوفّر قوائم الأسعار والخصومات هنا قريبًا ضمن الوحدة الموحّدة."
      />
    </div>
  );
}
