import assert from "node:assert/strict";

import {
  pushUnsupportedMessage,
  pushUnsupportedReason,
  requestOneSignalPermission,
  type OneSignalSdk,
} from "../src/lib/notifications/onesignal-client.ts";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Mobile/23G90 Safari/604.1";
const IPAD_DESKTOP_MODE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36";

// The owner's iPhone, 14 Nov 2026: Phoenix open in a Safari TAB, where iOS gives no web push at all.
// The enable button answered "your browser didn't grant notification permission … check your
// browser's site settings" — a switch Safari does not have. The reason must travel with the result
// so the caller says "Add to Home Screen" instead.
function runPushUnsupportedReasonCases() {
  const base = { maxTouchPoints: 0, standalone: false, hasNotification: true };
  assert.equal(
    pushUnsupportedReason({ ...base, userAgent: IPHONE_SAFARI, maxTouchPoints: 5, hasNotification: false }),
    "ios-home-screen",
    "an iPhone Safari tab must be told to add Phoenix to the Home Screen",
  );
  assert.equal(
    pushUnsupportedReason({ ...base, userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 5, hasNotification: false }),
    "ios-home-screen",
    "an iPad asking for the desktop site reports a Mac — its touch points must still mark it as iOS",
  );
  assert.equal(
    pushUnsupportedReason({ ...base, userAgent: IPHONE_SAFARI, maxTouchPoints: 5, standalone: true }),
    null,
    "Phoenix opened from the iPhone Home Screen with notifications available must go ahead to the real opt-in",
  );
  assert.equal(
    pushUnsupportedReason({ ...base, userAgent: IPHONE_SAFARI, maxTouchPoints: 5, standalone: true, hasNotification: false }),
    "ios-update",
    "a Home Screen app on iOS older than 16.4 has no notifications and must be told to update",
  );
  assert.equal(
    pushUnsupportedReason({ ...base, userAgent: IPAD_DESKTOP_MODE }),
    null,
    "a real Mac (no touch points) is not an iPad",
  );
  assert.equal(
    pushUnsupportedReason({ ...base, userAgent: ANDROID_CHROME, maxTouchPoints: 5, hasNotification: false }),
    "browser",
    "a browser with no Notification API (an in-app browser) must be told to open a real browser",
  );
  assert.equal(pushUnsupportedReason({ ...base, userAgent: ANDROID_CHROME, maxTouchPoints: 5 }), null);
  assert.match(pushUnsupportedMessage("ios-home-screen"), /Add to Home Screen/);
  assert.doesNotMatch(
    pushUnsupportedMessage("ios-home-screen"),
    /site settings/i,
    "the iPhone message must not send anyone to site settings, the very advice that misled the owner",
  );
}

// Regression guard for the 2026-08-02 frozen-button bug on /admin/profile.
//
// Observed in production, not theorised: Chrome had notifications BLOCKED for
// phoenix-hr.satopharma.com (Notification.permission === "denied"), so OneSignal.init()
// never completed and nothing ever drained window.OneSignalDeferred. requestOneSignalPermission()
// queued its callback onto that dead queue and returned a promise that settled NEITHER way.
// The Notification Settings panel therefore sat with every control disabled — measured still
// disabled 22s after the click, with anyVisibleError: [] — until the page was reloaded.
//
// The cruel part: the caller already had the right message for this case
// ("your browser didn't grant notification permission … allow notifications"), at
// notification-settings-panel.tsx. It simply never ran, because the promise it was awaiting
// never resolved. So this is a hang bug, not a missing-copy bug, and the test must assert
// SETTLEMENT — asserting the returned value alone would still pass against the broken code
// by hanging forever inside the runner.
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function fakeSdk(overrides?: { optedIn?: boolean; permission?: boolean }): OneSignalSdk {
  return {
    init: async () => {},
    login: async () => {},
    logout: async () => {},
    Notifications: { permission: overrides?.permission ?? true, requestPermission: async () => {} },
    User: {
      PushSubscription: {
        addEventListener: () => {},
        id: "subscription-1",
        optedIn: overrides?.optedIn ?? true,
        optIn: async () => {},
      },
    },
  };
}

export async function runPushEnableHangTests() {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    runPushUnsupportedReasonCases();

    // ---- 0. An iPhone Safari tab: no Notification API, so it must answer at once with the
    // reason, and never queue onto OneSignal (nothing there can succeed in a tab).
    const iphoneQueue: Array<(sdk: OneSignalSdk) => void | Promise<void>> = [];
    Reflect.deleteProperty(globalThis, "Notification");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: IPHONE_SAFARI, maxTouchPoints: 5 },
    });
    Reflect.set(globalThis, "window", {
      OneSignalDeferred: iphoneQueue,
      matchMedia: () => ({ matches: false }),
    });
    const iphone = await withDeadline(
      // A rejection is caught into the value so the assertion below names the defect.
      requestOneSignalPermission(50).catch((error: unknown) => ({ rejected: String(error) })),
      1_000,
      "requestOneSignalPermission never settled in an iPhone Safari tab",
    );
    assert.deepEqual(
      iphone,
      { optedIn: false, permission: false, unsupported: "ios-home-screen" },
      "an iPhone Safari tab must come back carrying the Home Screen reason, not as a plain browser refusal",
    );
    assert.equal(iphoneQueue.length, 0, "an iPhone tab must not queue onto OneSignalDeferred");
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");

    // ---- 1. THE REGRESSION: browser has permanently blocked notifications ----
    // Nothing drains this queue, exactly as in production.
    const deadQueue: Array<(sdk: OneSignalSdk) => void | Promise<void>> = [];
    Reflect.set(globalThis, "Notification", { permission: "denied" });
    Reflect.set(globalThis, "window", { OneSignalDeferred: deadQueue });

    const blocked = await withDeadline(
      requestOneSignalPermission(50),
      1_000,
      "requestOneSignalPermission NEVER SETTLED with Notification.permission === 'denied' — this is the frozen-button bug: the panel stays disabled forever and shows no error",
    );
    assert.deepEqual(
      blocked,
      { optedIn: false, permission: false },
      "a blocked browser must resolve { optedIn:false, permission:false } so the caller renders its 'allow notifications in your site settings' error",
    );
    assert.equal(
      deadQueue.length,
      0,
      "a blocked browser must not queue onto OneSignalDeferred at all — that undrained queue is the thing that hangs",
    );

    // ---- 2. SDK never loads / init throws: must time out loudly, not hang ----
    // permission "default" so the fast path above does NOT apply; this exercises the
    // timeout safety net that covers adblockers, CSP failures and a dead CDN.
    const neverDrained: Array<(sdk: OneSignalSdk) => void | Promise<void>> = [];
    Reflect.set(globalThis, "Notification", { permission: "default" });
    Reflect.set(globalThis, "window", { OneSignalDeferred: neverDrained });

    await assert.rejects(
      () =>
        withDeadline(
          requestOneSignalPermission(60),
          2_000,
          "requestOneSignalPermission NEVER SETTLED when the SDK failed to drain OneSignalDeferred — it must reject on its own timeout instead",
        ),
      /didn't finish setting up in time/,
      "an SDK that never drains the deferred queue must surface a readable error rather than freeze the button",
    );
    assert.equal(neverDrained.length, 1, "the un-blocked path should still queue its callback (that is the path that used to hang)");

    // ---- 3. Happy path still reports the SDK's REAL state ----
    // Guards against 'fixing' the hang by hard-coding a failure result.
    const liveQueue: Array<(sdk: OneSignalSdk) => void | Promise<void>> = [];
    Reflect.set(globalThis, "Notification", { permission: "default" });
    Reflect.set(globalThis, "window", { OneSignalDeferred: liveQueue });

    const pending = requestOneSignalPermission(2_000);
    // Drain the queue the way the real SDK does once it finishes loading.
    await Promise.all(liveQueue.map((callback) => callback(fakeSdk({ optedIn: true, permission: true }))));
    const granted = await withDeadline(pending, 2_000, "a successful opt-in must still settle");
    assert.deepEqual(
      granted,
      { optedIn: true, permission: true },
      "a successful opt-in must report the SDK's real state, not a canned failure",
    );

    // ---- 4. Granted-but-not-subscribed must stay distinguishable ----
    // permission true / optedIn false is the network-blocked-push-service case, which the
    // caller renders with a DIFFERENT message. Collapsing the two states would send a user
    // to check a browser setting that is already correct.
    const partialQueue: Array<(sdk: OneSignalSdk) => void | Promise<void>> = [];
    Reflect.set(globalThis, "window", { OneSignalDeferred: partialQueue });
    const partialPending = requestOneSignalPermission(2_000);
    await Promise.all(partialQueue.map((callback) => callback(fakeSdk({ optedIn: false, permission: true }))));
    const partial = await withDeadline(partialPending, 2_000, "the partial-success path must still settle");
    assert.deepEqual(
      partial,
      { optedIn: false, permission: true },
      "browser granted but push registration failed must stay distinct from browser-denied",
    );
  } finally {
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedNotification) Object.defineProperty(globalThis, "Notification", savedNotification);
    else Reflect.deleteProperty(globalThis, "Notification");
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}
