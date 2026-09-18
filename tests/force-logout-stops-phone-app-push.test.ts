import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deleteOneSignalSubscription } from "../src/lib/notifications/push.ts";
import { isPhoenixAppPushSubscription, stopPhoneAppPushForEmployee } from "../src/lib/notifications/settings.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

// What the app records for itself (describeThisDevice in mobile/src/lib/push.tsx), and what two
// browsers record, as they reach `push_subscriptions.user_agent`.
const APP = "Phoenix Workforce app 1.0.0 · samsung SM-A546E · Android 14";
const PHONE_BROWSER = "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const DESKTOP_BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const EARLIER = "2026-09-01T09:00:00.000Z";

// OneSignal's own answer for a subscription it no longer holds.
const NOT_FOUND = { errors: [{ code: "subscription-0", title: "Subscription not found" }] };
const SERVER_ERROR = { errors: [{ code: "internal-0", title: "Internal error" }] };

type OneSignalCall = { authorization: string | null; method: string; subscriptionId: string; url: string };

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function answer(status: number, body: unknown): Response {
  return { json: async () => body, ok: status >= 200 && status < 300, status } as unknown as Response;
}

/**
 * Runs `body` with fetch and the OneSignal settings stubbed, so nothing leaves this process. The
 * suite runs with production credentials, so a real OneSignal call from here would delete a real
 * employee's subscription; every id below is fake as well.
 */
async function withStubbedOneSignal<T>(
  respond: (subscriptionId: string) => Response,
  body: (calls: OneSignalCall[]) => Promise<T>,
  configured = true,
): Promise<T> {
  const saved = { apiKey: process.env.ONESIGNAL_REST_API_KEY, appId: process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID };
  const savedFetch = globalThis.fetch;
  const calls: OneSignalCall[] = [];
  try {
    if (configured) {
      process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID = "test-app-id";
      process.env.ONESIGNAL_REST_API_KEY = "test-rest-key";
    } else {
      delete process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID;
      delete process.env.ONESIGNAL_REST_API_KEY;
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const subscriptionId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      calls.push({ authorization: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET", subscriptionId, url });
      return respond(subscriptionId);
    }) as typeof fetch;
    return await body(calls);
  } finally {
    globalThis.fetch = savedFetch;
    restoreEnv("NEXT_PUBLIC_ONESIGNAL_APP_ID", saved.appId);
    restoreEnv("ONESIGNAL_REST_API_KEY", saved.apiKey);
  }
}

function subscriptionRow(id: string, hrId: string, deviceType: string, userAgent: string, status: "subscribed" | "unsubscribed") {
  return {
    device_type: deviceType,
    hr_id: hrId,
    onesignal_subscription_id: id,
    status,
    unsubscribed_at: status === "unsubscribed" ? EARLIER : null,
    updated_at: EARLIER,
    user_agent: userAgent,
  };
}

/**
 * Force logout stops the Phoenix app's notifications on the person's phones.
 *
 * Revoking the sessions cannot do that alone: to the app a revoked session looks like one that
 * lapsed, so it leaves push running and a lost phone keeps showing that employee's notifications.
 * The server deletes each app subscription at OneSignal instead. What this pins:
 *
 *   - the delete is the call OneSignal documents, and a subscription OneSignal no longer holds counts
 *     as stopped, while any other failure does not;
 *   - only the app's subscriptions are deleted, found by the words the app records for itself: never
 *     a phone browser (the web SDK would not bring it back after the person signs in again), a
 *     computer, or anyone else's;
 *   - a row is marked unsubscribed only once OneSignal confirmed, so pressing Force logout again
 *     retries exactly what failed;
 *   - Force logout runs it after revoking the sessions and never lets it undo them.
 */
export async function runForceLogoutStopsPhoneAppPushTests() {
  // --- One delete, as OneSignal answers it. -------------------------------------------------------
  await withStubbedOneSignal(() => answer(202, {}), async (calls) => {
    assert.equal(await deleteOneSignalSubscription(" sub-1 "), "deleted", "OneSignal's 202 means the subscription is gone and delivery to it has stopped");
    assert.deepEqual(
      calls.map(({ authorization, method, url }) => ({ authorization, method, url })),
      [{ authorization: "Key test-rest-key", method: "DELETE", url: "https://api.onesignal.com/apps/test-app-id/subscriptions/sub-1" }],
      "the delete is OneSignal's Delete Subscription call, authorised with the same REST key the send uses",
    );
  });

  await withStubbedOneSignal(() => answer(404, NOT_FOUND), async () => {
    assert.equal(
      await deleteOneSignalSubscription("sub-1"),
      "already-gone",
      "a subscription OneSignal no longer holds is already the state Force logout wants, so a retry is not a failure",
    );
  });

  await withStubbedOneSignal(() => answer(404, { errors: [{ code: "app-0", title: "App not found" }] }), async () => {
    await assert.rejects(
      deleteOneSignalSubscription("sub-1"),
      /\(HTTP 404\): App not found/,
      "a 404 that is not about the subscription deleted nothing, so it must never be reported as stopped",
    );
  });

  await withStubbedOneSignal(() => answer(500, SERVER_ERROR), async () => {
    await assert.rejects(deleteOneSignalSubscription("sub-1"), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\(HTTP 500\): Internal error \/ internal-0/, "OneSignal's own words reach the log");
      assert.doesNotMatch(error.message, /\[object Object\]/, "object-shaped errors are spelled out, not printed as [object Object]");
      return true;
    });
  });

  await withStubbedOneSignal(() => answer(202, {}), async (calls) => {
    await assert.rejects(deleteOneSignalSubscription("sub-1"), /not configured/);
    assert.equal(calls.length, 0, "without OneSignal settings nothing is sent anywhere");
  }, false);

  await withStubbedOneSignal(() => answer(202, {}), async (calls) => {
    await assert.rejects(deleteOneSignalSubscription("   "), /missing/);
    assert.equal(calls.length, 0, "a blank id never becomes a request against the app's subscription list");
  });

  // --- Which rows are the app's. ------------------------------------------------------------------
  assert.equal(isPhoenixAppPushSubscription({ device_type: "mobile", user_agent: APP }), true, "the app's own row");
  assert.equal(
    isPhoenixAppPushSubscription({ device_type: "mobile", user_agent: PHONE_BROWSER }),
    false,
    "a phone browser is `mobile` too, and must not be taken for the app",
  );
  assert.equal(isPhoenixAppPushSubscription({ device_type: "desktop", user_agent: APP }), false, "only a `mobile` row can be the app");
  assert.equal(isPhoenixAppPushSubscription({ device_type: "mobile", user_agent: null }), false, "a row with no description is not the app");

  // --- A whole Force logout, against rows shaped like the real table. -------------------------------
  const client = fakeSupabaseClient(
    {
      push_subscriptions: [
        subscriptionRow("app-live", "TEST-FL-1", "mobile", APP, "subscribed"),
        subscriptionRow("app-gone", "TEST-FL-1", "mobile", APP, "subscribed"),
        subscriptionRow("app-old", "TEST-FL-1", "mobile", APP, "unsubscribed"),
        subscriptionRow("app-fails", "TEST-FL-1", "mobile", APP, "subscribed"),
        subscriptionRow("phone-browser", "TEST-FL-1", "mobile", PHONE_BROWSER, "subscribed"),
        subscriptionRow("computer", "TEST-FL-1", "desktop", DESKTOP_BROWSER, "subscribed"),
        subscriptionRow("someone-else", "TEST-FL-2", "mobile", APP, "subscribed"),
      ],
    },
    { projectColumns: true },
  );
  const row = (id: string) => client.rows("push_subscriptions").find((candidate) => candidate.onesignal_subscription_id === id);
  const failing = new Set(["app-fails"]);
  const respond = (subscriptionId: string) => {
    if (subscriptionId === "app-gone") return answer(404, NOT_FOUND);
    if (failing.has(subscriptionId)) return answer(500, SERVER_ERROR);
    return answer(202, {});
  };

  await withStubbedOneSignal(respond, async (calls) => {
    // Lower case on purpose: the table stores the upper-case spelling, and a case-sensitive match
    // would stop nothing while reporting success.
    const first = await stopPhoneAppPushForEmployee("test-fl-1", client as never);
    assert.deepEqual(
      first,
      { failed: 1, stopped: 2 },
      "two phones were receiving and are not now; one could not be stopped and is reported, never counted as stopped",
    );
    assert.deepEqual(
      calls.map((call) => call.subscriptionId).sort(),
      ["app-fails", "app-gone", "app-live", "app-old"],
      "every app install of this person is deleted, whatever its status; never a phone browser, a computer or someone else",
    );

    for (const id of ["app-live", "app-gone"]) {
      assert.equal(row(id)?.status, "unsubscribed", `${id}: a stopped phone is recorded as no longer reachable`);
      assert.notEqual(row(id)?.unsubscribed_at, null, `${id}: and when that happened`);
    }
    assert.equal(row("app-old")?.unsubscribed_at, EARLIER, "a row that was already off keeps the date it went off");
    assert.equal(row("app-fails")?.status, "subscribed", "a failed delete leaves the row as it was, so a retry picks it up");
    for (const id of ["phone-browser", "computer", "someone-else"]) {
      assert.equal(row(id)?.status, "subscribed", `${id}: untouched`);
      assert.equal(row(id)?.updated_at, EARLIER, `${id}: not even re-stamped`);
    }

    // Pressing Force logout again, once OneSignal answers: only what is left is stopped.
    failing.clear();
    calls.length = 0;
    const retry = await stopPhoneAppPushForEmployee("TEST-FL-1", client as never);
    assert.deepEqual(retry, { failed: 0, stopped: 1 }, "the retry stops the phone the first press could not, and counts nothing twice");
    assert.equal(row("app-fails")?.status, "unsubscribed", "the retried phone is recorded as stopped");
  });

  // --- When there is nothing this server could stop. ---------------------------------------------
  const unconfigured = fakeSupabaseClient({ push_subscriptions: [subscriptionRow("app-live", "TEST-FL-1", "mobile", APP, "subscribed")] });
  await withStubbedOneSignal(() => answer(202, {}), async (calls) => {
    assert.deepEqual(await stopPhoneAppPushForEmployee("TEST-FL-1", unconfigured as never), { failed: 0, stopped: 0 });
    assert.equal(calls.length, 0, "a server without OneSignal sends no push, so it has nothing to stop and calls nobody");
    assert.equal(unconfigured.rows("push_subscriptions")[0]?.status, "subscribed", "and it records nothing it did not do");
  }, false);

  const noTable = fakeSupabaseClient({}, { failOn: { push_subscriptions: "Could not find the table 'public.push_subscriptions' in the schema cache" } });
  await withStubbedOneSignal(() => answer(202, {}), async (calls) => {
    assert.deepEqual(await stopPhoneAppPushForEmployee("TEST-FL-1", noTable as never), { failed: 0, stopped: 0 });
    assert.equal(calls.length, 0);
  });

  const unreadable = fakeSupabaseClient({}, { failOn: { push_subscriptions: "permission denied for table push_subscriptions" } });
  await withStubbedOneSignal(() => answer(202, {}), async () => {
    await assert.rejects(
      stopPhoneAppPushForEmployee("TEST-FL-1", unreadable as never),
      /Could not read the phone push subscriptions/,
      "a read that fails is an error Force logout reports, never a quiet 'no phones'",
    );
  });

  // --- Force logout calls it after the sessions are revoked, and it can never undo them. ----------
  const service = readFileSync(new URL("../src/lib/activity/service.ts", import.meta.url), "utf8");
  const forceLogout = service.slice(service.indexOf("export async function forceLogoutUser"));
  const forceLogoutBody = forceLogout.slice(0, forceLogout.indexOf("\n}") + 2);
  const revoke = forceLogoutBody.indexOf('.from("app_sessions")');
  const stop = forceLogoutBody.indexOf("stopPhoneAppPushForEmployee(hrId)");
  assert.ok(revoke >= 0 && stop > revoke, "Force logout stops the phone app's notifications, after it revokes the sessions");
  assert.match(
    forceLogoutBody,
    /try \{\s*phonePush = await stopPhoneAppPushForEmployee\(hrId\);\s*\} catch \(\w+\) \{\s*logError\(/,
    "a failure to stop the phone is logged and reported; it never turns a completed logout into an error",
  );
  assert.match(forceLogoutBody, /return \{ phonePush, revokedCount/, "Force logout returns what happened on the phones");

  const route = readFileSync(new URL("../app/api/admin/activity/force-logout/route.ts", import.meta.url), "utf8");
  assert.match(route, /phonePush: result\.phonePush/, "the dashboard is told what happened on the phones");

  // The server finds the app's rows by the words the app writes. If the app stops writing them,
  // Force logout silently stops nothing.
  const app = readFileSync(new URL("../mobile/src/lib/push.tsx", import.meta.url), "utf8");
  const describe = app.slice(app.indexOf("function describeThisDevice"));
  assert.match(
    describe.slice(0, describe.indexOf("\n}")),
    /`Phoenix Workforce app \$\{/,
    "the app's device description still opens with the words isPhoenixAppPushSubscription looks for",
  );
}
