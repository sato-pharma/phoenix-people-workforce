import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  KPIS_A_PHARMACY_IS_NEVER_IN,
  PHARMACY_LIST_TYPE,
  PLANNABLE_LIST_TYPES,
  isPharmacyListType,
  isPlannableListType,
  parseListType,
  pharmacyCountsInKpi,
  visitApprovalKind,
  visitCountBucketForListType,
} from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";

/**
 * Phoenix CRM — a pharmacy call is a third list, never planned, never approved, never a KPI.
 *
 * Three of the owner's four rulings here REMOVE something, and a removal is what a later reader
 * restores by analogy: the off-plan approval machinery sits one file away and a pharmacy call is,
 * literally, a visit that is not on a plan. So each removal is pinned as its own assertion with the
 * owner's words beside it, and the parser is pinned because every existing reader of `list_type` is
 * a binary that would file a pharmacy under PM with nothing going red.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

export function runPhoenixCrmPharmacyCallTests(): void {
  // ── 1. A third list, and a parser that cannot swallow it ──────────────────────────────────────
  {
    assert.equal(PHARMACY_LIST_TYPE, "Pharmacy", "the vendor's own spelling, so the import needs no translation");

    assert.equal(parseListType("AM"), "AM");
    assert.equal(parseListType("PM"), "PM");
    assert.equal(parseListType("Pharmacy"), "Pharmacy");

    // Anything unrecognised still reads PM, exactly as `row.list_type === "AM" ? "AM" : "PM"` did
    // before a third list existed — a row written by an older build means what it always meant.
    for (const odd of [null, undefined, "", "pm", "pharmacy", 7, {}]) {
      assert.equal(parseListType(odd), "PM", `${JSON.stringify(odd)} falls back to PM, never to Pharmacy`);
    }

    assert.ok(isPharmacyListType("Pharmacy"));
    assert.ok(!isPharmacyListType("PM"), "the one thing the fallback must never do");
    assert.ok(!isPharmacyListType("pharmacy"), "the stored spelling is exact; a near miss is not a pharmacy");
  }

  // ── 2. Never planned (owner, 2026-10-02: "He don't plan it. We don't want extra.") ────────────
  {
    assert.deepEqual([...PLANNABLE_LIST_TYPES], ["AM", "PM"], "a pharmacy is not offered on a weekly plan");
    assert.ok(isPlannableListType("AM"));
    assert.ok(isPlannableListType("PM"));
    assert.ok(!isPlannableListType("Pharmacy"), "the ruling that reverses the morning's 'planned like doctors'");

    // The cap he set that morning capped PLANNING. With no plan row there is nothing to cap, and a
    // cap on VISITS would be the "extra" he ruled out. Nothing here may grow one back.
    const rules = source("src/lib/phoenix-crm/pharmacy-call-rules.ts");
    assert.doesNotMatch(rules, /\b(cap|CAP|maxPerDay|perDayLimit)\b/, "no pharmacy cap, of any kind");
    assert.doesNotMatch(rules, /planItem|planRow|plan_items/, "and nothing here writes a plan row");
  }

  // ── 3. Never approved (owner, 2026-10-02: "no approval for an unplanned pharmacy visit") ──────
  {
    // A pharmacy is `none` whatever shape the visit is given — on a plan it cannot be on, off a plan
    // it was never on. This is the short-circuit that stops the off-plan machinery reaching it.
    assert.equal(visitApprovalKind({ listType: "Pharmacy" }), "none");
    assert.equal(visitApprovalKind({ listType: "Pharmacy", unplannedKind: "out_of_plan" }), "none");
    assert.equal(visitApprovalKind({ listType: "Pharmacy", unplannedKind: "out_of_list" }), "none");

    // A doctor keeps every bit of it: his manager then the SFE off-plan, the CUSTOMER's own
    // admission out of list, and nothing at all on an ordinary planned day.
    assert.equal(visitApprovalKind({ listType: "PM", unplannedKind: "out_of_plan" }), "manager_sfe");
    assert.equal(visitApprovalKind({ listType: "PM", unplannedKind: "out_of_list" }), "customer");
    assert.equal(visitApprovalKind({ listType: "PM", unplannedKind: null }), "none");
    assert.equal(visitApprovalKind({ listType: "AM", unplannedKind: "out_of_plan" }), "manager_sfe");
  }

  // ── 4. No KPI reads a pharmacy (owner, 2026-10-02: "no KPIs is counted on it") ────────────────
  {
    assert.deepEqual(
      [...KPIS_A_PHARMACY_IS_NEVER_IN],
      ["coverage", "frequency", "monthly_target", "call_rate", "capacity"],
      "named rather than counted, so a sixth measure is a decision and not an oversight",
    );
    for (const kpi of KPIS_A_PHARMACY_IS_NEVER_IN) {
      assert.equal(pharmacyCountsInKpi(kpi), false, `${kpi} never counts a pharmacy`);
    }
  }

  // ── 5. The AM · PM · Pharmacies golden rule, structurally ─────────────────────────────────────
  {
    assert.equal(visitCountBucketForListType("Pharmacy"), "Pharmacies");
    assert.equal(visitCountBucketForListType("AM"), "AM");
    assert.equal(visitCountBucketForListType("PM"), "PM");
    // The failure this rule exists to prevent: a pharmacy counted among the doctors.
    assert.notEqual(visitCountBucketForListType("Pharmacy"), "PM");
    assert.notEqual(visitCountBucketForListType("Pharmacy"), "AM");
  }

  console.log("phoenix-crm pharmacy calls: OK");
}
