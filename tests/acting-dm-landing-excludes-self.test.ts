import assert from "node:assert/strict";

import { districtManagerLandingPeople } from "../src/lib/employee-portal/home-snapshot.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

// An acting District Manager never sees herself on her own District Manager landing page.
//
// Real case, 2026-09-21: Nosiba Salah is an ACTING District Manager. Her app access role is
// District Manager, and HR keeps her job title "Medical Representative" on purpose. She also still
// occupies the rep seat of Minia 1, one of the areas she manages, so the sales engine attributes
// Minia 1's rows to her as a rep and the team service returns her as one of her own reps. Her landing
// page therefore listed her on "My Reps", counted her in "Team Size" (3 instead of her 2 reps) and
// put her red on her own CRM first-visit board. Owner rule (AGENTS.md section 4): an acting District
// Manager sees exactly what a District Manager sees, her team and never her own row.

function row(over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    displayName: over.hrId,
    employmentStatus: "active",
    organogramVisible: true,
    jobTitle: "Medical Representative",
    ...over,
  } as EmployeeDirectoryRow;
}

function member(hrId: string, name: string, achievementPercent: number, totalSales: number) {
  return { hrId, name, achievementPercent, totalSales, totalTarget: 100_000 };
}

export function runActingDmLandingExcludesSelfTests() {
  const directory = [
    // The acting District Manager herself: Medical Representative by title, District Manager by access.
    row({ hrId: "B-1", displayName: "Nosiba Salah" }),
    row({ hrId: "B-79", displayName: "Aisha Ehab" }),
    row({ hrId: "AI-0012", displayName: "Hanan Safwat" }),
    row({ hrId: "B-106", displayName: "Abanoub Ehab", employmentStatus: "resigned", organogramVisible: false }),
  ];

  // The shape the team service returned for her live on 2026-09-21, plus one leaver.
  const team = [
    member("B-79", "Aisha Ehab Mamdouh Hussein", 92, 410_000),
    member("B-1", "Nosiba Salah Hassanin Moussa", 88, 380_000),
    member("AI-0012", "Hanan Safwat SalahEldeen Hassan", 75, 300_000),
    member("B-106", "Abanoub Ehab Shoukry Andaros", 60, 50_000),
  ];

  // ── The rule: the viewer is never on her own team ─────────────────────────────────────────
  const acting = districtManagerLandingPeople(team, directory, "B-1");
  assert.deepEqual(
    acting.members.map((m) => m.hrId),
    ["B-79", "AI-0012"],
    "an acting District Manager must not appear on her own 'My Reps' board — she sees her team, never her own row",
  );
  assert.equal(
    acting.memberCount,
    2,
    "'Team Size' must count her two reps, not her own rep seat as a third member of her own team",
  );
  assert.deepEqual(
    acting.crmReps.map((r) => r.hrId),
    ["B-79", "AI-0012"],
    "her own CRM first-visit board must not list her as one of her reps",
  );

  // The session carries the HR id in whatever form the account holds; the match must not depend on
  // casing or the hyphen, or the fix silently stops working for her.
  for (const viewer of ["b-1", "B1", "b1", " B-1 "]) {
    const variant = districtManagerLandingPeople(team, directory, viewer);
    assert.equal(
      variant.members.some((m) => m.hrId === "B-1"),
      false,
      `viewer id "${viewer}" must still take her own row off her team`,
    );
    assert.equal(variant.memberCount, 2, `viewer id "${viewer}" must still count only her two reps`);
  }

  // A different HR id that merely shares a prefix with hers is a different person and stays.
  const b10Team = [...team, member("B-10", "Another Rep", 70, 90_000)];
  directory.push(row({ hrId: "B-10", displayName: "Another Rep" }));
  assert.equal(
    districtManagerLandingPeople(b10Team, directory, "B-1").members.some((m) => m.hrId === "B-10"),
    true,
    "B-10 is not B-1: only the viewer herself comes off the team",
  );
  directory.pop();

  // ── A real District Manager is untouched ──────────────────────────────────────────────────
  // He holds no rep seat, so he is never in his own team rows and nothing is removed.
  const realDm = districtManagerLandingPeople(team, directory, "B-12");
  assert.deepEqual(
    realDm.members.map((m) => m.hrId),
    ["B-79", "B-1", "AI-0012"],
    "a District Manager who is not on the team loses nobody, and the board stays ranked by achievement",
  );
  assert.equal(realDm.memberCount, 3);

  // No HR id resolved: nothing to exclude, and nothing may be emptied by accident.
  assert.equal(districtManagerLandingPeople(team, directory, "").memberCount, 3);
  assert.equal(districtManagerLandingPeople(team, directory, null).memberCount, 3);

  // ── What the change must NOT disturb ──────────────────────────────────────────────────────
  // Leavers still come off the people lists and are accounted for in the leavers note.
  assert.equal(acting.departedCount, 1, "a resigned rep is still split out, not silently dropped");
  assert.equal(acting.departedSales, 50_000, "the leaver's sales are still reported beside the board");
  assert.equal(acting.members.some((m) => m.hrId === "B-106"), false);

  // Names come from the directory's display name, as before.
  assert.equal(acting.members[0].name, "Aisha Ehab");

  // Does not mutate its input.
  assert.equal(team.length, 4);
  assert.equal(team[1].hrId, "B-1");
}
