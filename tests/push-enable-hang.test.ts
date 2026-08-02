import assert from "node:assert/strict";

import { requestOneSignalPermission, type OneSignalSdk } from "../src/lib/notifications/onesignal-client.ts";

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

  try {
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
  }
}
