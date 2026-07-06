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

function fetchAndBroadcast(src: string): void {
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
      const newCount = d.count;
      const overdue = d.overdue === true;
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
 * - First subscriber boots the fetch, 30s poll, and `visibilitychange` handler.
 * - Subsequent subscribers for the same `src` receive the cached count
 *   immediately without triggering another fetch.
 * - When all subscribers unsubscribe, the channel is fully torn down.
 */
export function subscribeNavBadge(src: string, listener: Listener): () => void {
  if (typeof window === "undefined") return () => {};

  let ch = channels.get(src);
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

  // Only the first subscriber starts the polling infrastructure.
  if (ch.listeners.size === 1) {
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
}
