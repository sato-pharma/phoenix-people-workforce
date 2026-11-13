import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  __setDirectorySharedVersionReaderForTests,
  DIRECTORY_SHARED_VERSION_CHECK_MS,
  getEmployeeNameRoster,
  invalidateEmployeeDirectoryCache,
  sharedDirectoryVersionMoved,
  type DirectorySharedVersion,
} from "../src/lib/employees/employee-directory.ts";
import { createExclusiveRunGuard, type JobLeaseRpcClient } from "../src/lib/platform/job-lease.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// PER-PROCESS STATE → SHARED STATE, BEFORE A SECOND INSTANCE IS EVER NEEDED (REC-083).
//
//   1. The notification drain's overlap guard was a module variable, so two instances (or the old and
//      the new container during a deploy) could each drain at once. It is a database lease now
//      (public.job_leases): TWO INSTANCES RUN, ONE DRAINS. A lease that cannot be read falls back to
//      the in-process guard, never to "the drain stops".
//   2. The page-timing beacon and the CSP report KEEP their per-instance address caps on purpose
//      (F-PLT-012): a shared count would write the caller's address to the database on every page view.
//   3. The employee directory cache was dropped only in the process that wrote. A copy held for the
//      check interval now asks a cheap shared version (the newest updated_at of its tables) and is
//      dropped when it moved — never served staler than the TTL it already had.
//
// Nothing here reaches a database: the lease is an in-memory fake shared by the two "instances", and
// the directory's reads go to a stand-in fetch.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = new URL("../", import.meta.url);
const code = (path: string) => stripComments(readFileSync(new URL(path, ROOT), "utf8"));

/** claim_job_lease with the migration's semantics (free, ours, or expired → ours), on a clock the test moves. */
function fakeLeaseStore(clock: { ms: number }) {
  const rows = new Map<string, { expiresMs: number; holder: string }>();
  let calls = 0;
  const client: JobLeaseRpcClient = {
    async rpc(fn, args) {
      calls += 1;
      assert.equal(fn, "claim_job_lease");
      const ttl = Number(args.p_ttl_seconds);
      assert.ok(ttl >= 1 && ttl <= 3600, "the claim function refuses a ttl outside 1..3600 seconds");
      const key = String(args.p_job_key);
      const holder = String(args.p_holder);
      const row = rows.get(key);
      if (!row || row.holder === holder || row.expiresMs < clock.ms) {
        rows.set(key, { expiresMs: clock.ms + ttl * 1000, holder });
      }
      const current = rows.get(key)!;
      return { data: [{ expires_at: new Date(current.expiresMs).toISOString(), held: current.holder === holder, holder: current.holder }], error: null };
    },
  };
  return { calls: () => calls, client };
}

type DrainResult = { skipped: true; reason: "overlapping-run"; via: string } | { skipped: false };

/** What runScheduledNotificationProcessing does around its steps, with the steps replaced by `work`. */
async function drainOn(
  guard: ReturnType<typeof createExclusiveRunGuard>,
  clock: { ms: number },
  work: () => Promise<void>,
): Promise<DrainResult> {
  const entry = await guard.enter(clock.ms);
  if (!entry.entered) return { reason: "overlapping-run", skipped: true, via: entry.via };
  try {
    await work();
    return { skipped: false };
  } finally {
    await entry.release();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const DRAIN_TTL_MS = 290_000;

async function runDrainLeaseTests() {
  const clock = { ms: Date.parse("2026-11-13T10:00:00Z") };
  const store = fakeLeaseStore(clock);
  let holderSeq = 0;
  // Two instances: each its own guard (its own in-process state), one lease store between them.
  const instance = (name: string) =>
    createExclusiveRunGuard({
      client: () => store.client,
      jobKey: "phoenix-process-notifications",
      newHolder: () => `${name}:run-${(holderSeq += 1)}`,
      ttlMs: DRAIN_TTL_MS,
    });
  const a = instance("instance-a");
  const b = instance("instance-b");

  // ── THE DONE-WHEN: two instances run; one drains ─────────────────────────────────────────────
  const drained: string[] = [];
  const gate = deferred();
  const runA = drainOn(a, clock, async () => {
    drained.push("a");
    await gate.promise;
  });
  const runB = drainOn(b, clock, async () => {
    drained.push("b");
    await gate.promise;
  });
  // Both are past their claim (or their skip) before the first run is allowed to finish.
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  gate.resolve();
  const [resultA, resultB] = await Promise.all([runA, runB]);
  assert.equal(drained.length, 1, `two instances started together: exactly ONE may drain (drained: ${drained.join(", ") || "none"})`);
  const skipped = [resultA, resultB].filter((result) => result.skipped);
  assert.equal(skipped.length, 1, "the other instance must be skipped");
  assert.deepEqual(
    { reason: (skipped[0] as { reason: string }).reason, via: (skipped[0] as { via: string }).via },
    { reason: "overlapping-run", via: "lease" },
    "the skipped instance answers overlapping-run, and it was the shared lease that refused it",
  );

  // ── Released: the next run anywhere drains ───────────────────────────────────────────────────
  // The release re-claims with the shortest ttl the claim allows (one second), so the next tick drains.
  clock.ms += 2_000;
  const afterRelease: string[] = [];
  assert.deepEqual(await drainOn(b, clock, async () => void afterRelease.push("b")), { skipped: false }, "after the lease is released, the other instance's next run drains");
  clock.ms += 2_000;
  assert.deepEqual(await drainOn(a, clock, async () => void afterRelease.push("a")), { skipped: false }, "and so does the first instance's");
  assert.deepEqual(afterRelease, ["b", "a"]);

  // ── A run killed mid-flight: its lease runs out, the next run drains ─────────────────────────
  clock.ms += 2_000;
  const dead = await a.enter(clock.ms);
  assert.equal(dead.entered, true, "an instance claims the drain and then dies without releasing it");
  clock.ms += 60_000;
  const whileHeld = await b.enter(clock.ms);
  assert.equal(whileHeld.entered, false, "while its lease is live, nobody else drains");
  assert.equal(whileHeld.entered === false && whileHeld.via, "lease");
  assert.equal(whileHeld.entered === false && whileHeld.inFlightForMs, 60_000, "the skip says how long the other run has been in flight");
  clock.ms += DRAIN_TTL_MS;
  const takeover = await b.enter(clock.ms);
  assert.equal(takeover.entered, true, "once the dead run's lease runs out (290 s), the next run drains — the old guard's self-healing");
  if (takeover.entered) await takeover.release();

  // ── The same instance twice: refused in process, without asking the store ──────────────────
  clock.ms += 2_000;
  const first = await a.enter(clock.ms);
  assert.equal(first.entered, true);
  const callsBefore = store.calls();
  const second = await a.enter(clock.ms + 5);
  assert.equal(second.entered === false && second.via, "process", "a second run in the SAME process is refused by the in-process guard");
  assert.equal(store.calls(), callsBefore, "and that costs no query");
  if (first.entered) await first.release();

  // ── The lease store is down: fall back to the in-process guard, never stop draining ─────────
  const availability: Array<string | null> = [];
  let storeDown = true;
  const flakyClient: JobLeaseRpcClient = {
    async rpc(fn, args) {
      if (storeDown) return { data: null, error: { code: "57P01", message: "terminating connection due to administrator command" } };
      return store.client.rpc(fn, args);
    },
  };
  const c = createExclusiveRunGuard({
    client: () => flakyClient,
    jobKey: "phoenix-process-notifications-fallback",
    onLeaseAvailability: (detail) => availability.push(detail),
    ttlMs: DRAIN_TTL_MS,
  });
  const downRun = await c.enter(clock.ms);
  assert.equal(downRun.entered, true, "🔴 a lease store that cannot be read must never stop the drain");
  assert.equal(downRun.entered && downRun.via, "process", "it runs under the in-process guard instead");
  const downSecond = await c.enter(clock.ms + 10);
  assert.equal(downSecond.entered === false && downSecond.via, "process", "and that guard still refuses a second run in this process");
  if (downRun.entered) await downRun.release();
  const downAgain = await c.enter(clock.ms + 20);
  assert.equal(downAgain.entered, true, "the in-process guard is released when the run ends");
  if (downAgain.entered) await downAgain.release();
  assert.equal(availability.length, 1, "the outage is reported once, not on every tick");
  assert.match(String(availability[0]), /57P01/, "with the store's own error");
  storeDown = false;
  const backUp = await c.enter(clock.ms + 30);
  assert.equal(backUp.entered && backUp.via, "lease", "when the store answers again, the lease guards the run");
  assert.deepEqual(availability.slice(1), [null], "and the recovery is reported once");
  if (backUp.entered) await backUp.release();

  // A client that cannot even be built (no service key in this process) is the same outage.
  const noClient = createExclusiveRunGuard({
    client: () => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
    },
    jobKey: "phoenix-process-notifications-noclient",
    ttlMs: DRAIN_TTL_MS,
  });
  const noClientRun = await noClient.enter(clock.ms);
  assert.equal(noClientRun.entered && noClientRun.via, "process", "a client that throws falls back too — enter() never throws");
  if (noClientRun.entered) await noClientRun.release();

  // ── The real drain is wired to it ────────────────────────────────────────────────────────────
  const scheduled = code("src/lib/notifications/scheduled-processing.ts");
  assert.match(scheduled, /const OVERLAP_LOCK_MS = 290_000;/, "the lease's ttl is today's 290 s");
  assert.match(scheduled, /createExclusiveRunGuard\(\{[\s\S]*?jobKey: NOTIFICATION_DRAIN_LEASE_KEY,[\s\S]*?ttlMs: OVERLAP_LOCK_MS,/, "the drain claims its own lease for OVERLAP_LOCK_MS");
  assert.match(scheduled, /const entry = await drainOverlapGuard\.enter\(enteredAt\);\s*if \(!entry\.entered\) \{/, "the drain asks the guard before any step runs");
  assert.match(scheduled, /cron_process_overlap_skipped/, "the skip keeps its log event");
  assert.match(scheduled, /return \{ skipped: true as const, reason: "overlapping-run" as const \};/, "and its result");
  assert.match(scheduled, /\} finally \{\s*await entry\.release\(\);\s*\}\s*\}\s*$/, "the lease is released when the run ends, however it ends");
  assert.doesNotMatch(scheduled, /let inFlightStartedAt/, "🔴 the per-process module variable must not come back as the guard");
  assert.match(code("src/lib/platform/job-lease.ts"), /export async function releaseJobLease[\s\S]*?ttlSeconds: 1,/, "a release re-claims for one second, so it can only shorten this holder's own lease");
}

function runBeaconLimitTests() {
  // F-PLT-012, reviewed 13 Nov 2026: the two public telemetry endpoints keep their per-instance caps on
  // purpose. A shared count keyed by the caller's address would write an address-keyed row to the
  // database on every page view; with N instances the cap is N× the limit, still bounded.
  for (const file of ["app/api/telemetry/page-timing/route.ts", "app/api/security/csp-report/route.ts"]) {
    const route = code(file);
    assert.ok(route.includes("createMemoryRateBuckets("), `${file} keeps its bounded per-instance address cap`);
    for (const forbidden of ["assertApiRateLimit", "api_rate_limit", "getSupabaseAdmin", "supabase"]) {
      assert.ok(!route.includes(forbidden), `🔴 ${file} must not count addresses in the shared store (${forbidden}) — that writes the caller's address on every page view`);
    }
  }
}

const STAND_URL = "http://directory-stand-in.invalid";

async function runDirectoryVersionTests() {
  // ── The rule, pure ───────────────────────────────────────────────────────────────────────────
  const at = 1_800_000_000_000;
  const version = (fingerprint: string, latestChangeMs: number | null): DirectorySharedVersion => ({ fingerprint, latestChangeMs });
  assert.equal(sharedDirectoryVersionMoved({ copiesLoadStartedAt: at, current: version("b", at - 60_000), now: at + 20_000, previousFingerprint: "a" }), true, "a version that differs from the last one seen has moved");
  assert.equal(sharedDirectoryVersionMoved({ copiesLoadStartedAt: at, current: version("a", at + 9_000), now: at + 20_000, previousFingerprint: "a" }), false, "the same version has not");
  assert.equal(sharedDirectoryVersionMoved({ copiesLoadStartedAt: at, current: version("x", at + 1_000), now: at + 20_000, previousFingerprint: null }), true, "first look: a change stamped after the copy began loading may be missing from it");
  assert.equal(sharedDirectoryVersionMoved({ copiesLoadStartedAt: at, current: version("x", at - 60_000), now: at + 20_000, previousFingerprint: null }), false, "first look: a change long before the load is in the copy");
  assert.equal(sharedDirectoryVersionMoved({ copiesLoadStartedAt: at, current: version("x", at + 3_600_000), now: at + 20_000, previousFingerprint: null }), false, "a stamp in the future says nothing usable — the TTL still bounds the copy");
  assert.equal(sharedDirectoryVersionMoved({ copiesLoadStartedAt: at, current: version("x", null), now: at + 20_000, previousFingerprint: null }), false);
  assert.ok(DIRECTORY_SHARED_VERSION_CHECK_MS <= 30_000, "a write on another instance must reach this one well inside the 60 s TTL");

  // ── The cache, end to end, against a stand-in database ───────────────────────────────────────
  const savedEnv = { key: process.env.SUPABASE_SERVICE_ROLE_KEY, url: process.env.NEXT_PUBLIC_SUPABASE_URL };
  const realFetch = globalThis.fetch;
  let rosterReads = 0;
  let personName = "Mona Adel";
  process.env.NEXT_PUBLIC_SUPABASE_URL = STAND_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-not-a-key";
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${STAND_URL}/rest/v1/employees?`)) throw new Error(`the directory stand-in was asked for ${url}`);
    rosterReads += 1;
    const rows = [
      { employment_status: "active", full_name: personName, hr_id: "E-9001", job_title: "Medical Representative", line_id: null, lines: null, nickname: null, organogram_visible: true, payroll_eligible: true, position_id: null, positions: null },
    ];
    return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" }, status: 200 });
  };

  let shared: DirectorySharedVersion | null = version("v1", Date.parse("2026-01-01T00:00:00Z"));
  let versionReads = 0;
  let readerThrows = false;
  const reader = async () => {
    versionReads += 1;
    if (readerThrows) throw new Error("database unreachable");
    return shared;
  };
  const nameOf = async () => (await getEmployeeNameRoster()).find((row) => row.hrId === "E-9001")?.displayName;

  try {
    invalidateEmployeeDirectoryCache();

    // A young copy is served without asking (the real interval): a page reading twice pays nothing.
    __setDirectorySharedVersionReaderForTests(reader);
    assert.equal(await nameOf(), "Mona Adel");
    assert.equal(await nameOf(), "Mona Adel");
    assert.equal(rosterReads, 1, "the second read is served from the copy");
    assert.equal(versionReads, 0, "a copy younger than the check interval never asks the shared version");

    // From here every read may ask (interval 0), so the version decides.
    __setDirectorySharedVersionReaderForTests(reader, { checkEveryMs: 0 });
    personName = "Mona Adel Hassan"; // written on ANOTHER instance — this one's cache was never told
    assert.equal(await nameOf(), "Mona Adel", "first look: the version predates the copy, so the copy stands");
    assert.equal(rosterReads, 1);
    assert.equal(await nameOf(), "Mona Adel", "an unchanged version keeps the copy (it is only ever made fresher, never re-read for nothing)");
    assert.equal(rosterReads, 1);

    shared = version("v2", Date.now());
    assert.equal(await nameOf(), "Mona Adel Hassan", "🔴 the shared version moved: this instance drops its copy and re-reads the write made elsewhere");
    assert.equal(rosterReads, 2);
    assert.equal(await nameOf(), "Mona Adel Hassan");
    assert.equal(rosterReads, 2, "and keeps the new copy while the version stands");

    // The version cannot be read: nothing changes, the copy (bounded by its TTL) still answers.
    readerThrows = true;
    personName = "Somebody Else";
    assert.equal(await nameOf(), "Mona Adel Hassan", "an unreadable version never drops a copy or fails a read");
    readerThrows = false;
    shared = null;
    assert.equal(await nameOf(), "Mona Adel Hassan", "nor does an empty answer");
    assert.equal(rosterReads, 2);
  } finally {
    __setDirectorySharedVersionReaderForTests(null);
    invalidateEmployeeDirectoryCache();
    globalThis.fetch = realFetch;
    if (savedEnv.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
    if (savedEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  }

  // The version is the data's own stamp — no new table — and every getter asks before it serves.
  const directory = code("src/lib/employees/employee-directory.ts");
  assert.match(directory, /DIRECTORY_VERSION_TABLES = \["employees", "employee_compensation", "employee_locations"\] as const;/);
  assert.match(directory, /select=updated_at&order=updated_at\.desc\.nullslast&limit=1/);
  for (const getter of ["export async function getEmployeeDirectory()", "export async function getEmployeeNameRoster()", "export async function getEmployeeDirectoryRows("]) {
    const start = directory.indexOf(getter);
    assert.ok(start >= 0, `${getter} must exist`);
    const head = directory.slice(start, start + 400);
    assert.ok(head.includes("await reconcileSharedDirectoryVersion();"), `${getter} must check the shared version before it serves a copy`);
  }
  assert.match(directory, /directoryCache = null;\s*cachedCopiesLoadStartedAt = null;\s*directoryRowsCache\.clear\(\);/, "a local invalidation forgets the copies' load time, so an empty cache never asks");
}

export async function runSharedInstanceStateTests() {
  await runDrainLeaseTests();
  runBeaconLimitTests();
  await runDirectoryVersionTests();
}
