/**
 * Module-level singleton store for NavBadge pending-count polling.
 *
 * Guarantees that for a given `src` URL:
 *  - Exactly one HTTP request is in-flight at any moment (`inFlight` guard).
 *  - Exactly one 30-second polling interval runs, regardless of how many
 *    NavBadge instances are mounted with the same `src`.
 *  - Exactly one `visibilitychange` listener is attached per `src`.
 *  - Browser notifications fire once per count increase (not once per instance).
 *  - SSR-safe: all browser globals are guarded before access.
 *
 * The four approval badge srcs are additionally BATCHED: they keep their own
 * channels (per-src counts, listeners, and notification-on-increase behavior are
 * unchanged), but share ONE polling loop against /api/approvals/badge-counts —
 * one HTTP request per 30s cycle instead of four. Any other `src` keeps the
 * original per-src fetch path.
 */

type Listener = (count: number | null, overdue: boolean) => void;

interface Channel {
  count: number | null;
  prevCount: number | null;
  overdue: boolean;
  inFlight: Promise<void> | null;
  listeners: Set<Listener>;
  intervalId: ReturnType<typeof setInterval> | null;
  onVisible: (() => void) | null;
}

const channels = new Map<string, Channel>();

// ── Batched approval badge polling ───────────────────────────────────────────

export const BADGE_COUNTS_ENDPOINT = "/api/approvals/badge-counts";

/** Maps each legacy per-src badge URL to its key in the batched response. */
const BATCH_KEY_BY_SRC: Record<string, "plan" | "vacation" | "excuse" | "hub"> = {
  "/api/approvals/plan/pending-count": "plan",
  "/api/approvals/vacation/pending-count": "vacation",
  "/api/approvals/excuse/pending-count": "excuse",
  "/api/approvals-hub/pending-count": "hub",
};

/** Shared polling infrastructure for every batched channel (one poll serves all). */
const batch: {
  inFlight: Promise<void> | null;
  intervalId: ReturnType<typeof setInterval> | null;
  onVisible: (() => void) | null;
} = { inFlight: null, intervalId: null, onVisible: null };

function isBatchedSrc(src: string): boolean {
  return Object.prototype.hasOwnProperty.call(BATCH_KEY_BY_SRC, src);
}

function hasBatchedChannels(): boolean {
  for (const src of Object.keys(BATCH_KEY_BY_SRC)) {
    if (channels.has(src)) return true;
  }
  return false;
}

/**
 * Apply a freshly fetched count to one channel: notification-on-increase, cache
 * update, and listener broadcast. Identical semantics to the original inline
 * per-src handler — extracted so the batched path reuses it verbatim.
 */
function applyCount(src: string, newCount: number, overdue: boolean): void {
  const channel = channels.get(src);
  if (!channel) return;
  if (
    channel.prevCount !== null &&
    newCount > channel.prevCount &&
    typeof window !== "undefined" &&
    "Notification" in window
  ) {
    if (Notification.permission === "default") {
      void Notification.requestPermission();
    } else if (Notification.permission === "granted") {
      new Notification("Action Center", {
        body: "New items are awaiting your approval.",
        icon: "/favicon.ico",
      });
    }
  }
  channel.prevCount = newCount;
  channel.count = newCount;
  channel.overdue = overdue;
  channel.listeners.forEach((l) => l(newCount, overdue));
}

/** One batched fetch distributes counts to every subscribed badge channel. */
function fetchAndBroadcastBatch(): void {
  // inFlight guard: if a batched request is already running, reuse it.
  if (batch.inFlight) return;

  batch.inFlight = globalThis
    .fetch(BADGE_COUNTS_ENDPOINT)
    .then((r) => r.json())
    .then((d: Partial<Record<"plan" | "vacation" | "excuse" | "hub", { count?: number; overdue?: boolean }>>) => {
      for (const [src, key] of Object.entries(BATCH_KEY_BY_SRC)) {
        const slot = d?.[key];
        if (!slot || typeof slot.count !== "number") continue;
        applyCount(src, slot.count, slot.overdue === true);
      }
    })
    .catch(() => {})
    .finally(() => {
      batch.inFlight = null;
    });
}

function teardownBatchIfIdle(): void {
  if (hasBatchedChannels()) return;
  if (batch.intervalId !== null) clearInterval(batch.intervalId);
  batch.intervalId = null;
  if (batch.onVisible && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", batch.onVisible);
  }
  batch.onVisible = null;
}

// ── Per-src fetch (non-batched srcs only) ────────────────────────────────────

function fetchAndBroadcast(src: string): void {
  if (isBatchedSrc(src)) {
    fetchAndBroadcastBatch();
    return;
  }

  const ch = channels.get(src);
  if (!ch) return;
  // inFlight guard: if a request is already running for this src, reuse it —
  // do not start a second parallel fetch.
  if (ch.inFlight) return;

  ch.inFlight = globalThis
    .fetch(src)
    .then((r) => r.json())
    .then((d: { count?: number; overdue?: boolean }) => {
      const channel = channels.get(src);
      if (!channel || typeof d.count !== "number") return;
      applyCount(src, d.count, d.overdue === true);
    })
    .catch(() => {})
    .finally(() => {
      const channel = channels.get(src);
      if (channel) channel.inFlight = null;
    });
}

/**
 * Subscribe `listener` to pending-count updates for `src`.
 * Returns an unsubscribe function; call it on component unmount.
 *
 * - First subscriber boots the fetch, 30s poll, and `visibilitychange` handler
 *   (batched srcs share ONE poll + handler across all four channels).
 * - Subsequent subscribers for the same `src` receive the cached count
 *   immediately without triggering another fetch.
 * - When all subscribers unsubscribe, the channel is fully torn down.
 */
export function subscribeNavBadge(src: string, listener: Listener): () => void {
  if (typeof window === "undefined") return () => {};

  let ch = channels.get(src);
  const isNewChannel = !ch;
  if (!ch) {
    ch = {
      count: null,
      prevCount: null,
      overdue: false,
      inFlight: null,
      listeners: new Set(),
      intervalId: null,
      onVisible: null,
    };
    channels.set(src, ch);
  }
  ch.listeners.add(listener);

  // Deliver cached count immediately so the badge doesn't blank on re-mount.
  if (ch.count !== null) {
    listener(ch.count, ch.overdue);
  }

  if (isBatchedSrc(src)) {
    if (isNewChannel) {
      // Fetch now so a late-mounting badge gets its count promptly; the shared
      // inFlight guard dedupes when another badge's request is already running
      // (its response covers this channel too, now that it exists).
      fetchAndBroadcastBatch();
      if (batch.intervalId === null) {
        batch.intervalId = setInterval(() => fetchAndBroadcastBatch(), 30_000);
      }
      if (batch.onVisible === null && typeof document !== "undefined") {
        const onVisible = () => {
          if (document.visibilityState === "visible") fetchAndBroadcastBatch();
        };
        batch.onVisible = onVisible;
        document.addEventListener("visibilitychange", onVisible);
      }
    }
  } else if (ch.listeners.size === 1) {
    // Only the first subscriber starts the polling infrastructure.
    fetchAndBroadcast(src);
    ch.intervalId = setInterval(() => fetchAndBroadcast(src), 30_000);
    if (typeof document !== "undefined") {
      const onVisible = () => {
        if (document.visibilityState === "visible") fetchAndBroadcast(src);
      };
      ch.onVisible = onVisible;
      document.addEventListener("visibilitychange", onVisible);
    }
  }

  return () => {
    const channel = channels.get(src);
    if (!channel) return;
    channel.listeners.delete(listener);
    if (channel.listeners.size === 0) {
      if (channel.intervalId !== null) clearInterval(channel.intervalId);
      if (channel.onVisible && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", channel.onVisible);
      }
      channels.delete(src);
      if (isBatchedSrc(src)) teardownBatchIfIdle();
    }
  };
}

/** For test cleanup only — do not call in production code. */
export function _resetNavBadgeChannels(): void {
  channels.forEach((ch) => {
    if (ch.intervalId !== null) clearInterval(ch.intervalId);
    if (ch.onVisible && typeof document !== "undefined") {
      try {
        document.removeEventListener("visibilitychange", ch.onVisible);
      } catch {
        // ignore — document may be a test stub
      }
    }
  });
  channels.clear();
  if (batch.intervalId !== null) clearInterval(batch.intervalId);
  batch.intervalId = null;
  if (batch.onVisible && typeof document !== "undefined") {
    try {
      document.removeEventListener("visibilitychange", batch.onVisible);
    } catch {
      // ignore — document may be a test stub
    }
  }
  batch.onVisible = null;
  batch.inFlight = null;
}
