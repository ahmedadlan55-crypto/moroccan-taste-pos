import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Lock, LogIn, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-error";

// The canonical page states (blueprint §14): loading skeleton, empty (first-use
// and filtered), server error, permission denied, offline, and a 409 conflict
// with a Refresh CTA.

function Shell({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="surface grid place-items-center gap-3 p-12 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">{icon}</div>
      <div className="text-base font-extrabold text-slate-800">{title}</div>
      {body && <p className="max-w-md text-sm font-medium text-slate-500">{body}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-busy="true">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-64" />
      {rows > 4 && <Skeleton className="h-40" />}
      <span className="sr-only">جارٍ التحميل…</span>
    </div>
  );
}

export function EmptyState({ title = "لا توجد بيانات بعد", body, action }: { title?: string; body?: string; action?: ReactNode }) {
  return <Shell icon={<Inbox className="h-6 w-6" />} title={title} body={body} action={action} />;
}

export function PermissionDenied() {
  return (
    <Shell
      icon={<Lock className="h-6 w-6" />}
      title="لا تملك صلاحية لعرض هذا القسم"
      body="هذه العملية تتطلب صلاحية أعلى. تواصل مع المدير إن كنت تظن أن هذا خطأ."
    />
  );
}

export function SessionExpired() {
  return (
    <Shell
      icon={<LogIn className="h-6 w-6" />}
      title="انتهت الجلسة"
      body="انتهت صلاحية تسجيل الدخول. سجّل الدخول من جديد من التطبيق الرئيسي ثم عُد إلى هذه الصفحة."
      action={
        <Button variant="primary" onClick={() => { window.location.href = "/"; }}>
          <LogIn className="h-4 w-4" /> تسجيل الدخول
        </Button>
      }
    />
  );
}

export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  return (
    <Shell
      icon={<WifiOff className="h-6 w-6" />}
      title="أنت غير متصل بالإنترنت"
      body="تعذّر الوصول إلى الخادم. سنعيد المحاولة تلقائيًا عند عودة الاتصال."
      action={onRetry && <Button variant="secondary" onClick={onRetry}><RefreshCw className="h-4 w-4" /> إعادة المحاولة</Button>}
    />
  );
}

// Never render raw technical / DB / stack error text to the user. Intentional
// short domain messages pass through; anything resembling SQL, driver internals,
// or a stack trace is replaced by a safe generic Arabic message.
export function safeUserMessage(error: unknown): string {
  const GENERIC = "حدث خطأ غير متوقع. أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول.";
  const raw = error instanceof Error ? String(error.message || "") : "";
  if (!raw) return GENERIC;
  if (/\b(select|insert|update|delete|from|where|group\s+by|sql_mode|only_full_group_by|nonaggregated|syntax|errno|econnrefused|sqlmessage)\b/i.test(raw)) return GENERIC;
  if (/\.(js|ts|tsx):\d+|\bat\s+\w+\s+\(/.test(raw)) return GENERIC; // stack frames
  if (raw.length > 160) return GENERIC; // overly long → likely a dump, not a UI message
  return raw;
}

export function ErrorState({ error, onRetry, title, body }: { error: unknown; onRetry?: () => void; title?: string; body?: string }) {
  if (error instanceof ApiError) {
    if (error.kind === "network") return <OfflineState onRetry={onRetry} />;
    if (error.kind === "unauthorized") return <SessionExpired />;
    if (error.kind === "forbidden") return <PermissionDenied />;
    if (error.isConflict) {
      return (
        <Shell
          icon={<RefreshCw className="h-6 w-6" />}
          title="تغيّرت البيانات منذ آخر تحميل"
          body={safeUserMessage(error)}
          action={onRetry && <Button onClick={onRetry}><RefreshCw className="h-4 w-4" /> تحديث</Button>}
        />
      );
    }
  }
  return (
    <Shell
      icon={<AlertTriangle className="h-6 w-6 text-rose-600" />}
      title={title ?? "تعذّر تحميل البيانات"}
      body={body ?? safeUserMessage(error)}
      action={onRetry && <Button variant="secondary" onClick={onRetry}><RefreshCw className="h-4 w-4" /> إعادة المحاولة</Button>}
    />
  );
}
