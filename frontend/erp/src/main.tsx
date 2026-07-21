import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/error-boundary";
import { installPreloadRecovery } from "./app/preload-recovery";
import { I18nProvider } from "./i18n";
import "./styles/index.css";

installPreloadRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);
