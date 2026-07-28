/**
 * English dictionary — the offline engine's OWN messages (lib/offline.ts).
 *
 * These were the last hardcoded Arabic strings reaching a cashier. The engine
 * lives outside the React tree, so it never had a t() of its own until
 * setTranslator() was added — and its literals were simply left behind. On an
 * English till the register spoke English everywhere except at the exact moment
 * something went wrong with a sale, which is the worst possible place to lose
 * the reader.
 *
 * Arabic mirror: frontend/pos/src/i18n/dictionaries/ar/syncEngine.ts
 */
export const syncEngine = {
  /** A drain finished. Deliberately does NOT call a resolved version conflict a
   *  "failure": the engine handled it by design and kept the cashier's work. */
  summary: {
    allOk: (n: number) => `${n} pending ${n === 1 ? "operation" : "operations"} synced`,
    withFailures: "Sync: {ok} sent, {failed} could not be sent",
    withConflicts: "Sync: {ok} sent, {conflicts} superseded by the server copy (your edits were kept)",
  },

  conflict: {
    /** The order was edited elsewhere; the server copy wins and the local edits
     *  are parked as a separate draft. */
    parked:
      "This order changed on the server — the server's copy is now the record, and your edits were saved as a separate draft",
    /** Same, for a non-edit operation where there is nothing to park. */
    serverWon: "Order {ref} changed on the server — the server's copy is now the record",
    /** Reported against ops dropped behind a conflict. */
    dropped: "Not sent — the order had already changed on the server",
  },

  checkout: {
    /** The order could not be created server-side, so no payment was taken. */
    prerequisiteFailed: "The order could not be saved to the server, so no payment was taken — please try again",
    /** The sale IS recorded; only the order's own completion step failed. */
    saleRecordedNotCompleted: "The sale was recorded, but the order could not be closed: {reason}",
  },
} as const;
