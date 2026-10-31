import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import { createAccessContext, resolveNavigationMode } from "../src/lib/auth/permissions.ts";
import {
  resolveEmployeePortalNavVisibility,
  shouldShowEmployeePortalMarketingQuickAction,
} from "../src/lib/employee-portal/navigation.ts";
import { stripComments } from "./support/comment-strip.ts";

function collectSourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((entry) => {
      const filePath = join(root, entry);
      if (statSync(filePath).isDirectory()) return collectSourceFiles(filePath);
      return /\.(tsx?|jsx?)$/.test(entry) ? [filePath] : [];
    });
}

export function runEmployeePortalNavigationTests() {
  const employeePortalSource = [
    ...collectSourceFiles("app/employee-portals"),
    ...collectSourceFiles("app/(admin)/leave-management"),
    ...collectSourceFiles("src/components/employee-portal"),
    ...collectSourceFiles("src/components/vacation"),
    "app/payslips/page.tsx",
  ]
    .map((filePath) => `${filePath}\n${readFileSync(filePath, "utf8")}`)
    .join("\n");
  const dashboardSource = readFileSync("src/components/employee-portal/employee-portal-dashboard.tsx", "utf8");
  // Request Support left the dashboard for its own file on 2026-10-01, so the form stops downloading
  // the dashboard's charts; the assertions that pinned it inside the dashboard now read it here.
  const supportPageSource = readFileSync("src/components/employee-portal/contact-hr-support-page.tsx", "utf8");
  const layoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const marketingDraftsSource = readFileSync("src/components/employee-portal/marketing-request-drafts.tsx", "utf8");
  const portalPrimitivesSource = readFileSync("src/components/employee-portal/portal-primitives.tsx", "utf8");
  const portalShellSource = readFileSync("src/components/employee-portal/enterprise-shell.tsx", "utf8");
  const adminPageSource = readFileSync("app/(admin)/admin/page.tsx", "utf8");
  const vacanciesPageSource = readFileSync("app/employee-portals/vacancies/page.tsx", "utf8");
  const teamPerformancePageSource = readFileSync("app/employee-portals/team-performance/page.tsx", "utf8");
  const roiPageSource = readFileSync("app/employee-portals/roi/page.tsx", "utf8");
  const launchSmokeSource = readFileSync("scripts/employee-portal-launch-smoke.mjs", "utf8");

  assert.doesNotMatch(
    employeePortalSource,
    /[\u00C3\u00C2\u00E2\uFFFD]/,
    "Employee portal source should not contain mojibake in UI text, comments, or fallback strings.",
  );
  assert.doesNotMatch(dashboardSource, /href="#"/, "Employee portal dashboard must not ship dead hash links.");
  assert.doesNotMatch(supportPageSource, /href="#"/, "Request Support must not ship dead hash links.");
  // Request Support once offered three "desks" whose Email / WhatsApp buttons pointed at placeholder
  // addresses (hr-support@phoenix.local, wa.me/201000000001…) — a rep who tapped one wrote to nobody.
  // Every request now goes through the tracked form; no placeholder contact may come back — in its
  // own file, or back in the dashboard it came from.
  assert.doesNotMatch(
    `${dashboardSource}\n${supportPageSource}`,
    /@phoenix\.local|wa\.me\/20100000000/,
    "Request Support must not offer placeholder HR contacts; requests go through the tracked form.",
  );
  assert.match(supportPageSource, /Loading\.\.\./);
  assert.match(layoutSource, /searchMatches/);
  assert.match(layoutSource, /navigateToSearchResult/);
  assert.match(layoutSource, /Search portal pages\.\.\./);
  assert.match(layoutSource, /timeZone: "Africa\/Cairo"/);
  assert.doesNotMatch(
    layoutSource,
    /marketing-requests\/roi-tracking/,
    "ROI Tracking must no longer be a sidebar tab for any role now that Coverage Report replaces it (the page/permission stay live for direct-URL access).",
  );
  // The standalone "Coverage Report" sidebar link was retired on 2026-09-22 (owner instruction):
  // the ROI Tracker and the Coverage Report merged into ONE two-tab module reached by a single
  // "ROI Tracker" sidebar link. The old /employee-portals/marketing-requests/coverage-report route
  // now redirects to /employee-portals/roi-tracker?tab=coverage, so it must no longer ship as its
  // own sidebar href — coverage is reached through the merged link's Coverage tab instead.
  assert.doesNotMatch(
    layoutSource,
    /href: "\/employee-portals\/marketing-requests\/coverage-report"/,
    "The standalone Coverage Report sidebar link must be gone — it is now the Coverage tab of the merged ROI Tracker module",
  );
  // The one merged link is offered on EITHER flag so the broader Coverage audience (Finance Manager /
  // Financial Advisor, admitted by showMarketingCoverageReportTab) still reaches the module even
  // though they hold no ROI-tab access.
  assert.match(
    layoutSource,
    /showMarketingRoiTrackingTab \|\| showMarketingCoverageReportTab\s*\?\s*\[\{ href: "\/employee-portals\/roi-tracker", label: "ROI Tracker"/,
    "The merged ROI Tracker sidebar link must be present and gated on either the ROI or the Coverage flag",
  );
  assert.doesNotMatch(marketingDraftsSource, /\u00E2\u20AC\u00A6/, "Marketing request drafts should not render mojibake ellipsis text.");
  assert.match(marketingDraftsSource, /Math\.max\(0, maxLen - 3\)\)\}\.\.\./);
  assert.match(adminPageSource, /canReadAdmin/);
  assert.match(adminPageSource, /canReadOverview/);
  assert.match(adminPageSource, /canAccess\(access, "employee_profile", "read"\)/);
  assert.match(adminPageSource, /Access unavailable/);
  assert.match(vacanciesPageSource, /canAccess\(access, "vacancies", "read"\)/);
  assert.doesNotMatch(vacanciesPageSource, /assertPermission\(access, "vacancies", "read"\)/);

  // ── Regional Manager vacancies: region-scoped, and it must FAIL CLOSED ──────────────────
  // Four gates had to agree for RM Vacancies to work, and they were maintained separately:
  // the `vacancies` grant, the showVacanciesTab flag, the command-palette roles list, and this
  // reader. Granting the first three while getEmployeePortalVacancies still returned null for RM
  // produced a visible tab that dead-ended on "Vacancies Unavailable" — verified live before the
  // reader branch was added. These assertions pin the reader half.
  const portalServiceSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(
    portalServiceSource,
    /const isRegionScoped =[^;]*currentRole === "Regional Manager"/,
    "getEmployeePortalVacancies must classify Regional Manager as region-scoped",
  );
  assert.match(
    portalServiceSource,
    /if \(!isDsm && !isLineScoped && !isCompanyScoped && !isRegionScoped\) return null;/,
    "the early return must admit the region-scoped Regional Manager, or the tab dead-ends",
  );
  // The RM must never be folded into the LINE branch: that would show them every open seat on
  // their line, including regions they do not manage (18 vs 6 on the live Pedia line).
  assert.match(
    portalServiceSource,
    /isRegionScoped[\s\S]{0,400}regionalManagerRegionKeys\.size === 0\) return false;/,
    "an unresolvable RM region set must return no rows, never fall through to the whole line",
  );
  assert.match(teamPerformancePageSource, /canAccess\(access, "sales", "read"\)/);
  assert.doesNotMatch(teamPerformancePageSource, /assertPermission\(access, "sales", "read"\)/);
  assert.match(
    roiPageSource,
    /ROI_PORTAL_ROLES = new Set\(\[[^\]]*"National Sales Manager"[^\]]*\]\)/,
    "ROI Intelligence page-level role gate must include National Sales Manager to match the sidebar tab",
  );
  assert.match(launchSmokeSource, /employeePortalStaticRoutes/);
  assert.match(launchSmokeSource, /employeePortalReachableRoutes/);
  assert.match(launchSmokeSource, /\/payslips/);
  assert.match(launchSmokeSource, /\/leave-management\/vacation-request/);
  assert.match(launchSmokeSource, /\/leave-management\/vacation-report/);
  assert.match(launchSmokeSource, /PHOENIX_EMPLOYEE_PORTAL_SMOKE_USERS_JSON/);
  assert.match(launchSmokeSource, /\/api\/auth\/login/);
  assert.match(launchSmokeSource, /runDirectRouteSweep/);
  assert.match(launchSmokeSource, /portal error/);
  assert.match(portalPrimitivesSource, /export function PortalResponsiveDataList/);
  assert.match(portalPrimitivesSource, /export function PortalRecordCard/);
  assert.match(portalPrimitivesSource, /export function PortalDesktopTable/);
  assert.match(portalPrimitivesSource, /data-portal-desktop-table/);
  assert.match(portalShellSource, /employee-portal-mobile-safe/);
  // `clip`, not `hidden` — hidden makes body a scroll container and kills every sticky in
  // the portal shell. This assertion pinned the defect; it now pins the fix.
  assert.match(portalShellSource, /overflow-x: clip/);
  assert.doesNotMatch(
    portalShellSource,
    /html, body \{ overflow-x: hidden; \}/,
    "The portal shell must not reinstate `overflow-x: hidden` on html/body — it makes body a scroll container and every sticky nav scrolls away.",
  );
  assert.doesNotMatch(
    employeePortalSource,
    /hidden xs:block|block xs:hidden|xs:hidden/,
    "Portal-owned pages must keep card/mobile layouts through md instead of exposing tables at xs.",
  );
  assert.doesNotMatch(
    employeePortalSource,
    /min-w-\[(?:1[12-9]\d{2}|[2-9]\d{3})px\]/,
    "Portal-owned pages must not ship 1200px+ Tailwind min-width tables as the mobile data strategy.",
  );

  const medicalRep = resolveEmployeePortalNavVisibility("Medical Rep");
  assert.equal(medicalRep.showDashboardTab, true, "Medical Rep should see Dashboard");
  assert.equal(medicalRep.showMyPerformanceTab, true, "Medical Rep should see My Performance");
  assert.equal(medicalRep.showExpenseActionTab, false, "Medical Rep should not see the manual outstation expense action");
  assert.equal(medicalRep.showExpenseDashboardTab, false, "Medical Rep should not see the Expense Dashboard (they have their own expenses tab)");
  assert.equal(medicalRep.showMedicalRepExpensesTab, true, "Medical Rep should see their own expenses tab");
  assert.equal(medicalRep.showMyCoachingTab, false, "Medical Rep should not see My Coaching Reports on the sidebar (hidden by owner instruction 2026-09-24)");
  assert.equal(medicalRep.showTeamCoachingTab, false, "Medical Rep should not see Team Coaching Reports");
  // The Team Coaching Skills Survey replaced the old form (owner, 2026-10-31): never shown to the person rated.
  assert.equal(medicalRep.showCoachingSkillsSurveyTab, false, "Medical Rep must never see the Coaching Skills Survey");

  // The APP ACCESS role is authoritative and now takes precedence over the job title in
  // resolvePortalRole (fix 2026-08-15; see tests/portal-nav-acting-dm-uses-app-role.test.ts for the
  // acting-DM case that motivated it). An account carrying the "Medical Rep" title but an elevated
  // National Sales Manager ACCESS role therefore gets the NSM nav its access actually grants — not
  // the rep sidebar. This block previously asserted the opposite (title-wins) precedence, which is
  // exactly the behavior the fix reverses.
  const medicalRepTitleWithNsmAccess = resolveEmployeePortalNavVisibility("Medical Rep", "National Sales Manager");
  assert.equal(
    medicalRepTitleWithNsmAccess.showMedicalRepExpensesTab,
    false,
    "An elevated NSM access role must NOT keep the Medical-Rep-only expenses tab — the nav follows the authoritative access role, not the job title",
  );
  assert.equal(
    medicalRepTitleWithNsmAccess.showExpenseActionTab,
    true,
    "The NSM access role drives the nav, so the manager expense action appears even though the job title says Medical Rep",
  );
  assert.equal(
    medicalRepTitleWithNsmAccess.showMedRepsPerformanceTab,
    true,
    "The NSM access role surfaces the NSM MRs-Performance tab — nav matches the permissions the access role grants",
  );

  const plainEmployee = resolveEmployeePortalNavVisibility("Employee");
  assert.equal(plainEmployee.showExpenseActionTab, true, "Any non-Medical-Rep employee should see Submit Expense");
  assert.equal(plainEmployee.showExpenseDashboardTab, true, "Any non-Medical-Rep employee should see Expense Dashboard");
  assert.equal(plainEmployee.showVacationApprovalsTab, false, "Plain Employee should not see Vacation Approvals");
  assert.equal(plainEmployee.showExcuseApprovalsTab, false, "Plain Employee should not see Excuse Approvals");
  assert.equal(plainEmployee.showPlanApprovalsTab, false, "Plain Employee should not see Plan Approvals");

  // Other Approvals: the Employee permission matrix grants no `approve` action on any
  // resource, so the hub is permanently empty for a real Employee-access-role user.
  for (const officeTitle of ["Office Coordinator", "Admin Assistant", "Buffet", null]) {
    const officeEmployee = resolveEmployeePortalNavVisibility(officeTitle, "Employee");
    assert.equal(
      officeEmployee.showActionsTab,
      false,
      `Plain Employee (${officeTitle ?? "no title"}) should not see Other Approvals — no approve permission on any resource`,
    );
  }
  // The exclusion keys on the ACCESS role, not the job-title-derived one. These two both
  // resolve to portal role "Employee" via the job-title fallback but hold a real approver
  // access role, so they must KEEP the hub — gating on the resolved role alone broke them.
  assert.equal(
    resolveEmployeePortalNavVisibility("Qppv", "Manager").showActionsTab,
    true,
    "An unclassifiable job title with a Manager access role must keep Other Approvals",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("District Sales Manager", "Employee").showActionsTab,
    true,
    "A District-Manager job title must keep Other Approvals even where the access role lags behind",
  );
  // The Head-Office people-manager rung keeps the hub — guards the exclusion from being
  // widened into the approver roles.
  const headOfficeManager = resolveEmployeePortalNavVisibility("R And D Manager", "Manager");
  assert.equal(headOfficeManager.showActionsTab, true, "Head-Office Manager should still see Other Approvals");
  assert.equal(headOfficeManager.showVacationApprovalsTab, true, "Head-Office Manager should still see Vacation Approvals");

  const districtManager = resolveEmployeePortalNavVisibility("District Manager");
  assert.equal(districtManager.showMyCoachingTab, false, "DSM should not see My Coaching Reports");
  assert.equal(districtManager.showTeamCoachingTab, true, "DSM should see Team Coaching Reports");
  assert.equal(districtManager.showCoachingSkillsSurveyTab, true, "DSM rates their team in the Coaching Skills Survey");
  // Added 2026-08-22 with isLineScopedOrganogramRole's District Manager branch. The DSM held
  // organogram: ["read"] with no link and no scope gate, so the audience picker inside OrgChartTree
  // was unreachable for him. The second assertion is the point of the exact-match spelling: the
  // legacy Head-Office "Manager" rung holds NO organogram grant, so a link there would bounce off
  // assertPermission — isDistrictManager would have handed it one.
  assert.equal(districtManager.showOrganogramTab, true, "DSM should see the Organogram (line-scoped, same grain as RM)");
  // Updated 2026-09-02: the rung DOES now hold organogram:read, granted for ONE account on it
  // (A-3, Samaa Mosaad — owner instruction). The assertion is unchanged because the reason moved
  // rather than disappeared: the enforcing gates are pinned to the HR_ID, so a Manager identified
  // by role alone still reaches nothing and must still be offered nothing. The A-3 half is pinned
  // in tests/a3-account-sees-the-full-organogram.test.ts.
  assert.equal(
    resolveEmployeePortalNavVisibility("Manager").showOrganogramTab,
    false,
    "The Head-Office 'Manager' rung is not company-scoped for the organogram and must not get the " +
      "tab from its ROLE — only the pinned A-3 account does, via viewerHrId",
  );

  // Regional Manager sits above the DSMs but previously saw NONE of the oversight tabs its own
  // read-permissions already imply — the data layers were RM-ready and only the sidebar flags were
  // missing (probation walks the RM subtree, coaching is RM=hierarchy, organogram is line-scoped).
  const regionalManager = resolveEmployeePortalNavVisibility("Regional Manager");
  assert.equal(regionalManager.showTeamCoachingTab, true, "RM should see Team Coaching Reports (coaching read is RM=hierarchy)");
  assert.equal(regionalManager.showCoachingSkillsSurveyTab, true, "RM reads their region in the Coaching Skills Survey");
  assert.equal(regionalManager.showProbationTab, true, "RM should see the Probation Tracker (canReadProbationEmployee has an RM subtree branch)");
  assert.equal(regionalManager.showOrganogramTab, true, "RM should see the Organogram (line-scoped, same grain as NSM)");
  assert.equal(regionalManager.showMyCoachingTab, false, "RM should not see My Coaching Reports (that is the Medical Rep view)");
  // Owner-approved 2026-07-30. Both blockers named in the previous version of this assertion are
  // gone: getEmployeePortalVacancies DOES have an RM branch (it bounds open seats to the RM's own
  // line AND regionsWithinManagerHierarchy), and `vacancies: ["read","export"]` is now declared on
  // the Regional Manager row of defaultPermissionMatrix. Before this, the RM branch was dead code —
  // the page's canAccess gate refused every RM, so nobody could ever reach it.
  assert.equal(
    regionalManager.showVacanciesTab,
    true,
    "RM should see Vacancies (region-scoped RM branch in getEmployeePortalVacancies + the vacancies grant)",
  );
  // "My Candidates" shipped with a page, a hiring_interviews grant and a notification deep-link, but
  // never a nav link on any surface — reachable only via the command palette until 2026-07-30.
  assert.equal(
    regionalManager.showMyCandidatesTab,
    true,
    "RM holds hiring_interviews:read, so My Candidates must be linked",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("District Manager").showMyCandidatesTab,
    true,
    "DSM is the primary hiring-manager role for Medical Rep candidates",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("Medical Rep").showMyCandidatesTab,
    false,
    "Medical Rep holds no hiring_interviews grant, so My Candidates must stay hidden",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("Manager").showMyCandidatesTab,
    false,
    "Manager is in the command-palette list but has no hiring_interviews grant — a link would dead-end",
  );
  assert.equal(
    regionalManager.showTeamPerformanceTab,
    false,
    "RM must NOT gain Team Performance — it is the single-district view; his several districts are MRs Performance, and the page sends him there",
  );

  // ── The Regional Manager's roll-up pages (owner, 2026-10-20) ────────────────────
  // His landing page listed his districts and his top reps, but he had no MRs Performance or DSMs
  // Performance page, and Team Performance told him it was "only available for District Sales
  // Managers". Both tabs are his now, and the tab, the page gate and the data gate must agree — a
  // tab whose page bounces him is the "visible row he cannot open" bug.
  {
    assert.equal(regionalManager.showMedRepsPerformanceTab, true, "RM must see MRs Performance — his own region's reps");
    assert.equal(regionalManager.showDsmsPerformanceTab, true, "RM must see DSMs Performance — his own region's district managers");
    const dsmNav = resolveEmployeePortalNavVisibility("District Manager");
    assert.equal(dsmNav.showMedRepsPerformanceTab, false, "a District Manager keeps Team Performance, not the roll-up pages");
    assert.equal(dsmNav.showDsmsPerformanceTab, false, "a District Manager is not offered DSMs Performance");

    for (const page of ["app/employee-portals/med-reps-performance/page.tsx", "app/employee-portals/dsms-performance/page.tsx"]) {
      const source = stripComments(readFileSync(page, "utf8"));
      assert.match(
        source,
        /const PERFORMANCE_ROLLUP_ROLES = new Set\(\["National Sales Manager", "Regional Manager"\]\)/,
        `${page} must admit exactly the two roles its tab is offered to`,
      );
      assert.match(source, /if \(!PERFORMANCE_ROLLUP_ROLES\.has\(access\.role\)\)/, `${page} must gate on that set`);
      assert.doesNotMatch(source, /isNationalSalesManager\(access\.role\)/, `${page} must not keep the NSM-only gate`);
    }

    const serviceSource = stripComments(readFileSync("src/lib/employee-portal/service.ts", "utf8"));
    const bodyOf = (name: string) => {
      const start = serviceSource.indexOf(`export async function ${name}(`);
      assert.ok(start > -1, `${name} must exist`);
      return serviceSource.slice(start, serviceSource.indexOf("\n}\n", start));
    };
    assert.match(bodyOf("getMedRepsPerformance"), /currentRole !== "Regional Manager"/, "MRs Performance's data must admit the RM");
    assert.match(bodyOf("getNsmDsmPerformance"), /currentRole !== "Regional Manager"/, "DSMs Performance's data must admit the RM");
    // getDsmTeamPerformance also fills the expense forms' medical-trip rep list; the RM's pages
    // must not reach him through it, or his expense form changes as a side effect.
    assert.doesNotMatch(
      bodyOf("getDsmTeamPerformance"),
      /Regional Manager/,
      "the expense forms' team read stays District Manager / National Sales Manager only",
    );
    assert.match(
      stripComments(readFileSync("app/employee-portals/med-reps-performance/page.tsx", "utf8")),
      /await getMedRepsPerformance\(access,/,
      "MRs Performance reads through the roll-up function that admits the RM",
    );

    const teamPerformanceSource = stripComments(readFileSync("app/employee-portals/team-performance/page.tsx", "utf8"));
    assert.match(
      teamPerformanceSource,
      /if \(access\.role === "Regional Manager"\) \{\s*redirect\("\/employee-portals\/med-reps-performance"\);/,
      "Team Performance must send an RM to his roll-up page rather than tell him it is for DSMs only",
    );
  }

  // Owner decision 2026-07-30: DSM and RM are out of the Excuse module entirely — no submit tab
  // and no approvals tab. Excuse is a Head-Office / fingerprint-attendance module and is
  // direct-manager-only, so nobody in the field ladder ever routes one to them. Enforced
  // server-side by EXCUSE_EXCLUDED_ROLES in src/lib/excuses/service.ts; these flags hide the links.
  // Independent of the RM oversight tabs asserted above — both must hold at once.
  for (const excludedRole of ["District Manager", "Regional Manager"]) {
    const fieldNav = resolveEmployeePortalNavVisibility(excludedRole, excludedRole, "Pedia", "Sales");
    assert.equal(fieldNav.showExcuseApprovalsTab, false, `${excludedRole} should not see Excuse Approvals`);
    assert.equal(fieldNav.showExcusesTab, false, `${excludedRole} should not see the Excuses submit tab`);
    // Vacation Approvals is a separate ladder and is deliberately untouched by this change.
    assert.equal(fieldNav.showVacationApprovalsTab, true, `${excludedRole} should keep Vacation Approvals`);
    // The isHeadOffice branch of showExcusesTab is line/department-based, so it must not re-open
    // the submit tab for one of these roles sitting on the Office line.
    const officeNav = resolveEmployeePortalNavVisibility(excludedRole, excludedRole, "Office", "Head Office");
    assert.equal(officeNav.showExcusesTab, false, `an Office-line ${excludedRole} should still not see Excuses`);
    assert.equal(officeNav.showExcuseApprovalsTab, false, `an Office-line ${excludedRole} should still not see Excuse Approvals`);
  }
  // The Head-Office "Manager" rung and the marketing roles are a different ladder and keep excuse
  // approvals — HO staff genuinely report to them.
  for (const keepsExcuse of ["Manager", "Product Manager", "Group Product Manager", "Marketing Manager"]) {
    const nav = resolveEmployeePortalNavVisibility(keepsExcuse, keepsExcuse, "Office", "Head Office");
    assert.equal(nav.showExcuseApprovalsTab, true, `${keepsExcuse} should keep Excuse Approvals`);
  }

  // Two portal pages existed, were scope-guarded, and were catalogued for Modules Control — but had
  // NO sidebar link, because the rendered sidebar (buildEmployeePortalSections) is a separate
  // hand-maintained list from the system-navigation.ts catalog. Reachable only by URL or Cmd+K.
  //
  // Territory Management (/employee-portals/territory-management): had no flag at all. The role set
  // must equal PORTAL_TERRITORY_MANAGEMENT_ROLES in src/lib/territory-management/service.ts, which is
  // the enforcing gate — a role listed here but not there gets a link that redirects it straight back.
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager"]) {
    assert.equal(
      resolveEmployeePortalNavVisibility(role).showTerritoryManagementTab,
      true,
      `${role} should see Territory Management (page admits it via PORTAL_TERRITORY_MANAGEMENT_ROLES)`,
    );
  }
  for (const role of ["Medical Rep", "Manager", "Employee", "Product Manager", "the retired HR seat"]) {
    assert.equal(
      resolveEmployeePortalNavVisibility(role).showTerritoryManagementTab,
      false,
      `${role} must NOT see Territory Management — the page redirects it, so the link would dead-end`,
    );
  }
  // "Manager" is the specific regression risk: isDistrictManager matches it, so using that helper
  // instead of an exact "District Manager" check would hand the HO rung a bouncing link.
  assert.equal(
    resolveEmployeePortalNavVisibility("Manager").showTerritoryManagementTab,
    false,
    "the Head-Office Manager rung must not see Territory Management (owns no field areas)",
  );

  // ROI Tracker (/employee-portals/roi-tracker): showMarketingRoiTrackingTab was already computed
  // here but was never consumed by the layout, so the flag was dead code. Mirrors
  // canUseEmployeePortalMarketingRoiTracking, which is the page guard's own role set.
  for (const role of [
    "Medical Rep",
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "SFE Manager",
    "CEO",
    "Super Admin",
  ]) {
    assert.equal(
      resolveEmployeePortalNavVisibility(role).showMarketingRoiTrackingTab,
      true,
      `${role} should see the ROI Tracker link (assertEmployeePortalMarketingPageAccess admits it)`,
    );
  }
  for (const role of ["Employee", "Training Manager", "the retired HR seat"]) {
    assert.equal(
      resolveEmployeePortalNavVisibility(role).showMarketingRoiTrackingTab,
      false,
      `${role} must NOT see the ROI Tracker link`,
    );
  }

  // Scoped CRM Master (/employee-portals/crm) — new surface. Role set must equal PORTAL_CRM_ROLES in
  // src/lib/crm/portal-crm-scope.ts (Medical Rep / DSM / RM / NSM, and since 2026-10-20 the Product
  // and Group Product Manager on their own line), the page's own gate.
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"]) {
    assert.equal(
      resolveEmployeePortalNavVisibility(role).showCrmMasterTab,
      true,
      `${role} should see the scoped CRM Master link`,
    );
  }
  for (const role of ["Manager", "Employee", "Marketing Manager", "the retired HR seat"]) {
    assert.equal(
      resolveEmployeePortalNavVisibility(role).showCrmMasterTab,
      false,
      `${role} must NOT see the scoped CRM Master link`,
    );
  }
  // "Manager" again: isDistrictManager matches it, so an exact "District Manager" check is required or
  // the Head-Office rung (no field reps → empty grid) gets a dead tab.
  assert.equal(
    resolveEmployeePortalNavVisibility("Manager").showCrmMasterTab,
    false,
    "the Head-Office Manager rung must not see the scoped CRM Master",
  );

  const a3Account = resolveEmployeePortalNavVisibility("Medical Rep", undefined, undefined, undefined, "A-3");
  assert.equal(a3Account.showMyPerformanceTab, false, "A-3 should not see My Performance in employee portal");
  assert.equal(a3Account.showIncentiveTab, false, "A-3 should not see Incentive in employee portal");
  // The 2026-06-10 `isA3Account ||` override that put the plan BUILDER in front of her was removed
  // on 2026-09-29 at the owner's instruction, with the other rows the Head-Office "Manager" rung
  // could not use: her real app role is Manager, which is absent from
  // WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES and holds no `weekly_plans:create`, so submitting was
  // Forbidden for the whole life of that override. She keeps the READ-ONLY Planning Calendar below,
  // which is the half that ever worked.
  assert.equal(a3Account.showPlansTab, false, "A-3 must not be offered the plan builder — submitting one was always Forbidden for her");
  assert.equal(a3Account.showPlanningCalendarTab, true, "A-3 should always see the Planning Calendar tab (split from showPlansTab, 2026-07-25)");
  assert.equal(a3Account.showReportItTab, true, "A-3 should see Report It");
  assert.equal(a3Account.showReportItDashboardTab, false, "A-3 Reports Dashboard is merged into the single Report It tab (no separate dashboard tab needed)");

  // The showPlansTab / showPlanningCalendarTab split was made on 2026-07-25 for the Talent
  // Acquisition seat specifically: she read the Planning Calendar but submitted no plan of her
  // own. That seat was retired on 2026-08-28 and both successors are ADMIN-shell roles, so this
  // function is never called for either of them and no portal role exercises the split any more.
  // The split itself is kept — A-3 above still depends on it — but the role-specific assertions
  // are gone rather than renamed, because renaming them would assert portal behaviour for a role
  // that can never reach the portal, which passes for the wrong reason and reads as coverage.
  for (const retired of ["HR Advisory", "HR Operations"] as const) {
    assert.notEqual(
      resolveNavigationMode(createAccessContext({ hrId: "HR-1", role: retired })),
      "employee-portal",
      `${retired} is an admin-shell role — if this ever flips, the portal nav flags below need a` +
        " deliberate answer for it, and resolveEmployeePortalNavVisibility works from role NAMES" +
        " rather than the permission matrix, so it will not answer on its own",
    );
  }

  // 2026-08-01 owner decision: Private Calendar is shown to EVERY portal role, not just the seat
  // it was first built for. It is self-scoped (each employee sees only their own recognized activity),
  // the page has no role gate, and every role holds the employee_profile:read + attendance:read
  // that getPrivateCalendarWorkspace asserts. Prove the widening for a field role and a manager
  // rung so a revert to the old single-role gate fails here.
  assert.equal(
    resolveEmployeePortalNavVisibility("Medical Rep").showPrivateCalendarTab,
    true,
    "Medical Rep should see Private Calendar (2026-08-01 all-roles decision)",
  );
  assert.equal(
    resolveEmployeePortalNavVisibility("District Manager").showPrivateCalendarTab,
    true,
    "District Manager should see Private Calendar (2026-08-01 all-roles decision)",
  );

  const nationalSalesManager = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nationalSalesManager.showMyCoachingTab, false, "NSM should not see My Coaching Reports");
  assert.equal(nationalSalesManager.showTeamCoachingTab, true, "NSM should see Team Coaching Reports");
  assert.equal(
    nationalSalesManager.showRoiIntelligenceTab,
    true,
    "NSM should see the ROI/Sales Marketing Intelligence dashboard (scoped to their own line server-side)",
  );
  assert.equal(
    nationalSalesManager.showCoachingAnalyticsTab,
    false,
    "NSM gaining ROI Intelligence must not also grant Coaching Analytics (that stays PM/GPM/MM only)",
  );
  assert.equal(
    nationalSalesManager.showDoubleVisitAnalyticsTab,
    false,
    "NSM gaining ROI Intelligence must not also grant Double-Visit Analytics (that stays PM/GPM/MM only)",
  );

  const nsmAlias = resolveEmployeePortalNavVisibility("NSM");
  assert.equal(nsmAlias.showTeamCoachingTab, true, "NSM alias should see Team Coaching Reports");

  const trainingManager = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManager.showDashboardTab, false, "Training Manager should not see Dashboard");
  assert.equal(trainingManager.showMyPerformanceTab, false, "Training Manager should not see My Performance");
  assert.equal(trainingManager.showIncentiveTab, false, "Training Manager should not see Incentive");
  assert.equal(trainingManager.showTrainingManagerDashboardTab, true, "Training Manager should see Coaching Dashboard");
  assert.equal(trainingManager.showCoachingSkillsSurveyTab, true, "Training Manager should see the Coaching Skills Survey, which replaced Create Coaching Report");
  assert.equal(trainingManager.showTrainingManagerFieldCoachingTab, true, "Training Manager should see Field Coaching");
  assert.equal(
    trainingManager.showTrainingManagerWeeklyPlanTab,
    true,
    "Training Manager should see her Phoenix CRM Weekly Plan — she holds no territory, so the Phoenix CRM row never shows",
  );
  assert.equal(resolveEmployeePortalNavVisibility("Medical Rep").showTrainingManagerWeeklyPlanTab, false, "Only the Training Manager gets her Weekly Plan tab");
  assert.equal(trainingManager.showMyCoachingTab, false, "Training Manager should not see My Coaching Reports");
  assert.equal(trainingManager.showTeamCoachingTab, false, "Training Manager should not see Team Coaching Reports");
  assert.equal(
    resolveLandingPathForRole("Training Manager"),
    "/employee-portals/training-manager",
    "Training Manager should land on the dedicated coaching dashboard",
  );
  assert.equal(
    resolveLandingPathForRole("SFE Manager"),
    "/admin/sfe-command-center",
    "SFE Manager should land in the dedicated SFE Manager overview",
  );

  const marketingManager = resolveEmployeePortalNavVisibility("Marketing Manager");
  assert.equal(marketingManager.showIncentiveTab, false, "Marketing Manager should NOT see Incentive (hidden from MM per portal policy)");

  // --- Marketing Requests and Contact HR Support both graduated to full modules ------
  const previousBetaFlag = process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  // Default launch posture (flag unset): Marketing Requests is a full module and stays
  // visible for authorized roles; Contact HR Support is now a full module visible to
  // every employee-portal user (everyone must be able to reach their HR team).
  delete process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;

  const nsmDefault = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmDefault.showMarketingRequestsTab, true, "NSM should see Marketing Requests in nav (full module, flag-independent)");
  assert.equal(nsmDefault.showSupportTab, true, "NSM should see Contact HR Support in nav (full module, flag-independent)");
  assert.equal(nsmDefault.showDoubleVisitReportTab, true, "NSM should see the Double Visit Report tab in the portal sidebar (in DV_FOCUS_ROLES)");

  // Product Manager and Group Product Manager are authorized for Marketing and must
  // see the module in nav without the launch flag (regression coverage).
  const productManagerDefault = resolveEmployeePortalNavVisibility("Product Manager");
  assert.equal(productManagerDefault.showMyPerformanceTab, true, "Product Manager now sees Sales Dashboard (showMyPerformanceTab)");
  assert.equal(productManagerDefault.showExpenseActionTab, true, "Product Manager should see Submit Expense in nav");
  assert.equal(productManagerDefault.showMarketingRequestsTab, true, "Product Manager should see Marketing Requests in nav (full module)");
  assert.equal(productManagerDefault.showMarketingInboxTab, true, "Product Manager should see the Marketing Approval Inbox in nav");
  assert.equal(productManagerDefault.showMarketingRoiTrackingTab, true, "Product Manager should stay authorized for ROI Tracking (permission-only; the tab itself is retired from the sidebar)");
  assert.equal(productManagerDefault.showVacanciesTab, true, "Product Manager should see the line-scoped Vacancies tab in nav");
  assert.equal(productManagerDefault.showProbationTab, true, "Product Manager should see the line-scoped Probation tab in nav");
  assert.equal(productManagerDefault.showOrganogramTab, true, "Product Manager should see the line-scoped Organogram tab in nav");

  const groupProductManagerDefault = resolveEmployeePortalNavVisibility("Group Product Manager");
  assert.equal(groupProductManagerDefault.showMyPerformanceTab, true, "Group Product Manager now sees Sales Dashboard (showMyPerformanceTab)");
  assert.equal(groupProductManagerDefault.showExpenseActionTab, true, "Group Product Manager should see Submit Expense in nav");
  assert.equal(groupProductManagerDefault.showMarketingRequestsTab, true, "Group Product Manager should see Marketing Requests in nav (full module)");
  assert.equal(groupProductManagerDefault.showMarketingInboxTab, true, "Group Product Manager should see the Marketing Approval Inbox in nav");
  assert.equal(groupProductManagerDefault.showMarketingRoiTrackingTab, true, "Group Product Manager should stay authorized for ROI Tracking (permission-only; the tab itself is retired from the sidebar)");
  assert.equal(groupProductManagerDefault.showVacanciesTab, true, "Group Product Manager should see the line-scoped Vacancies tab in nav");
  assert.equal(groupProductManagerDefault.showProbationTab, true, "Group Product Manager should see the line-scoped Probation tab in nav");
  assert.equal(groupProductManagerDefault.showOrganogramTab, true, "Group Product Manager should see the line-scoped Organogram tab in nav");

  // Monthly Closing -- portal render of /sales/monthly-closing, gated by PORTAL_CLOSING_ROLES
  // (monthly-closing-portal.ts). Every line-owning field-sales management role sees it, plus the
  // Marketing Manager (owner, 2026-08-12 -- her three oversight lines) and the Medical Rep (owner,
  // 2026-09-16 -- their own area only; the bound is server-side, see
  // tests/medical-rep-monthly-closing.test.ts). The layout/registry/catalog all gate the tab on
  // showMonthlyClosingTab, so this flag is the single sidebar switch for the module.
  assert.equal(districtManager.showMonthlyClosingTab, true, "District Manager should see Monthly Closing");
  assert.equal(regionalManager.showMonthlyClosingTab, true, "Regional Manager should see Monthly Closing");
  assert.equal(nationalSalesManager.showMonthlyClosingTab, true, "National Sales Manager should see Monthly Closing");
  assert.equal(productManagerDefault.showMonthlyClosingTab, true, "Product Manager should see Monthly Closing");
  assert.equal(groupProductManagerDefault.showMonthlyClosingTab, true, "Group Product Manager should see Monthly Closing");
  assert.equal(
    resolveEmployeePortalNavVisibility("Marketing Manager").showMonthlyClosingTab,
    true,
    "Marketing Manager should see Monthly Closing -- her tab is the portal answer to the admin " +
      "/sales/monthly-closing URL, which redirects her as a portal-navigation role",
  );
  assert.equal(medicalRep.showMonthlyClosingTab, true, "Medical Rep should see Monthly Closing (owner, 2026-09-16) -- scoped server-side to their own area");
  assert.equal(plainEmployee.showMonthlyClosingTab, false, "A plain Employee has no closing to see");
  assert.equal(trainingManager.showMonthlyClosingTab, false, "Training Manager is not a closing role");
  // The legacy "Manager" alias USED to resolve to the same access as District Manager here. Both
  // halves — this flag and PORTAL_CLOSING_ROLES in monthly-closing-portal.ts — dropped it on
  // 2026-09-29 at the owner's instruction: the rung is not a district seat (the two live accounts
  // are Head Office, QPPV and R&D Manager), and Head Office is stripped from every closing viewer,
  // so the page could only ever answer "we couldn't resolve a product line". They move together, or
  // one of them is a grant nobody can reach — see tests/marketing-manager-monthly-closing.test.ts.
  assert.equal(
    resolveEmployeePortalNavVisibility("Manager").showMonthlyClosingTab,
    false,
    "The Head-Office 'Manager' rung must not be offered Monthly Closing — the page has no line to show it",
  );
  // The sidebar item and its published-gated href must be wired behind the flag.
  assert.match(
    layoutSource,
    /showMonthlyClosingTab \? \[\{ href: "\/employee-portals\/monthly-closing"/,
    "Monthly Closing sidebar item must be gated behind showMonthlyClosingTab",
  );

  // Direct Orders -- ONE portal tab, shown to the module's own requester-role set.
  //
  // `showDirectOrdersApprovalsTab` and `showDirectOrdersReportTab` were retired 2026-08-10 with the
  // rows they gated: the approval queue became the workspace's Needs Action tab and the report
  // became a link inside the workspace, so neither needs a nav flag any more.
  //
  // The RULE those flags carried did not go with them, it moved DOWN. "Only a person-rung approver
  // sees anything to approve" is now enforced by getDirectOrderWorkspaceData filtering `awaiting`
  // through viewerCanActOnStep -- a service gate covered by direct-orders-approval-flow.test.ts,
  // and a stronger place for it than a sidebar flag, which only ever hid a link.
  //
  // The CNS exclusion below is unchanged and still asserted: it is a business rule about who may
  // use the module at all, not about which page they land on.
  const districtManagerDefault = resolveEmployeePortalNavVisibility("District Manager");
  const regionalManagerDefault = resolveEmployeePortalNavVisibility("Regional Manager");
  assert.equal(districtManagerDefault.showDirectOrdersTab, true, "District Manager should see Direct Orders (requester role)");
  assert.equal(regionalManagerDefault.showDirectOrdersTab, true, "Regional Manager should see Direct Orders (requester role)");
  assert.equal(nsmDefault.showDirectOrdersTab, true, "National Sales Manager should see Direct Orders (requester role)");
  assert.equal(productManagerDefault.showDirectOrdersTab, true, "Product Manager should see Direct Orders (requester role)");
  assert.equal(groupProductManagerDefault.showDirectOrdersTab, true, "Group Product Manager should see Direct Orders (requester role)");
  const trainingManagerForDirectOrders = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerForDirectOrders.showDirectOrdersTab, false, "Direct Orders must not show for a role outside the module's requester set");

  // Direct Orders is hidden from the CNS line entirely (owner decision, 2026-07-20) --
  // even a role that would otherwise qualify never sees any of the 3 tabs on CNS.
  const cnsDistrictManager = resolveEmployeePortalNavVisibility("District Manager", undefined, "CNS");
  const cnsRegionalManager = resolveEmployeePortalNavVisibility("Regional Manager", undefined, "CNS");
  assert.equal(cnsDistrictManager.showDirectOrdersTab, false, "CNS District Manager must not see Direct Orders");
  assert.equal(cnsRegionalManager.showDirectOrdersTab, false, "CNS Regional Manager must not see Direct Orders");
  // A non-CNS line for the same roles must be unaffected (the exclusion is CNS-specific).
  const pediaDistrictManager = resolveEmployeePortalNavVisibility("District Manager", undefined, "Pedia");
  assert.equal(pediaDistrictManager.showDirectOrdersTab, true, "Pedia District Manager keeps Direct Orders -- the CNS exclusion must not leak to other lines");

  const marketingManagerDefault = resolveEmployeePortalNavVisibility("Marketing Manager");
  assert.equal(marketingManagerDefault.showDirectOrdersTab, false, "Marketing Manager is NOT a Direct Orders requester role");
  // MM mirrors GPM on every nav surface EXCEPT these intentional differences:
  // - Incentive stays hidden from Marketing Manager per portal policy
  // - Attendance Analytics is visible for team attendance oversight
  // - Double Visit Report is hidden: MM is NOT in DV_FOCUS_ROLES, so its page would reject MM
  // - Field Activity is hidden for the SAME reason, one module along: MM is not in
  //   FIELD_ACTIVITY_ROLES, which deliberately holds the seats that read one PERSON'S day rather
  //   than the seats that read the DV board for its counts. resolveFieldActivityAccess would
  //   refuse her, so a row here would be a link to a page that bounces her — which is precisely
  //   the defect #4686 exists to fix, and it must not be reintroduced from the other direction.
  // - Direct Orders submit/report are hidden: MM is NOT in DIRECT_ORDER_REQUESTER_ROLES,
  //   so the module's own server-side gate would reject an MM submission anyway
  // - All Marketing Requests is VISIBLE to MM but not GPM: the company-wide request register is
  //   the oversight trio only (Marketing Manager / SFE Manager / Super Admin), owner instruction
  //   2026-08-03. A GPM keeps its bounded subtree through the normal workspace, so this is a
  //   deliberate divergence — see canUseEmployeePortalMarketingAllRequests.
  // - Phoenix CRM is VISIBLE to GPM but not MM (owner, 2026-10-20): a GPM reads his own product
  //   line through the doctor-coverage line scope; the Marketing Manager holds no one line, the
  //   portal grid would resolve her to nothing, and she reads the CRM in the admin shell instead.
  //
  // Monthly Closing was a sixth difference until 2026-08-12, when the owner gave the Marketing
  // Manager her own Monthly Closing tab. It is deliberately NOT overridden below any more: both
  // roles now see it, so leaving it out of the override list makes this assertion PROVE they agree
  // rather than paper over a divergence that no longer exists.
  assert.deepEqual(
    {
      ...marketingManagerDefault,
      showIncentiveTab: groupProductManagerDefault.showIncentiveTab,
      showFingerprintReportTab: groupProductManagerDefault.showFingerprintReportTab,
      showDoubleVisitReportTab: groupProductManagerDefault.showDoubleVisitReportTab,
      showFieldActivityTab: groupProductManagerDefault.showFieldActivityTab,
      showDirectOrdersTab: groupProductManagerDefault.showDirectOrdersTab,
      showMarketingAllRequestsTab: groupProductManagerDefault.showMarketingAllRequestsTab,
      showCrmMasterTab: groupProductManagerDefault.showCrmMasterTab,
    },
    groupProductManagerDefault,
    "Marketing Manager sidebar visibility must mimic Group Product Manager (apart from the hidden Incentive tab, the Attendance Analytics tab, the Double Visit Report and Field Activity tabs, Direct Orders submit/report, the company-wide All Marketing Requests register, and the line-scoped Phoenix CRM grid)",
  );
  assert.equal(marketingManagerDefault.showMarketingAllRequestsTab, true, "Marketing Manager sees the company-wide request register");
  assert.equal(groupProductManagerDefault.showCrmMasterTab, true, "Group Product Manager reads his own line in the portal CRM grid");
  assert.equal(marketingManagerDefault.showCrmMasterTab, false, "Marketing Manager holds no one line, so the line-scoped portal CRM grid is not offered to her");
  assert.equal(groupProductManagerDefault.showMarketingAllRequestsTab, false, "Group Product Manager stays scoped to its own subtree — no company-wide register");
  assert.equal(groupProductManagerDefault.showDoubleVisitReportTab, true, "Group Product Manager sees the Double Visit Report tab (in DV_FOCUS_ROLES)");
  assert.equal(marketingManagerDefault.showDoubleVisitReportTab, false, "Marketing Manager does NOT get the Double Visit Report tab (not in DV_FOCUS_ROLES — its page would redirect)");
  assert.equal(groupProductManagerDefault.showIncentiveTab, true, "Group Product Manager still sees Incentive (only MM is hidden)");
  assert.equal(marketingManagerDefault.showIncentiveTab, false, "Marketing Manager should NOT see Incentive (hidden from MM per portal policy)");
  assert.equal(
    marketingManagerDefault.showFingerprintReportTab,
    true,
    "Marketing Manager additionally gets the Attendance Analytics tab (team attendance oversight)",
  );
  assert.equal(
    groupProductManagerDefault.showFingerprintReportTab,
    false,
    "Group Product Manager does not get the Attendance Analytics tab",
  );
  assert.equal(marketingManagerDefault.showMonthlyClosingTab, true, "Marketing Manager DOES get Monthly Closing (owner, 2026-08-12) — her three oversight lines, exported as the full closing workbook");
  assert.equal(marketingManagerDefault.showMyPerformanceTab, true, "Marketing Manager sees Sales Dashboard like GPM");
  assert.equal(marketingManagerDefault.showPlansTab, true, "Marketing Manager should see plans like PM/GPM");
  assert.equal(marketingManagerDefault.showVacanciesTab, true, "Marketing Manager should see Vacancies like PM/GPM");
  assert.equal(marketingManagerDefault.showProbationTab, true, "Marketing Manager should see Probation like PM/GPM");
  assert.equal(marketingManagerDefault.showOrganogramTab, true, "Marketing Manager should see Organogram like PM/GPM");
  assert.equal(marketingManagerDefault.showExpenseActionTab, true, "Marketing Manager should see Submit Expense like PM/GPM");
  assert.equal(marketingManagerDefault.showMarketingRequestsTab, true, "Marketing Manager should see Marketing Requests in nav");
  assert.equal(marketingManagerDefault.showMarketingInboxTab, true, "Marketing Manager should see the Marketing Approval Inbox in nav");
  assert.equal(marketingManagerDefault.showMarketingRoiTrackingTab, true, "Marketing Manager should stay authorized for ROI Tracking (permission-only; the tab itself is retired from the sidebar)");

  const sfeDefault = resolveEmployeePortalNavVisibility("SFE Manager");
  assert.equal(sfeDefault.showMarketingControlTab, true, "SFE Manager should see Marketing Control in nav (full module)");
  assert.equal(sfeDefault.showMarketingRequestsTab, true, "SFE Manager should see Marketing Requests in nav (full module)");

  const superAdminDefault = resolveEmployeePortalNavVisibility("Super Admin");
  assert.equal(superAdminDefault.showMarketingRequestsTab, true, "Super Admin should see Marketing Requests in nav (full module)");
  assert.equal(superAdminDefault.showMarketingControlTab, true, "Super Admin should see Marketing Control in nav (full module)");
  assert.equal(superAdminDefault.showMarketingCustomerDatabaseTab, true, "Super Admin should see Customer Database in nav (full module)");
  assert.equal(superAdminDefault.showSupportTab, true, "Super Admin should see Contact HR Support in nav (full module)");

  // Contact HR Support is available to every portal role, including those with a trimmed
  // nav like Training Manager — everyone must be able to reach their HR team.
  const trainingManagerSupport = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerSupport.showSupportTab, true, "Contact HR Support must show for every portal role");

  // Marketing Requests visibility never extends to an unauthorized role.
  const trainingManagerDefault = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerDefault.showMarketingRequestsTab, false, "Marketing Requests must not show for an unauthorized role");
  assert.equal(trainingManagerDefault.showMarketingControlTab, false, "Marketing Control must not show for an unauthorized role");

  // Core 8 launch modules stay visible for the correct roles regardless of the flag.
  const medRepCore = resolveEmployeePortalNavVisibility("Medical Rep");
  assert.equal(medRepCore.showDashboardTab, true, "Core: Medical Rep keeps Dashboard with beta nav off");
  assert.equal(medRepCore.showMyPerformanceTab, true, "Core: Medical Rep keeps My Performance with beta nav off");
  assert.equal(medRepCore.showIncentiveTab, true, "Core: Medical Rep keeps Incentive with beta nav off");
  assert.equal(medRepCore.showMedicalRepExpensesTab, true, "Core: Medical Rep keeps outstation expenses with beta nav off");

  const nsmCore = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmCore.showMedRepsPerformanceTab, true, "Core: NSM keeps MRs Performance with beta nav off");
  assert.equal(nsmCore.showDsmsPerformanceTab, true, "Core: NSM keeps DSMs Performance with beta nav off");
  assert.equal(nsmCore.showTeamExpensesTab, false, "NSM no longer sees the standalone Team Expenses tab (consolidated into the Expense Dashboard)");

  // Beta flag enabled: full modules stay visible; the flag never downgrades them.
  process.env.PHOENIX_PORTAL_SHOW_BETA_NAV = "true";

  const nsmBeta = resolveEmployeePortalNavVisibility("National Sales Manager");
  assert.equal(nsmBeta.showMarketingRequestsTab, true, "NSM keeps Marketing Requests when beta nav is enabled");
  assert.equal(nsmBeta.showSupportTab, true, "Contact HR Support stays visible when beta nav is enabled");

  // Enabling the flag must never grant Marketing to a role that was not authorized.
  const trainingManagerBeta = resolveEmployeePortalNavVisibility("Training Manager");
  assert.equal(trainingManagerBeta.showMarketingRequestsTab, false, "Beta flag must not grant Marketing Requests to an unauthorized role");
  assert.equal(trainingManagerBeta.showMarketingControlTab, false, "Beta flag must not grant Marketing Control to an unauthorized role");
  assert.equal(trainingManagerBeta.showSupportTab, true, "Contact HR Support stays visible for any portal role");

  // Restore the launch posture so the flag never leaks into other suites.
  if (previousBetaFlag === undefined) {
    delete process.env.PHOENIX_PORTAL_SHOW_BETA_NAV;
  } else {
    process.env.PHOENIX_PORTAL_SHOW_BETA_NAV = previousBetaFlag;
  }

  // buildEmployeePortalSections wires every Beta nav item behind its flag, and the
  // flags default to false, so the launch nav hides them unless explicitly enabled.
  assert.match(
    layoutSource,
    /showSupportTab = false/,
    "Support nav flag must default to hidden in buildEmployeePortalSections",
  );
  assert.match(
    layoutSource,
    /showSupportTab \? \[\{ href: "\/employee-portals\/contact-hr-support"/,
    "Contact HR Support nav item must be gated behind showSupportTab",
  );
  assert.match(
    layoutSource,
    /showMarketingValidationTab \? \[\{ href: "\/employee-portals\/marketing-requests\/validation"/,
    // Its own flag since 2026-09-18 (owner): the Medical Rep keeps Customer Validation while the
    // drafts workspace and the Approval Inbox — which showMarketingRequestsTab gates — are closed
    // to them. Putting the two back on one flag silently reopens both.
    "Customer Validation nav item must be gated behind showMarketingValidationTab",
  );
  assert.match(
    layoutSource,
    /showMarketingControlTab \? \[\{ href: "\/employee-portals\/marketing-requests\/control"/,
    "Marketing Control nav item must be gated behind showMarketingControlTab",
  );
  assert.match(
    layoutSource,
    /showMarketingCustomerDatabaseTab \? \[\{ href: "\/employee-portals\/marketing-requests\/customer-database"/,
    "Customer Database nav item must be gated behind showMarketingCustomerDatabaseTab",
  );

  // Page-level guards must remain unchanged: hiding nav never weakens direct-URL access.
  const contactHrSupportPageSource = readFileSync("app/employee-portals/contact-hr-support/page.tsx", "utf8");
  assert.match(
    contactHrSupportPageSource,
    /if \(!access\.loginId && !access\.hrId\) \{[\s\S]*?redirect\("\/login"\);[\s\S]*?\}[\s\S]*?assertPermission\(access, "support_requests", "create"\)/,
    "Contact HR Support page must redirect guests before asserting support request permissions",
  );
  assert.match(
    contactHrSupportPageSource,
    /assertPermission\(access, "support_requests", "create"\)/,
    "Contact HR Support page must keep its support_requests create guard",
  );
  const marketingRequestsPageSource = readFileSync("app/employee-portals/marketing-requests/page.tsx", "utf8");
  assert.match(
    marketingRequestsPageSource,
    /assertEmployeePortalMarketingPageAccess/,
    "Marketing Requests page must keep its page-level access guard",
  );

  // --- Dashboard Marketing quick-action: full module, role-gated only ----------
  // Visible for authorized roles regardless of the (legacy) beta flag argument.
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(undefined, "District Manager"),
    true,
    "Dashboard Marketing quick-action shows for an authorized role (full module, flag-independent)",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "National Sales Manager"),
    true,
    "Dashboard Marketing quick-action shows for NSM even when the legacy beta argument is false",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "Product Manager"),
    true,
    "Dashboard Marketing quick-action shows for Product Manager (full module)",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(false, "Group Product Manager"),
    true,
    "Dashboard Marketing quick-action shows for Group Product Manager (full module)",
  );

  // Never surfaces for roles not authorized for Marketing.
  // The Medical Rep joined that list on 2026-09-18 (owner): the quick action says "Submit Marketing
  // Request", and a rep no longer submits one — they validate the customer their District Manager
  // then raises the spend against. It follows canUseEmployeePortalMarketingRequests, so it falls
  // away with the sidebar link rather than needing a gate of its own.
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Medical Rep"),
    false,
    "Marketing quick-action must not surface for a Medical Rep — they raise no requests",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Employee"),
    false,
    "Marketing quick-action must not surface for an unauthorized Employee",
  );
  assert.equal(
    shouldShowEmployeePortalMarketingQuickAction(true, "Training Manager"),
    false,
    "Marketing quick-action must not surface for Training Manager",
  );

  // The dashboard wires the quick-action through the gating helper, and Core 8
  // quick-actions (Submit Expense, Submit Vacation Request) remain ungated.
  assert.match(
    dashboardSource,
    /shouldShowEmployeePortalMarketingQuickAction\(data\.betaNavEnabled, data\.employee\.roleLabel\)/,
    "Dashboard Marketing quick-action must be gated via shouldShowEmployeePortalMarketingQuickAction",
  );
  assert.match(dashboardSource, /label: "Submit Expense"/, "Core 8 Submit Expense quick-action must remain present");
  assert.match(dashboardSource, /label: "Submit Vacation Request"/, "Core 8 Submit Vacation Request quick-action must remain present");
}
