import assert from "node:assert/strict";

import {
  canViewerSeeManagerCandidates,
  managersWithinViewerTeam,
  type TeamRosterEntry,
} from "../src/lib/recruitment/hiring-manager-team-scope.ts";

/**
 * "I want the National Sales Manager to have the authority to filter for one of the district
 *  managers reporting to him and see the CVs and candidates in his portal."
 *
 * The owner, 2026-08-30.
 *
 * THE RISK THIS SUITE EXISTS FOR. Every other route under app/api/recruitment/hiring-manager/**
 * takes its scope from the session and states so in its own header — "there is no id to guess and no
 * way to ask for somebody else's pushes". This feature necessarily gives that up: it accepts a
 * manager's HR_ID from the caller. So the org walk below IS the access-control decision for a screen
 * showing named job applicants' phone numbers, salaries and CVs, and it is the only thing standing
 * between one National Sales Manager and the other one's candidates.
 *
 * The fixture is production's real shape, read the same morning:
 *
 *   aa ─┬─ a-12   (NSM)  ─┬─ b-94    (DSM)
 *       │                 ├─ b-23    (DSM)
 *       │                 └─ pd-0001 (Regional) ─┬─ pd-0010 (DSM)   ← two levels down
 *       │                                        └─ b-154   (DSM)
 *       └─ ai-0008 (NSM) ─┬─ b-12    (DSM)
 *                         └─ ai-0001 (DSM)
 *
 * pd-0010 is the case that decides the design: a district manager reporting to a REGIONAL manager
 * who reports to the NSM. Reading "district managers reporting to him" as direct reports only would
 * hide that CV from the NSM completely, and a CV nobody senior can see is the failure this feature
 * was asked for to fix.
 */

function person(
  hrId: string,
  fields: {
    manager?: string | null;
    pending?: string | null;
    title?: string;
    name?: string;
    status?: string;
  } = {},
): TeamRosterEntry {
  return {
    employmentStatus: fields.status ?? "active",
    fullName: fields.name ?? hrId.toUpperCase(),
    hrId,
    jobTitle: fields.title ?? "District Sales Manager",
    managerHrId: fields.manager ?? null,
    pendingManagerReplacementForHrId: fields.pending ?? null,
  };
}

const ROSTER: TeamRosterEntry[] = [
  person("aa", { title: "Chief Executive Officer" }),
  person("a-12", { manager: "aa", title: "National Sales Manager", name: "Ali Mohamed Ali Elsayed" }),
  person("ai-0008", { manager: "aa", title: "National Sales Manager", name: "Magdy El Senosey" }),
  person("b-94", { manager: "a-12", name: "Taha Mohamed Taha Elsayed AboElftouh" }),
  person("b-23", { manager: "a-12", name: "Yehya Mohamed Kamal eldeen Saad Mohamed" }),
  person("pd-0001", { manager: "a-12", title: "Regional Sales Manager", name: "Hany Saad Mohamed Omar" }),
  person("pd-0010", { manager: "pd-0001", name: "Ahmed Elsayed Ahmed" }),
  person("b-154", { manager: "pd-0001", name: "Nermeen Salah Abdelaty Abohussien" }),
  person("b-12", { manager: "ai-0008", name: "Dina Hamdy Fadel Mohamed Bdair" }),
  person("ai-0001", { manager: "ai-0008", name: "Momen Abdelhady Mohamed Shehata" }),
  // Medical reps. They give their managers somebody to manage — which is what makes those managers
  // managers at all — and must never appear in a picker themselves.
  person("r-1", { manager: "b-94", title: "Medical Representative" }),
  person("r-2", { manager: "pd-0010", title: "Medical Representative" }),
  person("r-3", { manager: "b-12", title: "Medical Representative" }),
  person("r-4", { manager: "b-23", title: "Medical Representative" }),
  person("r-5", { manager: "b-154", title: "Medical Representative" }),
  person("r-6", { manager: "ai-0001", title: "Medical Representative" }),
];

const ids = (list: Array<{ hrId: string }>) => list.map((row) => row.hrId).sort();

export async function runHiringManagerTeamScopeTests() {
  // ── 1 · THE WHOLE CHAIN, not just direct reports ──────────────────────────
  const ali = managersWithinViewerTeam({ roster: ROSTER, viewerHrId: "a-12" });

  assert.deepEqual(
    ids(ali),
    ["b-154", "b-23", "b-94", "pd-0001", "pd-0010"],
    "an NSM sees every manager beneath him, including the two sitting under his regional manager",
  );
  assert.ok(
    ali.some((manager) => manager.hrId === "pd-0010"),
    "pd-0010 is a real production row: a DSM two levels down. Direct-reports-only would hide their CV entirely",
  );

  // Direct and indirect are distinguished, because the screen says which is which.
  assert.deepEqual(
    ids(ali.filter((manager) => manager.direct)),
    ["b-23", "b-94", "pd-0001"],
    "direct reports are marked as such",
  );
  assert.equal(
    ali.find((manager) => manager.hrId === "pd-0010")?.direct,
    false,
    "and somebody under a regional manager is not",
  );
  // Direct reports sort first — an NSM reads his own districts before the ones one level further.
  assert.ok(
    ali.findIndex((manager) => manager.hrId === "pd-0010") > ali.findIndex((manager) => manager.direct),
    "direct reports come first in the picker",
  );

  // ── 2 · THE HEADLINE: one NSM never sees the other's team ─────────────────
  // The assertion this whole feature has to satisfy. Both are National Sales Managers, both report
  // to the same CEO, and neither may read the other's candidates.
  for (const forbidden of ["b-12", "ai-0001", "ai-0008"]) {
    assert.ok(
      !ali.some((manager) => manager.hrId === forbidden),
      `a-12 must never see ${forbidden} — that is the other National Sales Manager's line`,
    );
    assert.equal(
      canViewerSeeManagerCandidates({ managerHrId: forbidden, roster: ROSTER, viewerHrId: "a-12" }),
      false,
      `and the gate must refuse ${forbidden} too, not only the picker`,
    );
  }

  // ── 3 · The picker and the gate are the SAME set ──────────────────────────
  // The property that matters more than any individual case: a screen offering a name the query then
  // refuses, or a query accepting one the screen never offered, is how this goes wrong in
  // production. Checked across EVERY viewer against EVERY other person on the roster.
  for (const viewer of ROSTER) {
    const offered = new Set(
      managersWithinViewerTeam({ roster: ROSTER, viewerHrId: viewer.hrId }).map((manager) => manager.hrId),
    );
    for (const subject of ROSTER) {
      const permitted = canViewerSeeManagerCandidates({
        managerHrId: subject.hrId,
        roster: ROSTER,
        viewerHrId: viewer.hrId,
      });
      // Everyone may read their own — that is the sibling route that has existed since 2026-08-15.
      const expected = subject.hrId === viewer.hrId || offered.has(subject.hrId);
      assert.equal(
        permitted,
        expected,
        `picker and gate disagree: ${viewer.hrId} ${expected ? "was offered" : "was not offered"} ${subject.hrId} but the gate said ${permitted}`,
      );
    }
  }

  // ── 4 · Never yourself, never a rep ───────────────────────────────────────
  assert.ok(!ali.some((manager) => manager.hrId === "a-12"), "the viewer is not in their own picker");
  assert.ok(
    !ali.some((manager) => manager.hrId.startsWith("r-")),
    "medical reps hold no CVs and must never be offered as a filter",
  );
  assert.deepEqual(
    managersWithinViewerTeam({ roster: ROSTER, viewerHrId: "b-94" }),
    [],
    "a district manager with only reps below them has an empty picker — the screen renders nothing, not an error",
  );

  // ── 5 · "Manager" is STRUCTURAL, never a job-title match ──────────────────
  // Titles here are free text an importer writes; 9 of 27 district managers are misspelt badly
  // enough to hide them from a title search. Somebody with reports is a manager whatever their row
  // is called, and somebody with none is not, however grand the title.
  const oddTitles: TeamRosterEntry[] = [
    person("boss", { title: "Chief Executive Officer" }),
    person("typo", { manager: "boss", title: "Distirct Manger" }),
    person("grand", { manager: "boss", title: "Senior Regional Sales Manager" }),
    person("rep", { manager: "typo", title: "Medical Representative" }),
  ];
  const underBoss = managersWithinViewerTeam({ roster: oddTitles, viewerHrId: "boss" });
  assert.deepEqual(
    ids(underBoss),
    ["typo"],
    "the misspelt manager IS offered (they have a report) and the grand title with nobody under it is NOT",
  );

  // ── 6 · A vacant seat below does not empty a manager's picker ─────────────
  // When a manager resigns their reports are reassigned UPWARD and stamped with the departed
  // manager's HR_ID. The replacement inherits them. Without reading that marker, the manager holding
  // those orphaned reports would drop out of the picker for as long as the seat stays open.
  const withVacancy: TeamRosterEntry[] = [
    person("nsm", { title: "National Sales Manager" }),
    person("acting", { manager: "nsm" }),
    // Reassigned up to `acting` after their own DSM left; the marker names the departed seat.
    person("orphan", { manager: "acting", pending: "gone-dsm", title: "Medical Representative" }),
  ];
  assert.deepEqual(
    ids(managersWithinViewerTeam({ roster: withVacancy, viewerHrId: "nsm" })),
    ["acting"],
    "a manager holding reports through a vacant seat is still a manager",
  );

  // ── 7 · HR_IDs are MIXED CASE, on both sides ──────────────────────────────
  // A plain equality match on this column has already under-returned by 28% elsewhere in this
  // codebase. Here the failure would be an NSM told he manages nobody.
  const mixed: TeamRosterEntry[] = [
    person("A-12", { title: "National Sales Manager" }),
    person("B-94", { manager: "a-12" }),
    person("R-9", { manager: "B-94", title: "Medical Representative" }),
  ];
  assert.deepEqual(
    ids(managersWithinViewerTeam({ roster: mixed, viewerHrId: "a-12" })),
    ["B-94"],
    "a lowercase session id must still find an uppercase roster row",
  );
  assert.equal(
    canViewerSeeManagerCandidates({ managerHrId: "b-94", roster: mixed, viewerHrId: "A-12" }),
    true,
    "and the gate must match regardless of which case each side was typed in",
  );

  // ── 8 · A viewer with no HR_ID gets nothing, and cannot open anything ─────
  // Not a theoretical row: AccessContext.hrId is nullable, and a login with no employee record
  // reaches this screen. "No HR_ID" must never canonicalise to something that matches a null
  // manager_hr_id and hands them the whole company.
  assert.deepEqual(managersWithinViewerTeam({ roster: ROSTER, viewerHrId: null }), []);
  assert.deepEqual(managersWithinViewerTeam({ roster: ROSTER, viewerHrId: "  " }), []);
  assert.equal(canViewerSeeManagerCandidates({ managerHrId: "b-94", roster: ROSTER, viewerHrId: null }), false);
  assert.equal(canViewerSeeManagerCandidates({ managerHrId: null, roster: ROSTER, viewerHrId: "a-12" }), false);
  assert.equal(
    canViewerSeeManagerCandidates({ managerHrId: "", roster: ROSTER, viewerHrId: "a-12" }),
    false,
    "an empty id is not a match for the roster rows that have no manager",
  );

  // ── 9 · A cycle in the org chart must not hang the request ────────────────
  // Nothing in the employees table forbids one, and a hung request on a portal page is an outage.
  const cycle: TeamRosterEntry[] = [
    person("x", { manager: "y" }),
    person("y", { manager: "x" }),
    person("z", { manager: "x", title: "Medical Representative" }),
  ];
  assert.deepEqual(ids(managersWithinViewerTeam({ roster: cycle, viewerHrId: "y" })), ["x"]);
  assert.deepEqual(managersWithinViewerTeam({ roster: [], viewerHrId: "a-12" }), []);

  // ── 10 · A leaver is LISTED, not hidden ───────────────────────────────────
  // Their pushed CVs keep their HR_ID and do not move. Dropping them would make those CVs invisible
  // to the one person above them who can reassign them — and invisible reads as "there were none".
  const withLeaver: TeamRosterEntry[] = [
    person("nsm2", { title: "National Sales Manager" }),
    person("left", { manager: "nsm2", status: "resigned" }),
    person("rep2", { manager: "left", title: "Medical Representative" }),
  ];
  const team = managersWithinViewerTeam({ roster: withLeaver, viewerHrId: "nsm2" });
  assert.deepEqual(ids(team), ["left"], "a departed manager stays in the picker");
  assert.equal(team[0]?.active, false, "and is marked as departed, so the screen can say so");
}
