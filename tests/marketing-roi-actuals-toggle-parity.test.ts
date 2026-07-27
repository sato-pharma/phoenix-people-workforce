import assert from "node:assert/strict";

import { loadActuals, type SupabaseAdmin } from "../src/lib/marketing-requests/roi-report-service.ts";

// Guards the bug found 2026-07-27: getMarketingRoiReport() calls
// loadActuals(supabase, ids, excludeCodes) where
// `excludeCodes = includeRestricted ? [] : RESTRICTED_CODES_UPPER`. Before this fix, loadActuals
// took a hard fork on "is excludeCodes empty" and called v1 (phx_marketing_request_roi_actuals)
// directly whenever it was — a shortcut that used to be a safe, byte-identical optimization
// ("passing an empty array reproduces the base RPC exactly", per the original v2/masking
// migration's own comment). The 2026-07-19 Phase-D migration
// (20260719151000_marketing_roi_actuals_v2_direct_branch.sql) added a track_direct_sales
// direct-order branch to v2 ONLY, silently invalidating that equivalence: v1 now under-counts
// sales for any direct-order campaign. The practical effect: a CEO/Super Admin ticking "include
// restricted products" on the ROI Report toggled the SAME page between two different engines —
// v2 (with direct-order sales) when unticked, v1 (without) when ticked — so the total changed for
// a reason unrelated to product restriction. loadActuals now always prefers v2 (passing whatever
// excludeCodes it was given, even []) and only falls back to v1 when the v2 RPC call itself fails.
//
// See also marketing-roi-attribution-consistency.test.ts, which locks the SQL side of this same
// v1-vs-v2 story (both bodies share the exact-match predicate; only v2 has the direct_hits union).

type RpcCall = { name: string; params: Record<string, unknown> };
type RpcHandler = (params: Record<string, unknown>) => { data: unknown; error: unknown };

/** Minimal stub of the Supabase client surface loadActuals uses (supabase.rpc only). */
function fakeRpcSupabase(handlers: Record<string, RpcHandler>) {
  const calls: RpcCall[] = [];
  const supabase = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      const handler = handlers[name];
      if (!handler) throw new Error(`fakeRpcSupabase: no handler registered for rpc "${name}"`);
      return handler(params);
    },
  } as unknown as SupabaseAdmin;
  return { supabase, calls };
}

function okRow(value: number) {
  return {
    data: [{ request_id: "r1", actual_value: value, actual_units: value / 10, sales_rows: 2, attribution_quality: "exact_customer" }],
    error: null,
  };
}

async function testEmptyExcludeCodesStillPrefersV2() {
  const { supabase, calls } = fakeRpcSupabase({
    phx_marketing_request_roi_actuals_v2: () => okRow(150),
    phx_marketing_request_roi_actuals: () => {
      throw new Error("v1 must not be called — v2 succeeded and there was nothing to fall back for");
    },
  });

  const { byRequest, masked } = await loadActuals(supabase, ["r1"], []);

  assert.equal(masked, false, "nothing to mask -> masked stays false");
  assert.equal(byRequest.get("r1")?.value, 150, "must use v2's total (includes Phase-D direct-order sales)");
  const v2Calls = calls.filter((c) => c.name === "phx_marketing_request_roi_actuals_v2");
  assert.equal(v2Calls.length, 1, "v2 must be called exactly once, even though excludeCodes is empty");
  assert.deepEqual(v2Calls[0]!.params.p_exclude_product_codes, [], "v2 is still called with the (empty) exclude list, not skipped entirely");
  assert.ok(
    !calls.some((c) => c.name === "phx_marketing_request_roi_actuals"),
    "v1 (no direct-order branch) must never be reached when v2 succeeds — this is the exact toggle bug",
  );
}

async function testNonEmptyExcludeCodesUnchangedMaskingBehavior() {
  const { supabase, calls } = fakeRpcSupabase({
    phx_marketing_request_roi_actuals_v2: (params) => {
      assert.deepEqual(params.p_exclude_product_codes, ["LA003"]);
      return okRow(150);
    },
  });

  const { byRequest, masked } = await loadActuals(supabase, ["r1"], ["LA003"]);

  assert.equal(masked, false, "v2 succeeded -> nothing was withheld");
  assert.equal(byRequest.get("r1")?.value, 150);
  assert.equal(calls.length, 1, "only v2 is called when it succeeds — the masking-required path is unchanged");
}

async function testV2FailureFallsBackToV1AndPreservesMaskedSemantics() {
  // Masking WAS required (non-empty excludeCodes) and v2 is unavailable -> withhold via masked:true.
  {
    const { supabase } = fakeRpcSupabase({
      phx_marketing_request_roi_actuals_v2: () => ({ data: null, error: new Error("v2 not deployed yet") }),
      phx_marketing_request_roi_actuals: () => okRow(100),
    });
    const { byRequest, masked } = await loadActuals(supabase, ["r1"], ["LA003"]);
    assert.equal(masked, true, "masking was required and v2 failed -> caller must withhold confidential-bearing requests");
    assert.equal(byRequest.get("r1")?.value, 100, "still returns v1's (lower, no-direct-order) total as the degraded read");
  }

  // Masking was NOT required (empty excludeCodes) and v2 is unavailable -> masked stays false,
  // since there was nothing to withhold; v1 is simply the best available (degraded) read.
  {
    const { supabase } = fakeRpcSupabase({
      phx_marketing_request_roi_actuals_v2: () => ({ data: null, error: new Error("v2 not deployed yet") }),
      phx_marketing_request_roi_actuals: () => okRow(100),
    });
    const { byRequest, masked } = await loadActuals(supabase, ["r1"], []);
    assert.equal(masked, false, "nothing needed masking, so there is nothing to withhold even in the v1 fallback");
    assert.equal(byRequest.get("r1")?.value, 100);
  }
}

export async function runMarketingRoiActualsToggleParityTests() {
  await testEmptyExcludeCodesStillPrefersV2();
  await testNonEmptyExcludeCodesUnchangedMaskingBehavior();
  await testV2FailureFallsBackToV1AndPreservesMaskedSemantics();
}
