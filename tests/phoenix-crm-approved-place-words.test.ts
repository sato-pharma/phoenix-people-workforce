import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  BUILDING_APPROVE_LABEL,
  buildingApproveVariant,
  buildingStatusPill,
  seatedTimetablePill,
} from "../src/lib/phoenix-crm/approved-place-words.ts";

/**
 * Phoenix CRM — Place checks: an approved building and an approved seated customer READ as approved.
 *
 * Owner, 21 Nov 2026, on Rowaida's polyclinic in Delta (2): "I approved validation of polyclinic … it kept the
 * bottom keep styled and it kept not approved." Production held both approvals (the customer's review approved
 * 16:09 Cairo with a stale `refusal_reason = schedule_missing` still on it, the building decided 16:14), and the
 * screen drew a "Keep it" button, a "Kept" outcome, an "In use" pill and a warning timetable pill.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

const WORDS = {
  match: "The timetable names this customer",
  other_name: "The timetable does not name this customer",
  no_schedule: "No timetable in the photo",
  unjudged: "The timetable could not be read",
} as const;

export function runPhoenixCrmApprovedPlaceWordsTests(): void {
  // ── 1 · the building's button says Approve, and drops to the plain look once it is decided ────────────
  assert.equal(BUILDING_APPROVE_LABEL, "Approve", "never 'Keep it'");
  assert.equal(buildingApproveVariant(null), "primary", "an undecided building's Approve is the primary action");
  assert.equal(buildingApproveVariant("21 Nov 2026, 16:14"), "secondary", "a decided building's Approve is no longer styled as the pending action");

  // ── 2 · the building's pill says Approved once it is, on the company board only ───────────────────────
  assert.deepEqual(buildingStatusPill({ status: "active", decidedAtText: "21 Nov 2026, 16:14" }, "company"), { text: "Approved", tone: "good" });
  assert.deepEqual(buildingStatusPill({ status: "active", decidedAtText: null }, "company"), { text: "In use", tone: "good" });
  assert.equal(buildingStatusPill({ status: "active", decidedAtText: "21 Nov 2026, 16:14" }, "team").text, "In use", "a manager's board says only what is true of the building");

  // ── 3 · an approved customer's stale refusal is information, never a warning ──────────────────────────
  const approved = { state: "in_use", reviewStatus: "approved" } as const;
  const staleNoTimetable = seatedTimetablePill(approved, "no_schedule", WORDS);
  assert.equal(staleNoTimetable.tone, "neutral", "an approved customer is not drawn under a warning");
  assert.ok(staleNoTimetable.text.startsWith("Approved."), "the pill leads with the approval");
  assert.equal(seatedTimetablePill(approved, "other_name", WORDS).tone, "neutral");
  assert.equal(seatedTimetablePill(approved, "match", WORDS).tone, "good");

  // A customer still waiting, or rejected, keeps the warning the system read.
  assert.equal(seatedTimetablePill({ state: "waiting", reviewStatus: "pending" }, "no_schedule", WORDS).tone, "warn");
  assert.equal(seatedTimetablePill({ state: "rejected", reviewStatus: "rejected" }, "other_name", WORDS).text, WORDS.other_name);

  // ── 4 · the screens use it ────────────────────────────────────────────────────────────────────────────
  const list = stripComments(read("src/components/phoenix-crm/shared-place-list.tsx"));
  assert.ok(!list.includes("Keep it"), "the building's button no longer reads Keep it");
  assert.ok(!list.includes('"kept"'), "no control reports a building as kept");
  assert.ok(list.includes("buildingStatusPill(row, mode)"), "the building's pill is the approved-aware one");
  assert.ok(list.includes("buildingApproveVariant(row.decidedAtText)"), "the Approve button's look follows the decision");

  const customers = stripComments(read("src/components/phoenix-crm/shared-place-customers.tsx"));
  assert.ok(customers.includes("seatedTimetablePill("), "the seated customer's timetable pill is the approved-aware one");
  assert.ok(customers.includes('customer.reviewStatus === "approved" && mode !== "team"'), "an approved customer carries an Approved pill on the company board");

  const done = stripComments(read("src/components/phoenix-crm/place-check-done.tsx"));
  assert.ok(!done.includes('text: "Kept"'), "a saved building never reads Kept");
}
