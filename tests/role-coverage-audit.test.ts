import assert from "node:assert/strict";

import {
  COVERAGE_ROLES,
  coverageRoleOf,
  scoreRoleCoverage,
  splitStartedRoster,
  type CoveragePerson,
} from "../src/lib/admin/role-coverage/coverage-roles.ts";
import { ROLE_COVERAGE_MODULES } from "../src/lib/admin/role-coverage/registry.ts";

// Owner, 2026-10-20: "many modules all over Phoenix show only reports on reps, and when you filter
// by manager you find no manager; others only head-office employees and you find no field force …
// every single role that is applicable to appear in a module — find it, show it, and add it to the
// Super Admin deep audit." The audit is the Role coverage section of /admin/system-audit (moved
// there from the retired /admin/data-health on 23 Oct 2026). This suite
// pins the two halves a later session could quietly weaken: how a person is bucketed, and how a
// module's own people list is scored against the roster.

export function runRoleCoverageAuditTests() {
  // ── Bucketing follows the job FUNCTION, so the seniority grades land where their seats are ──
  assert.equal(coverageRoleOf({ jobTitle: "Medical Representative" }), "Medical Rep");
  assert.equal(
    coverageRoleOf({ jobTitle: "Senior Medical Representative" }),
    "Medical Rep",
    "a Senior Medical Representative is a medical rep, not Head Office",
  );
  assert.equal(coverageRoleOf({ jobTitle: "District Sales Manager" }), "District Manager");
  assert.equal(
    coverageRoleOf({ jobTitle: "Senior District Manager" }),
    "District Manager",
    "a Senior District Manager is a district manager, not Head Office",
  );
  assert.equal(coverageRoleOf({ jobTitle: "Regional Sales Manager" }), "Regional Manager");
  assert.equal(coverageRoleOf({ jobTitle: "National Sales Manager" }), "National Sales Manager");
  assert.equal(coverageRoleOf({ jobTitle: "Group Product Manager" }), "Group Product Manager");
  assert.equal(coverageRoleOf({ jobTitle: "CEO" }), "CEO", "the Chief Executive is his own bucket");
  assert.equal(coverageRoleOf({ jobTitle: "QPPV" }), "Head Office");
  assert.equal(coverageRoleOf({ jobTitle: "HR Manager" }), "Head Office");
  assert.equal(coverageRoleOf({ jobTitle: null }), "Head Office");

  // ── Scoring ──
  const roster: CoveragePerson[] = [
    { hrId: "R-1", name: "Rep One", jobTitle: "Medical Representative", role: "Medical Rep" },
    { hrId: "R-2", name: "Rep Two", jobTitle: "Senior Medical Representative", role: "Medical Rep" },
    { hrId: "D-1", name: "District One", jobTitle: "District Sales Manager", role: "District Manager" },
    { hrId: "D-2", name: "District Two", jobTitle: "Senior District Manager", role: "District Manager" },
    { hrId: "N-1", name: "National One", jobTitle: "National Sales Manager", role: "National Sales Manager" },
    { hrId: "H-1", name: "Office One", jobTitle: "QPPV", role: "Head Office" },
    { hrId: "C-1", name: "Chief", jobTitle: "CEO", role: "CEO" },
  ];

  // The owner's exact complaint: a reps-only report whose manager filter finds nobody.
  const repsOnly = scoreRoleCoverage(roster, ["R-1", "r-2"], {
    applies: ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager"],
  });
  assert.deepEqual(
    repsOnly.absentRoles,
    ["District Manager", "National Sales Manager"],
    "a reps-only list must be reported as missing every manager rung that holds people",
  );
  const districtCell = repsOnly.cells.find((cell) => cell.role === "District Manager");
  assert.equal(districtCell?.status, "absent");
  assert.deepEqual(
    districtCell?.missing.map((person) => person.name),
    ["District One", "District Two"],
    "the missing managers are named, not just counted",
  );
  assert.equal(
    repsOnly.cells.find((cell) => cell.role === "Medical Rep")?.status,
    "complete",
    "HR ids are compared case-insensitively — a lower-case id from a module is still the same person",
  );
  assert.equal(
    repsOnly.cells.find((cell) => cell.role === "Regional Manager")?.status,
    "nobody-in-role",
    "a role nobody holds today is never reported as a gap",
  );
  assert.equal(repsOnly.absentRoles.includes("Regional Manager"), false);

  // Partial: one of two district managers shown.
  const partial = scoreRoleCoverage(roster, ["R-1", "R-2", "D-1", "N-1"], {
    applies: ["Medical Rep", "District Manager", "National Sales Manager"],
  });
  assert.deepEqual(partial.partialRoles, ["District Manager"]);
  assert.deepEqual(partial.absentRoles, []);

  // A head-office-only list that leaves the field force out ON PURPOSE is not a gap …
  const headOfficeOnly = scoreRoleCoverage(roster, ["H-1"], {
    applies: ["Head Office"],
    leftOut: { "Medical Rep": "Reps are reported through their district manager." },
  });
  assert.deepEqual(headOfficeOnly.absentRoles, []);
  const leftOutCell = headOfficeOnly.cells.find((cell) => cell.role === "Medical Rep");
  assert.equal(leftOutCell?.status, "left-out");
  assert.equal(leftOutCell?.leftOutReason, "Reps are reported through their district manager.");
  assert.deepEqual(leftOutCell?.missing, [], "a left-out role lists nobody as missing");

  // … but if the page shows that role anyway, the stated rule and the page disagree, and it says so.
  const drifted = scoreRoleCoverage(roster, ["H-1", "R-1"], {
    applies: ["Head Office"],
    leftOut: { "Medical Rep": "Reps are reported through their district manager." },
  });
  assert.equal(drifted.cells.find((cell) => cell.role === "Medical Rep")?.status, "left-out-but-shown");

  // A role neither applicable nor left out is not scored at all.
  assert.equal(headOfficeOnly.cells.some((cell) => cell.role === "CEO"), false);

  // ── Only people who have STARTED are scored ──
  // A District Manager starting in four days read "missing" from five lists on 2026-10-20: nobody
  // reported to her yet, so every list built from a team rightly left her out. She is named apart.
  const split = splitStartedRoster(
    [
      { name: "Started", startDate: "2026-10-01" },
      { name: "Starts today", startDate: "2026-10-20" },
      { name: "Starts later", startDate: "2026-10-24" },
      { name: "No date", startDate: null },
      { name: "Timestamp", startDate: "2026-11-02T00:00:00Z" },
    ],
    "2026-10-20",
  );
  assert.deepEqual(
    split.started.map((person) => person.name),
    ["Started", "Starts today", "No date"],
    "a person who started today, or whose start date is unknown, is scored",
  );
  assert.deepEqual(
    split.notStartedYet.map((person) => person.name),
    ["Starts later", "Timestamp"],
    "a person whose start date is still ahead is held apart, never scored as a gap",
  );

  // ── Every registered module states its roles honestly ──
  const ids = new Set<string>();
  for (const entry of ROLE_COVERAGE_MODULES) {
    assert.equal(ids.has(entry.id), false, `role coverage module id "${entry.id}" is registered twice`);
    ids.add(entry.id);
    assert.ok(entry.applies.length > 0, `${entry.label} must name at least one role it applies to`);
    assert.ok(entry.href.startsWith("/"), `${entry.label} must link to its page`);
    assert.ok(entry.population.trim().length > 0, `${entry.label} must say what its people list is`);
    assert.ok(entry.source.trim().length > 0, `${entry.label} must name the function its probe calls`);
    for (const role of entry.applies) {
      assert.ok(COVERAGE_ROLES.includes(role), `${entry.label} applies to an unknown role "${role}"`);
    }
    for (const [role, reason] of Object.entries(entry.leftOut ?? {})) {
      assert.ok(
        String(reason ?? "").trim().length > 0,
        `${entry.label} leaves ${role} out without saying why`,
      );
      assert.equal(
        entry.applies.includes(role as (typeof COVERAGE_ROLES)[number]),
        false,
        `${entry.label} both applies to and leaves out ${role}`,
      );
    }
  }
  assert.ok(ROLE_COVERAGE_MODULES.length > 0, "the Role Coverage audit must measure at least one module");
}
