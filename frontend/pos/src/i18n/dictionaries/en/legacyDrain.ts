export const legacyDrain = {
  invalidRecord: "Invalid record — cannot be sent",
  serverRejected: "Server rejected it (HTTP {status})",
  connectionLost: "Connection lost during sync — it will retry later",
} as const;
