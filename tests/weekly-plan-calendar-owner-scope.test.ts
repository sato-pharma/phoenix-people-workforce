import { strict as assert } from "node:assert";

import { isPlanItemVisibleToViewer } from "../src/lib/weekly-planning/calendar-service.ts";
import type { CalendarViewerContext } from "../src/lib/weekly-planning/calendar-service.ts";
import type { PlanningCalendarPlanItem } from "../src/lib/weekly-planning/calendar.ts";
import { normalizeHrIdForAccess } from "../src/lib/auth/permissions.ts";

/**
 * Coverage for the shared planning calendar's visibility gate: first
 * isAllowedCalendarOwner (is the plan's owner title calendar-eligible at all,
 * regardless of viewer), then the role/line-scoped viewer matrix (owner
 * decision 2026-07-20, refined same-day, superseding the unconditional
 * 2026-07-19 visibility):
 *   - CEO / Super Admin: unrestricted (explicit, owner-confirmed).
 *   - Training Manager: unrestricted.
 *   - Marketing Manager: Training Manager + every Product Manager/Group Product
 *     Manager, company-wide (not line-scoped).
 *   - B-155 (Ahmed Sharaf): Pedia + Anti Infective + Training Manager.
 *   - Group Product Manager (Pedia line): Training Manager + all Pedia.
 *   - National Sales Manager (Pedia line): the Group Product Manager + all Pedia.
 *   - National Sales Manager (Anti Infective line): Training Manager + all Anti Infective.
 *   - National Sales Manager (CNS line): Training Manager + all CNS (owner, 2026-09-20).
 *   - Product Manager (Anti Infective line): Training Manager + all Anti Infective.
 *   - District Manager: Training Manager + their own line's Product Manager ONLY —
 *     never Group Product Manager, never their own line's NSM, never other lines,
 *     never a peer District Manager (including their own submission).
 *   - Regional Manager: District Manager's scope + their own line's Group Product
 *     Manager + the District Managers who report DIRECTLY to them (via
 *     CalendarViewerContext.directReportHrIds, not every District Manager on the line).
 *   - Any other role/line combination keeps the unrestricted 2026-07-19 default.
 */

function planItem(input: Partial<PlanningCalendarPlanItem> & { employeeHrId: string; employeeJobTitle: string | null }): PlanningCalendarPlanItem {
  return {
    activityTitle: "Field visit",
    activityType: "Field",
    area: null,
    conflictKey: null,
    conflictWarning: null,
    employeeName: "Test Employee",
    employeeDisplayName: "Test Employee",
    endDate: "2026-07-06",
    id: "plan-1",
    lineName: "Pedia",
    medicalRepHrId: null,
    medicalRepName: null,
    medicalRepDisplayName: null,
    notes: null,
    planId: "header-1",
    planKind: "weekly",
    region: null,
    source: "plan",
    startDate: "2026-07-06",
    status: "submitted",
    time: null,
    title: "Test Employee — Field visit",
    ...input,
  };
}

function viewer(input: Partial<CalendarViewerContext>): CalendarViewerContext {
  return { hrId: "VIEWER-1", role: null, lineName: null, directReportHrIds: new Set(), ...input };
}

// An unrestricted viewer used to isolate owner-eligibility assertions from the
// role/line-scoped matrix below — Training Manager sees every eligible item.
// (Marketing Manager is NOT used here — it is itself scoped, see below.)
const UNRESTRICTED_VIEWER = viewer({ hrId: "A-7", role: "Training Manager" });

export function runWeeklyPlanCalendarOwnerScopeTests() {
  // --- Title recognition (isAllowedCalendarOwner) ---

  const trainingManagerItem = planItem({ employeeHrId: "A-7", employeeJobTitle: "Training Manager", lineName: "Head Office" });
  assert.equal(
    isPlanItemVisibleToViewer(trainingManagerItem, UNRESTRICTED_VIEWER),
    true,
    "Training Manager item is recognized as an allowed owner via title",
  );

  const marketingManagerItem = planItem({ employeeHrId: "MM-1", employeeJobTitle: "Marketing Manager", lineName: "Head Office" });
  assert.equal(
    isPlanItemVisibleToViewer(marketingManagerItem, UNRESTRICTED_VIEWER),
    true,
    "Marketing Manager item is recognized as an allowed owner",
  );

  for (const title of ["District Manager", "District Sales Manager", "DSM"]) {
    const dmItem = planItem({ employeeHrId: "DM-1", employeeJobTitle: title, lineName: "Pedia" });
    assert.equal(
      isPlanItemVisibleToViewer(dmItem, UNRESTRICTED_VIEWER),
      true,
      `District Manager title variant "${title}" is recognized as an allowed owner`,
    );
  }

  const territoryManagerFullItem = planItem({ employeeHrId: "TER-1", employeeJobTitle: "Territory Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(territoryManagerFullItem, UNRESTRICTED_VIEWER),
    true,
    "Territory Manager (full title) is still recognized — regression guard",
  );
  const territoryManagerAliasItem = planItem({ employeeHrId: "TER-2", employeeJobTitle: "TM", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(territoryManagerAliasItem, UNRESTRICTED_VIEWER),
    true,
    "Territory Manager 'tm' alias is still recognized — regression guard",
  );
  // Territory Manager's "tm" alias must not be conflated with Training Manager:
  // both are recognized owners, but via independent match paths (full-string
  // containment for "training manager" vs the bare token alias for "tm").
  assert.notEqual(
    territoryManagerAliasItem.employeeJobTitle,
    trainingManagerItem.employeeJobTitle,
    "Territory Manager 'tm' fixture and Training Manager fixture use distinct titles",
  );

  const unrecognizedItem = planItem({ employeeHrId: "MR-1", employeeJobTitle: "Medical Rep", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(unrecognizedItem, UNRESTRICTED_VIEWER),
    false,
    "an unrecognized job title (e.g. Medical Rep) is never an allowed owner, regardless of viewer",
  );

  // Owner decision 2026-07-30: the Regional Manager became a plan SUBMITTER (added to
  // WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES in weekly-planning/plan-v1.ts). A submitted plan whose
  // owner title is not calendar-eligible is invisible to EVERY viewer — including the RM who wrote it
  // and the NSM who approves it — so the two lists must agree. Previously asserted false.
  const regionalManagerItem = planItem({ employeeHrId: "RM-1", employeeJobTitle: "Regional Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(regionalManagerItem, UNRESTRICTED_VIEWER),
    true,
    "Regional Manager is a calendar-eligible owner: they submit plans, so their plan must be visible",
  );
  const regionalSalesManagerItem = planItem({
    employeeHrId: "RM-2",
    employeeJobTitle: "Regional Sales Manager",
    lineName: "Pedia",
  });
  assert.equal(
    isPlanItemVisibleToViewer(regionalSalesManagerItem, UNRESTRICTED_VIEWER),
    true,
    "the real-world title 'Regional Sales Manager' must resolve too (that is what the live RM row carries)",
  );

  // --- Default: unrestricted for any role/line not named in the 2026-07-20 matrix ---

  const headOfficeItem = planItem({ employeeHrId: "A-8", employeeJobTitle: "Training Manager", lineName: "Head Office" });
  assert.equal(
    isPlanItemVisibleToViewer(headOfficeItem, UNRESTRICTED_VIEWER),
    true,
    "Head Office line item stays visible to an unrestricted viewer",
  );

  const cnsNsmViewer = viewer({ hrId: "B-122", role: "National Sales Manager", lineName: "CNS" });
  const dermaItem = planItem({ employeeHrId: "PM-1", employeeJobTitle: "Product Manager", lineName: "Derma" });
  // 2026-09-20: the CNS NSM was the one NSM left on the unrestricted default. He is scoped to CNS now,
  // like the Pedia and Anti Infective NSMs.
  const cnsFieldItemForNsm = planItem({ employeeHrId: "DSM-CNS-1", employeeJobTitle: "District Manager", lineName: "CNS" });
  const cnsTrainingItem = planItem({ employeeHrId: "A-7", employeeJobTitle: "Training Manager", lineName: "Head Office" });
  const pediaFieldItemForNsm = planItem({ employeeHrId: "DSM-P-1", employeeJobTitle: "District Manager", lineName: "Pedia" });
  const aiFieldItemForNsm = planItem({ employeeHrId: "DSM-AI-1", employeeJobTitle: "District Manager", lineName: "Anti Infective" });
  assert.equal(isPlanItemVisibleToViewer(cnsFieldItemForNsm, cnsNsmViewer), true, "CNS NSM sees a CNS-line plan");
  assert.equal(isPlanItemVisibleToViewer(cnsTrainingItem, cnsNsmViewer), true, "CNS NSM sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaFieldItemForNsm, cnsNsmViewer), false, "CNS NSM does NOT see a Pedia-line plan");
  assert.equal(isPlanItemVisibleToViewer(aiFieldItemForNsm, cnsNsmViewer), false, "CNS NSM does NOT see an Anti Infective-line plan");
  assert.equal(isPlanItemVisibleToViewer(dermaItem, cnsNsmViewer), false, "CNS NSM does NOT see another line's Product Manager");

  // --- CEO / Super Admin: explicit unrestricted (owner-confirmed 2026-07-20) ---

  const superAdminViewer = viewer({ hrId: "SA-1", role: "Super Admin" });
  const anyLineItem = planItem({ employeeHrId: "PM-2", employeeJobTitle: "Product Manager", lineName: null });
  assert.equal(
    isPlanItemVisibleToViewer(anyLineItem, superAdminViewer),
    true,
    "Super Admin sees everything, including items with no lineName on record",
  );

  const ceoViewer = viewer({ hrId: "AA", role: "CEO" });
  assert.equal(isPlanItemVisibleToViewer(anyLineItem, ceoViewer), true, "CEO sees everything, including items with no lineName on record");

  // --- Marketing Manager: Training Manager + Product Manager/Group Product
  // Manager, company-wide (owner correction — narrower than the original
  // 2026-07-20 "unrestricted" decision for this specific role) ---

  const marketingManagerViewer = viewer({ hrId: "A-9", role: "Marketing Manager" });
  const dermaPmItem = planItem({ employeeHrId: "PM-DERMA-1", employeeJobTitle: "Product Manager", lineName: "Derma" });
  const dermaGpmItem = planItem({ employeeHrId: "GPM-DERMA-1", employeeJobTitle: "Group Product Manager", lineName: "Derma" });
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, marketingManagerViewer), true, "Marketing Manager sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(dermaPmItem, marketingManagerViewer), true, "Marketing Manager sees a Product Manager's plan on ANY line (not line-scoped)");
  assert.equal(isPlanItemVisibleToViewer(dermaGpmItem, marketingManagerViewer), true, "Marketing Manager sees a Group Product Manager's plan on ANY line");
  const nsmItemForMm = planItem({ employeeHrId: "NSM-1", employeeJobTitle: "National Sales Manager", lineName: "Pedia" });
  assert.equal(isPlanItemVisibleToViewer(nsmItemForMm, marketingManagerViewer), false, "Marketing Manager does NOT see an NSM's plan — not in scope");
  const dsmItemForMm = planItem({ employeeHrId: "DSM-MM-1", employeeJobTitle: "District Manager", lineName: "Pedia" });
  assert.equal(isPlanItemVisibleToViewer(dsmItemForMm, marketingManagerViewer), false, "Marketing Manager does NOT see a District Manager's plan — not in scope");

  // --- Role/line-scoped matrix (owner decision 2026-07-20) ---

  const pediaGpmViewer = viewer({ hrId: "A-8", role: "Group Product Manager", lineName: "Pedia" });
  const pediaFieldItem = planItem({ employeeHrId: "DSM-1", employeeJobTitle: "District Manager", lineName: "Pedia" });
  const antiInfectiveFieldItem = planItem({ employeeHrId: "DSM-2", employeeJobTitle: "District Manager", lineName: "Anti Infective" });
  assert.equal(isPlanItemVisibleToViewer(pediaFieldItem, pediaGpmViewer), true, "Pedia GPM sees a Pedia-line plan");
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, pediaGpmViewer), true, "Pedia GPM sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(antiInfectiveFieldItem, pediaGpmViewer), false, "Pedia GPM does NOT see an Anti Infective-line plan");
  assert.equal(isPlanItemVisibleToViewer(marketingManagerItem, pediaGpmViewer), false, "Pedia GPM does NOT see the Marketing Manager's plan (not in scope)");

  const pediaNsmViewer = viewer({ hrId: "A-12", role: "National Sales Manager", lineName: "Pedia" });
  const pediaGpmItem = planItem({ employeeHrId: "A-8", employeeJobTitle: "Group Product Manager", lineName: "Pedia" });
  assert.equal(isPlanItemVisibleToViewer(pediaFieldItem, pediaNsmViewer), true, "Pedia NSM sees a Pedia-line plan");
  assert.equal(isPlanItemVisibleToViewer(pediaGpmItem, pediaNsmViewer), true, "Pedia NSM sees the Group Product Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, pediaNsmViewer), false, "Pedia NSM does NOT see the Training Manager's plan (not in scope)");
  assert.equal(isPlanItemVisibleToViewer(antiInfectiveFieldItem, pediaNsmViewer), false, "Pedia NSM does NOT see an Anti Infective-line plan");

  const antiInfectiveNsmViewer = viewer({ hrId: "B-157", role: "National Sales Manager", lineName: "Anti Infective" });
  assert.equal(isPlanItemVisibleToViewer(antiInfectiveFieldItem, antiInfectiveNsmViewer), true, "Anti Infective NSM sees an Anti Infective-line plan");
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, antiInfectiveNsmViewer), true, "Anti Infective NSM sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaFieldItem, antiInfectiveNsmViewer), false, "Anti Infective NSM does NOT see a Pedia-line plan");
  assert.equal(isPlanItemVisibleToViewer(pediaGpmItem, antiInfectiveNsmViewer), false, "Anti Infective NSM does NOT see the Group Product Manager's plan (Pedia-only relationship)");

  const antiInfectivePmViewer = viewer({ hrId: "A-10", role: "Product Manager", lineName: "Anti Infective" });
  assert.equal(isPlanItemVisibleToViewer(antiInfectiveFieldItem, antiInfectivePmViewer), true, "Anti Infective PM sees an Anti Infective-line plan");
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, antiInfectivePmViewer), true, "Anti Infective PM sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaFieldItem, antiInfectivePmViewer), false, "Anti Infective PM does NOT see a Pedia-line plan");

  // A generic Pedia-line Product Manager (i.e. not B-155) is not named in the matrix —
  // falls through to the unrestricted default rather than being silently blocked.
  const genericPediaPmViewer = viewer({ hrId: "PM-9", role: "Product Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(antiInfectiveFieldItem, genericPediaPmViewer),
    true,
    "a Pedia-line Product Manager other than B-155 is not narrowed — keeps the unrestricted default",
  );

  // --- B-155 (Ahmed Sharaf): named exception, Pedia + Anti Infective + Training Manager ---

  const ahmedSharafViewer = viewer({ hrId: "B-155", role: "Product Manager", lineName: "Pedia" });
  const cnsFieldItem = planItem({ employeeHrId: "DSM-3", employeeJobTitle: "District Manager", lineName: "CNS" });
  assert.equal(isPlanItemVisibleToViewer(pediaFieldItem, ahmedSharafViewer), true, "Ahmed Sharaf (B-155) sees a Pedia-line plan");
  assert.equal(isPlanItemVisibleToViewer(antiInfectiveFieldItem, ahmedSharafViewer), true, "Ahmed Sharaf (B-155) sees an Anti Infective-line plan");
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, ahmedSharafViewer), true, "Ahmed Sharaf (B-155) sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(cnsFieldItem, ahmedSharafViewer), false, "Ahmed Sharaf (B-155) does NOT see a CNS-line plan — his exception is exactly Pedia + Anti Infective, not every line");
  assert.equal(
    isPlanItemVisibleToViewer(cnsFieldItem, viewer({ hrId: "b-155", role: "Product Manager", lineName: "Pedia" })),
    false,
    "the B-155 exception matches case-insensitively on hrId, same as normalizeHrId elsewhere",
  );

  // --- District Manager: Training Manager + own-line Product Manager ONLY ---
  // (never Group Product Manager, never their own line's NSM, never other lines,
  // never a peer District Manager — including their own submission, which does not
  // match either grant; this is a coordination view, not "my own plan".)

  const pediaPmTitledItem = planItem({ employeeHrId: "PM-PEDIA-1", employeeJobTitle: "Product Manager", lineName: "Pedia" });
  const antiInfectivePmTitledItem = planItem({ employeeHrId: "PM-AI-1", employeeJobTitle: "Product Manager", lineName: "Anti Infective" });
  const pediaNsmOwnedItem = planItem({ employeeHrId: "A-12", employeeJobTitle: "National Sales Manager", lineName: "Pedia" });

  const pediaDsmViewer = viewer({ hrId: "DSM-PEDIA-1", role: "District Manager", lineName: "Pedia" });
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, pediaDsmViewer), true, "Pedia District Manager sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaPmTitledItem, pediaDsmViewer), true, "Pedia District Manager sees their own line's Product Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaGpmItem, pediaDsmViewer), false, "Pedia District Manager does NOT see the Group Product Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaNsmOwnedItem, pediaDsmViewer), false, "Pedia District Manager does NOT see their own line's NSM's plan");
  assert.equal(isPlanItemVisibleToViewer(antiInfectivePmTitledItem, pediaDsmViewer), false, "Pedia District Manager does NOT see an Anti Infective-line plan, even a Product Manager's");
  const peerDsmItem = planItem({ employeeHrId: "DSM-PEDIA-2", employeeJobTitle: "District Manager", lineName: "Pedia" });
  assert.equal(isPlanItemVisibleToViewer(peerDsmItem, pediaDsmViewer), false, "Pedia District Manager does NOT see a peer District Manager's plan, even on the same line");
  const ownDsmItem = planItem({ employeeHrId: "DSM-PEDIA-1", employeeJobTitle: "District Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(ownDsmItem, pediaDsmViewer),
    false,
    "a District Manager does not see their own plan on this shared calendar either — matches neither grant; this is a coordination view, not a personal one",
  );

  // --- Regional Manager: District Manager's scope + own-line Group Product Manager
  // + the District Managers who report DIRECTLY to them (not every District Manager
  // on their line) ---

  const reportingDsmHrId = "DSM-PEDIA-3";
  const nonReportingDsmHrId = "DSM-PEDIA-4";
  const regionalManagerViewer = viewer({
    hrId: "RM-PEDIA-1",
    role: "Regional Manager",
    lineName: "Pedia",
    directReportHrIds: new Set([normalizeHrIdForAccess(reportingDsmHrId) ?? ""]),
  });
  assert.equal(isPlanItemVisibleToViewer(trainingManagerItem, regionalManagerViewer), true, "Regional Manager sees the Training Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaPmTitledItem, regionalManagerViewer), true, "Regional Manager sees their own line's Product Manager's plan");
  assert.equal(isPlanItemVisibleToViewer(pediaGpmItem, regionalManagerViewer), true, "Regional Manager sees their own line's Group Product Manager's plan (unlike District Manager)");
  assert.equal(isPlanItemVisibleToViewer(pediaNsmOwnedItem, regionalManagerViewer), false, "Regional Manager does NOT see their own line's NSM's plan");
  const reportingDsmItem = planItem({ employeeHrId: reportingDsmHrId, employeeJobTitle: "District Manager", lineName: "Pedia" });
  assert.equal(isPlanItemVisibleToViewer(reportingDsmItem, regionalManagerViewer), true, "Regional Manager sees the plan of a District Manager who reports directly to them");
  const nonReportingDsmItem = planItem({ employeeHrId: nonReportingDsmHrId, employeeJobTitle: "District Manager", lineName: "Pedia" });
  assert.equal(
    isPlanItemVisibleToViewer(nonReportingDsmItem, regionalManagerViewer),
    false,
    "Regional Manager does NOT see a same-line District Manager who does not report to them",
  );
  assert.equal(isPlanItemVisibleToViewer(antiInfectivePmTitledItem, regionalManagerViewer), false, "Regional Manager does NOT see an Anti Infective-line plan");

  // --- HR Advisory: unrestricted, same as Training Manager (owner decision
  // 2026-07-25, Head Office system-wide audit) — she is a Head Office role serving all
  // 3 sales lines, not a role confined to Head-Office-only scheduling. A same-day
  // narrower rule (Head-Office-line plans plus one named PM exception) was reverted
  // once that concept was clarified; these assertions confirm the full revert, not
  // just the addition of a couple of previously-blocked cases. ---

  const hrAdvisoryViewer = viewer({ hrId: "A-16", role: "HR Advisory" });
  assert.equal(
    isPlanItemVisibleToViewer(headOfficeItem, hrAdvisoryViewer),
    true,
    "HR Advisory sees a Head-Office-line plan",
  );
  assert.equal(
    isPlanItemVisibleToViewer(pediaFieldItem, hrAdvisoryViewer),
    true,
    "HR Advisory sees a Pedia-line plan too — she serves all 3 sales lines, not just Head Office",
  );
  assert.equal(
    isPlanItemVisibleToViewer(antiInfectiveFieldItem, hrAdvisoryViewer),
    true,
    "HR Advisory sees an Anti Infective-line plan too",
  );
  assert.equal(
    isPlanItemVisibleToViewer(antiInfectivePmTitledItem, hrAdvisoryViewer),
    true,
    "HR Advisory sees every Anti Infective Product Manager's plan now, not just one named exception",
  );

  // --- An acting District Manager (owner, 2026-10-20): she holds the District Manager APP role but
  // keeps a Medical Representative title, so the title test alone dropped her plans from every
  // calendar. The viewer context's districtManagerHrIds (active District Manager sign-ins) makes her
  // an owner; a real rep is still not one, and a context built without the set keeps the title rule. ---
  const actingDmItem = planItem({ employeeHrId: "R-77", employeeJobTitle: "Medical Representative", lineName: "CNS" });
  const realRepItem = planItem({ employeeHrId: "R-78", employeeJobTitle: "Medical Representative", lineName: "CNS" });
  const actingDmKeys = new Set([normalizeHrIdForAccess("R-77") ?? ""]);
  assert.equal(
    isPlanItemVisibleToViewer(actingDmItem, viewer({ hrId: "A-7", role: "Training Manager", districtManagerHrIds: actingDmKeys })),
    true,
    "an acting District Manager's plan is on the calendar once her app role is known",
  );
  assert.equal(
    isPlanItemVisibleToViewer(realRepItem, viewer({ hrId: "A-7", role: "Training Manager", districtManagerHrIds: actingDmKeys })),
    false,
    "a Medical Representative without the District Manager app role is still not a calendar owner",
  );
  assert.equal(
    isPlanItemVisibleToViewer(actingDmItem, UNRESTRICTED_VIEWER),
    false,
    "without the app-role set, ownership is decided by title alone, as before",
  );
  assert.equal(
    isPlanItemVisibleToViewer(
      actingDmItem,
      viewer({
        hrId: "RM-1",
        role: "Regional Manager",
        lineName: "CNS",
        directReportHrIds: new Set([normalizeHrIdForAccess("R-77") ?? ""]),
        districtManagerHrIds: actingDmKeys,
      }),
    ),
    true,
    "her own Regional Manager sees her plan as one of his District Managers'",
  );
  assert.equal(
    isPlanItemVisibleToViewer(
      actingDmItem,
      viewer({ hrId: "DM-2", role: "District Manager", lineName: "CNS", districtManagerHrIds: actingDmKeys }),
    ),
    false,
    "a peer District Manager still never sees another District Manager's plan",
  );

  // A district manager's half-day WITH a manager or product manager (owner, 2026-10-24: "calendar + notice"):
  // the person he picked sees it whatever the role rules say — the CNS Marketing Manager sees no district
  // manager's plan otherwise — and nobody else gains anything from the pick.
  const withMarketing = planItem({ employeeHrId: "B-118", employeeJobTitle: "District Manager", lineName: "CNS", withHrId: "A-9" });
  const marketingManager = viewer({ hrId: "A-9", role: "Marketing Manager", lineName: "CNS" });
  assert.equal(isPlanItemVisibleToViewer(withMarketing, marketingManager), true, "the Marketing Manager the district manager picked sees that half-day");
  assert.equal(
    isPlanItemVisibleToViewer({ ...withMarketing, withHrId: null }, marketingManager),
    false,
    "without the pick the Marketing Manager still sees no district manager's plan",
  );
  assert.equal(
    isPlanItemVisibleToViewer(withMarketing, viewer({ hrId: "MM-2", role: "Marketing Manager", lineName: "CNS" })),
    false,
    "another Marketing Manager gains nothing from someone else's pick",
  );
  assert.equal(
    isPlanItemVisibleToViewer(withMarketing, viewer({ hrId: "DM-2", role: "District Manager", lineName: "CNS" })),
    false,
    "a peer District Manager still never sees it",
  );
}
