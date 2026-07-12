// The feedback surface — a curated re-export of the state/notification pieces
// from the UI kit, so screens can import them from a single, intent-named path.
export {
  // page states
  LoadingState,
  EmptyState,
  ErrorState,
  PermissionDenied,
  SessionExpired,
  OfflineState,
  safeUserMessage,
  // primitives
  Skeleton,
  Spinner,
  Progress,
  // notifications
  ToastProvider,
  useToast,
  Tooltip,
  ErrorBoundary,
} from "@/shared/ui";

export type { ToastTone, ToastOptions } from "@/shared/ui";
