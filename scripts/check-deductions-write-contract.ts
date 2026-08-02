#!/usr/bin/env node
// CI gate: assert what the deductions write path actually puts ON THE WIRE.
//
// WHY THIS IS A STANDALONE SCRIPT AND NOT A TEST.
//
// It was a test first (PR #1596) and it broke CI twice, identically.
// getSupabaseAdmin() memoizes its client for the whole process, and
// tests/run-tests.ts shares ONE process across 519 files. Before this existed CI
// had no Supabase env, getRequiredEnv threw, no client was ever constructed, and
// every later call failed instantly. Setting placeholder env makes a client
// CONSTRUCTIBLE — so every later test touching canAccess ->
// getPermissionMatrixFromDb attempted a real request costing ~7s each, and
// `validate` hit its 20-minute cap (20m16s, then 20m17s after a "fix"; the
// baseline on main is 3m28s-3m42s).
//
// The placeholder VALUE was never the variable — the failures stayed exactly 7s
// apart with 127.0.0.1:1, which refuses instantly. Any test that successfully
// constructs the admin client poisons the shared runner. So this runs in its own
// process, where the constructed client dies with the process and cannot leak.
//
// WHAT IT CATCHES — two defect classes that reached production in 2026-08:
//
//   1. `month_key` is GENERATED ALWAYS. Supplying it made Postgres reject every
//      insert with 428C9: the first real production run created 0 candidates out
//      of 120. A hand-written fake client object would have ACCEPTED that
//      payload, and the suite in fact contained
//      `assert.equal(payload.month_key, "2026-05")` — it asserted the bug and
//      stayed green.
//   2. `.eq(col, null)` and `.is(col, null)` emit DIFFERENT query strings. A
//      `crm_id IS NULL`-only guard is how two managers were billed 53,161 EGP
//      for a month they had worked.
//
// Only the wire shows either one. By the time a request reaches fetch,
// supabase-js has built the real URL and the real JSON body — which is exactly
// what Postgres will see.

import { strict as assert } from "node:assert";

// Assigned unconditionally, NOT with `??=`. `.env.local` on this machine points at
// PRODUCTION Supabase, and a gate that runs on every commit must be structurally
// incapable of holding a real project URL or service-role key — even though the
// fetch stub below means nothing would leave the process anyway.
// 127.0.0.1:1 refuses instantly (no DNS), so an escaped request fails fast rather
// than hanging a CI job.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake-anon-key";

type RecordedRequest = {
  method: string;
  table: string;
  params: Record<string, string>;
  body: unknown;
};

const calls: RecordedRequest[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, "http://127.0.0.1:1");
  const method = (init?.method ?? "GET").toUpperCase();
  const marker = "/rest/v1/";
  const index = url.pathname.indexOf(marker);
  const table = index === -1 ? url.pathname : (url.pathname.slice(index + marker.length).split("?")[0] ?? "");

  let body: unknown = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }

  calls.push({ method, table, params: Object.fromEntries(url.searchParams.entries()), body });

  const rows = Array.isArray(body) ? body : body ? [body] : [];
  const payload = method === "GET" || method === "HEAD" ? [] : rows;
  return new Response(JSON.stringify(payload), {
    status: method === "GET" || method === "HEAD" ? 200 : 201,
    headers: { "content-type": "application/json" },
  });
}) as typeof globalThis.fetch;

const failures: string[] = [];

function check(name: string, run: () => void) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`  FAIL ${name}\n       ${message}`);
  }
}

async function main() {
  const { insertCandidateDrafts } = await import("../src/lib/deductions/service.ts");

  const result = await insertCandidateDrafts({
    createdBy: "write-contract-check",
    drafts: [
      {
        category: "crm",
        sourceSystem: "write-contract-check",
        sourceRecordId: "rec-1",
        employeeHrId: "B-124",
        employeeName: "Contract Check",
        monthKey: "2026-06",
        month: 6,
        year: 2026,
        unit: "days",
        rawValue: 1,
        estimatedAmount: 100,
        dates: ["2026-06-10"],
      },
    ],
    sourceLabel: "write-contract-check",
  });

  console.log("[deductions-write-contract] asserting the wire\n");

  check("the real insert path completes", () => {
    assert.equal(result.created, 1, `expected 1 candidate created, got ${result.created}: ${result.warnings.join("; ")}`);
  });

  const written = calls
    .filter((call) => call.table === "deductions_candidates" && call.method !== "GET" && call.method !== "HEAD")
    .flatMap((call) => (Array.isArray(call.body) ? call.body : call.body ? [call.body] : []) as Record<string, unknown>[]);

  check("exactly one candidate row is sent", () => {
    assert.equal(written.length, 1, `expected 1 insert row, got ${written.length}`);
  });

  // 1. THE month_key CLASS.
  check("the insert body carries NO generated column (month_key)", () => {
    assert.ok(
      written[0] && !Object.prototype.hasOwnProperty.call(written[0], "month_key"),
      "month_key is GENERATED ALWAYS — sending it makes Postgres reject the insert with 428C9, which produced 0 of 120 candidates in production",
    );
  });

  check("month and year ARE sent (the database derives month_key from them)", () => {
    assert.equal(written[0]?.month, 6);
    assert.equal(written[0]?.year, 2026);
  });

  // 2. THE is-null vs eq-null CLASS.
  check("the duplicate probe emits `is.null`, not `eq.null`", () => {
    const probes = calls.filter((call) => call.table === "deductions_candidates" && call.method === "GET");
    assert.ok(probes.length > 0, "the duplicate probe must reach the wire");
    assert.equal(
      probes[0].params.superseded_at,
      "is.null",
      "`eq.null` is a different query that matches no rows — a crm_id IS NULL-only guard is how two managers were billed 53,161 EGP",
    );
  });

  // ── THE DECISION WRITE PATH ────────────────────────────────────────────────
  //
  // The day-picker's Save is the other write this module makes, and it could not
  // be exercised against a real database: production does not have
  // `applied_dates` until the migration lands, and staging does not have the
  // unified deductions tables at all (it still only carries the legacy
  // `deduction_*` governance set). The wire is therefore the only place the
  // payload can be checked — which is exactly what this script exists for.
  //
  // A URL-aware stub, because recordDecision now READS before it writes:
  // `.single()`/`.maybeSingle()` ask for a single object, and answering those
  // with `[]` would leave `unit` undefined and silently route the candidate down
  // the amount-unit branch — the assertions would then pass on the wrong code.
  const decisionCalls: RecordedRequest[] = [];
  const CANDIDATE = {
    id: "cand-1",
    locked_at: null,
    unit: "days",
    raw_value: 4,
    estimated_amount: 400,
    dates: ["2026-07-03", "2026-07-07", "2026-07-14", "2026-07-21"],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://127.0.0.1:1");
    const method = (init?.method ?? "GET").toUpperCase();
    const marker = "/rest/v1/";
    const index = url.pathname.indexOf(marker);
    const table = index === -1 ? url.pathname : (url.pathname.slice(index + marker.length).split("?")[0] ?? "");

    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    decisionCalls.push({ method, table, params: Object.fromEntries(url.searchParams.entries()), body });

    const wantsObject = String(new Headers(init?.headers).get("accept") ?? "").includes("pgrst.object");

    if (method === "GET") {
      if (table === "deductions_candidates") {
        return new Response(JSON.stringify(wantsObject ? CANDIDATE : [CANDIDATE]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // No decision row yet — maybeSingle() reads this as data null, error null.
      return new Response(JSON.stringify(wantsObject ? null : []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const written = Array.isArray(body) ? body[0] : body;
    const row = { id: "dec-1", candidate_id: "cand-1", created_at: "x", updated_at: "x", ...(written as object) };
    return new Response(JSON.stringify(wantsObject ? row : [row]), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  const { recordDecision } = await import("../src/lib/deductions/service.ts");
  await recordDecision({
    actor: { role: "Super Admin", hrId: "B-1", loginId: "contract-check" },
    candidateId: "cand-1",
    decisionStatus: "Pending",
    decisionReason: "",
    // Three of the four detected days ticked — the reviewer dropped 2026-07-07.
    appliedDates: ["2026-07-03", "2026-07-14", "2026-07-21"],
  });

  console.log("\n[deductions-write-contract] asserting the DECISION wire\n");

  const decisionWrites = decisionCalls
    .filter((call) => call.table === "deductions_decisions" && call.method !== "GET" && call.method !== "HEAD")
    .flatMap((call) => (Array.isArray(call.body) ? call.body : call.body ? [call.body] : []) as Record<string, unknown>[]);

  check("the decision upsert reaches the wire exactly once", () => {
    assert.equal(decisionWrites.length, 1, `expected 1 decision write, got ${decisionWrites.length}`);
  });

  check("the ticked days are sent as applied_dates", () => {
    assert.deepEqual(
      decisionWrites[0]?.applied_dates,
      ["2026-07-03", "2026-07-14", "2026-07-21"],
      "the reviewer's day selection must reach the database, or the picker is decorative",
    );
  });

  check("applied_value is DERIVED from the ticks, not from the caller", () => {
    assert.equal(decisionWrites[0]?.applied_value, 3, "three ticked days must be sent as three days");
  });

  check("applied_amount is DERIVED server-side (400 EGP over 4 days -> 300 for 3)", () => {
    assert.equal(
      decisionWrites[0]?.applied_amount,
      300,
      "the amount must be re-derived from the stored candidate — a browser must never dictate a payroll figure",
    );
  });

  check("the existing decision is READ before it is overwritten", () => {
    const firstWriteIndex = decisionCalls.findIndex(
      (call) => call.table === "deductions_decisions" && call.method !== "GET" && call.method !== "HEAD",
    );
    const readIndex = decisionCalls.findIndex(
      (call) => call.table === "deductions_decisions" && call.method === "GET",
    );
    assert.ok(readIndex !== -1, "recordDecision must read the existing decision row");
    assert.ok(
      readIndex < firstWriteIndex,
      "the read must precede the upsert, or an omitted field blanks a saved day selection",
    );
  });

  globalThis.fetch = originalFetch;

  if (failures.length > 0) {
    console.error(`\n[deductions-write-contract] FAILED — ${failures.length} assertion(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\n[deductions-write-contract] OK — the write path sends exactly what the schema accepts.");
}

main().catch((error) => {
  globalThis.fetch = originalFetch;
  console.error("[deductions-write-contract] threw:", error);
  process.exit(1);
});
