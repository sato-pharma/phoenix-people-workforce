import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import { canViewPersonMoney, subjectHasIncentiveTab } from "../src/lib/employee-360/access.ts";
import { personIncentiveFigures } from "../src/lib/employee-360/person-incentive.ts";
import type { MedicalRepPortalData } from "../src/lib/employee-portal/service.ts";

// Employee 360's personnel chapter (owner, 2026-11-03, "build 4"). Who may see another person's
// incentive and device values was his multiple-choice answer: "Also their managers".
export function runEmployee360PersonnelRecordsTests() {
  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  const viewer = (role: PhoenixRole, hrId: string | null, scope: AccessContext["scope"] = "self"): AccessContext => ({
    hrId,
    loginId: null,
    role,
    scope,
    source: "session",
  });
  // Rep R-1 reports to District Manager D-1, who reports to Regional Manager M-1. R-2 is on another team.
  const seat = (managerHrId: string | null) => ({ managerHrId, pendingManagerReplacementForHrId: null });
  const tree = {
    byCanonicalHrId: new Map([
      ["r-1", seat("D-1")],
      ["r-2", seat("D-2")],
      ["d-1", seat("M-1")],
      ["d-2", seat("M-2")],
      ["m-1", seat(null)],
      ["m-2", seat(null)],
    ]),
  };
  const rep = { hrId: "R-1", managerHrId: "D-1", pendingManagerReplacementForHrId: null };

  // ── 1. The gate ─────────────────────────────────────────────────────────────────────────────────
  assert.equal(canViewPersonMoney(viewer("Medical Rep", "R-1"), rep, tree), true, "the person themselves");
  assert.equal(canViewPersonMoney(viewer("Medical Rep", "r-1"), rep, tree), true, "their own id in any casing");
  assert.equal(canViewPersonMoney(viewer("District Manager", "D-1", "team"), rep, tree), true, "their direct manager");
  assert.equal(canViewPersonMoney(viewer("Regional Manager", "M-1", "hierarchy"), rep, tree), true, "a manager further up the tree");
  assert.equal(canViewPersonMoney(viewer("CEO", "C-1", "company"), rep, tree), true);
  assert.equal(canViewPersonMoney(viewer("Super Admin", "B-10", "company"), rep, tree), true);

  assert.equal(canViewPersonMoney(viewer("Medical Rep", "R-2"), rep, tree), false, "a colleague");
  assert.equal(canViewPersonMoney(viewer("District Manager", "D-2", "team"), rep, tree), false, "another team's manager");
  assert.equal(canViewPersonMoney(viewer("Regional Manager", "M-2", "hierarchy"), rep, tree), false, "another region's manager");
  assert.equal(canViewPersonMoney(viewer("HR Operations", "H-1", "company"), rep, tree), false, "company scope is not the answer: HR Operations opens every rep's 360");
  assert.equal(canViewPersonMoney(viewer("Finance Manager", "F-1", "company"), rep, tree), false);
  assert.equal(canViewPersonMoney(viewer("Training Manager", "T-1"), rep, tree), false, "opening the report is not being above them");
  assert.equal(canViewPersonMoney(viewer("Medical Rep", null), rep, tree), false, "no identity, no figures");
  assert.equal(canViewPersonMoney({ ...viewer("CEO", "C-1", "company"), source: "guest" }, rep, tree), false);
  assert.equal(canViewPersonMoney(viewer("District Manager", "D-1", "team"), { ...rep, managerHrId: "D-2" }, tree), false, "walks the tree, not the viewer's title");

  assert.equal(subjectHasIncentiveTab("Medical Rep"), true);
  assert.equal(subjectHasIncentiveTab("Marketing Manager"), false);
  assert.equal(subjectHasIncentiveTab("Training Manager"), false);

  // ── 2. What the incentive section may carry ─────────────────────────────────────────────────────
  const data = (sales: Partial<MedicalRepPortalData["sales"]>, empty = false) =>
    ({
      empty: { payroll: false, profile: empty, sales: false },
      payroll: { baseSalary: 9000, basicSalary: 6300, grossSalary: 11000, incentive: 4200, netSalary: 8000 },
      sales: {
        incentiveClosingUnread: false,
        incentiveSemesterLabel: "Semester 2 2026",
        incentiveSemesterTarget: 500,
        incentiveWindowNotice: null,
        overviewAchievementPercent: 97.5,
        pediaSplit: null,
        ...sales,
      },
    }) as unknown as MedicalRepPortalData;

  const ready = personIncentiveFigures(data({}));
  assert.deepEqual(ready, {
    state: "ready",
    semesterLabel: "Semester 2 2026",
    achievementPercent: 97.5,
    incentiveEgp: 4200,
    satoAchievementPercent: null,
    notice: null,
  });
  assert.doesNotMatch(JSON.stringify(ready), /9000|6300|11000|8000|[Ss]alary/, "the person's salaries never reach this report's browser");

  const noTarget = personIncentiveFigures(data({ incentiveSemesterTarget: 0, overviewAchievementPercent: 0 }));
  assert.ok(noTarget.state === "ready" && noTarget.achievementPercent === null && noTarget.incentiveEgp === null, "no target is not 0%");
  assert.deepEqual(personIncentiveFigures(data({ incentiveClosingUnread: true })), { state: "unread" }, "an unread closing is never 'No target yet'");
  assert.deepEqual(personIncentiveFigures(data({}, true)), { state: "none" });
  const split = { satoAchievementPercent: 88, satoTarget: 100 } as unknown as MedicalRepPortalData["sales"]["pediaSplit"];
  const pedia = personIncentiveFigures(data({ pediaSplit: split }));
  assert.ok(pedia.state === "ready" && pedia.satoAchievementPercent === 88);

  // ── 3. The money gate holds on the server ───────────────────────────────────────────────────────
  const records = source("src/lib/employee-360/personnel-records.ts");
  assert.match(records, /agreedValueEgp: money \? device\.agreedValueEgp : null/, "a device value is stripped on the server, not hidden in the page");
  const incentiveLoader = records.slice(records.indexOf("export async function loadEmployee360PersonIncentive"));
  assert.match(incentiveLoader, /!canViewPersonMoney\(access, target, scope\)/, "the loader asks the gate itself");
  assert.match(incentiveLoader, /canAccess\(access, "incentive", "read"\)/, "a module lock still applies");
  assert.match(incentiveLoader, /throw forbiddenError\(/);
  assert.ok(
    incentiveLoader.indexOf("throw forbiddenError(") < incentiveLoader.indexOf("getEmployeePortalIncentiveData("),
    "the refusal comes before the read",
  );
  assert.match(records, /async \(\) => money && \(await canAccess\(access, "incentive", "read"\)\)/, "no incentive section unless the gate passed");
  assert.match(records, /\(await getProbationRows\(access\)\)\.find\(/, "probation stays the viewer's own list");
  // Caught by a live read: normalizeHrId is lower case and the column is not, so an eq found nobody
  // and every report silently had no incentive section at all.
  assert.match(records, /\.select\("login_id,role"\)\s*\.ilike\("hr_id", hrId\.trim\(\)\)/, "the sign-in is found whatever the id's casing");

  // ── 4. Every report page carries the chapter, through one loader ────────────────────────────────
  for (const page of [
    "app/(admin)/employee-360/[hrId]/page.tsx",
    "app/employee-portals/employee-360/[hrId]/page.tsx",
    "app/employee-portals/employee-360/page.tsx",
  ]) {
    const body = source(page);
    assert.match(body, /loadEmployee360PersonnelRecords\(\{ access, target, scope/, `${page}: reads the chapter`);
    assert.match(body, /personnel=\{personnel\}/, `${page}: passes it to the view`);
    assert.match(body, /personnel\.incentiveSignIn \? \(\s*<Employee360IncentiveSection/, `${page}: the section is built only past the gate`);
  }

  // ── 4b. Whose leave: the leave screen's own rule, because every seat holds leave:read for itself ──
  assert.match(records, /canAccess\(access, "leave", "read"\)\) && \(await canViewEmployeeLeaveRecord\(access, target\.hrId\)\)/);
  const vacation = source("src/lib/vacation/service.ts");
  assert.match(vacation, /const visible = await filterVacationEmployeesForAccess\(access, await getEmployeeDirectoryRows\(\{ includeInactive: true \}\)\);/, "the screen's own filter, not a copy");
  assert.match(vacation, /instanceof VacationViewerHasNoEmployeeProfileError\) return false;/, "a viewer with no profile sees nothing");

  // ── 5. A failed read names itself ───────────────────────────────────────────────────────────────
  const view = source("src/components/employee-360/employee-360-view.tsx");
  assert.match(view, /const unreadNames = \[\.\.\.unreadSections, \.\.\.\(personnel\?\.unread \?\? \[\]\)\]/);
  assert.match(records, /unread\.push\(name\)/);
  const section = source("src/components/employee-360/incentive-section.tsx");
  assert.match(section, /Could not be read just now/, "an unread incentive says so");
  assert.match(section, /<Suspense/, "the report does not wait for the incentive");

  // The portal payload says when the closing was not read, so this section never has to guess.
  assert.match(source("src/lib/employee-portal/service.ts"), /incentiveClosingUnread: closingUnavailable,/);
}
