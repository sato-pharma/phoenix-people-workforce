/**
 * Module-level singleton for the SESSION PULSE — the one request an open tab sends where it used to
 * send three (/api/auth/pulse, app/api/auth/pulse/route.ts).
 *
 * A visible tab used to run three clocks: the sidebar badges every 30 s (nav-badge-store.ts), the
 * notification bell every 60 s (in-app-notifications-bell.tsx) and the session heartbeat on activity
 * with a 60 s floor (session-security-guard.tsx). Each request resolved the viewer, and resolving the
 * viewer is one `phx_auth_session_bundle` call — 36,926 calls a day on production, 87 ms each, the
 * heaviest function in the system (measured 23 Oct 2026). This store owns the ONE loop all three now
 * ride, so a visible tab pays two session reads a minute instead of four with every number as fresh
 * as before.
 *
 * What it guarantees:
 *  - One 30 s interval and one `visibilitychange` listener, however many subscribers exist.
 *  - One request in flight at a time.
 *  - The interval skips a hidden tab (nobody can see its badges); a tab shown again refetches unless
 *    it fetched inside PULSE_RETURN_GAP_MS.
 *  - A tick asks only for what a subscriber wants: badges when a badge is mounted and its counts are at
 *    least BADGES_GAP_MS old, notices when a bell is mounted and its list is at least NOTICES_GAP_MS
 *    old, and a request that nobody needs is not sent at all.
 *  - The heartbeat is a POST, sent when the viewer has been active and the last one is at least
 *    HEARTBEAT_GAP_MS old; every other tick is a read-only GET. Only the POST confirms the session
 *    is still live, so a 401 on it is the sign-out signal.
 *  - A heartbeat with nothing else to carry waits up to HEARTBEAT_GATHER_MS for a badge or the bell
 *    to ride with it, so a page opening sends ONE request, not a bare POST and then a GET.
 *  - SSR-safe: every browser global is guarded before access.
 */

/** The shared tick. A visible tab fetches this often when anything wants fresh data. */
export const PULSE_INTERVAL_MS = 30_000;

/** The least time between two fetches when the trigger is a tab coming back into view. */
export const PULSE_RETURN_GAP_MS = 15_000;

/** The notification list is refreshed on a tick only when it is at least this old (one minute, with slack). */
export const NOTICES_GAP_MS = 55_000;

/**
 * The sidebar badge counts are refreshed on a tick only when they are at least this old (one minute,
 * with slack) — the owner's choice, 31 Oct 2026: "badges up to 1 minute old".
 *
 * WHY. Every tick asked for the badges, and the server's per-viewer memory of them lasts 20 s
 * (badge-counts-cache.ts), so a tab left open paid a full badge read every 30 s: eleven domain reads,
 * 11–35 Supabase requests a time depending on the seat. Production, Wednesday 28 Oct 2026: about 2,700
 * badge reads, 50,000–57,000 Supabase requests, about 8% of the day; one District Manager's open tab
 * alone was 699 reads. Asking once a minute halves that, and a quiet tab sends one request a minute
 * instead of two: the badges and the bell arrive together when a page opens, so they fall due on the
 * same tick. A tab shown again still refreshes them at once (PULSE_RETURN_GAP_MS), and a badge mounted
 * with nothing cached still asks.
 */
export const BADGES_GAP_MS = 55_000;

/** The session heartbeat floor — unchanged from the standalone heartbeat it replaces. */
export const HEARTBEAT_GAP_MS = 60_000;

/**
 * How long a heartbeat with nothing else to carry waits for a badge or the bell to ride with it.
 *
 * WHY (31 Oct 2026). Opening a page mounts the session guard, which reports activity at once, and the
 * bell a moment later. The guard's report sent the heartbeat straight away with nothing in it, and the
 * bell, arriving while that POST was in flight, sent its own GET the moment the POST answered: two
 * session reads for one page opening. Production HTTP logs, 31 Oct 14:51–15:00 Cairo: 14 of the 67
 * pulse requests were that bare POST, followed 0.4–2.5 s later by the bell's GET from the same phone.
 * Holding the bare heartbeat lets the bell's request BE the heartbeat. Nothing waits for data: a badge
 * or the bell is answered as soon as it asks, and only a heartbeat that would have travelled empty
 * waits. A session's idle limit equals its absolute limit (session-token.ts), so three seconds of
 * delay on its keep-alive cannot end one.
 */
export const HEARTBEAT_GATHER_MS = 3_000;

export const PULSE_ENDPOINT = "/api/auth/pulse";

/** The notices half of a pulse, in the shape the bell already reads. */
export interface PulseNotices {
  data?: unknown[];
  success?: boolean;
  error?: string;
  message?: string;
}

/** The badges half of a pulse: one `{ count, overdue? }` slot per badge, keyed as nav-badge-store.ts maps them. */
export type PulseBadges = Partial<Record<string, { count?: number; overdue?: boolean }>>;

type BadgesListener = (badges: PulseBadges) => void;
type NoticesListener = (notices: PulseNotices) => void;
type SessionListener = () => void;

const state: {
  badgeListeners: Set<BadgesListener>;
  noticeListeners: Set<NoticesListener>;
  sessionEndedListeners: Set<SessionListener>;
  inFlight: Promise<void> | null;
  /** What the request in flight carries, so a subscriber arriving mid-request is not answered by a second one. */
  inFlightBadges: boolean;
  inFlightNotices: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  onVisible: (() => void) | null;
  /** The wait a bare heartbeat is held in (HEARTBEAT_GATHER_MS): none, running, or over and free to go alone. */
  heartbeatHold: "none" | "holding" | "released";
  heartbeatHoldTimer: ReturnType<typeof setTimeout> | null;
  /** When the last request STARTED (Date.now()); 0 = never. */
  lastFetchStartedAt: number;
  /** When the last heartbeat POST started; 0 = never. */
  lastHeartbeatAt: number;
  /** When notices last arrived; 0 = never. */
  lastNoticesAt: number;
  /** When the badge counts last arrived; 0 = never. */
  lastBadgesAt: number;
  /** The viewer has done something since the last heartbeat. */
  activitySinceHeartbeat: boolean;
  /** A subscriber arrived and has no data yet — the next request must include it. */
  needBadges: boolean;
  needNotices: boolean;
  badges: PulseBadges | null;
  notices: PulseNotices | null;
} = {
  badgeListeners: new Set(),
  noticeListeners: new Set(),
  sessionEndedListeners: new Set(),
  inFlight: null,
  inFlightBadges: false,
  inFlightNotices: false,
  intervalId: null,
  onVisible: null,
  heartbeatHold: "none",
  heartbeatHoldTimer: null,
  lastFetchStartedAt: 0,
  lastHeartbeatAt: 0,
  lastNoticesAt: 0,
  lastBadgesAt: 0,
  activitySinceHeartbeat: false,
  needBadges: false,
  needNotices: false,
  badges: null,
  notices: null,
};

function tabIsHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function hasSubscribers(): boolean {
  return state.badgeListeners.size > 0 || state.noticeListeners.size > 0 || state.sessionEndedListeners.size > 0;
}

function heartbeatDue(now: number): boolean {
  return state.activitySinceHeartbeat && now - state.lastHeartbeatAt >= HEARTBEAT_GAP_MS;
}

function clearHeartbeatHold(): void {
  if (state.heartbeatHoldTimer !== null) clearTimeout(state.heartbeatHoldTimer);
  state.heartbeatHoldTimer = null;
  state.heartbeatHold = "none";
}

/**
 * True while a heartbeat with nothing else to carry must still wait (HEARTBEAT_GATHER_MS). The first
 * call starts the wait; when it ends the heartbeat is released and goes on its own.
 */
function holdBareHeartbeat(): boolean {
  if (state.heartbeatHold === "released") return false;
  if (state.heartbeatHold === "none") {
    state.heartbeatHold = "holding";
    state.heartbeatHoldTimer = setTimeout(() => {
      state.heartbeatHoldTimer = null;
      state.heartbeatHold = "released";
      pulse();
    }, HEARTBEAT_GATHER_MS);
  }
  return true;
}

/** One request that carries whatever is wanted right now, or nothing when nothing is. */
function pulse(): void {
  if (state.inFlight) return;
  if (!hasSubscribers()) {
    // Everyone who asked has already left (a page change inside the same task).
    state.needBadges = false;
    state.needNotices = false;
    return;
  }

  const now = Date.now();
  const wantBadges =
    (state.badgeListeners.size > 0 && now - state.lastBadgesAt >= BADGES_GAP_MS) || state.needBadges;
  const wantNotices =
    (state.noticeListeners.size > 0 && now - state.lastNoticesAt >= NOTICES_GAP_MS) || state.needNotices;
  const sendHeartbeat = heartbeatDue(now);
  if (!wantBadges && !wantNotices && !sendHeartbeat) return;
  // A heartbeat that would travel empty waits a moment for a badge or the bell to ride with it.
  if (sendHeartbeat && !wantBadges && !wantNotices && holdBareHeartbeat()) return;

  state.needBadges = false;
  state.needNotices = false;
  state.lastFetchStartedAt = now;
  state.inFlightBadges = wantBadges;
  state.inFlightNotices = wantNotices;
  if (sendHeartbeat) {
    state.lastHeartbeatAt = now;
    state.activitySinceHeartbeat = false;
    clearHeartbeatHold();
  }

  const query = [wantBadges ? "badges=1" : "", wantNotices ? "notices=1" : ""].filter(Boolean).join("&");
  const url = query ? `${PULSE_ENDPOINT}?${query}` : PULSE_ENDPOINT;

  state.inFlight = globalThis
    .fetch(url, sendHeartbeat ? { method: "POST" } : undefined)
    .then(async (response) => {
      if (response.status === 401) {
        // Only the POST confirms the session; a GET resolves the viewer softly and never answers 401.
        state.sessionEndedListeners.forEach((listener) => listener());
        return;
      }
      const body = (await response.json()) as { badges?: PulseBadges; notices?: PulseNotices } | null;
      if (body?.badges) {
        state.badges = body.badges;
        state.lastBadgesAt = Date.now();
        const badges = body.badges;
        state.badgeListeners.forEach((listener) => listener(badges));
      }
      if (body?.notices) {
        state.notices = body.notices;
        state.lastNoticesAt = Date.now();
        const notices = body.notices;
        state.noticeListeners.forEach((listener) => listener(notices));
      }
    })
    .catch(() => {
      // Transient network hiccup — the next tick or activity retries.
    })
    .finally(() => {
      state.inFlight = null;
      state.inFlightBadges = false;
      state.inFlightNotices = false;
      // A subscriber that arrived mid-request, or activity that came due, waits for no one.
      if (state.needBadges || state.needNotices || heartbeatDue(Date.now())) pulse();
    });
}

let pulseQueued = false;

/**
 * Send the pulse at the end of the current task rather than inside it, so subscribers mounting in the
 * same React commit (the sidebar badge and the bell, side by side) share ONE request instead of the
 * first one going out alone. A request already carrying what a subscriber wants answers it too.
 */
function pulseSoon(): void {
  if (pulseQueued) return;
  pulseQueued = true;
  queueMicrotask(() => {
    pulseQueued = false;
    pulse();
  });
}

function ensureLoop(): void {
  if (typeof window === "undefined") return;
  if (state.intervalId === null) {
    state.intervalId = setInterval(() => {
      if (!tabIsHidden()) pulse();
    }, PULSE_INTERVAL_MS);
  }
  if (state.onVisible === null && typeof document !== "undefined") {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - state.lastFetchStartedAt < PULSE_RETURN_GAP_MS) return;
      // A tab shown again refreshes what it shows, however young the counts are by the clock.
      if (state.badgeListeners.size > 0) state.needBadges = true;
      pulse();
    };
    state.onVisible = onVisible;
    document.addEventListener("visibilitychange", onVisible);
  }
}

function teardownIfIdle(): void {
  if (hasSubscribers()) return;
  clearHeartbeatHold();
  if (state.intervalId !== null) clearInterval(state.intervalId);
  state.intervalId = null;
  if (state.onVisible && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", state.onVisible);
  }
  state.onVisible = null;
}

/**
 * Subscribe to the sidebar badge counts. A cached payload is delivered at once; with none, a request
 * is sent at the end of the current task and carries them. Returns the unsubscribe function.
 */
export function subscribePulseBadges(listener: BadgesListener): () => void {
  if (typeof window === "undefined") return () => {};
  state.badgeListeners.add(listener);
  ensureLoop();
  if (state.badges) listener(state.badges);
  else requestPulseBadges();
  return () => {
    state.badgeListeners.delete(listener);
    teardownIfIdle();
  };
}

/**
 * Subscribe to the notification list. A cached list is delivered at once and refreshed only when it
 * is at least NOTICES_GAP_MS old; with none, a request is sent at the end of the current task and carries it.
 */
export function subscribePulseNotices(listener: NoticesListener): () => void {
  if (typeof window === "undefined") return () => {};
  state.noticeListeners.add(listener);
  ensureLoop();
  if (state.notices) listener(state.notices);
  if ((!state.notices || Date.now() - state.lastNoticesAt >= NOTICES_GAP_MS) && !(state.inFlight && state.inFlightNotices)) {
    state.needNotices = true;
    pulseSoon();
  }
  return () => {
    state.noticeListeners.delete(listener);
    teardownIfIdle();
  };
}

/**
 * Subscribe to the end of the session: called when the heartbeat answers 401 (revoked, expired or
 * role changed). Subscribing also keeps the loop alive, so a page with no badge and no bell still
 * keeps its session.
 */
export function subscribePulseSessionEnded(listener: SessionListener): () => void {
  if (typeof window === "undefined") return () => {};
  state.sessionEndedListeners.add(listener);
  ensureLoop();
  return () => {
    state.sessionEndedListeners.delete(listener);
    teardownIfIdle();
  };
}

/**
 * The viewer did something (a click, a key, a focus). Marks the session active so the next request
 * is the heartbeat POST, and sends one when the last heartbeat is old enough — at once when a badge
 * or the bell rides with it, after HEARTBEAT_GATHER_MS at most when nothing does.
 */
export function notePulseActivity(): void {
  if (typeof window === "undefined") return;
  state.activitySinceHeartbeat = true;
  if (heartbeatDue(Date.now())) pulse();
}

/** The last badge payload, or null before the first answer. */
export function pulseBadgesSnapshot(): PulseBadges | null {
  return state.badges;
}

/**
 * Ask for the badges in the next request and send it now (a badge mounted after the first answer).
 * A request already in flight with the badges in it answers this too, so no second one is sent.
 */
export function requestPulseBadges(): void {
  if (state.inFlight && state.inFlightBadges) return;
  state.needBadges = true;
  pulseSoon();
}

/** For test cleanup only — do not call in production code. */
export function _resetSessionPulse(): void {
  clearHeartbeatHold();
  if (state.intervalId !== null) clearInterval(state.intervalId);
  state.intervalId = null;
  if (state.onVisible && typeof document !== "undefined") {
    try {
      document.removeEventListener("visibilitychange", state.onVisible);
    } catch {
      // ignore — document may be a test stub
    }
  }
  state.onVisible = null;
  state.badgeListeners.clear();
  state.noticeListeners.clear();
  state.sessionEndedListeners.clear();
  state.inFlight = null;
  state.inFlightBadges = false;
  state.inFlightNotices = false;
  state.lastFetchStartedAt = 0;
  state.lastHeartbeatAt = 0;
  state.lastNoticesAt = 0;
  state.lastBadgesAt = 0;
  state.activitySinceHeartbeat = false;
  state.needBadges = false;
  state.needNotices = false;
  state.badges = null;
  state.notices = null;
  pulseQueued = false;
}
