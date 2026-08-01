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
