import { Component, type ErrorInfo, type ReactNode } from "react";

// Top-level safety net: any render/runtime error thrown anywhere in the tree is
// caught here and replaced with a friendly Arabic recovery screen instead of a
// blank white page. React error boundaries must be class components.
interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep a diagnostic trail in the console; never surface raw errors to users.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div dir="rtl" className="grid min-h-screen place-items-center bg-canvas p-6 font-sans">
        <div className="grid max-w-md place-items-center gap-3 rounded-2xl bg-white p-10 text-center shadow-soft">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-600" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </div>
          <h1 className="text-lg font-extrabold text-ink">حدث خطأ غير متوقّع</h1>
          <p className="text-sm font-medium text-slate-500">
            نأسف على الإزعاج، حدث خلل مؤقّت في الواجهة. جرّب إعادة تحميل الصفحة، وإن استمرّت المشكلة تواصل مع الدعم الفني.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-1 inline-flex min-h-11 items-center justify-center rounded-xl bg-teal-600 px-6 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-teal-700"
          >
            إعادة تحميل الصفحة
          </button>
        </div>
      </div>
    );
  }
}
