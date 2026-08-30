import assert from "node:assert/strict";

import { sendPushNotification } from "../src/lib/notifications/push.ts";

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/**
 * Regression for the desktop push notification click target resolving to a dead host.
 *
 * Every caller of sendPushNotification() passes an app-relative actionUrl (e.g.
 * "/api/probation/redirect?employeeHrId=AI-0005"), the same shape email and Telegram already
 * resolve against NOTIFICATION_DASHBOARD_URL/NEXT_PUBLIC_APP_URL before sending. Push skipped
 * that step and sent the relative path straight through as OneSignal's `url` field, so OneSignal
 * fell back to its own dashboard-configured default — which had drifted to the old Cloud Run
 * bind address (0.0.0.0:8080) and broke every desktop notification's click target in production.
 */
export async function runPushActionUrlResolutionTests() {
  const savedEnv = {
    appId: process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID,
    apiKey: process.env.ONESIGNAL_REST_API_KEY,
    dashboardUrl: process.env.NOTIFICATION_DASHBOARD_URL,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
  };
  const savedFetch = globalThis.fetch;
  const capturedUrls: (string | undefined)[] = [];

  async function sendAndCapture(actionUrl: string) {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      capturedUrls.push(body.url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "test-notification-id" }),
      } as unknown as Response;
    }) as typeof fetch;

    await sendPushNotification({
      actionUrl,
      externalId: "AI-0005",
      message: "Your probation feedback is due.",
      title: "Probation reminder",
    });
  }

  try {
    process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID = "test-app-id";
    process.env.ONESIGNAL_REST_API_KEY = "test-rest-key";

    // NOTIFICATION_DASHBOARD_URL takes priority when set.
    process.env.NOTIFICATION_DASHBOARD_URL = "https://phoenix-hr.satopharma.com";
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendAndCapture("/api/probation/redirect?employeeHrId=AI-0005");
    assert.equal(
      capturedUrls.at(-1),
      "https://phoenix-hr.satopharma.com/api/probation/redirect?employeeHrId=AI-0005",
      "a relative actionUrl must resolve against NOTIFICATION_DASHBOARD_URL",
    );

    // Falls back to NEXT_PUBLIC_APP_URL when NOTIFICATION_DASHBOARD_URL is unset.
    delete process.env.NOTIFICATION_DASHBOARD_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://phoenix-hr.satopharma.com";
    await sendAndCapture("/api/probation/redirect?employeeHrId=AI-0005");
    assert.equal(
      capturedUrls.at(-1),
      "https://phoenix-hr.satopharma.com/api/probation/redirect?employeeHrId=AI-0005",
      "must fall back to NEXT_PUBLIC_APP_URL when NOTIFICATION_DASHBOARD_URL is unset",
    );

    // An already-absolute actionUrl must never be re-prefixed.
    await sendAndCapture("https://phoenix-hr.satopharma.com/api/already/absolute");
    assert.equal(
      capturedUrls.at(-1),
      "https://phoenix-hr.satopharma.com/api/already/absolute",
      "an already-absolute actionUrl must pass through untouched, never double-prefixed",
    );

    // With neither base env var set, the relative path passes through as-is — the pre-existing
    // behavior for a misconfigured environment, not a new regression from this fix.
    delete process.env.NEXT_PUBLIC_APP_URL;
    await sendAndCapture("/api/probation/redirect?employeeHrId=AI-0005");
    assert.equal(
      capturedUrls.at(-1),
      "/api/probation/redirect?employeeHrId=AI-0005",
      "with no base URL configured, the relative path passes through unresolved",
    );
  } finally {
    globalThis.fetch = savedFetch;
    restoreEnv("NEXT_PUBLIC_ONESIGNAL_APP_ID", savedEnv.appId);
    restoreEnv("ONESIGNAL_REST_API_KEY", savedEnv.apiKey);
    restoreEnv("NOTIFICATION_DASHBOARD_URL", savedEnv.dashboardUrl);
    restoreEnv("NEXT_PUBLIC_APP_URL", savedEnv.appUrl);
  }
}
