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
 * The approval badge srcs are additionally BATCHED: they keep their own
 * channels (per-src counts, listeners, and notification-on-increase behavior are
 * unchanged), but read their counts from the SESSION PULSE (session-pulse-store.ts) —
 * the one request an open tab sends for the badges, the notification bell and the
 * session heartbeat together. It ticks every 30 s and asks for the badges once a minute
 * (BADGES_GAP_MS, 31 Oct 2026). Any other `src` keeps the original per-src fetch path.
 */

import {
  PULSE_RETURN_GAP_MS,
  pulseBadgesSnapshot,
  requestPulseBadges,
  subscribePulseBadges,
  _resetSessionPulse,
  type PulseBadges,
} from "@/lib/session-pulse-store";

/**
 * `unavailable` is true when the server said it could NOT read the count (a failed read, never a refusal).
 * The badge then says so instead of drawing nothing, because a dead read and an empty queue must never
 * look the same (owner, 27 Nov 2026: a count that cannot be read shows as unavailable, never as 0).
 */
type Listener = (count: number | null, overdue: boolean, unavailable: boolean) => void;

interface Channel {
  count: number | null;
  prevCount: number | null;
  overdue: boolean;
  unavailable: boolean;
  inFlight: Promise<void> | null;
  listeners: Set<Listener>;
  intervalId: ReturnType<typeof setInterval> | null;
  onVisible: (() => void) | null;
}

const channels = new Map<string, Channel>();

// ── Batched approval badge polling ───────────────────────────────────────────

/** The standalone batched endpoint. It stays live for other consumers; the badges no longer poll it (they ride /api/auth/pulse). */
export const BADGE_COUNTS_ENDPOINT = "/api/approvals/badge-counts";

type BatchKey =
  | "plan"
  | "vacation"
  | "excuse"
  | "hub"
  | "directOrders"
  | "directOrdersUnbooked"
  | "directOrdersNeedsAction"
  | "marketing"
  | "marketAwareness"
  | "calendarDisputes"
  | "deductionDisputes"
  | "placeChecks"
  | "sfeRecommendedChecks"
  | "cameraReviews"
  | "lateVisits"
  | "recordedVisits"
  | "ownerListAdds"
  | "ownerFarVisitHolds"
  | "ownerDoubleVisitRequests"
  | "ownerVisitAsks"
  | "ownerProbation"
  | "ownerContractRenewals"
  | "ownerHeldEmails";

/** Maps each legacy per-src badge URL to its key in the batched response. */
const BATCH_KEY_BY_SRC: Record<string, BatchKey> = {
  "/api/approvals/plan/pending-count": "plan",
  "/api/approvals/vacation/pending-count": "vacation",
  "/api/approvals/excuse/pending-count": "excuse",
  "/api/approvals-hub/pending-count": "hub",
  // Without this entry the badge still works, but falls back to its own separate 30s poll
  // instead of riding the single batched request.
  "/api/approvals/direct-orders/pending-count": "directOrders",
  // The Finance Manager's unbooked-sales-month queue. A SEPARATE slot from "directOrders" above,
  // not a widening of it: that one counts orders waiting on the caller's own approval rung, this
  // one counts orders that have already cleared the chain and are waiting on Finance. The two can
  // never be the same number, and one person (B-185) sees only this one.
  "/api/direct-orders/unbooked-count": "directOrdersUnbooked",
  // The ONE Direct Orders sidebar row, after the module's five nav entries were collapsed into the
  // workspace. It is the SUM of the two slots above, derived server-side from values the batch
  // already computes — so it rides the same poll and costs no extra query.
  "/api/direct-orders/needs-action-count": "directOrdersNeedsAction",
  // Marketing keeps its own dedicated approval inbox (it is deliberately excluded from the
  // consolidated hub), so it needs its own slot — "hub" will never carry a marketing item.
  "/api/marketing-requests/pending-count": "marketing",
  // Market Awareness keeps its own approvals inbox for the same reason marketing does, so it needs
  // its own slot too — "hub" will never carry an awareness activity either.
  "/api/market-awareness/pending-count": "marketAwareness",
  // Calendar Disputes, its own inbox since 2026-10-08. Its own slot for the same reason: "hub" has
  // never counted a review request.
  "/api/private-calendar/disputes/pending-count": "calendarDisputes",
  // Deduction Disputes, its own inbox under the Approvals tab since 2026-10-08. Its own slot too:
  // "hub" has never counted a deduction comment either.
  "/api/deductions/disputes/pending-count": "deductionDisputes",
  // The Super Admin's own Phoenix CRM queues (owner, 27 Nov 2026), one slot each so every row carries its
  // own number. One route answers all five by `queue`, for a consumer outside the batch.
  "/api/approvals/crm-queues/pending-count?queue=place-checks": "placeChecks",
  "/api/approvals/crm-queues/pending-count?queue=sfe-recommended-checks": "sfeRecommendedChecks",
  "/api/approvals/crm-queues/pending-count?queue=camera-reviews": "cameraReviews",
  "/api/approvals/crm-queues/pending-count?queue=late-visits": "lateVisits",
  "/api/approvals/crm-queues/pending-count?queue=recorded-visits": "recordedVisits",
  // The owner's seven queue shortcuts (27 Nov 2026). Each slot may carry `unavailable: true` — a count the
  // server could not read — which the badge draws as a dash, never as an empty queue.
  "/api/approvals/owner-queues/pending-count?queue=list-adds": "ownerListAdds",
  "/api/approvals/owner-queues/pending-count?queue=far-visit-holds": "ownerFarVisitHolds",
  "/api/approvals/owner-queues/pending-count?queue=double-visit-requests": "ownerDoubleVisitRequests",
  "/api/approvals/owner-queues/pending-count?queue=visit-asks": "ownerVisitAsks",
  "/api/approvals/owner-queues/pending-count?queue=probation": "ownerProbation",
  "/api/approvals/owner-queues/pending-count?queue=contract-renewals": "ownerContractRenewals",
  "/api/approvals/owner-queues/pending-count?queue=held-emails": "ownerHeldEmails",
};

/**
 * The least time between two fetches when the trigger is a tab coming BACK into view (2026-10-23,
 * every page change under 1 second). The rule now lives in the pulse store, which owns the loop and
 * its `visibilitychange` listener; the value is the same 15 s the bell and the badges each used.
 */
export const BADGE_RETURN_GAP_MS = PULSE_RETURN_GAP_MS;

/** The one subscription every batched channel shares to the session pulse; null while none is mounted. */
const batch: { unsubscribe: (() => void) | null } = { unsubscribe: null };

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
function applyCount(src: string, newCount: number, overdue: boolean, unavailable = false): void {
  const channel = channels.get(src);
  if (!channel) return;
  if (
    !unavailable &&
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
        icon: "/brand/phoenix-notification-icon.png",
      });
    }
  }
  // An unreadable count is not a number to compare the next one against: a dead read followed by a
  // good one must not announce "new items" that were there all along.
  if (!unavailable) channel.prevCount = newCount;
  channel.count = newCount;
  channel.overdue = overdue;
  channel.unavailable = unavailable;
  channel.listeners.forEach((l) => l(newCount, overdue, unavailable));
}

/**
 * A tab in the background skips its 30 s poll (2026-10-04 performance review, PERF-001): nobody can
 * see its badges, and every open tab used to cost the server a full poll. The `visibilitychange`
 * listener below fetches the moment the tab is shown again, so a returning viewer never reads a stale
 * count.
 */
function tabIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Distribute one pulse's badge payload to the batched channels (only `onlySrc` when given). */
function applyBatch(d: PulseBadges | null | undefined, onlySrc?: string): void {
  for (const [src, key] of Object.entries(BATCH_KEY_BY_SRC)) {
    if (onlySrc !== undefined && src !== onlySrc) continue;
    const slot = d?.[key];
    if (!slot || typeof slot.count !== "number") continue;
    applyCount(src, slot.count, slot.overdue === true, slot.unavailable === true);
  }
}

function teardownBatchIfIdle(): void {
  if (hasBatchedChannels()) return;
  batch.unsubscribe?.();
  batch.unsubscribe = null;
}

// ── Per-src fetch (non-batched srcs only) ────────────────────────────────────

function fetchAndBroadcast(src: string): void {
  // Batched srcs never come here: they are served by the pulse (see subscribeNavBadge).
  const ch = channels.get(src);
  if (!ch) return;
  // inFlight guard: if a request is already running for this src, reuse it —
  // do not start a second parallel fetch.
  if (ch.inFlight) return;

  ch.inFlight = globalThis
    .fetch(src)
    .then((r) => r.json())
    .then((d: { count?: number; overdue?: boolean; unavailable?: boolean }) => {
      const channel = channels.get(src);
      if (!channel || typeof d.count !== "number") return;
      applyCount(src, d.count, d.overdue === true, d.unavailable === true);
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
      unavailable: false,
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
    listener(ch.count, ch.overdue, ch.unavailable);
  }

  if (isBatchedSrc(src)) {
    if (isNewChannel) {
      if (batch.unsubscribe === null) {
        // The first batched channel joins the pulse; its cached payload, or its first answer, reaches
        // every channel through applyBatch. The pulse owns the poll (badges at most a minute old,
        // BADGES_GAP_MS), the in-flight guard and the 15 s rule for a tab shown again.
        batch.unsubscribe = subscribePulseBadges((badges) => applyBatch(badges));
      } else {
        // A badge mounting later reads its slot from the last answer, or asks for one now.
        const cached = pulseBadgesSnapshot();
        if (cached) applyBatch(cached, src);
        else requestPulseBadges();
      }
    }
  } else if (ch.listeners.size === 1) {
    // Only the first subscriber starts the polling infrastructure.
    fetchAndBroadcast(src);
    ch.intervalId = setInterval(() => {
      if (!tabIsHidden()) fetchAndBroadcast(src);
    }, 30_000);
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
  batch.unsubscribe = null;
  _resetSessionPulse();
}
