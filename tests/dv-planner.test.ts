import assert from "node:assert/strict";

import {
  buildDvPlannerRoster,
  groupDvPlannerVisitsByRepDate,
  matchDvPlannerVisits,
} from "../src/lib/double-visit-analytics/planner.ts";
import type { DoubleVisitFocusRosterEntry, DoubleVisitReportRow } from "../src/lib/double-visit-analytics/types.ts";

function neverVisited(overrides: Partial<DoubleVisitFocusRosterEntry> & { hrId: string }): DoubleVisitFocusRosterEntry {
  return {
    areaName: null,
    daysSinceHire: null,
    flagged: false,
    hireDate: null,
    name: overrides.hrId,
    visited: false,
    ...overrides,
  };
}

function row(overrides: Partial<DoubleVisitReportRow> & { visitedHrId: string }): DoubleVisitReportRow {
  return {
    activityDate: "2026-07-01",
    areaName: null,
    daysSinceVisitedHire: null,
    doubleVisitorHrId: null,
    doubleVisitorName: null,
    doubleVisitorRole: null,
    lineName: null,
    period: "PM",
    regionName: null,
    visitCount: 1,
    visitedEmployeeHireDate: null,
    visitedName: overrides.visitedHrId,
    visitedStatus: "active_mapped",
    visitKind: "Regular",
    ...overrides,
  };
}

export function runDvPlannerTests() {
  // ── buildDvPlannerRoster: never-visited seeds a rep with lineName null ──────────
  {
    const { reps, visits } = buildDvPlannerRoster({ neverVisited: [neverVisited({ hrId: "B-101", areaName: "Giza", name: "Sara" })], rows: [] });
    assert.equal(reps.length, 1);
    assert.deepEqual(reps[0], { areaName: "Giza", hrId: "B-101", lineName: null, name: "Sara" });
    assert.equal(visits.length, 0);
  }

  // ── A row for a NEW hrId (not in neverVisited) adds a rep and a visit ──────────
  {
    const { reps, visits } = buildDvPlannerRoster({
      neverVisited: [],
      rows: [row({ visitedHrId: "B-202", visitedName: "Omar", areaName: "Cairo", lineName: "Anti-Infective" })],
    });
    assert.equal(reps.length, 1);
    assert.deepEqual(reps[0], { areaName: "Cairo", hrId: "B-202", lineName: "Anti-Infective", name: "Omar" });
    assert.equal(visits.length, 1);
    assert.equal(visits[0].visitedHrId, "B-202");
  }

  // ── A row for an hrId already in neverVisited overwrites area/line/name (row wins) ──
  {
    const { reps } = buildDvPlannerRoster({
      neverVisited: [neverVisited({ hrId: "B-303", areaName: "Stale area", name: "Stale name" })],
      rows: [row({ visitedHrId: "B-303", visitedName: "Fresh name", areaName: "Fresh area", lineName: "Pediatrics" })],
    });
    assert.equal(reps.length, 1, "must merge into one rep, not duplicate");
    assert.deepEqual(reps[0], { areaName: "Fresh area", hrId: "B-303", lineName: "Pediatrics", name: "Fresh name" });
  }

  // ── A second row for the same hrId must not clobber a known field with a blank one ──
  {
    const { reps } = buildDvPlannerRoster({
      neverVisited: [],
      rows: [
        row({ visitedHrId: "B-404", visitedName: "Nour", areaName: "Giza", lineName: "Anti-Infective" }),
        row({ visitedHrId: "B-404", visitedName: null, areaName: null, lineName: null, activityDate: "2026-07-02" }),
      ],
    });
    assert.equal(reps.length, 1);
    assert.deepEqual(
      reps[0],
      { areaName: "Giza", hrId: "B-404", lineName: "Anti-Infective", name: "Nour" },
      "a later row with blank fields must not overwrite the earlier row's known values",
    );
  }

  // ── Rows that aren't active_mapped are excluded from both reps and visits ──────
  {
    const { reps, visits } = buildDvPlannerRoster({
      neverVisited: [],
      rows: [row({ visitedHrId: "B-505", visitedStatus: "resigned" }), row({ visitedHrId: "B-606", visitedStatus: "vacant" })],
    });
    assert.equal(reps.length, 0);
    assert.equal(visits.length, 0);
  }

  // ── A row with no visitedHrId is excluded ───────────────────────────────────────
  {
    const { reps, visits } = buildDvPlannerRoster({ neverVisited: [], rows: [row({ visitedHrId: "" })] });
    assert.equal(reps.length, 0);
    assert.equal(visits.length, 0);
  }

  // ── Same HR ID in different casing dedupes to one rep (canonicalHrIdKey) ────────
  {
    const { reps } = buildDvPlannerRoster({
      neverVisited: [],
      rows: [row({ visitedHrId: "b-707", visitedName: "First" }), row({ visitedHrId: "B-707", visitedName: "Second" })],
    });
    assert.equal(reps.length, 1, "HR IDs differing only in case must dedupe to one rep");
  }

  // ── reps are sorted by name ──────────────────────────────────────────────────────
  {
    const { reps } = buildDvPlannerRoster({
      neverVisited: [neverVisited({ hrId: "B-1", name: "Zaid" }), neverVisited({ hrId: "B-2", name: "Amira" })],
      rows: [],
    });
    assert.deepEqual(reps.map((r) => r.name), ["Amira", "Zaid"]);
  }

  // ── null/undefined data degrades to empty roster, not a throw ───────────────────
  {
    assert.deepEqual(buildDvPlannerRoster(null), { reps: [], visits: [] });
    assert.deepEqual(buildDvPlannerRoster(undefined), { reps: [], visits: [] });
  }

  // ── groupDvPlannerVisitsByRepDate + matchDvPlannerVisits: the core "was it recorded" answer ──
  {
    const visits = [
      { activityDate: "2026-07-01", doubleVisitorName: "Manager A", visitCount: 1, visitedHrId: "B-101" },
      { activityDate: "2026-07-01", doubleVisitorName: "Manager B", visitCount: 1, visitedHrId: "B-101" },
      { activityDate: "2026-07-02", doubleVisitorName: "Manager A", visitCount: 1, visitedHrId: "B-101" },
    ];
    const index = groupDvPlannerVisitsByRepDate(visits);

    const recorded = matchDvPlannerVisits(index, "B-101", "2026-07-01");
    assert.equal(recorded.wasRecorded, true);
    assert.deepEqual(new Set(recorded.visitors), new Set(["Manager A", "Manager B"]), "visitor names must dedupe and include both managers for that day");

    const notRecorded = matchDvPlannerVisits(index, "B-101", "2026-07-05");
    assert.equal(notRecorded.wasRecorded, false);
    assert.deepEqual(notRecorded.visitors, []);

    const noDateChosen = matchDvPlannerVisits(index, "B-101", "");
    assert.equal(noDateChosen.wasRecorded, false, "no date selected yet must never read as recorded");

    const caseInsensitive = matchDvPlannerVisits(index, "b-101", "2026-07-02");
    assert.equal(caseInsensitive.wasRecorded, true, "hrId lookup must be case-insensitive like the roster building side");
  }
}
