export const syncReportDialog = {
  title: "Sync report",
  status: {
    online: "Connected to server",
    offline: "Offline",
    queueLabel: "operations awaiting sync",
  },
  sync: {
    now: "Sync now",
  },
  queue: {
    heading: "Queue",
  },
  order: "Order",
  lastSync: "Last sync",
  empty: {
    title: "No sync yet",
    hint: "Results will appear here after the first batch",
  },
  result: {
    replayed: "Replayed",
    succeeded: "Succeeded",
    failed: "Failed",
  },
  opLabels: {
    upsert: "Save order",
    hold: "Hold",
    resume: "Resume",
    reopen: "Reopen",
    void: "Void",
    complete: "Complete",
    submitAndSale: "Pay + invoice",
  },
} as const;
