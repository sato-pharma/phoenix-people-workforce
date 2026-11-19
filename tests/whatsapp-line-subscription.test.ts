import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  appIsSubscribedToAccount,
  evaluateWebhookRouting,
  expectedWebhookUrl,
  fetchWebhookRouting,
  quietLinesDetail,
  type WhatsAppLineAccount,
} from "../src/lib/recruitment/inbound/whatsapp-health.ts";
import {
  __resetWhatsAppResubscribeAttemptsForTests,
  describeResubscribeResults,
  resubscribeUnsubscribedWhatsAppLines,
  whatsAppResubscribeRefusal,
} from "../src/lib/recruitment/inbound/whatsapp-line-resubscribe.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A WHATSAPP LINE WHOSE BUSINESS ACCOUNT DROPPED THE PHOENIX APP IS NAMED, AND PUT BACK (owner,
 * 19 Nov 2026: "automate this").
 *
 * Found that day: the Recruitment line (+20 10 98500699, the number every advert carries) received no
 * applicant from 11 Nov 22:40 Cairo, while the HR handset on the same webhook kept receiving — and
 * every routing check read healthy, so all the alert could say for four days was "gone quiet". Meta
 * keeps a line's delivery on its business account's list of subscribed apps, the two lines sit in two
 * accounts, and nothing asked either account.
 *
 *   1. The routing check asks each line's business account (GET /{account}/subscribed_apps). An account
 *      that lists the app passes; one that does not names the line and makes the routing fail, which
 *      the alert reports as "not being delivered here". An unreadable answer is UNVERIFIED — never a
 *      failure, never a reason to act.
 *   2. The intake job re-subscribes such an account (POST, the connect screen's own call), production
 *      only, once an hour per account, and the alert says what was done or what Meta answered.
 *   3. A line quiet while its account is confirmed subscribed is called what it then is: applicants not
 *      messaging the number, so the person reading it looks at the adverts, not at Meta.
 *
 * Nothing here reaches Meta: fetch is stubbed and every other host is refused.
 */

const RECRUITMENT: WhatsAppLineAccount = {
  businessAccountId: "2265574670642375",
  displayNumber: "+20 10 98500699",
  label: "Recruitment line",
  phoneNumberId: "1319071451278873",
};
const HANDSET_PHONE_ID = "477586495433549";
const HANDSET_ACCOUNT = "365968989943377";
const APP_ID = "APP-1";

type Call = { url: string; method: string; authorization: string | null };

async function withGraph(
  answers: (url: URL, method: string) => { status: number; body: unknown },
  body: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const names = [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_PHONE_NUMBER_IDS",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_GRAPH_API_VERSION",
    "WHATSAPP_INBOX_RECRUITMENT_PHONE_NUMBER_ID",
    "WHATSAPP_INBOX_RECRUITMENT_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_INBOX_HANDSET_PHONE_NUMBER_ID",
    "WHATSAPP_INBOX_HANDSET_BUSINESS_ACCOUNT_ID",
  ];
  const saved = names.map((name) => [name, env[name]] as const);
  for (const name of names) delete env[name];
  env.WHATSAPP_ACCESS_TOKEN = "stand-in-token";
  env.WHATSAPP_APP_SECRET = "stand-in-secret";
  env.WHATSAPP_PHONE_NUMBER_IDS = `${RECRUITMENT.phoneNumberId},${HANDSET_PHONE_ID}`;
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? undefined);
    calls.push({ authorization: headers.get("authorization"), method, url: url.toString() });
    if (url.host !== "graph.facebook.com") throw new Error(`the test refuses ${url.host}`);
    const answer = answers(url, method);
    return new Response(JSON.stringify(answer.body), { headers: { "content-type": "application/json" }, status: answer.status });
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

/** Meta as it answers when everything is wired, with each account's subscribed-apps list chosen. */
function meta(accounts: Record<string, { status: number; body: unknown }>) {
  return (url: URL, method: string) => {
    const path = url.pathname.replace(/^\/v[0-9.]+\//, "");
    if (path === "debug_token") return { body: { data: { app_id: APP_ID } }, status: 200 };
    if (path === `${APP_ID}/subscriptions`) {
      return {
        body: { data: [{ active: true, callback_url: expectedWebhookUrl(), fields: [{ name: "messages" }], object: "whatsapp_business_account" }] },
        status: 200,
      };
    }
    if (url.searchParams.get("fields") === "webhook_configuration") return { body: {}, status: 200 };
    const account = path.match(/^(\d+)\/subscribed_apps$/)?.[1];
    if (account && method === "GET") return accounts[account] ?? { body: { error: { message: "unknown account" } }, status: 404 };
    return { body: { error: { message: `unexpected ${method} ${path}` } }, status: 400 };
  };
}

const LISTS_APP = { body: { data: [{ whatsapp_business_api_data: { id: APP_ID, name: "Phoenix" } }] }, status: 200 };
const LISTS_NOTHING = { body: { data: [] }, status: 200 };
const LISTS_ANOTHER_APP = { body: { data: [{ whatsapp_business_api_data: { id: "SOME-OTHER-APP" } }] }, status: 200 };
const REFUSED = { body: { error: { message: "(#200) Permissions error" } }, status: 403 };

function testReadingTheSubscribedAppsAnswer() {
  assert.equal(appIsSubscribedToAccount(LISTS_APP.body, APP_ID), true);
  assert.equal(appIsSubscribedToAccount(LISTS_NOTHING.body, APP_ID), false, "an empty list is a readable NO");
  assert.equal(appIsSubscribedToAccount(LISTS_ANOTHER_APP.body, APP_ID), false, "another app on the account is not ours");
  assert.equal(appIsSubscribedToAccount(null, APP_ID), null, "no answer is unverified, never a no");
  assert.equal(appIsSubscribedToAccount(REFUSED.body, APP_ID), null, "an error body is unverified, never a no");
}

function testAnUnsubscribedAccountFailsTheRouting() {
  const healthy = evaluateWebhookRouting({
    answerable: true,
    expectedCallbackUrl: "https://phoenix.example/api/webhooks/whatsapp",
    numberOverrideUrl: null,
    subscription: { active: true, callback_url: "https://phoenix.example/api/webhooks/whatsapp", fields: [{ name: "messages" }] },
  });
  assert.equal(healthy.ok, true, "with no account named, routing is healthy as before");
  const dropped = evaluateWebhookRouting({
    answerable: true,
    expectedCallbackUrl: "https://phoenix.example/api/webhooks/whatsapp",
    numberOverrideUrl: null,
    subscription: { active: true, callback_url: "https://phoenix.example/api/webhooks/whatsapp", fields: [{ name: "messages" }] },
    unsubscribedLines: [RECRUITMENT],
  });
  assert.equal(dropped.ok, false, "an account without the app fails the routing — the alert reads 'not being delivered here'");
  assert.ok(
    dropped.problems.some((problem) => problem.includes("Recruitment line (+20 10 98500699)") && problem.includes("not subscribed to the Phoenix app")),
    `the problem names the line: ${dropped.problems.join(" | ")}`,
  );
  assert.deepEqual(dropped.unsubscribedLines, [RECRUITMENT]);
}

async function testTheRoutingCheckAsksEachAccount() {
  // The 11 Nov shape: the Recruitment account lists nothing, the handset's lists the app.
  await withGraph(meta({ [RECRUITMENT.businessAccountId]: LISTS_NOTHING, [HANDSET_ACCOUNT]: LISTS_APP }), async (calls) => {
    const routing = await fetchWebhookRouting();
    assert.equal(routing.ok, false, "DROPPED: the Recruitment account without the app fails the routing");
    assert.deepEqual(routing.unsubscribedLines?.map((line) => line.phoneNumberId), [RECRUITMENT.phoneNumberId], "DROPPED: the Recruitment line is named");
    assert.deepEqual(routing.subscribedLineIds, [HANDSET_PHONE_ID], "DROPPED: the handset is confirmed delivered");
    const asked = calls.filter((call) => call.url.includes("/subscribed_apps")).map((call) => `${call.method} ${new URL(call.url).pathname.replace(/^\/v[0-9.]+\//, "")}`);
    assert.deepEqual(asked.sort(), [`GET ${HANDSET_ACCOUNT}/subscribed_apps`, `GET ${RECRUITMENT.businessAccountId}/subscribed_apps`].sort(), "DROPPED: each account asked once, read only");
  });

  await withGraph(meta({ [RECRUITMENT.businessAccountId]: LISTS_APP, [HANDSET_ACCOUNT]: LISTS_APP }), async () => {
    const routing = await fetchWebhookRouting();
    assert.equal(routing.ok, true, "BOTH SUBSCRIBED: routing passes");
    assert.deepEqual(routing.unsubscribedLines, []);
    assert.deepEqual([...(routing.subscribedLineIds ?? [])].sort(), [HANDSET_PHONE_ID, RECRUITMENT.phoneNumberId].sort());
  });

  await withGraph(meta({ [RECRUITMENT.businessAccountId]: REFUSED, [HANDSET_ACCOUNT]: LISTS_APP }), async () => {
    const routing = await fetchWebhookRouting();
    assert.equal(routing.ok, true, "UNREADABLE: an account Meta will not describe is never called unsubscribed");
    assert.deepEqual(routing.unsubscribedLines, [], "UNREADABLE: so nothing is ever re-subscribed on a guess");
    assert.deepEqual(routing.unverifiedLineIds, [RECRUITMENT.phoneNumberId], "UNREADABLE: and the line is recorded as unverified");
  });
}

async function testTheRepairRunsOnlyInProductionOnceAnHour() {
  __resetWhatsAppResubscribeAttemptsForTests();
  const production = { APP_ENV: "production", WHATSAPP_ACCESS_TOKEN: "stand-in-token" };
  const now = new Date("2026-11-19T13:10:00Z");

  for (const [env, reason] of [
    [{ ...production, APP_ENV: "staging" }, "APP_ENV is not production"],
    [{ ...production, PHOENIX_WHATSAPP_AUTO_RESUBSCRIBE: "off" }, "PHOENIX_WHATSAPP_AUTO_RESUBSCRIBE is off"],
    [{ APP_ENV: "production" }, "no WhatsApp access token"],
  ] as const) {
    assert.equal(whatsAppResubscribeRefusal(env), reason, `REFUSED: the gate refuses and says why (${reason})`);
    await withGraph(() => ({ body: { success: true }, status: 200 }), async (calls) => {
      const results = await resubscribeUnsubscribedWhatsAppLines([RECRUITMENT], now, env);
      assert.deepEqual(results.map((result) => result.outcome), ["skipped"], `REFUSED (${reason}): nothing pressed`);
      assert.equal(calls.length, 0, `REFUSED (${reason}): Meta was never called`);
    });
  }
  assert.equal(whatsAppResubscribeRefusal(production), null, "PRODUCTION with a token: the gate lets it run");

  await withGraph(() => ({ body: { success: true }, status: 200 }), async (calls) => {
    assert.deepEqual(await resubscribeUnsubscribedWhatsAppLines([], now, production), [], "nothing to repair, nothing pressed");
    const results = await resubscribeUnsubscribedWhatsAppLines([RECRUITMENT], now, production);
    assert.deepEqual(results.map((result) => result.outcome), ["resubscribed"], "PRODUCTION: the account is re-subscribed");
    assert.equal(calls.length, 1, "PRODUCTION: one request");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v[0-9.]+\/2265574670642375\/subscribed_apps$/, "PRODUCTION: to the named account's subscribed apps, nothing else");
    assert.equal(calls[0].authorization, "Bearer stand-in-token");
    const note = describeResubscribeResults(results) ?? "";
    assert.match(note, /re-subscribed the Recruitment line \(\+20 10 98500699\) to its app automatically at 19 Nov 2026 · 15:10 Cairo/, `the alert says what was done, in Cairo time: ${note}`);

    const again = await resubscribeUnsubscribedWhatsAppLines([RECRUITMENT], new Date(now.getTime() + 10 * 60 * 1000), production);
    assert.deepEqual(again.map((result) => result.outcome), ["skipped"], "TEN MINUTES LATER: not pressed again");
    assert.equal(calls.length, 1, "TEN MINUTES LATER: Meta was not called again");
    const hourLater = await resubscribeUnsubscribedWhatsAppLines([RECRUITMENT], new Date(now.getTime() + 61 * 60 * 1000), production);
    assert.deepEqual(hourLater.map((result) => result.outcome), ["resubscribed"], "AN HOUR LATER: tried again");
    assert.equal(calls.length, 2);
  });

  __resetWhatsAppResubscribeAttemptsForTests();
  await withGraph(() => REFUSED, async () => {
    const results = await resubscribeUnsubscribedWhatsAppLines([RECRUITMENT], now, production);
    assert.deepEqual(results.map((result) => [result.outcome, result.reason]), [["failed", "(#200) Permissions error"]], "REFUSED BY META: failed, in Meta's words");
    assert.match(describeResubscribeResults(results) ?? "", /Meta refused \(\(#200\) Permissions error\), so it needs a person in WhatsApp Manager/);
  });
  __resetWhatsAppResubscribeAttemptsForTests();
}

function testAQuietLineWithAConfirmedAccountPointsAtTheAdverts() {
  const confirmed = evaluateWebhookRouting({
    answerable: true,
    expectedCallbackUrl: "https://phoenix.example/api/webhooks/whatsapp",
    numberOverrideUrl: null,
    subscribedLineIds: [RECRUITMENT.phoneNumberId, HANDSET_PHONE_ID],
    subscription: { active: true, callback_url: "https://phoenix.example/api/webhooks/whatsapp", fields: [{ name: "messages" }] },
  });
  const quiet = [{ displayNumber: RECRUITMENT.displayNumber, phoneNumberId: RECRUITMENT.phoneNumberId }];
  const delivered = quietLinesDetail(quiet, confirmed, 96);
  assert.match(delivered, /Line\(s\) \+20 10 98500699 have gone quiet \(>96h\)/);
  assert.match(delivered, /applicants are no longer messaging this number/, "CONFIRMED: the alert says delivery is fine and points at the adverts");

  const unconfirmed = evaluateWebhookRouting({
    answerable: true,
    expectedCallbackUrl: "https://phoenix.example/api/webhooks/whatsapp",
    numberOverrideUrl: null,
    subscription: { active: true, callback_url: "https://phoenix.example/api/webhooks/whatsapp", fields: [{ name: "messages" }] },
    unverifiedLineIds: [RECRUITMENT.phoneNumberId],
  });
  const unknown = quietLinesDetail(quiet, unconfirmed, 96);
  assert.match(unknown, /could not be confirmed on this run/, "UNVERIFIED: it never claims delivery it did not read");
  assert.doesNotMatch(unknown, /no longer messaging/);
}

function testTheIntakeJobRepairsBeforeItAlerts() {
  const route = stripComments(readFileSync(new URL("../app/api/cron/recruitment-email-intake/route.ts", import.meta.url), "utf8"));
  const repair = route.indexOf("resubscribeUnsubscribedWhatsAppLines(checked.routing?.unsubscribedLines ?? [])");
  const alert = route.indexOf("if (PAGING_STATUSES.has(health.status))");
  assert.ok(repair > 0, "the intake job hands the unsubscribed lines to the repair");
  assert.ok(alert > repair, "the repair runs before the alert, so the alert can say what was done");
  assert.match(route, /detail: `\$\{checked\.detail\}\$\{resubscribeNote\}`/, "the outcome is appended to the alert's own words");
  assert.match(route, /notifyWhatsAppIntakeUnhealthy\(health\)/, "the notice carries that detail");
}

export async function runWhatsAppLineSubscriptionTests() {
  testReadingTheSubscribedAppsAnswer();
  testAnUnsubscribedAccountFailsTheRouting();
  await testTheRoutingCheckAsksEachAccount();
  await testTheRepairRunsOnlyInProductionOnceAnHour();
  testAQuietLineWithAConfirmedAccountPointsAtTheAdverts();
  testTheIntakeJobRepairsBeforeItAlerts();
}
