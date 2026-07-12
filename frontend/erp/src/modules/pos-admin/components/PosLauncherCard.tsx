import type { LucideIcon } from "lucide-react";
import { ExternalLink } from "lucide-react";
import { Card } from "@/shared/ui";

// The unified back-office is served at /app/; the cashier (POS) SPA is a peer app
// mounted at /pos-v2/ (see frontend/pos/vite.config.ts `base`). Launching the
// register is a cross-app navigation, so it uses a real anchor rather than the
// in-app router.
export const POS_APP_URL = "/pos-v2/";

interface PosLauncherCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  ctaLabel: string;
  href?: string;
}

/** A prominent card that hands the operator off to the POS cashier application. */
export function PosLauncherCard({
  icon: Icon,
  title,
  description,
  ctaLabel,
  href = POS_APP_URL,
}: PosLauncherCardProps) {
  return (
    <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-extrabold text-slate-900">{title}</h3>
          <p className="mt-1 max-w-xl text-sm font-medium leading-6 text-slate-500">{description}</p>
        </div>
      </div>
      <a
        href={href}
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-teal-700 hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        <ExternalLink className="h-4 w-4" aria-hidden="true" />
        {ctaLabel}
      </a>
    </Card>
  );
}
