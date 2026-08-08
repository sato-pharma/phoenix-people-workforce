import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isMissingCrmRpcError,
  resolveLiveDepartedExclusion,
  scanDepartedAgentCrmIds,
} from "../src/lib/crm/reads.ts";
import { isCrmSchemaMissingError } from "../src/lib/crm/schema.ts";

// scanDepartedAgentCrmIds computes the LIVE half of the CRM agent exclusion, and that list feeds
// Double Visit Analytics, Field Workforce Compliance, probation DV credit, and the FWC connector
// behind automated payroll's no-activity deduction detector. Both directions are expensive:
// over-excluding hides a working rep's fieldwork, under-excluding resurfaces a departed one and can
// arm a deduction against somebody who genuinely stopped logging visits months ago.
//
// It used to read every matching visit row 2,000 at a time purely to collect DISTINCT
// agent_crm_id. Measured against production 2026-08-09: 8 sequential Railway-sfo →
// Supabase-eu-central-1 round trips, 15,492 rows, 1,944 ms, to produce 23 integers. It now asks
// Postgres for the distinct set in one statement (phx_crm_agent_crm_ids_for_hr_ids). These tests
// pin the four ways that swap could silently change WHICH ids come back.

type QueryResult = { data: unknown; error: unknown; count?: number | null };

/** Minimal thenable that mimics a PostgREST builder: every chained filter returns `this`, and
 * awaiting it resolves the recorded result. */
function builder(resolve: () => QueryResult) {
  const self: Record<string, unknown> = {
    then(onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) {
      return Promise.resolve()
        .then(resolve)
        .then(onFulfilled, onRejected);
    },
  };
  for (const method of ["select", "in", "order", "limit", "gt", "range", "eq", "not"]) {
    self[method] = () => self;
  }
  return self;
}

const PGRST202 = {
  code: "PGRST202",
  message: "Could not find the function public.phx_crm_agent_crm_ids_for_hr_ids(p_agent_hr_ids) in the schema cache",
};
const MIRROR_MISSING = {
  code: "42P01",
  message: 'relation "public.ireports360_visits" does not exist',
};

/** A client whose RPC answers, and whose table reads blow up if anything falls back to them. */
function rpcClient(result: QueryResult) {
  const calls: { rpc: number; from: number } = { rpc: 0, from: 0 };
  const client = {
    rpc: () => {
      calls.rpc += 1;
      return builder(() => result);
    },
    from: () => {
      calls.from += 1;
      throw new Error("the page walk must not run when the RPC answered");
    },
  } as unknown as SupabaseClient;
  return { calls, client };
}

/** A client whose RPC serves successive responses — models PostgREST capping a response at
 * db-max-rows and `rpcAll` fetching the remainder by range. */
function cappedRpcClient(responses: QueryResult[]) {
  let index = 0;
  const calls = { rpc: 0 };
  const client = {
    rpc: () => {
      calls.rpc += 1;
      const response = responses[index] ?? { data: [], error: null, count: 0 };
      index += 1;
      return builder(() => response);
    },
    from: () => {
      throw new Error("the page walk must not run when the RPC answered");
    },
  } as unknown as SupabaseClient;
  return { calls, client };
}

/** A client with NO RPC (returns PGRST202) whose table reads serve `pages` in order — the shape of
 * a database where the distinct-scan migration has not been applied yet. */
function pageWalkClient(pages: Array<Array<{ id: string; agent_crm_id: number | null }>>, rpcError: unknown = PGRST202) {
  const calls = { rpc: 0, from: 0 };
  let pageIndex = 0;
  const client = {
    rpc: () => {
      calls.rpc += 1;
      return builder(() => ({ data: null, error: rpcError }));
    },
    from: () => {
      calls.from += 1;
      return builder(() => ({ data: pages[pageIndex++] ?? [], error: null }));
    },
  } as unknown as SupabaseClient;
  return { calls, client };
}

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

export async function runCrmDepartedAgentScanTests() {
  // 1. The happy path: one RPC round trip, distinct ids, nulls dropped, never a table read.
  const happy = rpcClient({
    data: [{ agent_crm_id: 1399 }, { agent_crm_id: "1207" }, { agent_crm_id: null }, { agent_crm_id: 1399 }],
    error: null,
    count: 4,
  });
  assert.deepEqual(
    sorted(await scanDepartedAgentCrmIds(["B-97"], happy.client)),
    [1207, 1399],
    "the RPC returns the distinct crm_id set; a null agent_crm_id is dropped, not coerced to 0, and a bigint delivered as a string still lands as a number",
  );
  assert.equal(happy.calls.rpc, 1, "the whole scan is ONE round trip — that is the entire point of the change");
  assert.equal(happy.calls.from, 0, "the mirror table is never paged when the RPC answered");

  // 2. An unmigrated database (PGRST202) falls back to the ORIGINAL page walk and produces the
  //    SAME set. Without this, staging/a fresh clone/a rollback would silently lose the live tier.
  const walk = pageWalkClient([
    [
      { id: "a", agent_crm_id: 1399 },
      { id: "b", agent_crm_id: 1207 },
      { id: "c", agent_crm_id: null },
      { id: "d", agent_crm_id: 1399 },
    ],
  ]);
  assert.deepEqual(
    sorted(await scanDepartedAgentCrmIds(["B-97"], walk.client)),
    [1207, 1399],
    "a database without the RPC still gets the identical id set from the page-walk fallback",
  );
  assert.equal(walk.calls.from, 1, "the fallback actually paged the mirror rather than returning empty");

  // 3. THE TRAP. PostgREST reports a missing FUNCTION with the words 'schema cache', which
  //    isCrmSchemaMissingError also matches. If the scan tested schema-missing first, an unmigrated
  //    database would degrade to an EMPTY live exclusion and every departed rep would reappear
  //    across DV Analytics, FWC, and the payroll no-activity detector.
  assert.equal(
    isCrmSchemaMissingError(PGRST202),
    true,
    "documents the collision: the mirror-missing matcher DOES match a missing-function error",
  );
  assert.equal(isMissingCrmRpcError(PGRST202), true, "a missing function is recognised as a missing function");
  assert.equal(
    isMissingCrmRpcError(MIRROR_MISSING),
    false,
    "a missing mirror TABLE is not a missing function — it must degrade, not page-walk forever",
  );

  // 4. A genuinely missing mirror still degrades to an empty scan instead of throwing (unchanged
  //    behavior: a fresh environment renders 'not set up yet' rather than crashing).
  const noMirror = pageWalkClient([[]], MIRROR_MISSING);
  assert.deepEqual(
    await scanDepartedAgentCrmIds(["B-97"], noMirror.client),
    [],
    "no mirror at all -> empty scan, matching the pre-existing degradation contract",
  );

  // 5. A REAL error must throw. Swallowing it would hand back an empty live tier that looks exactly
  //    like 'nobody has left', which is the under-exclusion failure mode.
  const broken = rpcClient({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
  await assert.rejects(
    () => scanDepartedAgentCrmIds(["B-97"], broken.client),
    /statement timeout/,
    "a timeout surfaces as a real error; it must never be mistaken for an empty departed set",
  );

  // 6. A response capped by db-max-rows must be completed, not silently truncated. A truncated
  //    exclusion list is an UNDER-exclusion: the departed reps in the dropped tail come back to
  //    life in every CRM read. `rpcAll` is used precisely so the exact count catches this.
  const capped = cappedRpcClient([
    { data: [{ agent_crm_id: 1207 }, { agent_crm_id: 1399 }], error: null, count: 3 },
    { data: [{ agent_crm_id: 1502 }], error: null, count: 3 },
  ]);
  assert.deepEqual(
    sorted(await scanDepartedAgentCrmIds(["B-97"], capped.client)),
    [1207, 1399, 1502],
    "the tail beyond the PostgREST row cap is fetched — a truncated exclusion would resurface a departed rep",
  );
  assert.equal(capped.calls.rpc, 2, "the second round trip only happens because the exact count said rows were missing");

  // 7. No departed employees -> no query at all. The client here throws on any use.
  const untouched = {
    rpc: () => {
      throw new Error("no departed hr ids means no database call");
    },
    from: () => {
      throw new Error("no departed hr ids means no database call");
    },
  } as unknown as SupabaseClient;
  assert.deepEqual(await scanDepartedAgentCrmIds([], untouched), [], "an empty departed list short-circuits");

  // 8. The handed-over-slot carve-out still runs ON TOP of the scan. crm_id 1399 is the real
  //    production case (B-97's slot, reassigned to AI-0006 hired 2026-08-02): the scan MUST still
  //    report it as departed, and resolveLiveDepartedExclusion is what keeps the successor visible.
  const scanned = await scanDepartedAgentCrmIds(["B-97"], rpcClient({
    data: [{ agent_crm_id: 1399 }, { agent_crm_id: 1207 }],
    error: null,
    count: 2,
  }).client);
  assert.ok(scanned.includes(1399), "the scan itself is date-unscoped and still sees the handed-over slot");
  assert.deepEqual(
    resolveLiveDepartedExclusion({ scannedCrmIds: scanned, activeEmployeeCrmIds: new Set(["1399"]) }),
    [1207],
    "a slot an ACTIVE employee now owns is dropped from the live exclusion — the successor stays visible",
  );
}
