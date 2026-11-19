import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SFE_RECOMMENDATIONS_PATH,
  sfeRecommendationOf,
  splitBySfeRecommendation,
  withoutSfeRecommended,
} from "@/lib/phoenix-crm/sfe-recommendations";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the SFE Manager's recommendations on place checks, set apart for the Super Admin.
 *
 * Owner, 19 November 2026: "in place checks make Khaled Bedair only able to recommend validation or not
 * recommend, never able to take a decision, and the recommended by him goes separately in a separate page
 * for admin decision."
 *
 * What must hold:
 *   1. ONE RULE FOR BOTH PAGES — a check is on the Place checks board or on the SFE recommendations page,
 *      never both and never neither, because both pages take the same rows through the same two helpers;
 *   2. only the SFE Manager's row moves a check: a district manager's recommendation leaves it where it was;
 *   3. the page is the Super Admin's alone, and the board hands him the link to it;
 *   4. the sidebar card is drawn for the Super Admin only.
 */

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));

type Recs = PlaceNoteIndex["recommendations"];
type Rec = Recs[string][number];

const rec = (writerRole: Rec["writerRole"], recommendation: Rec["recommendation"]): Rec => ({
  managerName: writerRole === "sfe_manager" ? "Khaled Bedair" : "A district manager",
  recommendation,
  decidedAtText: "19 Nov 2026",
  writerRole,
  mine: false,
});

export function runPhoenixCrmSfeRecommendationsTests() {
  const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const keyOf = (row: { id: string }) => `place:${row.id}`;
  const recommendations: Recs = {
    "place:a": [rec("sfe_manager", "validate")],
    "place:b": [rec("district_manager", "validate"), rec("sfe_manager", "reject")],
    "place:c": [rec("district_manager", "reject")],
    "place:d": [],
  };

  // ── 2 · ONLY THE SFE MANAGER'S WORD MOVES A CHECK ──────────────────────────────────────────────
  assert.equal(sfeRecommendationOf(recommendations, "place:a"), "validate", "the SFE Manager recommended validating a");
  assert.equal(sfeRecommendationOf(recommendations, "place:b"), "reject", "his word is found beside a district manager's");
  assert.equal(sfeRecommendationOf(recommendations, "place:c"), null, "🔴 a district manager's recommendation alone moves nothing");
  assert.equal(sfeRecommendationOf(recommendations, "place:d"), null, "an empty list is no recommendation");
  assert.equal(sfeRecommendationOf(recommendations, "place:e"), null, "nor is a subject with no entry");

  // ── 1 · ONE RULE, EXACTLY ONE PAGE ────────────────────────────────────────────────────────────
  const board = withoutSfeRecommended(rows, keyOf, recommendations);
  const page = splitBySfeRecommendation(rows, keyOf, recommendations);
  assert.deepEqual(board.map((row) => row.id), ["c", "d", "e"], "the board keeps what the SFE Manager has not recommended on");
  assert.deepEqual(page.validate.map((row) => row.id), ["a"], "recommended to validate");
  assert.deepEqual(page.reject.map((row) => row.id), ["b"], "not recommended");
  const onPage = [...page.validate, ...page.reject].map((row) => row.id);
  for (const row of rows) {
    const where = Number(board.includes(row)) + Number(onPage.includes(row.id));
    assert.equal(where, 1, `🔴 ${row.id} is on exactly one of the two pages`);
  }

  // ── 3 · THE PAGE AND THE LINK ─────────────────────────────────────────────────────────────────
  assert.equal(SFE_RECOMMENDATIONS_PATH, "/admin/field-crm/sfe-recommendations");
  const sfePage = read("app/(admin)/admin/field-crm/sfe-recommendations/page.tsx");
  assert.ok(sfePage.includes('canAccess(access, "phoenix_crm", "update")'), "the page's first gate is `update`, which the SFE Manager does not hold");
  assert.ok(sfePage.includes("if (!viewer || !canDecideValidationReviews(viewer)) redirect(\"/admin\");"), "🔴 and its second is the decider");
  assert.ok(sfePage.includes("splitBySfeRecommendation("), "it takes its rows through the shared rule");
  const placeChecks = read("app/(admin)/admin/field-crm/validation-reviews/page.tsx");
  assert.ok(placeChecks.includes("withoutSfeRecommended("), "and the Place checks board takes the same rows out through it");
  assert.ok(/decides \? withoutSfeRecommended\(/.test(placeChecks), "only for the decider — the SFE Manager still sees every check he can recommend on");
  assert.ok(placeChecks.includes("SFE_RECOMMENDATIONS_PATH"), "the board links the Super Admin to the page");

  // ── 4 · THE SIDEBAR CARD ──────────────────────────────────────────────────────────────────────
  const navigation = read("src/config/system-navigation.ts");
  const card = /href: "\/admin\/field-crm\/sfe-recommendations",[\s\S]*?\n  \},/.exec(navigation)?.[0] ?? "";
  assert.ok(card.length > 0, "the SFE Recommendations card is found");
  assert.ok(card.includes('permissions: [{ resource: "phoenix_crm", action: "update" }]'), "the card's permission is `update`");
  assert.ok(card.includes('roles: ["Super Admin"]'), "🔴 and it is drawn for the Super Admin alone");
}
