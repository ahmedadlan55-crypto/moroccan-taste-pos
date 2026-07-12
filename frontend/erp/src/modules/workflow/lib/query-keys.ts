// Centralized TanStack Query keys for the Workflow domain. One namespace
// ("workflow") so caches are collision-free with the other modules.

export const qk = {
  all: ["workflow"] as const,
  incoming: (username: string) => [...qk.all, "incoming", username] as const,
  outbox: (username: string) => [...qk.all, "outbox", username] as const,
  myRequests: (username: string) => [...qk.all, "my-requests", username] as const,
  bundle: (id: string, username: string) => [...qk.all, "bundle", id, username] as const,
};
