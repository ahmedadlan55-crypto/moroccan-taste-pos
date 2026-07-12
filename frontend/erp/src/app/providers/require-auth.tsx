import type { ReactNode } from "react";
import { LayoutGrid, LogIn } from "lucide-react";
import { useAuth } from "./auth-provider";

// Gate the whole app behind a valid session. The Back-Office shares the legacy
// app's JWT (localStorage pos_token); there is no separate login here. In
// dev/preview we render the UI even without a token so the foundation is
// demoable; in production an unauthenticated user is sent to the main app.
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated || import.meta.env.DEV) return <>{children}</>;
  return <NotAuthenticated />;
}

function NotAuthenticated() {
  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="surface grid max-w-md place-items-center gap-4 p-10 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-teal-600 text-white">
          <LayoutGrid className="h-6 w-6" />
        </span>
        <h1 className="text-xl font-extrabold text-slate-900">المذاق المغربي</h1>
        <p className="text-sm font-medium text-slate-500">
          انتهت جلستك أو لم تسجّل الدخول. يرجى تسجيل الدخول من التطبيق الرئيسي ثم العودة إلى هذه الصفحة.
        </p>
        <a className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2 text-sm font-bold text-white hover:bg-teal-700" href="/">
          <LogIn className="h-4 w-4" /> الذهاب لتسجيل الدخول
        </a>
      </div>
    </div>
  );
}
