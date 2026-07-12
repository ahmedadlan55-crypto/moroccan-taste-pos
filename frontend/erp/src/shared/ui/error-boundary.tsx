import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

// Render/runtime safety net: any error thrown in the subtree is caught here and
// replaced with a friendly Arabic recovery screen instead of a blank page.
// React error boundaries must be class components.
interface Props {
  children: ReactNode;
  /** Optional custom fallback; receives the caught error + a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep a diagnostic trail in the console; never surface raw errors to users.
    console.error("Unhandled UI error:", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div dir="rtl" className="grid min-h-[60vh] place-items-center p-6 font-sans">
        <div className="grid max-w-md place-items-center gap-3 rounded-2xl bg-white p-10 text-center shadow-soft">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-600" aria-hidden="true">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h1 className="text-lg font-extrabold text-ink">حدث خطأ غير متوقّع</h1>
          <p className="text-sm font-medium text-slate-500">
            نأسف على الإزعاج، حدث خلل مؤقّت في الواجهة. جرّب إعادة المحاولة، وإن استمرّت المشكلة تواصل مع الدعم الفني.
          </p>
          <button
            type="button"
            onClick={this.reset}
            className="mt-1 inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-600 px-6 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-teal-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
          >
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }
}
