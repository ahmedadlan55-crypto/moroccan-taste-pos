import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./components/Toasts";
import { ApiError, clearSession } from "./lib/api";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // No blanket retry. Every screen here is a read the employee triggered by
      // opening a tab, and a silent triple-retry on a bad connection just makes
      // the spinner last three times as long before the same error appears.
      retry: false,
      // A phone locks and unlocks constantly. Refetching on focus is exactly
      // right for attendance and the live salary projection.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});

// An expired or revoked token must end the session rather than leave the app
// looping 401s behind every tab. The reload lands on the sign-in screen because
// App reads the (now empty) session on mount.
queryClient.getQueryCache().subscribe((event) => {
  const error = event.query.state.error;
  if (error instanceof ApiError && error.status === 401) {
    clearSession();
    queryClient.clear();
    window.location.reload();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>
  </React.StrictMode>,
);
