import assert from "node:assert/strict";

import {
  ALL,
  EMPTY_CAPTURE_FILTER,
  applyCaptureFilter,
  distinctPeople,
  matchesCaptureFilter,
  type FilterableCapture,
} from "../src/lib/verified-captures/filters.ts";
import { canOpenVerifiedCaptures } from "../src/lib/verified-captures/access.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";

// The Verified Captures gallery is Super Admin only (owner, 2026-09-24), and the rep/DM/search
// filter is the interaction the owner asked for by name ("filter by rep or by district manager").
// These are the two pieces worth pinning: the gate must not widen, and the filter must select the
// right rows. Both are pure, so they test without a database or a DOM.

const ROWS: FilterableCapture[] = [
  {
    repHrId: "B-20",
    repName: "Mona Adel",
    managerHrId: "B-05",
    managerName: "Karim Fouad",
    searchText: "El Nasr Pharmacy · Cairo · 12 Tahrir St",
  },
  {
    repHrId: "B-21",
    repName: "Ahmed Sami",
    managerHrId: "B-05",
    managerName: "Karim Fouad",
    searchText: "Shifa Pharmacy · Giza",
  },
  {
    repHrId: "B-20",
    repName: "Mona Adel",
    managerHrId: "B-06",
    managerName: "Hala Nabil",
    searchText: "Rowad Pharmacy · Alexandria",
  },
  // A capture whose rep the employees table has not named: still filterable, labelled by id.
  {
    repHrId: "B-99",
    repName: null,
    managerHrId: null,
    managerName: null,
    searchText: "Orphan Pharmacy",
  },
];

export function runVerifiedCapturesTests() {
  // ── The gate is the narrowest one there is ─────────────────────────────────
  assert.equal(
    canOpenVerifiedCaptures({ role: "Super Admin", scope: "self" }),
    true,
    "Super Admin opens the gallery",
  );
  assert.equal(
    canOpenVerifiedCaptures({ role: "Employee", scope: "system" }),
    true,
    "the system scope (Super Admin's own) opens it",
  );
  const deniedRoles: PhoenixRole[] = ["SFE Manager", "CEO", "District Manager", "Medical Rep", "Employee"];
  for (const role of deniedRoles) {
    assert.equal(
      canOpenVerifiedCaptures({ role, scope: "self" }),
      false,
      `${role} cannot open the gallery`,
    );
  }

  // ── distinctPeople: one option per person, sorted, id-labelled when unnamed ──
  const reps = distinctPeople(ROWS, "rep");
  assert.deepEqual(
    reps.map((option) => option.hrId),
    ["B-21", "B-20", "B-99"],
    "reps are distinct and sorted by name (Ahmed, Mona, then the id-only B-99)",
  );
  assert.equal(reps.find((option) => option.hrId === "B-99")?.name, "B-99", "an unnamed rep is labelled by id");

  const managers = distinctPeople(ROWS, "manager");
  assert.deepEqual(
    managers.map((option) => option.hrId),
    ["B-06", "B-05"],
    "managers are distinct and sorted by name (Hala, then Karim)",
  );

  // ── The empty filter matches everything ────────────────────────────────────
  assert.equal(applyCaptureFilter(ROWS, EMPTY_CAPTURE_FILTER).length, ROWS.length, "no filter shows every row");

  // ── Rep filter ─────────────────────────────────────────────────────────────
  const monaOnly = applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, rep: "B-20" });
  assert.equal(monaOnly.length, 2, "Mona owns two captures");
  assert.ok(monaOnly.every((row) => row.repHrId === "B-20"));

  // ── District-manager filter ────────────────────────────────────────────────
  const karimOnly = applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, manager: "B-05" });
  assert.equal(karimOnly.length, 2, "Karim manages two captures");
  assert.ok(karimOnly.every((row) => row.managerHrId === "B-05"));

  // ── Rep AND manager together ───────────────────────────────────────────────
  const monaUnderKarim = applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, rep: "B-20", manager: "B-05" });
  assert.equal(monaUnderKarim.length, 1, "Mona's captures under Karim is exactly one");
  assert.equal(monaUnderKarim[0]?.searchText, "El Nasr Pharmacy · Cairo · 12 Tahrir St");

  // ── Search matches text, rep name and manager name, case-insensitively ──────
  assert.equal(applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "alexandria" }).length, 1);
  assert.equal(applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "PHARMACY" }).length, 4);
  assert.equal(
    applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "ahmed" }).length,
    1,
    "search matches the rep's name, not only the row text",
  );
  assert.equal(
    applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "hala" }).length,
    1,
    "search matches the manager's name too",
  );

  // ── ALL is the no-filter sentinel, never a real id ─────────────────────────
  assert.equal(matchesCaptureFilter(ROWS[3], { rep: ALL, manager: ALL, search: "" }), true);
  assert.equal(
    matchesCaptureFilter(ROWS[3], { ...EMPTY_CAPTURE_FILTER, search: "no-such-text" }),
    false,
    "a non-matching search excludes the row",
  );
}
