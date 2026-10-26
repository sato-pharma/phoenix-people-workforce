// The interview calendar's .ics feed stops the day its holder leaves or loses their login, and the
// route is rate-limited before the token is looked up (audit point 18, owner-approved 2026-10-26).
//
// WHY THIS EXISTS. A feed token is minted once and kept, and `buildCalendarFeedForToken` used to
// serve it for as long as the token row existed. So after a person was offboarded, or their login
// was disabled, the calendar app they had subscribed kept pulling candidate names, Zoom links and
// interview notes indefinitely, and nothing limited how fast anyone could ask. Now:
//   - the feed is served only while the holder has an ACTIVE login and an employee record that does
//     not revoke access (the session's own rule, notice-period grace included);
//   - a holder who fails either gets EXACTLY the unknown token's answer — the valid empty calendar —
//     so nothing tells a real token from a guessed one;
//   - a read that FAILS (the token, the holder, the interviews) answers 503 through the route, never
//     the empty calendar: an empty calendar tells the subscriber's app that every interview was
//     cancelled, so a database blip used to wipe them (risk review, 26 Oct);
//   - the route asks `assertApiRateLimit` per address and per link BEFORE the token lookup, and
//     answers a 429 with Retry-After.
// No database is touched: the admin client points at a `.invalid` URL and `fetch` is stubbed, then
// everything is restored.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Namespace import, so a build without the helper fails an ASSERTION below, not the import.
import * as feed from "../src/lib/recruitment/interview-calendar-ics.ts";
import { stripComments } from "./support/comment-strip.ts";

const SUPABASE_URL = "http://interview-feed-test.invalid";
const VALID_TOKEN = "t".repeat(43);
const HOLDER = "B-77";
const NOW = new Date("2026-10-26T10:00:00.000Z");
const ENV_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

type HolderHelper = (input: {
  hasActiveLogin: boolean;
  employmentStatus: string | null | undefined;
  lastWorkingDate?: string | null;
  todayCairo: string;
}) => boolean;

function holderHelper(): HolderHelper {
  const fn = (feed as Record<string, unknown>).isCalendarFeedHolderActive;
  assert.equal(typeof fn, "function", "interview-calendar-ics.ts exports isCalendarFeedHolderActive, the feed's holder gate");
  return fn as HolderHelper;
}

function testTheHolderGate() {
  const isCalendarFeedHolderActive = holderHelper();
  const today = "2026-10-26";
  const cases: Array<[boolean, string | null, string | null, boolean, string]> = [
    [true, "active", null, true, "an active login and an active employee are served"],
    [true, "on_leave", null, true, "an employee on leave is still served"],
    [true, null, null, true, "an active login with no employee row is served, as a session allows it"],
    [false, "active", null, false, "HEADLINE: a disabled login is never served, even for an active employee"],
    [true, "resigned", "2026-10-25", false, "HEADLINE: an offboarded holder (last working day passed) is never served"],
    [true, "terminated", "2026-10-26", false, "a departure dated today stops the feed today"],
    [true, "resigned", "2026-11-15", true, "a holder still serving notice keeps the feed until the last working day"],
    [true, "resigned", null, false, "a departure with no last working day stops the feed"],
    [true, "inactive", null, false, "an inactive employee is never served"],
    [true, "historical_payroll_record", "2026-12-31", false, "a ledger artefact is never served"],
  ];
  for (const [hasActiveLogin, employmentStatus, lastWorkingDate, expected, message] of cases) {
    assert.equal(isCalendarFeedHolderActive({ employmentStatus, hasActiveLogin, lastWorkingDate, todayCairo: today }), expected, message);
  }
}

type Scenario = {
  login: "active" | "none" | "error";
  employee: { employment_status: string; last_working_date: string | null } | null | "error";
  limiter?: { allowed: boolean; retryAfterSeconds?: number };
  tokens?: "error";
  bookings?: "error";
};

const READ_FAILS = { code: "XX000", details: null, hint: null, message: "connection reset" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

const bookingRow = {
  candidate_id: null,
  duration_minutes: 30,
  external_name: "Mona Adel",
  id: "22222222-2222-2222-2222-222222222222",
  interviewer_hr_id: HOLDER,
  notes: "Bring the CV",
  panelist_hr_ids: [],
  platform: "zoom",
  requested_by_hr_id: null,
  session_id: null,
  starts_at: "2026-10-28T08:00:00.000Z",
  updated_at: "2026-10-25T09:00:00.000Z",
  zoom_join_url: "https://zoom.us/j/777",
};

async function withStubbedDatabase(scenario: Scenario, run: (asked: string[]) => Promise<void>) {
  const asked: string[] = [];
  const savedFetch = globalThis.fetch;
  const env = process.env as Record<string, string | undefined>;
  const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-key";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(`${url.origin}${url.pathname}?${decodeURIComponent(url.search)}`);
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    if (table === "rpc/api_rate_limit_consume") {
      const limiter = scenario.limiter ?? { allowed: true };
      return json([{ allowed: limiter.allowed, retry_after_seconds: limiter.retryAfterSeconds ?? null }]);
    }
    if (table === "ats_interview_ics_feed_tokens") {
      if (scenario.tokens === "error") return json(READ_FAILS, 500);
      return json(url.searchParams.get("token") === `eq.${VALID_TOKEN}` ? [{ hr_id: HOLDER }] : []);
    }
    if (table === "app_auth_users") {
      if (scenario.login === "error") return json({ code: "XX000", details: null, hint: null, message: "connection reset" }, 500);
      return json(scenario.login === "active" ? [{ login_id: HOLDER.toLowerCase() }] : []);
    }
    if (table === "employees" && (url.searchParams.get("select") ?? "").includes("employment_status")) {
      if (scenario.employee === "error") return json({ code: "XX000", details: null, hint: null, message: "connection reset" }, 500);
      return json(scenario.employee ? [scenario.employee] : []);
    }
    if (table === "ats_interview_bookings") return scenario.bookings === "error" ? json(READ_FAILS, 500) : json([bookingRow]);
    return json([]);
  }) as typeof fetch;
  try {
    await run(asked);
  } finally {
    globalThis.fetch = savedFetch;
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete env[name];
      else env[name] = savedEnv[name];
    }
  }
  assert.ok(
    asked.every((url) => url.startsWith(`${SUPABASE_URL}/`)),
    "the test never reaches a real database",
  );
}

const askedTable = (asked: readonly string[], table: string) => asked.some((url) => url.includes(`/rest/v1/${table}?`));

async function testTheFeedFollowsItsHolder() {
  const unknownToken = feed.renderCalendarFeed([], NOW);

  await withStubbedDatabase({ employee: { employment_status: "active", last_working_date: null }, login: "active" }, async (asked) => {
    const served = await feed.buildCalendarFeedForToken(VALID_TOKEN, NOW);
    assert.match(served, /BEGIN:VEVENT[\s\S]*SUMMARY:Interview . Mona Adel/, "an active holder's feed carries their interview");
    assert.ok(askedTable(asked, "app_auth_users"), "the holder's login is checked");
    assert.ok(asked.some((url) => url.includes("/rest/v1/app_auth_users?") && url.includes("is_active=eq.true")), "the check asks for an ACTIVE login");
    assert.ok(asked.some((url) => url.includes("/rest/v1/employees?") && url.includes("employment_status")), "the holder's employment is checked");
  });

  const refused: Array<[Scenario, string]> = [
    [{ employee: { employment_status: "resigned", last_working_date: "2026-10-20" }, login: "active" }, "HEADLINE: an offboarded holder's token answers exactly like an unknown token"],
    [{ employee: { employment_status: "active", last_working_date: null }, login: "none" }, "HEADLINE: a disabled login's token answers exactly like an unknown token"],
  ];
  for (const [scenario, message] of refused) {
    await withStubbedDatabase(scenario, async (asked) => {
      const answer = await feed.buildCalendarFeedForToken(VALID_TOKEN, NOW);
      assert.equal(answer, unknownToken, message);
      assert.ok(!askedTable(asked, "ats_interview_bookings"), `${message}: the interviews are never even read`);
    });
  }

  await withStubbedDatabase({ employee: { employment_status: "active", last_working_date: null }, login: "active" }, async () => {
    assert.equal(await feed.buildCalendarFeedForToken("u".repeat(43), NOW), unknownToken, "an unknown token still answers the empty calendar");
  });

  // A failed read is NOT an inactive holder: the builder throws, so the route can answer 503.
  const Unavailable = (feed as Record<string, unknown>).CalendarFeedUnavailableError as (new (what: string) => Error) | undefined;
  assert.equal(typeof Unavailable, "function", "interview-calendar-ics.ts exports CalendarFeedUnavailableError");
  const failing: Array<[Scenario, string]> = [
    [{ employee: { employment_status: "active", last_working_date: null }, login: "error" }, "HEADLINE: a login read that fails is told apart from a disabled login"],
    [{ employee: "error", login: "active" }, "an employee read that fails is told apart from a leaver"],
    [{ employee: { employment_status: "active", last_working_date: null }, login: "active", tokens: "error" }, "a token lookup that fails is told apart from an unknown token"],
    [{ bookings: "error", employee: { employment_status: "active", last_working_date: null }, login: "active" }, "an interviews read that fails is told apart from no interviews"],
  ];
  for (const [scenario, message] of failing) {
    await withStubbedDatabase(scenario, async () => {
      await assert.rejects(feed.buildCalendarFeedForToken(VALID_TOKEN, NOW), (error: unknown) => error instanceof Unavailable!, message);
    });
  }
}

async function loadRoute(): Promise<(request: Request, context: { params: Promise<{ token: string }> }) => Promise<Response>> {
  const path = resolve(process.cwd(), "app/api/recruitment/interview-calendar/ics/[token]/route.ts");
  const route = (await import(pathToFileURL(path).href)) as { GET: (request: Request, context: { params: Promise<{ token: string }> }) => Promise<Response> };
  return route.GET;
}

async function testTheRouteIsRateLimitedBeforeTheLookup() {
  const GET = await loadRoute();
  const call = (token: string) =>
    GET(new Request(`https://phoenix.test/api/recruitment/interview-calendar/ics/${token}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), {
      params: Promise.resolve({ token }),
    });

  await withStubbedDatabase(
    { employee: { employment_status: "active", last_working_date: null }, limiter: { allowed: false, retryAfterSeconds: 42 }, login: "active" },
    async (asked) => {
      const response = await call(VALID_TOKEN);
      assert.equal(response.status, 429, "HEADLINE: a caller over the limit is refused with a 429");
      assert.equal(response.headers.get("retry-after"), "42", "the 429 says when to come back");
      assert.ok(asked.some((url) => url.includes("/rest/v1/rpc/api_rate_limit_consume")), "the route asks the shared rate limiter");
      assert.ok(!askedTable(asked, "ats_interview_ics_feed_tokens"), "the limit is applied BEFORE the token is looked up");
      assert.doesNotMatch(await response.text(), /BEGIN:VEVENT/, "a refused caller gets no interviews");
    },
  );

  await withStubbedDatabase({ employee: { employment_status: "active", last_working_date: null }, login: "active" }, async (asked) => {
    const response = await call(VALID_TOKEN);
    assert.equal(response.status, 200, "a caller under the limit is served");
    assert.match(response.headers.get("content-type") ?? "", /text\/calendar/, "the feed is still text/calendar");
    assert.match(await response.text(), /BEGIN:VEVENT/, "an active holder under the limit gets their interviews");
    const limiterCalls = asked.filter((url) => url.includes("/rest/v1/rpc/api_rate_limit_consume")).length;
    assert.equal(limiterCalls, 2, "two limits are asked: per address and per link");
  });

  await withStubbedDatabase({ employee: { employment_status: "resigned", last_working_date: "2026-01-01" }, login: "active" }, async () => {
    const response = await call(VALID_TOKEN);
    assert.equal(response.status, 200, "a leaver's token answers 200, like an unknown token");
    assert.doesNotMatch(await response.text(), /BEGIN:VEVENT/, "a leaver's token serves no interviews through the route");
  });

  // A failed read answers 503 with Retry-After — never the empty calendar that wipes the subscriber's
  // copy, and never an interview.
  const failing: Array<[Scenario, string]> = [
    [{ employee: { employment_status: "active", last_working_date: null }, login: "error" }, "HEADLINE: a holder read that fails answers 503, not an empty calendar"],
    [{ employee: "error", login: "active" }, "an employee read that fails answers 503"],
    [{ employee: { employment_status: "active", last_working_date: null }, login: "active", tokens: "error" }, "a token lookup that fails answers 503"],
    [{ bookings: "error", employee: { employment_status: "active", last_working_date: null }, login: "active" }, "an interviews read that fails answers 503"],
  ];
  for (const [scenario, message] of failing) {
    await withStubbedDatabase(scenario, async () => {
      const response = await call(VALID_TOKEN);
      assert.equal(response.status, 503, message);
      assert.equal(response.headers.get("retry-after"), "300", `${message}: it says when to ask again`);
      const body = await response.text();
      assert.doesNotMatch(body, /BEGIN:VCALENDAR/, `${message}: it is not a calendar the app would sync`);
      assert.doesNotMatch(body, /connection reset|XX000/, `${message}: it names no database cause`);
    });
  }
}

function testTheRouteSource() {
  const route = stripComments(readFileSync(resolve(process.cwd(), "app/api/recruitment/interview-calendar/ics/[token]/route.ts"), "utf8"));
  const ipLimit = route.indexOf('scope: "interview_calendar_feed_ip"');
  const linkLimit = route.indexOf('scope: "interview_calendar_feed_link"');
  const build = route.indexOf("buildCalendarFeedForToken(token)");
  assert.ok(ipLimit > 0 && linkLimit > 0, "the route limits per address and per link");
  assert.ok(ipLimit < build && linkLimit < build, "both limits run before the feed is built");
  assert.match(route, /rateLimitIdentity\(\{ request \}\)/, "the address limit keys on the caller's address");
  assert.match(route, /rateLimitIdentity\(\{ request, token \}\)/, "the link limit keys on the token");
  assert.match(route, /error instanceof ApiRateLimitError[\s\S]*status: 429/, "a limit answers 429");
  assert.doesNotMatch(route, /renderCalendarFeed\(/, "the route's error path never hands back an empty calendar");
  assert.match(route, /status: 503/, "a failed read answers 503");
  assert.doesNotMatch(route, /resolveAccessContext/, "the feed stays public by design — the bearer token is the credential");
}

export async function runInterviewCalendarFeedHolderTests() {
  testTheHolderGate();
  await testTheFeedFollowsItsHolder();
  await testTheRouteIsRateLimitedBeforeTheLookup();
  testTheRouteSource();
}
