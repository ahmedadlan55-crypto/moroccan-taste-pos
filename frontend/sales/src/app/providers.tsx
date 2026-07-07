import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-error";
import { AuthProvider } from "./auth-provider";
import { PermissionProvider } from "./permission-provider";

// App-wide providers. One QueryClient with sane defaults:
//   • queries retry a couple of times, but NEVER on 4xx (auth/permission/
//     validation/conflict are not transient)
//   • MUTATIONS never auto-retry (idempotency is not guaranteed — blueprint §10)

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                return false;
              }
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <PermissionProvider>{children}</PermissionProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
