import type { LucideIcon } from "lucide-react";
import { ExternalLink } from "lucide-react";
import { EmptyState } from "@/shared/ui";
import { POS_APP_URL } from "../components/PosLauncherCard";

interface DeferredNoticePageProps {
  icon: LucideIcon;
  title: string;
  body: string;
}

// Held orders and device sync are runtime concerns owned by the POS (cashier)
// application, not the back-office — there is no back-office admin endpoint for
// them. Rather than fake a screen, we surface a clear notice + a hand-off link.
export function DeferredNoticePage({ icon: Icon, title, body }: DeferredNoticePageProps) {
  return (
    <div className="space-y-4">
      <EmptyState
        icon={<Icon className="h-6 w-6" aria-hidden="true" />}
        title={title}
        body={body}
        action={
          <a
            href={POS_APP_URL}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-teal-200 bg-teal-50 px-4 py-2 text-sm font-bold text-teal-700 transition hover:bg-teal-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            فتح تطبيق نقطة البيع
          </a>
        }
      />
    </div>
  );
}
