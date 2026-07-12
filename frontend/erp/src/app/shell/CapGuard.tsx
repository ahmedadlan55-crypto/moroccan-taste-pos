import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { usePermissions } from "@/app/providers";
import type { Capability } from "@/app/permissions";

// Per-route capability gate. Renders the page when the user has the capability;
// otherwise a self-contained "permission denied" state. In dev/preview it never
// blocks (parity with RequireAuth) so the foundation stays demoable without a
// real session. The backend remains the authoritative boundary.
export function CapGuard({ cap, children }: { cap?: Capability; children: ReactNode }) {
  const { can } = usePermissions();
  if (!cap || can(cap) || import.meta.env.DEV) return <>{children}</>;
  return <PermissionDenied />;
}

function PermissionDenied() {
  return (
    <div className="surface grid place-items-center gap-3 p-12 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">
        <Lock className="h-6 w-6" aria-hidden="true" />
      </div>
      <div className="text-base font-extrabold text-slate-800">لا تملك صلاحية لعرض هذا القسم</div>
      <p className="max-w-md text-sm font-medium text-slate-500">
        هذه العملية تتطلب صلاحية أعلى. تواصل مع المدير إن كنت تظن أن هذا خطأ.
      </p>
    </div>
  );
}
