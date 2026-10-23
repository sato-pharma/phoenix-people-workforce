import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { conductedVisitBucket } from "../src/lib/employee-360/deep-service.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A district manager's work, everywhere it is shown (owner, 2026-10-23): *"any record submitted by himself or a double
 * visit with him, it must appear … if a manager himself added a visit to a pharmacy, it should be count, but in a
 * different color, and separate then the total visits … same for district managers, and same in everywhere."*
 *
 * Pins the Employee 360 half and the readers that carry his own visits out of their table:
 *   1. a conducted double visit is bucketed AM · PM · Pharmacies by the golden rule's one helper, a campaign in none;
 *   2. the leadership section reads his own single visits through the one door out of their table, and a failed read
 *      is "—", never a zero;
 *   3. the portal Team Calendar hangs them on his day cells through the same door.
 */
export function runManagerOwnVisitsEverywhereTests(): void {
  // ── 1. The conducted double visit's bucket ─────────────────────────────────────────────────────────────────────
  const row = { ampm: "AM", comment: null, source: "phoenix", speciality: null, visit_type: 0, visit_type_description: null };
  assert.equal(conductedVisitBucket(row), "AM");
  assert.equal(conductedVisitBucket({ ...row, ampm: "PM" }), "PM");
  assert.equal(conductedVisitBucket({ ...row, ampm: "Pharmacy" }), "Pharmacies", "a pharmacy he joined is a pharmacy, never a half");
  assert.equal(conductedVisitBucket({ ...row, speciality: "Pharmacy" }), "Pharmacies");
  assert.equal(conductedVisitBucket({ ...row, visit_type: -8 }), null, "a campaign double visit is in no figure");

  // ── 2. Employee 360 reads his own visits through the one door, and never invents a zero ────────────────────────
  const service = stripComments(readFileSync("src/lib/employee-360/deep-service.ts", "utf8"));
  assert.match(service, /await loadManagerOwnVisitDays\(\{ end: window\.to, managerHrIds: \[hrId\], start: window\.from \}\)/, "through the only door out of that table");
  assert.match(service, /const ownSingle = await readOwnSingleVisits\(hrId, window\);/, "read for every leader the section is drawn for");
  assert.match(service, /ownSingle,\r?\n\s*dvRepsReached,/, "and handed to the screen");
  assert.doesNotMatch(service, /from\("phoenix_crm_manager_visits"\)/, "never read here directly");
  const view = stripComments(readFileSync("src/components/employee-360/employee-360-view.tsx", "utf8"));
  assert.match(view, /label="Own single visits"/, "the leader's own visits have a tile of their own");
  assert.match(view, /value=\{leadership\.ownSingle \? intFmt\.format\(leadership\.ownSingle\.visits\) : "—"\}/, "an unread figure is a dash, never 0");
  assert.match(view, /splitLine\(leadership\.dvSplit\)/, "the double visits he conducted are split AM · PM · Pharmacies");

  // ── 3. The portal Team Calendar carries them ─────────────────────────────────────────────────────────────────
  const portal = stripComments(readFileSync("src/lib/employee-portal/team-calendar.ts", "utf8"));
  assert.match(portal, /attachManagerOwnVisitSplits\(inLine, await loadOwnVisitDaysQuietly\(inLine, year, month\)\)/, "his own visits reach his cells");
  assert.match(portal, /return await loadManagerOwnVisitDays\(\{ end, managerHrIds: hrIds, start \}\);/, "through the same door");
}
