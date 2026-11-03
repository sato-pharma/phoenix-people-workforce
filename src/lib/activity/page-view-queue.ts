// The browser's page views on their way to /api/activity/track: the page open now, and the ones
// waiting to be sent. A leaf module with no React in it, because two callers hold it: the activity
// tracker, which says when a page opens and closes, and the sign-out, which sends everything while
// the session still exists.

const ENDPOINT = "/api/activity/track";
// Ignore pass-through navigations shorter than this (redirect chains, mis-taps).
const MIN_DWELL_MS = 1000;
/** How long a page view waits in the queue before the batch is sent. */
export const ACTIVITY_FLUSH_INTERVAL_MS = 30_000;
/** The route accepts this many events in one request (MAX_EVENTS_PER_REQUEST); a full queue is sent at once. */
export const ACTIVITY_BATCH_LIMIT = 25;
/** The longest a sign-out waits for its page views to land before it logs out anyway. */
export const SIGN_OUT_FLUSH_CAP_MS = 1_500;

type QueuedPageView = { path: string; enteredAt: string | null; durationMs: number };

/**
 * ONE REQUEST PER TAB EVERY 30 SECONDS, NOT ONE PER PAGE (1 Nov 2026). Every navigation sent its own
 * POST the moment the page was left — a request, and a session read behind it, per page view for
 * every role, on the saturated host where each costs about 450 ms. Page views now wait in this
 * module-level queue and go together: when the queue fills (the route's own batch limit), when the
 * tab is hidden or unloaded (keepalive, so the batch survives the close), and otherwise every
 * ACTIVITY_FLUSH_INTERVAL_MS. Each entry carries its own `enteredAt`, so the server records the true
 * time however long it waited; the route already accepts `{events: [...]}`.
 */
const queue: QueuedPageView[] = [];
let flushTimer: number | null = null;
/** The page open now. `startedAt` is null while its clock is stopped: the tab is hidden, or its time has been queued. */
let openView: { enteredAt: string | null; path: string; startedAt: number | null } | null = null;

function sendBatch(events: QueuedPageView[]): Promise<unknown> {
  try {
    // fetch(keepalive) sets the Origin header (so it passes CSRF) and survives
    // unload, unlike a bare fetch. Errors are swallowed — tracking must be silent.
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Never let tracking surface an error to the user.
    return Promise.resolve();
  }
}

/** Sends everything queued, in route-sized batches. Settles once each batch has been answered, and never rejects. */
export function flushActivityQueue(): Promise<unknown> {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  const sending: Array<Promise<unknown>> = [];
  while (queue.length > 0) sending.push(sendBatch(queue.splice(0, ACTIVITY_BATCH_LIMIT)));
  return Promise.all(sending);
}

function queueActivityBeacon(path: string, enteredAtIso: string | null, durationMs: number) {
  if (!path || durationMs < MIN_DWELL_MS) return;
  queue.push({ path, enteredAt: enteredAtIso, durationMs: Math.round(durationMs) });
  if (queue.length >= ACTIVITY_BATCH_LIMIT) {
    flushActivityQueue();
    return;
  }
  if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flushActivityQueue();
    }, ACTIVITY_FLUSH_INTERVAL_MS);
  }
}

/** A page opened: its clock starts. */
export function startPageView(path: string): void {
  openView = { enteredAt: new Date().toISOString(), path, startedAt: Date.now() };
}

/** Stops the open page's clock and queues the time so far. Does nothing while the clock is stopped. */
export function endPageView(): void {
  if (openView?.startedAt == null) return;
  queueActivityBeacon(openView.path, openView.enteredAt, Date.now() - openView.startedAt);
  openView.startedAt = null;
}

/** The person is back on the same page: its clock starts again. */
export function resumePageView(): void {
  if (!openView || openView.startedAt != null) return;
  openView.enteredAt = new Date().toISOString();
  openView.startedAt = Date.now();
}

/**
 * Sends the page views, the one the person is signing out from included, and waits for the answers
 * while the session still exists: the track route drops anything that reaches it after the logout.
 * The wait is capped, and nothing here can stop the person signing out.
 */
export async function sendPageViewsBeforeSignOut(): Promise<void> {
  let cap: ReturnType<typeof setTimeout> | undefined;
  try {
    endPageView();
    await Promise.race([
      flushActivityQueue(),
      new Promise((resolve) => {
        cap = setTimeout(resolve, SIGN_OUT_FLUSH_CAP_MS);
      }),
    ]);
  } catch {
    // Tracking must be silent.
  } finally {
    clearTimeout(cap);
  }
}
