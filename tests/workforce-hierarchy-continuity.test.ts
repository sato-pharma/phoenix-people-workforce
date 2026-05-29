import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildVacantSeatKey,
  formatVacantSeatLabel,
  isHeldByVacantSeat,
  isWithinManagerHierarchy,
  lineScopeIncludesEmployee,
  reportsToManagerSeat,
  resolveReportingSeatHrId,
  resolveSeatGrouping,
  sameWorkforceDepartment,
  sameWorkforceLine,
  selectVacantManagerSeat,
  type ResolvedVacantSeat,
  type SeatContinuitySubject,
} from "../src/lib/workforce/hierarchy-resolver.ts";
import { buildSalesManagerPerformanceGroups } from "../src/lib/sales/metrics.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

/**
 * Regression coverage for the workforce hierarchy / seat-continuity bug:
 * after a DSM resigns under an NSM, reports must stay grouped under the vacant
 * DSM seat (not the NSM), and a Sales NSM's LINE-scoped vacation view must not
 * leak Marketing employees who merely share the same product line.
 */

// Scenario actors (generic — not tied to any specific real HR_ID).
const NSM = "NSM-1";
const DSM = "DSM-CAI"; // resigned Cairo DSM seat
const NEW_DSM = "DSM-CAI-2"; // replacement DSM

type Rep = {
  hrId: string;
  managerHrId: string | null;
  managerName: string | null;
  pendingManagerReplacementForHrId: string | null;
  areaName: string | null;
  teamName: string | null;
  lineName: string | null;
};

// A Cairo med rep after the DSM resigned: manager_hr_id was reassigned upward to
// the NSM by the resignation trigger, but the seat-continuity key still points at
// the departed DSM seat.
function cairoRepHeldByVacantSeat(hrId: string): Rep {
  return {
    hrId,
    managerHrId: NSM,
    managerName: "National Sales Manager",
    pendingManagerReplacementForHrId: DSM,
    areaName: "Cairo",
    teamName: "Cairo District",
    lineName: "Pedia",
  };
}

// A member row as consumed by buildSalesManagerPerformanceGroups, built the same
// way the employee-portal service builds it (seat-aware grouping, with optional
// vacancy fallback for orphaned reps whose continuity marker was lost).
function toPerformanceMember(
  rep: Rep,
  ctx: { nsmHrId?: string | null; vacantSeat?: ResolvedVacantSeat | null } = {},
) {
  const grouping = resolveSeatGrouping(rep, {
    vacantSeatTitle: "DSM seat",
    orphanFallback:
      ctx.vacantSeat !== undefined
        ? { isOrphanToNsm: rep.managerHrId === ctx.nsmHrId, vacantSeat: ctx.vacantSeat }
        : undefined,
  });
  return {
    hrId: rep.hrId,
    managerHrId: grouping.seatHrId,
    managerName: grouping.seatName,
    totalSales: 100,
    totalTarget: 100,
  };
}

// An active Cairo rep that LOST its continuity marker: manager reassigned to the
// NSM, pending_manager_replacement_for_hr_id is NULL (mirrors live B-164).
function cairoRepMarkerLost(hrId: string): Rep {
  return {
    hrId,
    managerHrId: NSM,
    managerName: "National Sales Manager",
    pendingManagerReplacementForHrId: null,
    areaName: "Nasr City",
    teamName: null,
    lineName: "Pedia",
  };
}

export function runWorkforceHierarchyContinuityTests() {
  // -- 1. DSM resignation leaves a vacant DSM seat the reports stay attached to.
  const held = cairoRepHeldByVacantSeat("MR-1");
  assert.equal(isHeldByVacantSeat(held), true, "held rep is recognised as vacant-seat held");
  assert.equal(
    resolveReportingSeatHrId(held),
    DSM,
    "reporting seat resolves to the vacant DSM seat, not the upward NSM",
  );

  // -- 2. Cairo MRs remain grouped under the vacant DSM seat.
  const grouping = resolveSeatGrouping(held, { vacantSeatTitle: "DSM seat" });
  assert.equal(grouping.isVacant, true, "grouping is flagged vacant");
  assert.equal(grouping.seatHrId, DSM, "grouping key is the departed DSM seat");
  assert.match(grouping.seatName ?? "", /Vacant DSM seat/, "vacant seat is labelled");

  // -- 3. Cairo MRs do NOT become direct NSM reports.
  assert.notEqual(grouping.seatHrId, NSM, "grouping key must not be the NSM");

  // -- 4. NSM Medical Reps Performance groups Cairo MRs by the vacant DSM seat.
  const members = [
    toPerformanceMember(cairoRepHeldByVacantSeat("MR-1")),
    toPerformanceMember(cairoRepHeldByVacantSeat("MR-2")),
  ];
  const groups = buildSalesManagerPerformanceGroups(members);
  assert.equal(groups.length, 1, "both Cairo reps collapse into a single district group");
  assert.equal(groups[0].managerHrId, DSM, "the district group is keyed by the vacant DSM seat");
  assert.equal(groups[0].members.length, 2, "both Cairo reps are inside the vacant seat group");
  assert.equal(
    groups.some((group) => group.managerHrId === NSM),
    false,
    "no Cairo reps are grouped directly under the NSM",
  );

  // -- selectVacantManagerSeat: only an unambiguous single seat is returned.
  const oneCandidate = [
    { vacancyId: 226, vacancyCode: "VAC-CAIRO-DSM", areaName: "Cairo", lineName: "Pedia" },
  ];
  const zeroPick = selectVacantManagerSeat([], "DSM seat");
  assert.equal(zeroPick.seat, null, "no candidates -> no seat");
  assert.equal(zeroPick.ambiguous, false, "zero candidates is not ambiguous");
  const onePick = selectVacantManagerSeat(oneCandidate, "DSM seat");
  assert.ok(onePick.seat, "exactly one candidate -> a seat");
  assert.equal(onePick.ambiguous, false, "one candidate is not ambiguous");
  assert.equal(onePick.seat?.seatKey, buildVacantSeatKey(oneCandidate[0]), "seat key is vacancy-derived");
  assert.match(onePick.seat?.seatLabel ?? "", /Cairo .* Vacant DSM seat/, "seat label uses the district");
  const twoPick = selectVacantManagerSeat(
    [...oneCandidate, { vacancyId: 227, vacancyCode: "VAC-ALEX-DSM", areaName: "Alex", lineName: "Pedia" }],
    "DSM seat",
  );
  assert.equal(twoPick.seat, null, "more than one candidate -> no seat (refuse to guess)");
  assert.equal(twoPick.ambiguous, true, "multiple candidates flagged ambiguous");

  // -- FALLBACK: marker lost (pending NULL) but exactly one open DSM vacancy.
  //    Mirrors live data B-164: active rep, manager reassigned to NSM, no marker.
  const seat: ResolvedVacantSeat = onePick.seat!;
  const lost = cairoRepMarkerLost("MR-LOST");
  const lostGrouping = resolveSeatGrouping(lost, {
    vacantSeatTitle: "DSM seat",
    orphanFallback: { isOrphanToNsm: true, vacantSeat: seat },
  });
  assert.equal(lostGrouping.isVacant, true, "orphaned marker-lost rep resolves to a vacant seat");
  assert.equal(lostGrouping.seatHrId, seat.seatKey, "fallback groups under the open DSM vacancy seat");
  assert.equal(lostGrouping.seatKeyIsSynthetic, true, "fallback seat key is synthetic (not an HR_ID)");
  assert.notEqual(lostGrouping.seatHrId, NSM, "marker-lost rep is NOT a direct NSM report");

  // -- FALLBACK negative: no open DSM vacancy -> rep stays under the NSM (no guess).
  const noSeatGrouping = resolveSeatGrouping(cairoRepMarkerLost("MR-LOST"), {
    vacantSeatTitle: "DSM seat",
    orphanFallback: { isOrphanToNsm: true, vacantSeat: null },
  });
  assert.equal(noSeatGrouping.isVacant, false, "no vacancy -> not reassigned");
  assert.equal(noSeatGrouping.seatHrId, NSM, "with no safe match the rep remains under the NSM");

  // -- FALLBACK negative: rep already under an ACTIVE DSM is never pulled to a seat.
  const underActiveDsm: Rep = {
    ...cairoRepMarkerLost("MR-ACTIVE"),
    managerHrId: NEW_DSM,
    managerName: "Active Cairo DSM",
  };
  const activeGrouping = resolveSeatGrouping(underActiveDsm, {
    vacantSeatTitle: "DSM seat",
    orphanFallback: { isOrphanToNsm: false, vacantSeat: seat },
  });
  assert.equal(activeGrouping.isVacant, false, "rep under an active DSM is unaffected");
  assert.equal(activeGrouping.seatHrId, NEW_DSM, "rep stays under the active DSM");

  // -- FALLBACK integration: marker-lost Cairo reps group under the vacant seat,
  //    not the NSM, via buildSalesManagerPerformanceGroups.
  const fallbackMembers = [
    toPerformanceMember(cairoRepMarkerLost("MR-L1"), { nsmHrId: NSM, vacantSeat: seat }),
    toPerformanceMember(cairoRepMarkerLost("MR-L2"), { nsmHrId: NSM, vacantSeat: seat }),
  ];
  const fallbackGroups = buildSalesManagerPerformanceGroups(fallbackMembers);
  assert.equal(fallbackGroups.length, 1, "marker-lost reps collapse into one district group");
  assert.equal(fallbackGroups[0].managerHrId, seat.seatKey, "group keyed by the vacant DSM seat");
  assert.equal(
    fallbackGroups.some((group) => group.managerHrId === NSM),
    false,
    "marker-lost reps are NOT grouped under the NSM",
  );

  // -- 9. Replacement DSM hire clears the pending seat -> grouping moves to the new DSM.
  const afterReplacement: Rep = {
    ...cairoRepHeldByVacantSeat("MR-1"),
    managerHrId: NEW_DSM,
    managerName: "New Cairo DSM",
    pendingManagerReplacementForHrId: null,
  };
  assert.equal(isHeldByVacantSeat(afterReplacement), false, "no longer vacant-seat held");
  const replacedGrouping = resolveSeatGrouping(afterReplacement, { vacantSeatTitle: "DSM seat" });
  assert.equal(replacedGrouping.isVacant, false, "grouping is no longer vacant");
  assert.equal(replacedGrouping.seatHrId, NEW_DSM, "grouping follows the replacement DSM");
  assert.equal(replacedGrouping.seatName, "New Cairo DSM", "label is the active DSM name");

  // -- Department-safe LINE scope (vacation report rule). Pedia line shared by
  //    Sales and Marketing departments.
  const nsmSales = { departmentId: 1, departmentName: "Sales", lineId: 2, lineName: "Pedia" };
  const repSales = { departmentId: 1, departmentName: "Sales", lineId: 2, lineName: "Pedia" };
  const marketingSameLine = {
    departmentId: 2,
    departmentName: "Marketing",
    lineId: 2,
    lineName: "Pedia",
  };
  const productManagerMarketing = {
    departmentId: 2,
    departmentName: "Marketing",
    lineId: 2,
    lineName: "Pedia",
  };

  // -- 5. Vacation NSM (Sales) includes same-line Sales employees.
  assert.equal(
    lineScopeIncludesEmployee(nsmSales, repSales),
    true,
    "Sales NSM sees same-line Sales reps",
  );

  // -- 6. Marketing employees sharing the line are excluded from the Sales NSM view.
  assert.equal(
    lineScopeIncludesEmployee(nsmSales, marketingSameLine),
    false,
    "Sales NSM must NOT see Marketing employees on the same line",
  );

  // -- 7. Product/Marketing manager line scope still works within Marketing, and
  //       excludes Sales employees on the same line.
  assert.equal(
    lineScopeIncludesEmployee(productManagerMarketing, marketingSameLine),
    true,
    "Marketing PM sees same-line Marketing colleagues",
  );
  assert.equal(
    lineScopeIncludesEmployee(productManagerMarketing, repSales),
    false,
    "Marketing PM must NOT see Sales employees on the same line",
  );

  // -- sameWorkforceLine / sameWorkforceDepartment fail-closed semantics.
  assert.equal(sameWorkforceLine(nsmSales, marketingSameLine), true, "same lineId matches");
  assert.equal(
    sameWorkforceDepartment({ departmentId: null, departmentName: null }, { departmentId: null, departmentName: null }),
    true,
    "both-missing departments are treated as matching",
  );
  assert.equal(
    sameWorkforceDepartment({ departmentId: 1, departmentName: "Sales" }, { departmentId: null, departmentName: null }),
    false,
    "department present on one side only fails closed",
  );

  // -- formatVacantSeatLabel falls back gracefully when no district is known.
  assert.equal(
    formatVacantSeatLabel({ areaName: null, teamName: null, lineName: null }, "DSM seat"),
    "Vacant DSM seat",
    "vacant seat label falls back without a district",
  );

  // ===========================================================================
  // WP-1: seat-continuity-aware TEAM / HIERARCHY helpers (vacation scope).
  // ===========================================================================
  const canon = (value: string | null | undefined) => canonicalHrIdKey(value);
  const RM = "RM-1";
  const DSM_OTHER = "DSM-ALX";

  // Active chain: MR -> DSM -> NSM -> RM.
  const nsmNode: SeatContinuitySubject = { managerHrId: RM, pendingManagerReplacementForHrId: null };
  const dsmNode: SeatContinuitySubject = { managerHrId: NSM, pendingManagerReplacementForHrId: null };
  const rmNode: SeatContinuitySubject = { managerHrId: null, pendingManagerReplacementForHrId: null };
  const mrUnderActiveDsm: SeatContinuitySubject = { managerHrId: DSM, pendingManagerReplacementForHrId: null };
  // After the Cairo DSM resigns: MR reassigned UP to the NSM, vacant seat = DSM.
  const mrOrphanedToNsm: SeatContinuitySubject = { managerHrId: NSM, pendingManagerReplacementForHrId: DSM };

  const byCanon = new Map<string, SeatContinuitySubject>([
    [canon(NSM)!, nsmNode],
    [canon(DSM)!, dsmNode],
    [canon(RM)!, rmNode],
  ]);

  // TEAM: DSM sees their report BEFORE resignation (current manager edge).
  assert.equal(
    reportsToManagerSeat({ employee: mrUnderActiveDsm, viewerCanonicalHrId: canon(DSM)!, canonicalize: canon }),
    true,
    "DSM sees own direct report before resignation",
  );
  // TEAM: DSM still owns the report AFTER resignation via the vacant-seat marker.
  assert.equal(
    reportsToManagerSeat({ employee: mrOrphanedToNsm, viewerCanonicalHrId: canon(DSM)!, canonicalize: canon }),
    true,
    "vacant DSM seat still owns the orphaned report after resignation",
  );
  // TEAM: an unrelated DSM never sees the report.
  assert.equal(
    reportsToManagerSeat({ employee: mrOrphanedToNsm, viewerCanonicalHrId: canon(DSM_OTHER)!, canonicalize: canon }),
    false,
    "an unrelated DSM does not see the orphaned report",
  );

  // HIERARCHY: RM sees the report both before and after the DSM resignation.
  assert.equal(
    isWithinManagerHierarchy({ employee: mrUnderActiveDsm, byCanonicalHrId: byCanon, viewerCanonicalHrId: canon(RM)!, canonicalize: canon }),
    true,
    "RM sees report via full chain before resignation",
  );
  assert.equal(
    isWithinManagerHierarchy({ employee: mrOrphanedToNsm, byCanonicalHrId: byCanon, viewerCanonicalHrId: canon(RM)!, canonicalize: canon }),
    true,
    "RM still sees report after DSM resignation (climb via reassigned manager edge)",
  );
  // HIERARCHY: NSM (intermediate) sees the orphaned report.
  assert.equal(
    isWithinManagerHierarchy({ employee: mrOrphanedToNsm, byCanonicalHrId: byCanon, viewerCanonicalHrId: canon(NSM)!, canonicalize: canon }),
    true,
    "NSM sees the report reassigned directly under them",
  );
  // HIERARCHY: the departed DSM owns the report via the vacant-seat marker at level 0.
  assert.equal(
    isWithinManagerHierarchy({ employee: mrOrphanedToNsm, byCanonicalHrId: byCanon, viewerCanonicalHrId: canon(DSM)!, canonicalize: canon }),
    true,
    "vacant DSM seat owner reachable via continuity marker",
  );
  // HIERARCHY: an unrelated RM does NOT climb into this chain (no leak past seats).
  assert.equal(
    isWithinManagerHierarchy({ employee: mrOrphanedToNsm, byCanonicalHrId: byCanon, viewerCanonicalHrId: canon("RM-OTHER")!, canonicalize: canon }),
    false,
    "unrelated manager does not see the report (no cross-branch leak)",
  );
  // HIERARCHY: cycle safety — self-referential manager does not infinite-loop.
  const cyclic: SeatContinuitySubject = { managerHrId: "CYC", pendingManagerReplacementForHrId: null };
  const cyclicMap = new Map<string, SeatContinuitySubject>([[canon("CYC")!, cyclic]]);
  assert.equal(
    isWithinManagerHierarchy({ employee: cyclic, byCanonicalHrId: cyclicMap, viewerCanonicalHrId: canon("NOPE")!, canonicalize: canon }),
    false,
    "cyclic manager chain terminates safely",
  );

  // -- Wiring assertions (the service modules cannot be imported under the test
  //    runner because they pull in env-bound Supabase clients, so we lock the
  //    integration points via source text — mirroring tests/vacation-module).
  const portalServiceSource = readFileSync(
    new URL("../src/lib/employee-portal/service.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    portalServiceSource,
    /resolveSeatGrouping\(emp, \{/,
    "Performance views must group members via the seat-continuity resolver",
  );
  assert.match(
    portalServiceSource,
    /resolveNsmVacantDsmSeat\(directory, lineScope/,
    "Performance views must resolve the single open DSM vacancy fallback",
  );
  assert.match(
    portalServiceSource,
    /orphanFallback:/,
    "Seat grouping must pass the orphaned-to-NSM vacancy fallback",
  );

  const vacationServiceSource = readFileSync(
    new URL("../src/lib/vacation/service.ts", import.meta.url),
    "utf8",
  );
  // -- 8. COMPANY scope (HR / Super Admin) returns all employees before any
  //       line/department filtering, so it is unaffected by the new gate.
  assert.match(
    vacationServiceSource,
    /if \(scope === "COMPANY"\) return employees;/,
    "COMPANY scope must short-circuit before LINE/department filtering",
  );
  assert.match(
    vacationServiceSource,
    /employeeLineMatches\(employee, currentEmployee\) &&\s*sameWorkforceDepartment\(currentEmployee, employee\)/,
    "LINE scope must be department-safe",
  );
  // WP-1: TEAM/HIERARCHY must route through the canonical seat-continuity helpers.
  assert.match(
    vacationServiceSource,
    /reportsToManagerSeat\(\{/,
    "Vacation TEAM scope must use the seat-continuity helper",
  );
  assert.match(
    vacationServiceSource,
    /isWithinManagerHierarchy\(\{/,
    "Vacation HIERARCHY scope must use the seat-continuity helper",
  );
  // WP-1: canSeeVacation secondary gate must restrict the manager-chain fallback
  // to management scopes so LINE/SELF cannot bypass the department-safe set.
  assert.match(
    vacationServiceSource,
    /scope === "TEAM" \|\| scope === "HIERARCHY"/,
    "canSeeVacation must gate the manager fallback to management scopes",
  );

  const directorySource = readFileSync(
    new URL("../src/lib/employees/employee-directory.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    directorySource,
    /loadPendingManagerReplacementByHrId/,
    "directory must expose pending_manager_replacement_for_hr_id defensively",
  );
}
