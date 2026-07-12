import { Store } from "lucide-react";
import { PageHeader, EmptyState } from "@/shared/ui";

// New manifest item (sl-channels → sales module). The standalone O2C app had no
// sales-channels screen; SD3 ports the existing order-to-cash surface, so this is
// a reachable, non-broken placeholder until the channels feature is built.
export function ChannelsPage() {
  return (
    <div>
      <PageHeader eyebrow="المبيعات" title="قنوات البيع" subtitle="إدارة قنوات ومنافذ البيع (فروع، متجر إلكتروني، تطبيقات التوصيل)." />
      <EmptyState
        icon={<Store className="h-6 w-6" />}
        title="قيد الإعداد"
        body="ستتوفّر إدارة قنوات البيع هنا قريبًا ضمن الوحدة الموحّدة."
      />
    </div>
  );
}
