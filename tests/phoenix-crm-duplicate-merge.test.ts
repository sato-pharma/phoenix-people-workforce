import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { MERGE_ACTIVE_PLACE_CAP, planMerge, type MergeCandidate } from "../src/lib/phoenix-crm/duplicate-merge-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the same-seat duplicate merge (owner, 2026-10-08: "auto-merge the proven duplicates,
 * with a pre-image and a report"). The keep rule is behaviour; the write's guards and the script's
 * dry-run default are pinned by source, because each failure there is a bulk production change.
 */

let next = 0;
const row = (overrides: Partial<MergeCandidate> = {}): MergeCandidate => {
  next += 1;
  return {
    customerId: `00000000-0000-0000-0000-${String(next).padStart(12, "0")}`,
    name: `row ${next}`,
    listType: "PM",
    activePlaces: 0,
    validatedAt: null,
    visits: 0,
    createdAt: "2026-10-01T08:00:00Z",
    hasMoves: false,
    grade: null,
    potentialGrade: null,
    phone: null,
    primaryPharmacyName: null,
    ...overrides,
  };
};

function checkKeepRule(): void {
  const place = row({ activePlaces: 1, name: "with place", validatedAt: "2026-10-03T08:00:00Z" });
  const validated = row({ validatedAt: "2026-10-02T08:00:00Z", name: "validated" });
  let plan = planMerge([validated, place]);
  assert.ok(plan.ok && plan.keeper.name === "with place", "the row holding an active place stays");
  assert.ok(plan.ok && plan.why === "It holds the validated place");

  plan = planMerge([row({ name: "plain" }), validated]);
  assert.ok(plan.ok && plan.keeper.name === "validated", "then the validated row");

  plan = planMerge([row({ name: "older", createdAt: "2026-09-01T08:00:00Z" }), row({ name: "busier", visits: 1 })]);
  assert.ok(plan.ok && plan.keeper.name === "busier", "then the one carrying more visits");

  plan = planMerge([row({ name: "newer", createdAt: "2026-10-02T08:00:00Z" }), row({ name: "older", createdAt: "2026-09-01T08:00:00Z" })]);
  assert.ok(plan.ok && plan.keeper.name === "older", "then the older");

  // Nothing is copied; a differing value is listed for the report.
  plan = planMerge([row({ name: "keeper", activePlaces: 1, validatedAt: "2026-10-03T08:00:00Z", grade: "A" }), row({ name: "loser", grade: "B", phone: "01001234567" })]);
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.deepEqual(plan.notCopied.map((entry) => entry.field).sort(), ["grade", "phone"], "a loser's grade and phone are reported, never copied");
  }

  // Refusals.
  assert.equal(planMerge([row({ listType: "AM" }), row({ listType: "PM" })]).ok, false, "two lists are never one entry");
  const crowded = planMerge([row({ activePlaces: MERGE_ACTIVE_PLACE_CAP }), row({ activePlaces: 1 })]);
  assert.ok(!crowded.ok && crowded.refused === "too_many_places", "the five-place cap holds");
  const moved = planMerge([row({ activePlaces: 1, validatedAt: "2026-10-03T08:00:00Z" }), row({ hasMoves: true })]);
  assert.ok(!moved.ok && moved.refused === "loser_has_moves", "move history is never rewritten");
  const heldVsValidated = planMerge([row({ activePlaces: 1 }), row({ validatedAt: "2026-10-02T08:00:00Z" })]);
  assert.ok(!heldVsValidated.ok && heldVsValidated.refused === "keeper_not_validated", "no judgement call is made for him");
}

function checkWriteAndScript(): void {
  const sql = readFileSync("supabase/migrations/20261008120000_phoenix_crm_merge_duplicate_customer.sql", "utf8");
  const body = sql.replace(/--[^\n]*/g, "");
  assert.ok(!/\bdelete\s+from\b/i.test(body), "the loser is archived, NEVER deleted — a deleted reference row is re-minted within minutes");
  assert.match(body, /set status = 'dropped',\s+dropped_reason = 'duplicate'/, "archived as a duplicate");
  for (const guard of ["not_same_list", "list_type_differs", "keeper_not_validated", "keeper_holds_no_place", "loser_has_moves", "visit_same_day", "plan_same_day", "ask_waiting_twice", "too_many_places"]) {
    assert.ok(body.includes(`phoenix_crm:${guard}`), `the write re-checks ${guard} itself`);
  }
  assert.match(body, /pg_advisory_xact_lock\(hashtext\('phoenix_crm:seat:'/, "the seat lock a move takes, so the two never interleave");
  assert.match(body, /revoke execute on function public\.phoenix_crm_merge_duplicate_customer\(jsonb\) from public, anon, authenticated;/);
  assert.ok(!/\bupdate public\.phoenix_crm_customers c\s+set[^;]*\bgrade\s*=/i.test(body), "a grade nobody set is never written onto the keeper");

  const script = stripComments(readFileSync("scripts/phoenix-crm-merge-same-seat-duplicates.ts", "utf8"));
  assert.ok(script.includes('if (arg("apply") === null)'), "a dry run is the default");
  assert.ok(script.includes("await verifyPreImage(schema,"), "--apply refuses without a pre-image it has read back");
  assert.ok(script.includes("revoke all on schema ${PRE_IMAGE_SCHEMA} from anon, authenticated;"), "the pre-image is never readable by anon");
  assert.ok(script.includes("groupSameRepDuplicates("), "the set is the duplicates board's own");
  assert.ok(!script.includes('"xlsx"') && !script.includes("xlsx/"), "the report lives outside the repository");

  const board = readFileSync("app/(admin)/admin/phoenix-crm/duplicates/page.tsx", "utf8");
  assert.ok(board.includes("<MergeVerdict"), "the board states the verdict");
  assert.ok(!/<(button|form)\b/.test(stripComments(board)), "and still acts on nothing");
}

export function runPhoenixCrmDuplicateMergeTests(): void {
  checkKeepRule();
  checkWriteAndScript();
  console.log("phoenix-crm duplicate merge: OK");
}
