import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolvePushLink } from "../mobile/src/lib/push-link.ts";
import { sendPushNotification } from "../src/lib/notifications/push.ts";

const PRODUCTION = "https://phoenix-hr.satopharma.com";
const STAGING = "https://phoenix-people-workforce-staging.up.railway.app";

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** The `url` the server really puts on a push for `actionUrl`, read off the OneSignal request. */
async function linkTheServerSends(actionUrl: string, dashboardUrl: string | null): Promise<unknown> {
  const saved = {
    apiKey: process.env.ONESIGNAL_REST_API_KEY,
    appId: process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID,
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    dashboardUrl: process.env.NOTIFICATION_DASHBOARD_URL,
  };
  const savedFetch = globalThis.fetch;
  let sent: unknown;

  try {
    process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID = "test-app-id";
    process.env.ONESIGNAL_REST_API_KEY = "test-rest-key";
    delete process.env.NEXT_PUBLIC_APP_URL;
    if (dashboardUrl) process.env.NOTIFICATION_DASHBOARD_URL = dashboardUrl;
    else delete process.env.NOTIFICATION_DASHBOARD_URL;

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent = init?.body ? JSON.parse(String(init.body)).url : undefined;
      return { json: async () => ({ id: "test-notification-id" }), ok: true, status: 200 } as unknown as Response;
    }) as typeof fetch;

    // fetch is stubbed above, so nothing leaves this process; the ID is fake all the same.
    await sendPushNotification({ actionUrl, externalId: "TEST-PUSH-LINK", message: "Body", title: "Title" });
  } finally {
    globalThis.fetch = savedFetch;
    restoreEnv("NEXT_PUBLIC_ONESIGNAL_APP_ID", saved.appId);
    restoreEnv("ONESIGNAL_REST_API_KEY", saved.apiKey);
    restoreEnv("NEXT_PUBLIC_APP_URL", saved.appUrl);
    restoreEnv("NOTIFICATION_DASHBOARD_URL", saved.dashboardUrl);
  }
  return sent;
}

/**
 * A tapped notification on the Android app goes where the portal link says — inside the app when
 * the app has that screen, to the browser when it does not, and nowhere outside Phoenix.
 *
 * The phone gets the same push as the browser, carrying a web portal link built by
 * `resolvePushActionUrl`. `mobile/src/lib/push-link.ts` turns that link into a tap. Three failures
 * this pins, each of which would ship silently because no screen shows them:
 *
 *   - the app screens stop matching what the server sends (the links below are produced by the real
 *     `sendPushNotification`, so a change to how the server builds them lands here too);
 *   - a Phoenix page the app has no screen for goes nowhere, which reads as a broken notification;
 *   - a link that is not Phoenix's is opened. Only Phoenix sends these pushes, so a foreign link is a
 *     mistake to contain — including the look-alikes a browser would resolve to another host.
 */
export async function runMobilePushLinkTests() {
  // --- Links exactly as the production server builds them. ---------------------------------------
  const home = await linkTheServerSends("/employee-portals", PRODUCTION);
  assert.equal(home, `${PRODUCTION}/employee-portals`, "the server's link base is the production domain");
  assert.deepEqual(
    resolvePushLink(home, PRODUCTION),
    { href: "/(portal)", kind: "screen" },
    "a notification pointing at the portal home opens the app's Home screen, not a web page",
  );

  assert.deepEqual(
    resolvePushLink(await linkTheServerSends("/employee-portals/profile", PRODUCTION), PRODUCTION),
    { href: "/(portal)/profile", kind: "screen" },
    "a notification pointing at the portal profile opens the app's Profile screen",
  );

  assert.deepEqual(
    resolvePushLink(await linkTheServerSends("/employee-portals/approvals/vacation/812", PRODUCTION), PRODUCTION),
    { kind: "browser", url: `${PRODUCTION}/employee-portals/approvals/vacation/812` },
    "a Phoenix page the app has no screen for opens in the browser rather than going nowhere",
  );

  assert.deepEqual(
    resolvePushLink(
      await linkTheServerSends("/api/probation/redirect?employeeHrId=AI-0005", PRODUCTION),
      PRODUCTION,
    ),
    { kind: "browser", url: `${PRODUCTION}/api/probation/redirect?employeeHrId=AI-0005` },
    "the query survives the trip to the browser — a redirect link is useless without it",
  );

  // A server with no base URL configured sends the path as it is; it is still a Phoenix path.
  const relative = await linkTheServerSends("/employee-portals/profile", null);
  assert.equal(relative, "/employee-portals/profile", "with no base URL the server sends the bare path");
  assert.deepEqual(
    resolvePushLink(relative, PRODUCTION),
    { href: "/(portal)/profile", kind: "screen" },
    "a bare path is a Phoenix path and opens the app screen",
  );
  assert.deepEqual(
    resolvePushLink("/employee-portals/expenses", STAGING),
    { kind: "browser", url: `${STAGING}/employee-portals/expenses` },
    "a bare path opens on the server this build talks to, never on a hard-coded domain",
  );

  // --- The same page, written differently. ---------------------------------------------------------
  assert.deepEqual(resolvePushLink(`${PRODUCTION}/employee-portals/`, PRODUCTION), { href: "/(portal)", kind: "screen" });
  assert.deepEqual(
    resolvePushLink("https://PHOENIX-HR.satopharma.com/employee-portals", PRODUCTION),
    { href: "/(portal)", kind: "screen" },
    "a host that differs only in letter case is the same host",
  );
  assert.deepEqual(resolvePushLink(`  ${PRODUCTION}/employee-portals  `, PRODUCTION), { href: "/(portal)", kind: "screen" });

  // --- An app screen only when the link asks for nothing the screen cannot show. -----------------
  assert.deepEqual(
    resolvePushLink(`${PRODUCTION}/employee-portals?tab=leave`, PRODUCTION),
    { kind: "browser", url: `${PRODUCTION}/employee-portals?tab=leave` },
    "a query on an app screen's page would be silently dropped by the app, so it goes to the browser",
  );
  assert.deepEqual(
    resolvePushLink("/employee-portals/profile#photo", PRODUCTION),
    { kind: "browser", url: `${PRODUCTION}/employee-portals/profile#photo` },
  );
  assert.deepEqual(
    resolvePushLink(`${PRODUCTION}/employee-portals/profile/documents`, PRODUCTION),
    { kind: "browser", url: `${PRODUCTION}/employee-portals/profile/documents` },
    "only the exact page maps to a screen — a page below it is a different page",
  );

  // --- Nothing outside Phoenix is ever opened. ------------------------------------------------------
  const foreign: Array<[link: string, server: string, why: string]> = [
    ["https://evil.example/employee-portals", PRODUCTION, "another domain"],
    ["https://phoenix-hr.satopharma.com.evil.example/employee-portals", PRODUCTION, "a look-alike with Phoenix's name as a prefix"],
    ["https://phoenix-hr.satopharma.com@evil.example/employee-portals", PRODUCTION, "Phoenix's name as a username on another host"],
    ["http://phoenix-hr.satopharma.com/employee-portals", PRODUCTION, "Phoenix over plain http"],
    ["https://phoenix-hr.satopharma.com:8443/employee-portals", PRODUCTION, "Phoenix's host on another port"],
    ["//evil.example/employee-portals", PRODUCTION, "a protocol-relative link, which names another host"],
    ["/\\evil.example/employee-portals", PRODUCTION, "a backslash, which a browser reads as a slash and so as another host"],
    ["https:\\\\evil.example/employee-portals", PRODUCTION, "backslashes in place of the slashes"],
    ["https://phoenix-hr.satopharma.com/employee portals", PRODUCTION, "a space a browser would rewrite"],
    [`/employee-${String.fromCharCode(0)}portals`, PRODUCTION, "a NUL, which no real link carries"],
    [`/employee-portals${String.fromCharCode(0x7f)}`, PRODUCTION, "a DEL, which no real link carries"],
    ["javascript:alert(1)", PRODUCTION, "a script"],
    ["phoenix://employee-portals", PRODUCTION, "the app's own scheme"],
    ["employee-portals", PRODUCTION, "a path with no leading slash"],
    [`${PRODUCTION}/employee-portals`, STAGING, "a production link reaching a build that talks to staging"],
  ];
  for (const [link, server, why] of foreign) {
    assert.equal(resolvePushLink(link, server), null, `not Phoenix's, so the tap only opens the app: ${why}`);
  }

  for (const nothing of [undefined, null, 42, {}, "", "   "]) {
    assert.equal(resolvePushLink(nothing, PRODUCTION), null, "a notification with no link just opens the app");
  }
  assert.equal(resolvePushLink(`${PRODUCTION}/employee-portals`, "not a url"), null, "no server, nothing is Phoenix's");

  // --- The phone joins OneSignal with what the context route returns. -------------------------------
  // `mobile/src/lib/push.tsx` reads `data.appId` and `data.hrId` from this route and does nothing
  // without both. The web provider reads only `hrId`, so dropping `appId` would break the phone and
  // leave the browser — and every web check — perfectly green.
  const route = readFileSync(new URL("../app/api/notifications/push/context/route.ts", import.meta.url), "utf8");
  assert.match(
    route,
    /data:\s*\{\s*appId:\s*onesignalAppId\(\),\s*hrId\s*\}/,
    "the push context route returns the OneSignal app ID alongside the HR ID, from the same env var the server sends with",
  );
  assert.match(route, /const hrId = pushIdentityOf\(access\);/, "the route answers through the one push-identity rule");
  const pushIdentity = readFileSync(new URL("../src/lib/notifications/push-identity.ts", import.meta.url), "utf8");
  assert.match(pushIdentity, /access\.hrId\.trim\(\)\.toUpperCase\(\)/, "the HR ID stays in the uppercased form pushes are addressed to");
}
