import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createSessionToken, phoenixSessionCookieName } from "@/lib/auth/session-token";
import {
  grantTestDryRun,
  installTestDryRunFetchFence,
  testDryRunFenceIsLive,
  testDryRunFetch,
} from "@/lib/auth/test-dry-run";
import { TEST_DRY_RUN_HEADER, proxyMarksTestDryRun, requestIsTestDryRun } from "@/lib/auth/test-dry-run-rules";

// A TEST ACCOUNT'S SAVE RUNS FULLY AND SAVES NOTHING (owner, 2026-11-06: "make the test account everything
// in it as the real … never I see you are blocked … every export, anything, but on the test data",
// answered "Runs fully, saves nothing"). This suite pins the four promises that make it safe:
//   1. only a test account's signed session is ever marked, and only for a write it may not make for real;
//   2. a forged header alone is nothing;
//   3. every write the route then makes is answered in the server — no table row, no function's row, no
//      file, no email, no Telegram — while reads, and a function's real answer and refusal, come back real;
//   4. the access guard lets the save run only when the fence is provably the fetch in use.

const root = process.cwd();
const SUPABASE = "https://ozucdzovmcqvepbozvqf.supabase.co";

type Call = { url: string; method: string; body: string | null };

function standIn(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const real = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, method: String(init?.method ?? "GET").toUpperCase(), body: typeof init?.body === "string" ? init.body : null };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { calls, real };
}

const dryRun = async () => true;
const notDryRun = async () => false;

function tokenFor(loginId: string): string {
  return createSessionToken({ hrId: null, loginId, maxAgeSeconds: 3600, role: "Medical Rep", sessionId: `SID-${loginId}`, sessionVersion: 1 });
}

function cookieFor(loginId: string): string {
  return `${phoenixSessionCookieName}=${tokenFor(loginId)}`;
}

function bag(values: Record<string, string>) {
  const headers = new Headers(values);
  return { get: (name: string) => headers.get(name) };
}

async function marksOnlyATestAccountsWrite() {
  const test = cookieFor("TEST-AYA");
  const real = cookieFor("B-7");
  assert.equal(proxyMarksTestDryRun("POST", "/api/vacations/requests", test), true, "a test account's leave request is marked to run as a dry run");
  assert.equal(proxyMarksTestDryRun("POST", "/api/exports/table", test), true, "a test account's export is marked too");
  assert.equal(proxyMarksTestDryRun("POST", "/employee-portals/coaching", test), true, "a server action on a page is marked");
  assert.equal(proxyMarksTestDryRun("GET", "/api/vacations/requests", test), false, "a read is never marked");
  assert.equal(proxyMarksTestDryRun("POST", "/api/phoenix-crm/plans", test), false, "Phoenix CRM keeps its own test world and saves for real");
  assert.equal(proxyMarksTestDryRun("POST", "/api/auth/logout", test), false, "sign-in and sign-out act on the test login itself");
  assert.equal(proxyMarksTestDryRun("POST", "/api/outstation/submit", test), false, "the expense form keeps its own dry run");
  assert.equal(proxyMarksTestDryRun("POST", "/api/vacations/requests", real), false, "a real person's save is never marked");
  assert.equal(proxyMarksTestDryRun("POST", "/api/vacations/requests", null), false, "no session, no mark");
  const forged = `${phoenixSessionCookieName}=${tokenFor("TEST-AYA").replace(/.$/, (c) => (c === "A" ? "B" : "A"))}`;
  assert.equal(proxyMarksTestDryRun("POST", "/api/vacations/requests", forged), false, "a session whose signature fails is not a test account");

  assert.equal(requestIsTestDryRun(bag({ [TEST_DRY_RUN_HEADER]: "1", cookie: test })), true, "the mark plus a test session is a dry run");
  assert.equal(requestIsTestDryRun(bag({ [TEST_DRY_RUN_HEADER]: "1", cookie: real })), false, "HEADLINE: a real person who forges the mark gets no dry run");
  assert.equal(requestIsTestDryRun(bag({ cookie: test })), false, "a test session without the mark is not a dry run");
}

async function readsAndUnmarkedRequestsPass() {
  const { calls, real } = standIn(() => new Response("[]", { status: 200 }));
  await testDryRunFetch(`${SUPABASE}/rest/v1/employees?select=*`, { method: "GET" }, real, dryRun);
  await testDryRunFetch(`${SUPABASE}/rest/v1/leave_requests`, { method: "POST", body: "{}" }, real, notDryRun);
  assert.equal(calls.length, 2, "a read during a dry run, and any write outside one, go out untouched");
}

async function tableWritesNeverLeave() {
  const { calls, real } = standIn(() => new Response(JSON.stringify([{ id: "r1", status: "pending", hr_id: "B-7" }]), { status: 200 }));

  const inserted = await testDryRunFetch(
    `${SUPABASE}/rest/v1/leave_requests?select=*`,
    { method: "POST", headers: { prefer: "return=representation", accept: "application/vnd.pgrst.object+json" }, body: JSON.stringify({ hr_id: "B-7", days: 2 }) },
    real,
    dryRun,
  );
  assert.equal(inserted.status, 201);
  const row = (await inserted.json()) as Record<string, unknown>;
  assert.equal(row.hr_id, "B-7", "the insert answers with the row it was sent");
  assert.equal(typeof row.id, "string", "and an id, as the database would give it");
  assert.equal(calls.length, 0, "HEADLINE: an insert never reaches the database");

  const minimal = await testDryRunFetch(`${SUPABASE}/rest/v1/audit_logs`, { method: "POST", body: JSON.stringify([{ summary: "x" }, { summary: "y" }]) }, real, dryRun);
  assert.equal(minimal.status, 201, "a return=minimal insert answers 201 with no body");
  assert.equal(calls.length, 0);

  const patched = await testDryRunFetch(
    `${SUPABASE}/rest/v1/leave_requests?id=eq.r1&select=*`,
    { method: "PATCH", headers: { prefer: "return=representation" }, body: JSON.stringify({ status: "cancelled" }) },
    real,
    dryRun,
  );
  assert.deepEqual(await patched.json(), [{ id: "r1", status: "cancelled", hr_id: "B-7" }], "an update answers with the real row and the change laid on it");
  assert.equal(calls.length, 1, "it read the row");
  assert.equal(calls[0].method, "GET", "HEADLINE: the only call an update makes is a READ of the same rows");
  assert.match(calls[0].url, /id=eq\.r1/, "with the same filter");

  const deleted = await testDryRunFetch(`${SUPABASE}/rest/v1/leave_requests?id=eq.r1`, { method: "DELETE" }, real, dryRun);
  assert.equal(deleted.status, 204, "a delete answers done");
  assert.equal(calls.length, 1, "and sends nothing");
}

async function functionsRunAndRollBack() {
  const wrapperAnswers: Record<string, unknown> = {
    phx_set_thing: { passthrough: false, kind: "single", value: 7 },
    phx_rows: { passthrough: false, kind: "set", value: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    phx_read_only: { passthrough: true },
  };
  const { calls, real } = standIn((call) => {
    if (call.url.endsWith("/rpc/phx_test_dry_run_rpc")) {
      const fn = (JSON.parse(call.body ?? "{}") as { p_function: string }).p_function;
      if (fn === "phx_refuses") return new Response(JSON.stringify({ code: "P0001", message: "Not allowed" }), { status: 400 });
      return new Response(JSON.stringify(wrapperAnswers[fn]), { status: 200 });
    }
    return new Response('"real answer"', { status: 200 });
  });

  const single = await testDryRunFetch(`${SUPABASE}/rest/v1/rpc/phx_set_thing`, { method: "POST", body: JSON.stringify({ p_id: 1 }) }, real, dryRun);
  assert.equal(await single.json(), 7, "a volatile function's real answer comes back");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rpc\/phx_test_dry_run_rpc$/, "HEADLINE: a volatile function is only ever called through the rollback wrapper");
  assert.deepEqual(JSON.parse(calls[0].body ?? "{}"), { p_function: "phx_set_thing", p_args: { p_id: 1 } });

  const page = await testDryRunFetch(`${SUPABASE}/rest/v1/rpc/phx_rows`, { method: "POST", headers: { range: "1-1" }, body: "{}" }, real, dryRun);
  assert.deepEqual(await page.json(), [{ n: 2 }], "a set answer honours the page asked for, so a paging loop ends");
  assert.equal(page.headers.get("content-range"), "0-0/3");

  const refused = await testDryRunFetch(`${SUPABASE}/rest/v1/rpc/phx_refuses`, { method: "POST", body: "{}" }, real, dryRun);
  assert.equal(refused.status, 400, "the function's own refusal is the answer");
  assert.ok(!calls.some((call) => call.url.endsWith("/rpc/phx_refuses")), "HEADLINE: a refused or failed dry run never falls back to the real call");

  const before = calls.length;
  const passthrough = await testDryRunFetch(`${SUPABASE}/rest/v1/rpc/phx_read_only`, { method: "POST", body: "{}" }, real, dryRun);
  assert.equal(await passthrough.json(), "real answer", "a STABLE function is sent as it is — it cannot write");
  assert.equal(calls.length - before, 2, "asked first, then sent");
}

async function filesAndMessagesNeverLeave() {
  const { calls, real } = standIn(() => new Response("{}", { status: 200 }));
  const upload = await testDryRunFetch(`${SUPABASE}/storage/v1/object/leave-docs/B-7/note.pdf`, { method: "POST", body: "x" }, real, dryRun);
  assert.deepEqual(Object.keys((await upload.json()) as object).sort(), ["Id", "Key"], "an upload answers as storage would");
  await testDryRunFetch(`${SUPABASE}/storage/v1/object/remove`, { method: "DELETE", body: "{}" }, real, dryRun);
  assert.equal(calls.length, 0, "HEADLINE: no file is stored or removed");
  await testDryRunFetch(`${SUPABASE}/storage/v1/object/sign/leave-docs/B-7/note.pdf`, { method: "POST", body: "{}" }, real, dryRun);
  assert.equal(calls.length, 1, "signing a link is a read and goes out");

  const sent = calls.length;
  for (const url of [
    "https://api.telegram.org/bot123/sendMessage",
    "https://api.resend.com/emails",
    "https://api.brevo.com/v3/smtp/email",
    "https://api.onesignal.com/notifications",
    "https://graph.facebook.com/v20.0/1/messages",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    "https://phoenix-hr.satopharma.com/api/notifications/send",
  ]) {
    const answer = await testDryRunFetch(url, { method: "POST", body: "{}" }, real, dryRun);
    assert.equal(answer.ok, true, `${url} is answered done`);
  }
  assert.equal(calls.length, sent, "HEADLINE: no email, Telegram, push, WhatsApp, calendar entry or call back into Phoenix leaves");

  await testDryRunFetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }, real, dryRun);
  await testDryRunFetch("https://routes.googleapis.com/directions/v2:computeRoutes", { method: "POST", body: "{}" }, real, dryRun);
  assert.equal(calls.length, sent + 2, "asking an AI or pricing a route is a read, and goes out");
}

async function theGuardNeedsTheLiveFence() {
  const headers = bag({ [TEST_DRY_RUN_HEADER]: "1", cookie: cookieFor("TEST-AYA") });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{}")) as typeof fetch;
    assert.equal(await testDryRunFenceIsLive(), false);
    assert.equal(await grantTestDryRun(headers), false, "HEADLINE: with no fence in the fetch chain, a test account's save is refused, never run unfenced");
    assert.equal(installTestDryRunFetchFence(), true);
    assert.equal(await testDryRunFenceIsLive(), true);
    assert.equal(await grantTestDryRun(headers), true, "with the fence live, the marked save runs");
    // Production, 2026-11-06 19:23 Cairo: Next.js 16 wraps fetch as patched → dedupeFetch → fence, and
    // dedupeFetch keeps NO handle on what it wraps — the old wrapper walk lost the fence there and
    // refused the Make It Happen export. A forwarding layer with no handle must still count.
    const fenced = globalThis.fetch;
    const dedupe = (async (input: RequestInfo | URL, init?: RequestInit) => fenced(input, init)) as typeof fetch;
    globalThis.fetch = Object.assign((async (input: RequestInfo | URL, init?: RequestInit) => dedupe(input, init)) as typeof fetch, {
      _nextOriginalFetch: dedupe,
    });
    assert.equal(await testDryRunFenceIsLive(), true, "HEADLINE: Next.js's patched → dedupe wrappers around the fence still count");
    assert.equal(await grantTestDryRun(headers), true, "and the marked save runs through them");
    // A wrapper that NAMES the fence but does not call it cuts the fence out: it must not count.
    globalThis.fetch = Object.assign((async () => new Response("{}")) as typeof fetch, { _nextOriginalFetch: fenced });
    assert.equal(await testDryRunFenceIsLive(), false, "a wrapper that names the fence but bypasses it is not live");
    globalThis.fetch = fenced;
    assert.equal(await grantTestDryRun(bag({ cookie: cookieFor("TEST-AYA") })), false, "an unmarked request is not granted");
  } finally {
    globalThis.fetch = original;
  }
}

function wiredWhereItMustBe() {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  const server = read("src/lib/auth/server.ts");
  assert.match(server, /if \(!\(access\.testPersona && \(await grantTestDryRun\(request\.headers\)\)\)\) assertTestAccountMayRun\(access, request\);/, "the API guard grants the dry run or refuses as before");
  assert.match(server, /next-action"\) && !\(await grantTestDryRun\(await headers\(\)\)\)\) \{\s*assertNotTestAccount\(access\);/, "a server action does the same");
  const proxy = read("proxy.ts");
  assert.match(proxy, /headers\.delete\(TEST_DRY_RUN_HEADER\);\s*const testDryRun = proxyMarksTestDryRun\(/, "the proxy drops any mark the browser sent before setting its own");
  const boot = read("instrumentation.ts");
  assert.ok(boot.indexOf("installTestDryRunFetchFence") < boot.indexOf("pinKeepAliveDispatcher"), "the fence is installed before anything can call out");
  for (const path of ["src/lib/personal-mailbox/smtp.ts", "src/lib/personal-mailbox/imap.ts"]) {
    assert.match(read(path), /if \(await isTestDryRunRequest\(\)\) return/, `${path} — mail that is not fetch answers a dry run itself`);
  }
}

export async function runTestAccountDryRunTests() {
  process.env.PHOENIX_AUTH_SECRET = process.env.PHOENIX_AUTH_SECRET || "test-session-secret";
  await marksOnlyATestAccountsWrite();
  await readsAndUnmarkedRequestsPass();
  await tableWritesNeverLeave();
  await functionsRunAndRollBack();
  await filesAndMessagesNeverLeave();
  await theGuardNeedsTheLiveFence();
  wiredWhereItMustBe();
}
