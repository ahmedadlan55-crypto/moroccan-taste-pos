/**
 * «الأكثر مبيعًا» / Top sellers — a LOCAL, offline-only popularity tally.
 *
 * WHY
 *   The live `menu` table holds ~2,000 rows. To ring up the same six drinks all
 *   day the cashier must either walk a category or type in the search box every
 *   single time — for items they sell dozens of times per shift. Nothing in the
 *   product surface remembers what this till actually sells.
 *
 * WHY LOCAL
 *   No server call, by design: the register must keep working through an
 *   outage, and "what THIS terminal sells" is exactly the signal a cashier
 *   wants — not a company-wide ranking. Everything here is localStorage, wrapped
 *   in try/catch, and shape-validated on read: a corrupted, foreign or
 *   hand-edited entry degrades to "no quick picks", never to a crash and never
 *   to a bogus id reaching the cart.
 *
 * WEEKLY DECAY
 *   Scores halve every 7 days (continuous, applied lazily on read/write). A
 *   seasonal item that stopped selling fades out on its own instead of being
 *   pinned to the rail forever by last winter's numbers, and a new best-seller
 *   climbs within a shift or two. Decay is applied at most every 6h so a busy
 *   till isn't rewriting storage on every tap.
 *
 * THE SENTINEL CATEGORY
 *   The rail surfaces this as a pinned first chip whose "category" value is
 *   QUICK_PICKS_CATEGORY. `filterItems` understands that sentinel, so the whole
 *   feature rides the EXISTING category plumbing (App holds `category` state and
 *   passes it to both the rail and the grid) with no host wiring at all.
 */
import { useSyncExternalStore } from "react";

/** The pseudo-category the pinned chip selects. Not a real DB category — no
 *  catalog item can ever carry it (they are Arabic names), so it cannot collide. */
export const QUICK_PICKS_CATEGORY = "__quick_picks__";

const STORAGE_KEY = "pos_v2_quick_picks";
const SHAPE_VERSION = 1;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Don't rewrite storage more than ~4×/day just to decay. */
const DECAY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Below this a score is noise — drop the id entirely. */
const MIN_SCORE = 0.05;
/** Hard cap on tracked ids so the entry can never grow without bound. */
const MAX_TRACKED = 200;
/** How many chips the grid shows. */
export const QUICK_PICKS_LIMIT = 12;
/** A catalog id is a short opaque token; anything longer is not one of ours. */
const MAX_ID_LEN = 64;

interface Tally {
  v: number;
  /** When decay was last applied (ms epoch). */
  decayedAt: number;
  items: Record<string, number>;
}

function emptyTally(now = Date.now()): Tally {
  return { v: SHAPE_VERSION, decayedAt: now, items: {} };
}

/**
 * Shape-validated read. ANY deviation — wrong version, non-object, array,
 * non-finite or non-positive score, oversized id — yields an empty tally rather
 * than a half-trusted one. Never throws.
 */
function readTally(): Tally {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyTally();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyTally();
    const o = parsed as Record<string, unknown>;
    if (o.v !== SHAPE_VERSION) return emptyTally();
    const src = o.items;
    if (!src || typeof src !== "object" || Array.isArray(src)) return emptyTally();
    const decayedAt =
      typeof o.decayedAt === "number" && Number.isFinite(o.decayedAt) && o.decayedAt > 0 ? o.decayedAt : Date.now();
    const items: Record<string, number> = {};
    for (const [id, score] of Object.entries(src as Record<string, unknown>)) {
      if (!id || id.length > MAX_ID_LEN) continue;
      const n = typeof score === "number" ? score : Number(score);
      if (!Number.isFinite(n) || n <= 0) continue;
      items[id] = Math.min(n, 1e6);
    }
    return { v: SHAPE_VERSION, decayedAt, items };
  } catch {
    return emptyTally(); // private mode / disabled storage / malformed JSON
  }
}

/** Best-effort write. A failure just means the tally won't survive the reload. */
function writeTally(tally: Tally): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tally));
  } catch {
    /* quota / private mode — the feature degrades to "this session only" */
  }
}

/** Continuous half-life decay, applied at most every DECAY_MIN_INTERVAL_MS. */
function applyDecay(tally: Tally, now: number): { tally: Tally; changed: boolean } {
  const elapsed = now - tally.decayedAt;
  if (!(elapsed >= DECAY_MIN_INTERVAL_MS)) return { tally, changed: false };
  const factor = Math.pow(0.5, elapsed / WEEK_MS);
  const items: Record<string, number> = {};
  for (const [id, score] of Object.entries(tally.items)) {
    const next = score * factor;
    if (next >= MIN_SCORE) items[id] = next;
  }
  return { tally: { v: SHAPE_VERSION, decayedAt: now, items }, changed: true };
}

/** Keep only the MAX_TRACKED highest-scoring ids. */
function trim(tally: Tally): Tally {
  const entries = Object.entries(tally.items);
  if (entries.length <= MAX_TRACKED) return tally;
  entries.sort((a, b) => b[1] - a[1]);
  const items: Record<string, number> = {};
  for (const [id, score] of entries.slice(0, MAX_TRACKED)) items[id] = score;
  return { ...tally, items };
}

/** Deterministic ranking: score desc, id asc as the tiebreaker. */
function rank(tally: Tally): string[] {
  return Object.entries(tally.items)
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, QUICK_PICKS_LIMIT)
    .map(([id]) => id);
}

// ── External store (useSyncExternalStore-compatible) ────────────────────────
// getSnapshot MUST be referentially stable between renders or React loops, so
// the derived list is cached and invalidated only when the tally really changes.
const listeners = new Set<() => void>();
let snapshot: string[] | null = null;

function invalidate(): void {
  snapshot = null;
  for (const l of listeners) l();
}

/** The current top ids, decayed. Cached — safe to call on every render. */
export function getQuickPicks(): string[] {
  if (snapshot) return snapshot;
  const now = Date.now();
  const { tally, changed } = applyDecay(readTally(), now);
  // Persist the decay silently: the list we are about to return is ALREADY
  // derived from the decayed tally, so notifying here would only re-enter.
  if (changed) writeTally(tally);
  snapshot = rank(tally);
  return snapshot;
}

/** One sale of `itemId`. Called from the store when a cart line is created. */
export function recordPick(itemId: string): void {
  const id = String(itemId ?? "").trim();
  if (!id || id.length > MAX_ID_LEN) return;
  const now = Date.now();
  const { tally } = applyDecay(readTally(), now);
  const next = trim({ ...tally, items: { ...tally.items, [id]: (tally.items[id] ?? 0) + 1 } });
  writeTally(next);
  invalidate();
}

/**
 * Drop ids the catalog no longer serves (deleted or deactivated items), so the
 * pinned chip's count is truthful and a tap can never surface a ghost. Called
 * from the store whenever a NON-EMPTY catalog resolves — pruning against an
 * empty/loading catalog would wipe the whole tally.
 */
export function pruneQuickPicks(validIds: Set<string>): void {
  const tally = readTally();
  const ids = Object.keys(tally.items);
  const keep = ids.filter((id) => validIds.has(id));
  if (keep.length === ids.length) return;
  const items: Record<string, number> = {};
  for (const id of keep) items[id] = tally.items[id]!;
  writeTally({ ...tally, items });
  invalidate();
}

/** Forget everything (test hook / storage reset). */
export function clearQuickPicks(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
  invalidate();
}

export function subscribeQuickPicks(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

// Another tab (a second till on the same browser profile) selling an item must
// refresh this one's chips too. Best-effort; absent in non-browser runtimes.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === STORAGE_KEY) invalidate();
  });
}

/** React binding — re-renders the rail/grid when the tally changes. */
export function useQuickPicks(): string[] {
  return useSyncExternalStore(subscribeQuickPicks, getQuickPicks, getQuickPicks);
}
