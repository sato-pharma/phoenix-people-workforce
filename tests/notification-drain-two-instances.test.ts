import assert from "node:assert/strict";

// TWO DRAINS START AT ONCE, ONE DRAINS — THE REAL DRAIN, NOT A COPY OF ITS WRAPPER (REC-083, 19 Nov 2026).
//
// tests/shared-instance-state.test.ts proves the lease helper (`createExclusiveRunGuard`) with two
// guards over a fake store, around a stand-in for the drain's steps. This test runs the drain itself:
// `runScheduledNotificationProcessing`, loaded as TWO module instances — two servers, each with its own
// in-process guard, as the old and the new container are during a deploy — against ONE in-memory
// stand-in for the database's `claim_job_lease` (the migration's rule: free, ours, or run out → ours).
// Every other database request is answered empty, and anything addressed outside the stand-in is
// refused and counted, so nothing leaves the machine.
//
// The first drain is held inside its first step while the second starts: the second must answer
// `overlapping-run` because the SHARED lease refused it (not the in-process guard, which a second
// server does not share), and only one drain may reach a step. Once the first drain ends and hands the
// lease back, the next run on the other server drains.

type LeaseRow = { expiresMs: number; holder: string };

const DRAIN_KEY = "phoenix-process-notifications";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

export async function runNotificationDrainTwoInstancesTests() {
  const saved = { fetch: globalThis.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY, log: console.log, url: process.env.NEXT_PUBLIC_SUPABASE_URL };
  const base = `https://drain-two-instances-${Date.now()}.example.supabase.co`;
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-drain-two-instances";

  const leases = new Map<string, LeaseRow>();
  const claims: Array<{ held: boolean; holder: string; ttl: number }> = [];
  const outside: string[] = [];
  let stepRequests = 0;
  let holdFirstStep: Promise<void> | null = null;
  let releaseFirstStep: () => void = () => undefined;
  let firstStepReached: () => void = () => undefined;
  const firstStepSeen = new Promise<void>((resolve) => {
    firstStepReached = resolve;
  });
  holdFirstStep = new Promise<void>((resolve) => {
    releaseFirstStep = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== base) {
      outside.push(url.origin);
      return json(503, { message: "refused by the test: nothing may leave the machine" });
    }
    if (url.pathname.endsWith("/rest/v1/rpc/claim_job_lease")) {
      const args = JSON.parse(String(init.body)) as { p_holder: string; p_job_key: string; p_ttl_seconds: number };
      const now = Date.now();
      const row = leases.get(args.p_job_key);
      if (!row || row.holder === args.p_holder || row.expiresMs < now) {
        leases.set(args.p_job_key, { expiresMs: now + args.p_ttl_seconds * 1000, holder: args.p_holder });
      }
      const current = leases.get(args.p_job_key)!;
      const held = current.holder === args.p_holder;
      if (args.p_job_key === DRAIN_KEY) claims.push({ held, holder: args.p_holder, ttl: args.p_ttl_seconds });
      return json(200, [{ expires_at: new Date(current.expiresMs).toISOString(), held, holder: current.holder }]);
    }
    // Any other request is a drain step reaching the database. The first one waits until the test lets
    // it go, so the first drain is provably mid-run while the second starts.
    stepRequests += 1;
    if (holdFirstStep) {
      const hold = holdFirstStep;
      holdFirstStep = null;
      firstStepReached();
      await hold;
    }
    const method = (init.method ?? "GET").toUpperCase();
    const wantsObject = (new Headers(init.headers).get("accept") ?? "").includes("vnd.pgrst.object");
    if (wantsObject) return json(406, { code: "PGRST116", message: "no rows" });
    return method === "GET" || method === "HEAD" ? json(200, []) : json(201, []);
  }) as typeof fetch;

  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  try {
    // Two servers: the same file loaded twice (a query string makes a second module instance), so each
    // has its own module-level drain guard.
    type DrainModule = typeof import("../src/lib/notifications/scheduled-processing.ts");
    const loadServer = async (name: string) => (await import(`../src/lib/notifications/scheduled-processing.ts?server=${name}`)) as DrainModule;
    const serverA = await loadServer("a");
    const serverB = await loadServer("b");
    assert.notEqual(serverA, serverB, "two module instances — two servers");

    // Both start at once.
    const runA = serverA.runScheduledNotificationProcessing(5);
    const runB = serverB.runScheduledNotificationProcessing(5);

    // One of them claimed the lease and is now held inside its first step…
    await firstStepSeen;
    // …and the other has already answered, while the first is still running.
    const loser = await Promise.race([
      runA.then((result) => ({ result, server: "a" as const })),
      runB.then((result) => ({ result, server: "b" as const })),
    ]);
    assert.deepEqual(loser.result, { reason: "overlapping-run", skipped: true }, "the second drain is skipped as an overlap while the first runs");
    assert.equal(stepRequests, 1, "only the first drain has reached a step");

    releaseFirstStep();
    const [resultA, resultB] = await Promise.all([runA, runB]);
    const drained = [resultA, resultB].filter((result) => !("skipped" in result && result.skipped));
    const skipped = [resultA, resultB].filter((result) => "skipped" in result && result.skipped);
    assert.equal(drained.length, 1, "two drains started together: exactly ONE drained");
    assert.equal(skipped.length, 1, "and the other was skipped");

    const overlap = lines.filter((line) => line.includes("cron_process_overlap_skipped"));
    assert.equal(overlap.length, 1, "the skip is logged once");
    assert.match(overlap[0], /"via":"lease"/, "and it was the SHARED lease that refused it — the in-process guard is not shared between servers");

    const drainClaims = claims.filter((claim) => claim.ttl === 290);
    assert.equal(drainClaims.length, 2, "each server asked the lease once, for the drain's 290 s");
    assert.notEqual(drainClaims[0].holder, drainClaims[1].holder, "under two different holders");
    assert.deepEqual(drainClaims.map((claim) => claim.held).sort(), [false, true], "one was granted, one refused");
    assert.ok(claims.some((claim) => claim.ttl === 1 && claim.holder === drainClaims.find((c) => c.held)!.holder), "the drain that ran handed the lease back when it ended");

    // Handed back: the release re-claims the lease for one second (the shortest the claim allows), so
    // the next run anywhere drains once that second is out — not after the full 290 s.
    const handedBack = leases.get(DRAIN_KEY)!;
    assert.ok(handedBack.expiresMs - Date.now() <= 1_000, "the lease now runs out within one second, not 290");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, handedBack.expiresMs - Date.now()) + 25));
    const stepsBefore = stepRequests;
    const refusedServer = loser.server === "a" ? serverA : serverB;
    const next = await refusedServer.runScheduledNotificationProcessing(5);
    assert.ok(!("skipped" in next && next.skipped), "after the first drain ends, the other server's next run drains");
    assert.ok(stepRequests > stepsBefore, "and reaches its steps");

    // Every request went to the stand-in, which refuses anything outside the database (a step reads the
    // public holiday calendar, for one). None of them was a message: no email, Telegram, push or WhatsApp.
    const senders = outside.filter((origin) => /resend|brevo|telegram|onesignal|facebook|turbify|yahoo/i.test(origin));
    assert.deepEqual(senders, [], `the drains reached no sending service (asked: ${[...new Set(outside)].join(", ") || "nothing outside"})`);
  } finally {
    console.log = saved.log;
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
  }
}
