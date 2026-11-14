import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  appendMasterNote,
  isPinnableMatch,
  isUntouchedCode,
  masterRecheckDetail,
  type MasterMatch,
  nightlyMatchNote,
  planMasterRecheck,
  type RecheckCodeRow,
  UNTOUCHED_NOTE,
} from "../src/lib/marketing-requests/master-recheck.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The nightly re-check of unresolved pharmacy codes (enterprise audit REC-077, F-MKT-011; 14 Nov 2026).
//
// Owner's choice, "pin untouched, list rest": a code nobody has decided on is matched to the sales
// master at night exactly as it would have been at capture; a code a PERSON approved or noted is never
// changed by the night, and waits in Marketing Control for a person. The case that makes this matter is
// on production: POS 1536256 was approved by hand as «صيدلية زمزم», and the master gives that code to a
// different shop. A night that pinned it would have silently re-pointed a person's decision.
// ─────────────────────────────────────────────────────────────────────────────

function code(overrides: Partial<RecheckCodeRow> & { id: string }): RecheckCodeRow {
  return {
    distributor_id: 1,
    distributor_pharmacy_code: "42850",
    master_match_kind: "unresolved",
    master_recheck_kept_at: null,
    pharmacy_id: "p-1",
    reference_status: "not_found",
    validated_by_hr_id: null,
    validation_notes: UNTOUCHED_NOTE,
    ...overrides,
  };
}

function match(id: string, kind = "exact"): MasterMatch {
  return { area_code: "A1", area_name: "Area One", code_id: id, customer_code: "42850", customer_name: "صيدلية", distributor_code: "EG", match_kind: kind };
}

export function runMarketingPharmacyCodeRecheckTests() {
  // ── who counts as untouched ──
  assert.equal(isUntouchedCode(code({ id: "a" })), true, "the capture flow's own not-found note is untouched");
  assert.equal(isUntouchedCode(code({ id: "a", validation_notes: null })), true, "no note is untouched");
  assert.equal(isUntouchedCode(code({ id: "a", validation_notes: "  Reference not found.  " })), true);
  // The production case: approved by hand, but with no validated_by — the status alone makes it a person's.
  assert.equal(
    isUntouchedCode(code({ id: "zamzam", reference_status: "manual_approved", validation_notes: "Reference not found. | Approved 2026-09-02" })),
    false,
    "an approved code is a person's decision even when nobody's id is on it (1536256)",
  );
  assert.equal(isUntouchedCode(code({ id: "a", validated_by_hr_id: "B-10" })), false, "a code with a validator is a person's");
  assert.equal(isUntouchedCode(code({ id: "a", validation_notes: "Corrected 2026-08-19: entered code 72884" })), false, "a written note is a person's");
  assert.equal(isUntouchedCode(code({ id: "a", reference_status: "rejected" })), false);

  assert.equal(isPinnableMatch(match("a", "exact")), true);
  assert.equal(isPinnableMatch(match("a", "digit_normalized")), true);
  assert.equal(isPinnableMatch(match("a", "ambiguous")), false, "an ambiguous master never pins");
  assert.equal(isPinnableMatch(null), false);

  // ── the plan, on the shape production had on 14 Nov 2026 ──
  const codes = [
    code({ id: "u1" }),
    code({ id: "u2", validation_notes: null }),
    code({ id: "zamzam", reference_status: "manual_approved", validation_notes: "Reference not found. | Approved by hand" }),
    code({ id: "khaled", reference_status: "manual_approved", validated_by_hr_id: "S-1", validation_notes: "Corrected" }),
    code({ id: "kept", reference_status: "manual_approved", validated_by_hr_id: "S-1", master_recheck_kept_at: "2026-11-14T10:00:00Z" }),
    code({ id: "amb" }),
    code({ id: "none" }),
    code({ id: "already", master_match_kind: "exact" }),
  ];
  const plan = planMasterRecheck(codes, [
    match("u1"),
    match("u2", "digit_normalized"),
    match("zamzam"),
    match("khaled"),
    match("kept"),
    match("amb", "ambiguous"),
    match("already"),
  ]);
  assert.deepEqual(plan.pin.map((entry) => entry.code.id), ["u1", "u2"], "only the untouched codes are pinned by the night");
  assert.deepEqual(
    plan.awaiting.map((entry) => entry.code.id),
    ["zamzam", "khaled"],
    "a person's code the master now knows is listed, never pinned; a kept one leaves the list",
  );
  assert.equal(plan.ambiguous, 1);
  assert.equal(plan.stillUnmatched, 1);
  assert.ok(!plan.pin.some((entry) => entry.code.id === "already"), "a code already resolved is not the re-check's");

  // ── what is said ──
  assert.equal(appendMasterNote(UNTOUCHED_NOTE, "Matched"), "Reference not found. | Matched", "the old note is kept in front");
  assert.equal(appendMasterNote(null, "Matched"), "Matched");
  assert.match(
    nightlyMatchNote(match("u1"), new Date("2026-11-14T23:30:00Z")),
    /nightly re-check on 2026-11-15: EG 42850 \(صيدلية\)/,
    "the note is dated in Cairo and names the master's shop",
  );
  assert.equal(
    masterRecheckDetail({ ambiguous: 1, awaitingConfirmation: 2, checked: 21, dryRun: false, notPinned: 0, pinned: 7, stillUnmatched: 11 }),
    "re-check: 21 unresolved, pinned 7, 2 awaiting confirmation, 1 ambiguous, 11 still unknown",
  );
  assert.match(
    masterRecheckDetail({ ambiguous: 0, awaitingConfirmation: 0, checked: 3, dryRun: true, notPinned: 0, pinned: 3, stillUnmatched: 0 }),
    /would pin 3/,
    "a dry run says what it would do",
  );

  // ── the wiring, pinned by source ──
  const service = readFileSync("src/lib/marketing-requests/master-recheck.ts", "utf8");
  assert.match(service, /\.eq\("reference_status", "not_found"\)\s*\.is\("validated_by_hr_id", null\)/, "the night's note only lands on a code still untouched");
  assert.match(service, /if \(!dryRun && plan\.pin\.length > 0\)/, "a dry run writes nothing");
  assert.equal((service.match(/assertRealSessionForDecision\(access/g) ?? []).length, 2, "both decisions need a real session");
  assert.equal((service.match(/writeRequiredAuditLog\(/g) ?? []).length, 2, "both decisions are audit-logged");
  assert.match(service, /access\.role !== "Super Admin"/, "the list and both decisions are Super Admin only");

  const cron = readFileSync("app/api/cron/marketing-pharmacy-code-sync/route.ts", "utf8");
  assert.ok(
    cron.indexOf("runSalesPharmacyCodeSync({ dryRun })") < cron.indexOf("runMasterRecheck({ dryRun })"),
    "the re-check runs after the sync has refreshed the master's codes",
  );
  assert.match(cron, /pingDeadMansSwitch\(JOB_SLUG, "success", detail\)/, "the night's counts are reported in the heartbeat");

  // The area's name comes back with the match: marketing code reads no `areas` table and no cached
  // reference list (tests/performance-phase-3.test.ts, tests/reference-list-cache.test.ts).
  assert.doesNotMatch(service, /from\("areas"\)|reference-lists/, "the list takes the area name from the preview");
  const nameMigration = readFileSync("supabase/migrations/20261114154921_marketing_pharmacy_code_recheck_area_name.sql", "utf8");
  assert.match(nameMigration, /area_name text\s*\)/, "the preview returns the area's name");
  assert.match(nameMigration, /revoke execute on function public\.phx_preview_marketing_pharmacy_code_matches\(uuid\[\]\) from public, anon, authenticated;/);

  const route = readFileSync("app/api/marketing-requests/pharmacy-code-recheck/route.ts", "utf8");
  assert.match(route, /assertSameOriginMutation\(request\)/, "a decision is same-origin only");

  const migration = readFileSync("supabase/migrations/20261114152653_marketing_pharmacy_code_recheck.sql", "utf8");
  assert.match(migration, /revoke execute on function public\.phx_preview_marketing_pharmacy_code_matches\(uuid\[\]\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.phx_preview_marketing_pharmacy_code_matches\(uuid\[\]\) to service_role;/);
  assert.match(migration, /coalesce\(cardinality\(p_code_ids\), 0\) > 0/, "the preview never reads the whole table on a null list");
  assert.doesNotMatch(migration.split("$function$")[1] ?? "", /\bupdate\b|\binsert\b|\bdelete\b/i, "the preview writes nothing");
}
