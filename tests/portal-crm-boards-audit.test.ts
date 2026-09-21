import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AM_CALL_RATE_TARGET,
  PHARMACY_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  zeroRepCallRate,
  type CallRateReport,
  type CallRateSlice,
  type RepCallRate,
} from "../src/lib/crm/call-rate.ts";
import { DOCTOR_COVERAGE_PORTAL_ROLES, type DoctorCoverageScope } from "../src/lib/crm/doctor-coverage-roles.ts";
import { buildOrgPlacementTree, type OrgTreeNode } from "../src/lib/crm/org-placement.ts";
import { buildRepsPlansBoard } from "../src/lib/crm/reps-plans.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The defects found by auditing Reps List, Reps Plans and KPIs IN the employee
// portal on 2026-09-04 — signed in as each seat, not read off the source.
//
// What they have in common is that NONE of them showed an error: a missing rep read
// as a smaller team, a dead filter read as reps who did nothing, an admin header
// inside the portal read as a different application. A board that is wrong in a way
// that looks right is the only kind worth a regression test.
// ─────────────────────────────────────────────────────────────────────────────

const CNS_DELTA = { lineCode: "cns", lineName: "CNS", regionCode: "delta", regionName: "Delta (1)" };
const CNS_GIZA = { lineCode: "cns", lineName: "CNS", regionCode: "giza", regionName: "Giza" };
const AI_DELTA = { lineCode: "ai", lineName: "Anti Infective", regionCode: "delta", regionName: "Delta (1)" };

/** `au_v_org_tree.path` carries the seat's OWN id last — matched here, as the sibling fixtures do. */
const seat = (
  seatId: string,
  seatTier: string,
  occupantHrId: string | null,
  ancestors: string[],
  cell?: { lineCode: string; lineName: string; regionCode: string; regionName: string },
): OrgTreeNode => ({
  seatId,
  path: [...ancestors, seatId],
  seatTier,
  occupantHrId,
  lineCode: cell?.lineCode ?? null,
  lineName: cell?.lineName ?? null,
  regionCode: cell?.regionCode ?? null,
  regionName: cell?.regionName ?? null,
});

// One DM over three reps on CNS/Delta, one rep on CNS/Giza under the NSM, and one on
// Anti Infective. The DM's team is the shape the live board got wrong.
const TREE = buildOrgPlacementTree([
  seat("CEO", "CEO", "A-9000", []),
  seat("NSM", "NSM", "A-0100", ["CEO"]),
  seat("DM", "DM", "B-118", ["CEO", "NSM"], CNS_DELTA),
  seat("R1", "REP", "B-130", ["CEO", "NSM", "DM"], CNS_DELTA),
  seat("R2", "REP", "B-131", ["CEO", "NSM", "DM"], CNS_DELTA),
  seat("R3", "REP", "B-132", ["CEO", "NSM", "DM"], CNS_DELTA),
  seat("R4", "REP", "B-200", ["CEO", "NSM"], CNS_GIZA),
  seat("R5", "REP", "B-300", ["CEO"], AI_DELTA),
]);

const NAMES = new Map([
  ["b-118", "Nabil Fahmy"],
  ["b-130", "Mohamed Adel"],
  ["b-131", "Gehad Samir"],
  ["b-132", "Nour Hany"],
  ["b-200", "Basem Fouad"],
  ["b-300", "Karim Saad"],
]);

function slice(target: number, verified: number, workingDays: number): CallRateSlice {
  const verifiedRate = workingDays > 0 ? verified / workingDays : null;
  return {
    verified,
    unverified: 0,
    campaign: 0,
    total: verified,
    verifiedRate,
    totalRate: verifiedRate,
    target,
    attainmentPct: verifiedRate == null ? null : (verifiedRate / target) * 100,
  };
}

function rep(hrId: string, crmId: number, am: number, pm: number, workingDays = 10): RepCallRate {
  return {
    agentCrmId: crmId,
    agentHrId: hrId,
    agentName: `CRM ${hrId}`,
    workingDays,
    am: slice(AM_CALL_RATE_TARGET, am, workingDays),
    pm: slice(PM_CALL_RATE_TARGET, pm, workingDays),
    // Separate from AM/PM entirely (owner, 2026-09-05) — none of these fixtures are about
    // pharmacies, so zero calls, no target.
    pharmacy: { verified: 0, unverified: 0, campaign: 0, total: 0, verifiedRate: workingDays > 0 ? 0 : null, totalRate: workingDays > 0 ? 0 : null, target: null, attainmentPct: null },
    unspecified: 0,
    campaignShare: 0,
    campaignOverLimitDays: [],
    campaignOnlyDays: 0,
  };
}

function report(reps: RepCallRate[], workingDays = 10): CallRateReport {
  return { dateFrom: "2026-09-01", dateTo: "2026-09-30", workingDays, holidayDays: 0, campaignLimit: 3, reps };
}

/** B-131 logged NOTHING. Everyone else on the chart worked. */
const SILENT_REP_REPORT = report([
  rep("B-130", 1, 20, 100),
  rep("B-132", 3, 15, 80),
  rep("B-200", 4, 10, 50),
  rep("B-300", 5, 5, 40),
]);

const DM_SCOPE: DoctorCoverageScope = {
  kind: "agents",
  basis: "team",
  agentHrIds: ["B-130", "B-131", "B-132"],
  label: "District Manager · own team",
};

const readSource = (path: string) => readFileSync(path, "utf8");

/**
 * The file with its comments removed.
 *
 * Every convention below is pinned by looking for a literal in the source, and each of these pages
 * DOCUMENTS the defect it fixed — the KPIs page's own header quotes `chrome="portal"` and
 * `error.message` while explaining why they are there and not there. Searching the raw file
 * therefore reads a prose paragraph as evidence of the code: removing the real `chrome="portal"`
 * from the JSX left this test green, which is how it was caught. A rule that cannot tell a fix
 * from its explanation gets deleted rather than obeyed.
 */
const readCode = (path: string) =>
  readSource(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// ── THE REP WHO DID NOTHING ──────────────────────────────────────────────────
export function runRepsPlansSilentRepTests() {
  // THE DEFECT. `computeCallRate` buckets visit ROWS, so a rep with no visits is not a
  // zero in `report.reps` — he is absent from it. Seeding the roster from that feed meant
  // the one rep a call-rate board exists to surface was the one rep it could not show.
  //
  // Measured in production on 2026-09-04: B-118's team is seven reps; B-131 had zero rows
  // in `ireports360_visits` for September while the other six had 12-40. The board said
  // six reps and named six people. Nothing on it was wrong — she was simply not on it,
  // which reads as a smaller team rather than as a rep who has not worked.
  const board = buildRepsPlansBoard(SILENT_REP_REPORT, {
    isCurrentMonth: false,
    month: "2026-09",
    repNameByHrId: NAMES,
    scope: DM_SCOPE,
    tree: TREE,
  });

  assert.deepEqual(
    board.reps.map((row) => row.repName).sort(),
    ["Gehad Samir", "Mohamed Adel", "Nour Hany"],
    "the DM's whole team is listed — including the rep the visit feed is silent about",
  );

  const silent = board.reps.find((row) => row.repName === "Gehad Samir");
  assert.ok(silent, "the seeded row exists");
  // NAMED, never coded. The seeded row is built through the same directory map every other
  // row uses, so a person the feed never mentions is still a person on screen.
  assert.equal(silent.agentHrId, "b-131", "the seeded row carries the hr id the organogram holds him by");
  assert.equal(silent.seatTierLabel, "Medical Rep", "and his seat, in words");
  assert.equal(silent.scored, true, "he is scored — a rep who did nothing is measured, not exempted");

  // ZERO, NOT BLANK. `finalizeSlice` returns early on a zero denominator, so a row built with
  // workingDays 0 would read "—" — the rendering that means "there is nothing to divide by".
  // This rep had ten working days and made no calls, and that is a measurement.
  assert.equal(silent.workingDays, 10, "the seeded row is measured over the window's own working days");
  assert.equal(silent.am.verifiedRate, 0, "so the AM rate reads 0.00, never an em dash");
  assert.equal(silent.pm.verifiedRate, 0);
  assert.equal(silent.am.attainmentPct, 0, "and 0% attainment, which is the finding this fix exists to state");
  assert.equal(silent.reportedCalls, 0);
  assert.equal(silent.verifiedCalls, 0);

  // THE TILES MOVE WITH HIM, which is the half that matters to the manager reading them.
  assert.equal(board.totals.reps, 3, "the denominator is the TEAM, not the part of it that showed up");
  // 35 verified AM over (10 days x 3 reps) = 1.17. Before the fix the same team read 1.75, because
  // the rep who made no calls was not in the denominator either — so a team rate was quietly the
  // rate of whoever turned up, which is the flattering direction to be wrong in.
  assert.equal(board.totals.am.verifiedRate, 1.17, "the silent rep dilutes the team rate, as he should");
  assert.notEqual(board.totals.am.verifiedRate, 1.75, "and the team is not scored on its attendees alone");

  // AND THE PICKER, so the manager can open the row he is looking for. The drill-down rebuilds
  // this same board to find the row, so a name offered here is a page that loads.
  assert.ok(
    board.repOptions.some((option) => option.repName === "Gehad Samir"),
    "the rep picker offers him too",
  );

  // A VACANCY IS NEVER A PERSON. `tree.index` holds occupied seats only, so nothing here can
  // invent a rep for an empty chair — the failure that would turn this fix into a worse bug.
  const withVacancy = buildOrgPlacementTree([
    seat("CEO", "CEO", "A-9000", []),
    seat("R9", "REP", null, ["CEO"], CNS_DELTA),
  ]);
  assert.equal(
    buildRepsPlansBoard(report([]), { isCurrentMonth: false, month: "2026-09", tree: withVacancy }).reps.length,
    0,
    "a vacant rep seat produces no row — the board lists people, never chairs",
  );

  // A MANAGER IS NOT SEEDED. Only scored (REP-tier) seats are, so the owner's medical-reps-only
  // rule cannot be undone from the roster side — the exact way a filter gets quietly reversed.
  const company = buildRepsPlansBoard(report([]), {
    isCurrentMonth: false,
    month: "2026-09",
    repNameByHrId: NAMES,
    tree: TREE,
  });
  assert.deepEqual(
    company.reps.map((row) => row.repName).sort(),
    ["Basem Fouad", "Gehad Samir", "Karim Saad", "Mohamed Adel", "Nour Hany"],
    "a month nobody worked lists every medical rep at zero — and neither the DM, the NSM nor the CEO",
  );

  // NO ORGANOGRAM, NO ROSTER. With the chart unreadable there is nothing to seed FROM, and a
  // partial seed would list a fraction of the field force as having done nothing. The board
  // degrades to exactly how it read before — feed rows only.
  assert.equal(
    buildRepsPlansBoard(SILENT_REP_REPORT, { isCurrentMonth: false, month: "2026-09", tree: null }).reps.length,
    4,
    "with no organogram the board shows who the feed knows about and invents nobody",
  );

  // THE HELPER'S OWN SHAPE, asserted once so a new RepCallRate field cannot be silently omitted
  // from the zero row and start reading as a real value.
  const zero = zeroRepCallRate(0, { agentHrId: "x-1" });
  assert.equal(zero.am.verifiedRate, null, "a zero denominator still yields no claim at all");
  assert.equal(zero.am.target, AM_CALL_RATE_TARGET);
  assert.equal(zero.pm.target, PM_CALL_RATE_TARGET);
  assert.equal(zero.pharmacy.target, PHARMACY_CALL_RATE_TARGET, "pharmacy is on the zero row too, target null");
  assert.equal(zero.pharmacy.verifiedRate, null, "and the same zero-denominator rule applies to it");
  assert.equal(zero.agentCrmId, null);
  assert.deepEqual(zero.campaignOverLimitDays, []);
}

// ── A PICKER IS NEVER WIDER THAN ITS VIEWER ──────────────────────────────────
export function runRepsPlansPickerScopeTests() {
  // THE DEFECT. The Line and Region pickers were built from `tree.cells` — every real
  // territory in the COMPANY — while the rows below them were scoped to the viewer. A
  // District Manager whose reps are all CNS/Delta was offered Anti Infective; choosing it
  // returned an empty board with the header reading "· ANTI INFECTIVE", which says "your
  // reps did nothing" rather than "you filtered yourself out of your own scope".
  //
  // The owner's rule is that a picker is never wider than its viewer, and the KPIs board
  // next door already builds its facets from the scoped rows for this exact reason.
  const board = buildRepsPlansBoard(SILENT_REP_REPORT, {
    isCurrentMonth: false,
    month: "2026-09",
    repNameByHrId: NAMES,
    scope: DM_SCOPE,
    tree: TREE,
  });

  assert.deepEqual(
    board.lineOptions.map((option) => option.name),
    ["CNS"],
    "a DM whose team is all CNS is offered CNS and nothing else",
  );
  assert.deepEqual(
    board.regionOptions.map((option) => option.name),
    ["Delta (1)"],
    "and only the region his reps actually sit in",
  );
  // Names, never codes — the owner's standing rule, and why the code map is still read.
  assert.deepEqual(board.lineOptions.map((option) => option.code), ["cns"]);

  // A LINE HE CANNOT REACH IS PRUNED, not applied. This is precisely what the live board did
  // wrong: `?line=ai` was accepted, labelled in the header, and returned zeroes.
  const other = buildRepsPlansBoard(SILENT_REP_REPORT, {
    geography: { line: "ai" },
    isCurrentMonth: false,
    month: "2026-09",
    repNameByHrId: NAMES,
    scope: DM_SCOPE,
    tree: TREE,
  });
  assert.equal(other.appliedLine, null, "a line outside the viewer's reach is dropped rather than applied");
  assert.equal(other.geographyLabel, null, "so the header never claims a filter that returned nobody");
  assert.equal(other.reps.length, 3, "and the board still shows his team");

  // THE COMPANY VIEW IS UNNARROWED — this scopes the picker to the viewer, it does not shrink
  // it for everyone. A Super Admin still gets every line his rows cover.
  const company = buildRepsPlansBoard(SILENT_REP_REPORT, {
    isCurrentMonth: false,
    month: "2026-09",
    repNameByHrId: NAMES,
    tree: TREE,
  });
  assert.deepEqual(
    company.lineOptions.map((option) => option.name),
    ["Anti Infective", "CNS"],
    "a company-wide viewer is offered both lines",
  );
  assert.deepEqual(company.regionOptions.map((option) => option.name), ["Delta (1)", "Giza"], "and both regions");

  // THE CASCADE STILL CASCADES: region narrows by the chosen line, which is the owner's order
  // and the one that avoids offering a pairing no rep satisfies.
  const cns = buildRepsPlansBoard(SILENT_REP_REPORT, {
    geography: { line: "cns" },
    isCurrentMonth: false,
    month: "2026-09",
    repNameByHrId: NAMES,
    tree: TREE,
  });
  assert.deepEqual(cns.regionOptions.map((option) => option.name), ["Delta (1)", "Giza"]);
  const ai = buildRepsPlansBoard(SILENT_REP_REPORT, {
    geography: { line: "ai" },
    isCurrentMonth: false,
    month: "2026-09",
    repNameByHrId: NAMES,
    tree: TREE,
  });
  assert.deepEqual(
    ai.regionOptions.map((option) => option.name),
    ["Delta (1)"],
    "Anti Infective offers only the region its reps are in",
  );

  // A VIEWER WITH NO REACH GETS NO PICKERS, rather than empty ones. An empty line picker reads
  // as "this company has no lines".
  const none = buildRepsPlansBoard(SILENT_REP_REPORT, {
    isCurrentMonth: false,
    month: "2026-09",
    scope: { kind: "none", reason: "No active reports are attached to your seat." },
    tree: TREE,
  });
  assert.equal(none.geographyAvailable, false, "no rows means no geography to offer");
  assert.deepEqual(none.lineOptions, []);
}

// ── THE PORTAL KPIs PAGE IS A PORTAL PAGE ────────────────────────────────────
export function runPortalKpisPageConventionsTests() {
  // THE DEFECT. The portal KPIs page was the admin page with `/admin` swapped for
  // `/employee-portals` and nothing else, so inside ONE nav group KPIs drew the admin header
  // on white while Reps List and Reps Plans drew the navy command header with the orange CRM
  // badge. Four portal conventions came off with the copy; each is pinned here against its two
  // siblings rather than against a remembered rule.
  const page = readCode("app/employee-portals/kpis/page.tsx");
  // Two siblings until 2026-09-21, when the owner merged Reps Plans into Reps List: the call-rate
  // board is now a tab of the Reps List page, and app/employee-portals/reps-plans/page.tsx is only a
  // redirect. So the one page carries both references — and it still has to follow all three.
  const siblings = [["reps-list", readCode("app/employee-portals/reps-list/page.tsx")]] as const;

  // The comparison's own floor. Every assertion below says "KPIs must do what its siblings do",
  // which proves nothing if a sibling quietly stopped doing it.
  for (const [name, sibling] of siblings) {
    assert.ok(
      sibling.includes("EmployeePortalPageShell") &&
        sibling.includes("logPortalFailure") &&
        sibling.includes('resolveNavigationMode(access) !== "employee-portal"'),
      `${name} is the reference for these conventions and must still follow all three of them`,
    );
  }

  assert.ok(
    page.includes("EmployeePortalPageShell") && page.includes('badge="CRM"'),
    "the portal KPIs page must draw the portal shell with the CRM badge — the admin header inside the portal reads as a different application",
  );
  assert.ok(
    page.includes('chrome="portal"'),
    "and must tell the board the shell owns the heading, or the page carries two titles",
  );
  assert.ok(
    page.includes('resolveNavigationMode(access) !== "employee-portal"'),
    "an admin-mode viewer is bounced to /overview, exactly as Reps List does — a seat with a better door must not land on a portal-framed copy",
  );
  assert.ok(
    page.includes("logPortalFailure("),
    "a KPI load failure must leave a row — this was the one page of the three whose load path was not instrumented",
  );
  assert.ok(
    page.includes("EmployeePortalEmptyState"),
    "a refused or failed load EXPLAINS in the portal, where a person arrives from a bookmark or a shared link",
  );
  // THE ONE THAT LEAKED. `error.message` on this path is a Supabase or PostgREST sentence,
  // rendered to a medical rep.
  assert.ok(
    !/error\.message/.test(page) && !page.includes("{loadError}"),
    "a raw error string must never reach the page — the empty state says what happened in words",
  );

  // THE ADMIN TWIN KEEPS ITS REDIRECT, deliberately. Inside the admin shell an unreachable page
  // should behave as though it does not exist for that role; the explaining empty state is a
  // PORTAL answer, not a correction to be applied everywhere.
  assert.ok(
    readCode("app/(admin)/admin/kpis/page.tsx").includes("redirect("),
    "the admin twin still redirects — the portal's empty state is not a rule about the admin shell",
  );

  // The board must be able to yield its heading, or `chrome="portal"` is a prop nothing reads.
  const view = readCode("src/components/crm/kpis-board-view.tsx");
  assert.ok(/chrome\??\s*:\s*"admin"\s*\|\s*"portal"/.test(view), "KpisBoardView must take the chrome prop");
  assert.ok(
    view.includes('showTitle={chrome === "admin"}'),
    "and suppress its own H1 in the portal, where the shell has already drawn one",
  );
}

// ── THE PORTAL RAIL READS THE PORTAL LIST ────────────────────────────────────
export function runPortalKpisNavTabTests() {
  // THE DEFECT. The portal rail decided the KPIs row with `canSeeDoctorCoverage`, which answers
  // for EVERY role with any door onto the board — admin-mode seats included. It returned the
  // right answer only because this resolver never runs for those seats: a claim about a caller
  // three modules away, untestable from here, and one that changes silently the day a preview or
  // an impersonation path renders the portal rail for an admin viewer.
  //
  // The two neighbouring flags already take the PORTAL half of their own lists. This one now does
  // too, and it is the same list `system-navigation.ts` gates the row with.
  const nav = readCode("src/lib/employee-portal/navigation.ts");
  assert.ok(
    nav.includes("const showKpisTab = DOCTOR_COVERAGE_PORTAL_ROLES.includes(resolvedRole)"),
    "the portal KPIs row is gated on the PORTAL role list, never on the predicate that answers for admin seats too",
  );
  assert.ok(
    !/canSeeDoctorCoverage\(/.test(nav),
    "and the wider predicate is not called anywhere in the portal rail",
  );

  const kpisFor = (role: string) => resolveEmployeePortalNavVisibility(role, role).showKpisTab;

  // Every portal-mode seat with a reach still gets the row. Driven off the list itself, so a role
  // added to the board cannot be added without the rail following.
  for (const role of DOCTOR_COVERAGE_PORTAL_ROLES) {
    assert.equal(kpisFor(role), true, `${role} reaches the KPIs board, so the portal rail must offer it`);
  }

  // Marketing Manager is in the list and is portal-mode, so she gets the row. She is hidden from
  // the Incentive tab, which is a different owner rule and must not bleed into this one.
  assert.equal(kpisFor("Marketing Manager"), true);

  // The admin-mode seats are absent from the PORTAL list — they land on /admin/kpis. This is the
  // assertion the old predicate could not make, because it answered `true` for all three.
  for (const role of ["Super Admin", "CEO", "SFE Manager"]) {
    assert.equal(
      DOCTOR_COVERAGE_PORTAL_ROLES.includes(role),
      false,
      `${role} is an admin-mode seat and must not be in the portal list`,
    );
    assert.equal(kpisFor(role), false, `${role} gets no portal KPIs row even if the portal rail is rendered for them`);
  }

  // And a seat with no reach at all is offered nothing.
  assert.equal(kpisFor("Employee"), false, "a seat with no reach onto the board is offered no row");
}
