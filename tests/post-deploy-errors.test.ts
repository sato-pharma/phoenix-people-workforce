import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isBrowserNoiseMessage } from "@/lib/error-monitor/browser-noise";
import { isModuleLockRefusal } from "@/lib/error-monitor/expected-refusal";

import {
  EXIT,
  classifyErrors,
  errorRowFilters,
  errorSignature,
  goLiveFrom,
  hasProductionSuccess,
  noiseReason,
  normalizeMessage,
  postDeployVerdict,
  readErrorRows,
  readSentryIssues,
  sentryEventParams,
} from "../scripts/lib/post-deploy-errors.mjs";

/**
 * `scripts/post-deploy-errors.mjs` is the ship skill's phase 7b: once a merge is serving, did it bring an error
 * the week before never had? It reads the production `app_error_events` table and Sentry's events, so every
 * reader takes its `fetch` as an argument and these tests drive them with stand-ins, never the network.
 *
 * What is held, and the break that proves each one:
 *   1. ONE ERROR IS ONE SIGNATURE, whatever ids, timings, hashes and minified names it carried this time, while
 *      two different React error codes stay two errors. Drop a normalisation and the pair stops matching.
 *   2. THE NOISE RULES ARE THE REPO'S OWN (browser-noise.ts, expected-refusal.ts), passed in, never copied.
 *   3. "NEW" MEANS NO OTHER RELEASE PRODUCED IT IN THE BASELINE WEEK, so an error already happening before the
 *      merge never reads as the merge's doing.
 *   4. 🔴 THE ROW READER PAGES BY THE SERVER'S TOTAL, not by "a short page means the end". Supabase caps a
 *      response at its max-rows setting, which can sit below the page size asked for; a reader that stopped at
 *      the first short page would judge 600 rows of 1,500 and say so to nobody. Swap the stop condition back
 *      to `page.length < pageSize` and the 1,500-row case reads 600.
 *   5. SENTRY IS READ THROUGH DISCOVER, and an unreadable Sentry is a stated "not read", never a pass. The read
 *      token answered 403 on the issue list and 200 on Discover (2026-10-19), which is why the reader asks
 *      `organizations/<org>/events/`.
 *   6. THE VERDICT: too early is NOT a pass, and an unreadable error table is CANNOT TELL, never CLEAN.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const classifiers = { isBrowserNoiseMessage, isModuleLockRefusal };

type Row = { created_at: string; source: string; route?: string; module_label?: string; message: string; digest?: string | null; release: string | null };
type SentryReading = {
  read: boolean;
  reason?: string;
  fresh?: { shortId: string; link: string | null }[];
  recurring?: { shortId: string }[];
  capped?: boolean;
};
const row = (over: Partial<Row>): Row => ({
  created_at: "2026-10-19T09:00:00.000000+00:00",
  source: "server",
  route: "/api/x",
  module_label: "CRM",
  message: "Something failed",
  digest: null,
  release: "aaa",
  ...over,
});

function jsonResponse(body: unknown, { status = 200, headers = {} as Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function signatureTests() {
  const timeout = (fn: string) =>
    JSON.stringify({ message: "AbortError: Supabase request timed out.", details: `AbortError: Supabase request timed out.\n    at ${fn} (/app/.next/server/chunks/123.js:1:2)` });
  assert.equal(normalizeMessage(timeout("k")), normalizeMessage(timeout("p")), "a minified function name in details is not a different error");
  assert.equal(normalizeMessage(timeout("k")), "AbortError: Supabase request timed out.");
  // A stored object cut short still yields its opening message.
  assert.equal(normalizeMessage('{"message":"Phoenix CRM request failed","details":"at q (/app/.ne'), "Phoenix CRM request failed");

  assert.equal(
    normalizeMessage("AI call failed — Phoenix CRM — reading the signboard in a place photo: timeout (model gpt-5.4-nano, 8004ms)"),
    normalizeMessage("AI call failed — Phoenix CRM — reading the signboard in a place photo: timeout (model gpt-5.4-nano, 8007ms)"),
    "a timing is not a different error",
  );
  assert.notEqual(
    normalizeMessage("Minified React error #441; visit https://react.dev/errors/441 for the full message"),
    normalizeMessage("Minified React error #418; visit https://react.dev/errors/418 for the full message"),
    "two React error codes are two errors",
  );
  assert.equal(
    normalizeMessage("Candidate 3f2b1c9a-1d2e-4f5a-9b8c-7d6e5f4a3b2c not found for sara.k@example.com at 33e88ab52fa4"),
    normalizeMessage("Candidate 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d not found for m.ali@example.org at 11fffe428fa4"),
    "ids, e-mail addresses and shas are not part of the error",
  );
  assert.equal(
    normalizeMessage("Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]= for more"),
    normalizeMessage("Minified React error #418; visit https://react.dev/errors/418?args[]=html for more"),
    "a URL's query string is not part of the error",
  );
  assert.equal(
    normalizeMessage("Failed to load chunk /_next/static/chunks/2cewb0u7fcwfg.js from module 553290"),
    normalizeMessage("Failed to load chunk /_next/static/chunks/9zzq1xk2b7w.js from module 11"),
    "a build's chunk name is not part of the error",
  );
  assert.equal(normalizeMessage("first line\n    at stack frame"), "first line", "only the first line is the error");

  const render = "An error occurred in the Server Components render. The specific message is omitted in production builds.";
  assert.notEqual(
    errorSignature(row({ message: render, digest: "1111" })),
    errorSignature(row({ message: render, digest: "2222" })),
    "for Next's fixed render sentence the digest tells two errors apart",
  );
  assert.equal(errorSignature(row({ message: "X failed", digest: "1111" })), errorSignature(row({ message: "X failed", digest: "2222" })));
  assert.notEqual(errorSignature(row({ source: "client" })), errorSignature(row({ source: "server" })), "a browser error and a server error are two errors");
}

function noiseTests() {
  assert.equal(noiseReason(row({ source: "client", message: "Load failed" }), classifiers), "browser network failure");
  assert.equal(noiseReason(row({ source: "server", message: "Load failed" }), classifiers), null, "the browser wording is noise only on a browser row");
  assert.equal(noiseReason(row({ message: "Forbidden: sales is temporarily locked by the system administrator." }), classifiers), "locked module refusal");
  assert.equal(noiseReason(row({ message: "Forbidden: Employee cannot read payroll." }), classifiers), null, "a real refusal still counts");
  assert.equal(noiseReason(row({ source: "client", message: "Load failed" }), null), null, "without the rules every row is judged");
}

function classifyTests() {
  const examined = [
    row({ message: "Known failure 12", release: "new1", created_at: "2026-10-19T09:01:00+00:00" }),
    row({ message: "Brand new failure", release: "new1", created_at: "2026-10-19T09:05:00+00:00", route: "/b" }),
    row({ message: "Brand new failure", release: "new2", created_at: "2026-10-19T09:02:00+00:00", route: "/a" }),
    row({ source: "client", message: "Failed to fetch", release: "new1" }),
  ];
  const baseline = [row({ message: "Known failure 7", release: "old" }), row({ source: "client", message: "Failed to fetch", release: "old" })];
  const result = classifyErrors({ examined, baseline, classifiers });
  assert.equal(result.noise, 1);
  assert.equal(result.fresh.length, 1);
  assert.equal(result.recurring.length, 1);
  const [fresh] = result.fresh;
  assert.equal(fresh.message, "Brand new failure");
  assert.equal(fresh.count, 2);
  assert.deepEqual(fresh.releases, ["new1", "new2"]);
  assert.deepEqual(fresh.routes, ["/a", "/b"]);
  assert.equal(fresh.firstAt, "2026-10-19T09:02:00+00:00");
  assert.equal(fresh.lastAt, "2026-10-19T09:05:00+00:00");
  assert.equal(result.recurring[0].message, "Known failure 12", "an error the week before already produced is recurring, not new");

  const filters = errorRowFilters({ releases: ["a1", "b2"], baselineSince: "2026-10-12T00:00:00.000Z" });
  assert.deepEqual(filters.examined, [["environment", "eq.production"], ["release", "in.(a1,b2)"]]);
  assert.deepEqual(filters.baseline, [
    ["environment", "eq.production"],
    ["created_at", "gte.2026-10-12T00:00:00.000Z"],
    ["or", "(release.is.null,release.not.in.(a1,b2))"],
  ]);
}

async function rowReaderTests() {
  const all = Array.from({ length: 1500 }, (_, i) => row({ message: `m${i}` }));
  const seen: { url: URL; headers: Record<string, string> }[] = [];
  const capped = async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input);
    seen.push({ url, headers: init?.headers ?? {} });
    const offset = Number(url.searchParams.get("offset"));
    const limit = Math.min(Number(url.searchParams.get("limit")), 600); // the server's own max-rows cap
    const page = all.slice(offset, offset + limit);
    return jsonResponse(page, { headers: { "content-range": `${offset}-${offset + page.length - 1}/${all.length}` } });
  };
  const rows = await readErrorRows({ supabaseUrl: "https://db.test", serviceKey: "service-key", filters: [["environment", "eq.production"]], fetchImpl: capped as unknown as typeof fetch });
  assert.equal(rows.length, 1500, "a server cap below the page size must not end the read early");
  assert.equal(seen.length, 3);
  assert.equal(seen[0].url.pathname, "/rest/v1/app_error_events");
  assert.equal(seen[0].url.searchParams.get("environment"), "eq.production");
  assert.equal(seen[0].headers.Prefer, "count=exact");
  assert.equal(seen[0].headers.apikey, "service-key");

  const stops = async (input: string) => {
    const offset = Number(new URL(input).searchParams.get("offset"));
    const page = offset === 0 ? all.slice(0, 1000) : [];
    return jsonResponse(page, { headers: { "content-range": `0-999/${all.length}` } });
  };
  await assert.rejects(
    readErrorRows({ supabaseUrl: "https://db.test", serviceKey: "k", filters: [], fetchImpl: stops as unknown as typeof fetch }),
    /stopped at 1000 of 1500 rows/,
    "a read that ends short of the server's total is refused, never judged",
  );
  await assert.rejects(
    readErrorRows({ supabaseUrl: "https://db.test", serviceKey: "k", filters: [], fetchImpl: (async () => jsonResponse({ message: "no" }, { status: 401 })) as unknown as typeof fetch }),
    /HTTP 401/,
  );
}

async function sentryTests() {
  let called = 0;
  const never = (async () => {
    called += 1;
    return jsonResponse({});
  }) as unknown as typeof fetch;
  const unread = (await readSentryIssues({ token: "", releases: ["a"], fetchImpl: never })) as SentryReading;
  assert.equal(unread.read, false);
  assert.match(unread.reason ?? "", /NOT read/);
  assert.equal(called, 0, "no token, no request");

  const refused = (await readSentryIssues({ token: "sntryu_x", releases: ["a"], fetchImpl: (async () => jsonResponse({ detail: "no" }, { status: 403 })) as unknown as typeof fetch })) as SentryReading;
  assert.equal(refused.read, false);
  assert.match(refused.reason ?? "", /HTTP 403.*cannot read events in phoenix-crm/);

  const TOKEN = "sntryu_SECRET_VALUE_0123";
  const calls: { url: URL; auth: string }[] = [];
  const discover = (async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input);
    calls.push({ url, auth: init?.headers?.Authorization ?? "" });
    const query = url.searchParams.get("query") ?? "";
    if (query.startsWith("release:")) {
      return jsonResponse({
        data: [
          { issue: "PHOENIX-WORKFORCE-A", "issue.id": 11, title: "TypeError: x is undefined", level: "error", "count()": 4, "count_unique(user)": 2, "min(timestamp)": "2026-10-19T09:01:00+00:00", "max(timestamp)": "2026-10-19T09:09:00+00:00" },
          { issue: "PHOENIX-WORKFORCE-6", "issue.id": 6, title: "captureStallInSentry", level: "warning", "count()": 1, "count_unique(user)": 0, "min(timestamp)": "2026-10-19T09:03:00+00:00", "max(timestamp)": "2026-10-19T09:03:00+00:00" },
        ],
      });
    }
    return jsonResponse({ data: [{ issue: "PHOENIX-WORKFORCE-6", "count()": 75 }] });
  }) as unknown as typeof fetch;
  const result = (await readSentryIssues({ token: TOKEN, releases: ["sha1", "sha2"], fetchImpl: discover })) as SentryReading;
  assert.equal(result.read, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://de.sentry.io/api/0/organizations/phoenix-crm/events/");
  assert.equal(calls[0].url.searchParams.get("query"), "release:[sha1,sha2] !event.type:transaction");
  assert.equal(calls[1].url.searchParams.get("query"), "issue:[PHOENIX-WORKFORCE-A,PHOENIX-WORKFORCE-6] !release:[sha1,sha2] !event.type:transaction");
  assert.equal(calls[1].url.searchParams.get("statsPeriod"), "7d");
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.deepEqual((result.fresh ?? []).map((i) => i.shortId), ["PHOENIX-WORKFORCE-A"]);
  assert.deepEqual((result.recurring ?? []).map((i) => i.shortId), ["PHOENIX-WORKFORCE-6"]);
  assert.equal(result.fresh?.[0]?.link, "https://phoenix-crm.sentry.io/issues/11/");
  assert.ok(!JSON.stringify(result).includes(TOKEN), "the token never travels in the result");

  calls.length = 0;
  const empty = await readSentryIssues({ token: TOKEN, releases: ["sha1"], fetchImpl: (async (input: string) => { calls.push({ url: new URL(input), auth: "" }); return jsonResponse({ data: [] }); }) as unknown as typeof fetch });
  assert.deepEqual(empty, { read: true, fresh: [], recurring: [], capped: false });
  assert.equal(calls.length, 1, "nothing in the release, no baseline read");

  // A dropped connection, a stall or a busy Sentry is tried again; the token's own refusal never is.
  let refusals = 0;
  await readSentryIssues({ token: TOKEN, releases: ["a"], pauseMs: 0, fetchImpl: (async () => { refusals += 1; return jsonResponse({}, { status: 403 }); }) as unknown as typeof fetch });
  assert.equal(refusals, 1, "a 401 or 403 is the token's answer and is never retried");

  const reset = () => new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  let flaky = 0;
  let signal: unknown = null;
  const recovered = (await readSentryIssues({
    token: TOKEN,
    releases: ["a"],
    pauseMs: 0,
    fetchImpl: (async (_input: string, init?: { signal?: unknown }) => {
      flaky += 1;
      signal = init?.signal ?? null;
      if (flaky === 1) throw reset();
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch,
  })) as SentryReading;
  assert.equal(recovered.read, true, "one dropped connection no longer costs the whole Sentry read");
  assert.equal(flaky, 2);
  assert.ok(signal instanceof AbortSignal, "every try carries a time limit, so a stalled read cannot hang the check");

  let busy = 0;
  const afterBusy = (await readSentryIssues({ token: TOKEN, releases: ["a"], pauseMs: 0, fetchImpl: (async () => { busy += 1; return busy === 1 ? jsonResponse({}, { status: 503 }) : jsonResponse({ data: [] }); }) as unknown as typeof fetch })) as SentryReading;
  assert.equal(afterBusy.read, true, "a 503 is tried again");
  assert.equal(busy, 2);

  let down = 0;
  const lost = (await readSentryIssues({ token: TOKEN, releases: ["a"], pauseMs: 0, fetchImpl: (async () => { down += 1; throw reset(); }) as unknown as typeof fetch })) as SentryReading;
  assert.equal(lost.read, false, "a Sentry that never answers is still not read, never a pass");
  assert.equal(down, 3, "three tries, then it stops");
  assert.match(lost.reason ?? "", /release read \(fetch failed: ECONNRESET\), after 3 tries/, "the reason names undici's real cause and the tries");

  const fields = sentryEventParams({ releases: ["a"] }).getAll("field");
  assert.ok(fields.includes("issue") && fields.includes("count()"));
}

function goLiveAndVerdictTests() {
  assert.equal(
    goLiveFrom([
      { environment: "Phoenix-HR-Workforce / production", statuses: [{ state: "success", created_at: "2026-10-19T09:05:39Z" }, { state: "success", created_at: "2026-10-19T08:59:24Z" }, { state: "in_progress", created_at: "2026-10-19T08:46:55Z" }] },
      { environment: "Phoenix-HR-Workforce / staging", statuses: [{ state: "success", created_at: "2026-10-19T08:40:00Z" }] },
      { environment: "Phoenix-HR-Workforce / production", statuses: [{ state: "failure", created_at: "2026-10-19T08:30:00Z" }] },
    ]),
    "2026-10-19T08:59:24Z",
    "the earliest production success, never staging, never a failure",
  );
  assert.equal(goLiveFrom([{ environment: "Phoenix-HR-Workforce / production", statuses: [{ state: "in_progress", created_at: "x" }] }]), null);

  // #6432, 24 Oct 2026: the merge's only production row read `failure` (17:49:33 Cairo) while production served that
  // very commit from 17:50:03. With success rows alone there was no go-live time and the whole watch read CANNOT TELL.
  const carried = [{ environment: "Phoenix-HR-Workforce / production", statuses: [{ state: "failure", created_at: "2026-10-24T14:49:33Z" }, { state: "in_progress", created_at: "2026-10-24T14:43:20Z" }] }];
  assert.equal(hasProductionSuccess(carried), false, "a carried row has no success");
  assert.equal(
    goLiveFrom(carried, "2026-10-24T14:52:10Z"),
    "2026-10-24T14:52:10Z",
    "a carried merge is timed from the first reading that saw production serving it",
  );
  assert.notEqual(goLiveFrom(carried, "2026-10-24T14:52:10Z"), "2026-10-24T14:49:33Z", "never from the failure row's own time, which came before the container went live");
  assert.equal(
    goLiveFrom([{ environment: "Phoenix-HR-Workforce / production", statuses: [{ state: "success", created_at: "2026-10-24T15:31:00Z" }] }, ...carried], "2026-10-24T14:52:10Z"),
    "2026-10-24T14:52:10Z",
    "a later release's success never pushes the go-live past the moment the merge was already seen serving",
  );
  assert.equal(
    goLiveFrom([{ environment: "Phoenix-HR-Workforce / production", statuses: [{ state: "success", created_at: "2026-10-24T14:50:30Z" }] }], "2026-10-24T14:52:10Z"),
    "2026-10-24T14:50:30Z",
    "an earlier success still wins over a later observation",
  );
  assert.equal(hasProductionSuccess([{ environment: "Phoenix-HR-Workforce / staging", statuses: [{ state: "success", created_at: "x" }] }]), false, "staging's success is not production's");
  const probe = readFileSync(resolve(REPO_ROOT, "scripts/post-deploy-errors.mjs"), "utf8");
  assert.match(probe, /goLiveFrom\(deployments, firstSeenServingAt\)/, "the script must hand its first serving observation to goLiveFrom, or a carried merge has no go-live time again");
  assert.match(probe, /HEALTHZ_TRIES = [2-9]/, "the health probe must retry: one stalled lookup on the laptop made a whole reading CANNOT TELL");

  const unread = { read: false, reason: "no SENTRY_READ_TOKEN, so Sentry was NOT read" };
  const clean = { read: true, fresh: [], recurring: [], capped: false };
  assert.equal(postDeployVerdict({ merged: false }).code, EXIT.NOT_MERGED);
  assert.equal(postDeployVerdict({ live: false }).code, EXIT.NOT_LIVE);
  assert.equal(postDeployVerdict({ fresh: [{}], sentry: unread, liveMinutes: 1 }).code, EXIT.NEW, "a new error is reported at once, window or not");
  const sentryFound = { read: true, fresh: [{}], recurring: [] };
  assert.equal(postDeployVerdict({ sentry: sentryFound, liveMinutes: 30 }).code, EXIT.NEW);
  assert.equal(postDeployVerdict({ appRead: false, sentry: clean, liveMinutes: 30 }).code, EXIT.CANNOT_TELL, "an unread error table is never CLEAN");
  assert.equal(postDeployVerdict({ sentry: clean, liveMinutes: null }).code, EXIT.CANNOT_TELL);
  const early = postDeployVerdict({ sentry: clean, liveMinutes: 4, windowMinutes: 15 });
  assert.equal(early.code, EXIT.TOO_EARLY);
  assert.match(early.note, /NOT a pass/);
  const passUnread = postDeployVerdict({ sentry: unread, liveMinutes: 15, windowMinutes: 15 });
  assert.equal(passUnread.code, EXIT.CLEAN);
  assert.match(passUnread.note, /Sentry not read/, "a clean table with an unread Sentry says Sentry was not read");
  assert.match(postDeployVerdict({ sentry: clean, liveMinutes: 20, windowMinutes: 15 }).note, /or in Sentry/);
}

function entryPointTests() {
  const script = resolve(REPO_ROOT, "scripts/post-deploy-errors.mjs");
  const typo = spawnSync(process.execPath, [script, "6118", "--wiat"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 });
  assert.equal(typo.status, 2, `a mistyped flag is refused before anything is read (stderr: ${typo.stderr})`);
  assert.match(typo.stderr, /--wiat/);
  const bare = spawnSync(process.execPath, [script], { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 });
  assert.equal(bare.status, EXIT.CANNOT_TELL, "no PR and no sha is a usage error, never a reading");
  assert.match(bare.stderr, /usage:/);

  const skill = readFileSync(resolve(REPO_ROOT, ".claude/skills/ship/SKILL.md"), "utf8");
  assert.match(skill, /node scripts\/post-deploy-errors\.mjs <n> --wait/, "the ship skill runs the check after the deploy is proven");

  // A short --sha matched no release (they are stamped with all 40 characters), so the merge's own
  // errors sat in the baseline and the verdict read CLEAN (code review, 19 Oct 2026).
  const entrySource = readFileSync(resolve(REPO_ROOT, "scripts/post-deploy-errors.mjs"), "utf8");
  assert.match(
    entrySource,
    /if \(shaArg\) \{[\s\S]*?gh\(\["api", `repos\/\$\{REPO\}\/commits\/\$\{shaArg\}`\]\)[\s\S]*?out\.mergeSha = commit\.sha;/,
    "--sha is resolved to the full commit before it is compared with any release",
  );
  assert.doesNotMatch(entrySource, /out\.mergeSha = shaArg;/, "--sha is never used as typed");
}

export async function runPostDeployErrorsTests() {
  signatureTests();
  noiseTests();
  classifyTests();
  await rowReaderTests();
  await sentryTests();
  goLiveAndVerdictTests();
  entryPointTests();
}
