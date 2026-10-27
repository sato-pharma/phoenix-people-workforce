export type OneSignalPushSubscriptionChangeEvent = {
  current: { id: string | null; optedIn: boolean };
};

export type OneSignalSdk = {
  init: (options: { allowLocalhostAsSecureOrigin?: boolean; appId: string }) => Promise<void>;
  login: (externalId: string) => Promise<void>;
  logout: () => Promise<void>;
  Notifications: {
    permission: boolean;
    requestPermission: () => Promise<void>;
  };
  User: {
    PushSubscription: {
      addEventListener: (event: "change", handler: (event: OneSignalPushSubscriptionChangeEvent) => void) => void;
      id: string | null;
      optedIn: boolean;
      optIn: () => Promise<void>;
    };
  };
};

declare global {
  interface Window {
    OneSignal?: OneSignalSdk;
    OneSignalDeferred?: Array<(OneSignal: OneSignalSdk) => void | Promise<void>>;
  }
}

export function onesignalAppId() {
  return process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID?.trim() || null;
}

/**
 * Whether this browser mirrors its push subscription into push_subscriptions, read off the answer
 * /api/notifications/push/context gave. A session the server gave NO push identity (`hrId: null`) has
 * nothing to register as: a test account (whose HR id is the real person it mirrors), the Super
 * Admin's View as Seat, and the system-administrator console login. For a test account the register
 * POST is refused before it runs — and that refusal, on a call the tester never pressed, was sent
 * from every page it opened (8 of TEST-DF's 9 refusals, 27–28 Oct 2026). So it is not sent at all.
 *
 * Only a definite "no identity" stops it. A context read that failed or answered something unreadable
 * keeps the old behaviour and reports, so a real employee's subscription never goes stale because
 * one read hiccupped.
 */
export function shouldReportPushSubscription(contextOk: boolean, payload: unknown): boolean {
  if (!contextOk) return true;
  const data = (payload as { data?: { hrId?: unknown } } | null)?.data;
  if (!data || typeof data !== "object") return true;
  return !("hrId" in data && data.hrId === null);
}

// The official pattern: OneSignal's CDN script defines window.OneSignal asynchronously,
// so every call site pushes a callback onto OneSignalDeferred instead of touching
// window.OneSignal directly (which may not exist yet).
export function withOneSignal(callback: (OneSignal: OneSignalSdk) => void | Promise<void>) {
  if (typeof window === "undefined") return;
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(callback);
}

export function detectDeviceType(): "desktop" | "mobile" | "unknown" {
  if (typeof navigator === "undefined") return "unknown";
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop";
}

export type EnablePushResult = {
  optedIn: boolean;
  permission: boolean;
};

// Activates push for this browser. Must be called from a user gesture (button click) —
// browsers silently ignore or auto-block a permission request that fires without one.
//
// PushSubscription.optIn() (not Notifications.requestPermission()) is the correct call
// here: per OneSignal's docs, optIn() shows the native permission prompt itself when
// there's no valid push token yet, AND marks the subscription "subscribed" on OneSignal's
// side once granted. requestPermission() only resolves the BROWSER-level permission — it
// never flips OneSignal's own subscription status, so a user could show as
// Notification.permission === "granted" in their browser while OneSignal never creates a
// subscription at all (confirmed in production: browser permission "Allowed", zero rows
// in push_subscriptions). Do not swap this back to requestPermission() without solving
// that gap some other way.
//
// optIn() itself resolves whether or not the user actually grants permission — a denied
// or already-blocked prompt does NOT reject the promise. Callers MUST check the returned
// `optedIn`/`permission` state rather than assuming success just because this resolved,
// or a denied user gets told "push enabled" when nothing was actually turned on.

// Waits for the OneSignal service worker registration to have an active worker, or
// resolves after `timeoutMs` regardless. This prevents the "Registration does not have
// an active worker" TypeError on Safari (and occasionally other browsers) where
// optIn() internally calls showNotification() before the SW has fully activated.
// navigator.serviceWorker.ready resolves with the first registration that has an active
// worker at the current scope — which is the OneSignalSDKWorker registered at "/".
function waitForServiceWorkerReady(timeoutMs = 10_000): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve();
  }
  const ready = navigator.serviceWorker.ready.then(() => undefined);
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs));
  return Promise.race([ready, timeout]);
}

// Upper bound on the whole enable-push attempt. withOneSignal() only QUEUES its callback
// onto window.OneSignalDeferred — it is the SDK that drains that queue, so if the SDK
// never loads or OneSignal.init() throws, the callback simply never runs and a promise
// built around it settles neither way. Without this ceiling the caller's button stays
// disabled until the user reloads the page. Generous enough to cover a slow CDN plus the
// 10s service-worker wait below, short enough that nobody sits in front of a dead button.
const ENABLE_PUSH_TIMEOUT_MS = 20_000;

// True when this browser has permanently blocked notifications for the origin. Once a user
// (or an enterprise policy) blocks a site, browsers never surface the permission prompt
// again — so optIn() cannot succeed, and cannot fail loudly either.
function notificationsBlockedByBrowser() {
  return typeof Notification !== "undefined" && Notification.permission === "denied";
}

// `timeoutMs` is injectable for tests only; production always uses the constant above.
export function requestOneSignalPermission(timeoutMs = ENABLE_PUSH_TIMEOUT_MS): Promise<EnablePushResult> {
  // Fast path for an already-blocked browser. Confirmed in production 2026-08-02 on
  // phoenix-hr.satopharma.com: Notification.permission === "denied", zero service-worker
  // registrations, OneSignalDeferred still holding an undrained callback, and the settings
  // panel still disabled 22s after the click with no error rendered. The caller already
  // renders the correct "allow notifications in your site settings" message for
  // { optedIn: false, permission: false }, so returning that shape immediately turns a
  // permanent freeze into instant, accurate feedback — and avoids queueing onto a dead
  // queue in the first place.
  if (notificationsBlockedByBrowser()) {
    return Promise.resolve({ optedIn: false, permission: false });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          "Push notifications didn't finish setting up in time. Reload the page and try again — if it keeps happening, a browser extension, VPN, or your network may be blocking OneSignal.",
        ),
      );
    }, timeoutMs);

    // Every exit path goes through here so a late callback after the timeout cannot
    // resolve an already-rejected promise (silently doing nothing) or leave the timer
    // running past a successful opt-in.
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };

    withOneSignal(async (OneSignal) => {
      try {
        // Wait for the service worker to reach "active" state before calling optIn().
        // On Safari the SW lifecycle is stricter: optIn() triggers showNotification()
        // internally, which throws "Registration does not have an active worker" when
        // called against a registration that is still in the installing/waiting phase.
        await waitForServiceWorkerReady();
        await OneSignal.User.PushSubscription.optIn();
        settle(() =>
          resolve({
            optedIn: OneSignal.User.PushSubscription.optedIn,
            permission: OneSignal.Notifications.permission,
          }),
        );
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error("Unable to enable push notifications.")));
      }
    });
  });
}

// Unbinds this browser from the signed-out user's OneSignal identity so a shared device
// doesn't keep receiving that person's pushes after someone else signs in. Best-effort —
// a failure here must never block sign-out itself.
export function logoutOneSignal(): void {
  withOneSignal((OneSignal) => {
    OneSignal.logout().catch(() => {
      // Best-effort — sign-out proceeds regardless.
    });
  });
}
