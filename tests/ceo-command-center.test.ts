import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import { assignablePhoenixRoles, buildPermissionLookup, permissionMatrix } from "../src/lib/auth/permissions.ts";
import {
  ceoDvManagerRows,
  managerOnLeaveCandidates,
  managersOnLeaveToday,
  sosPeriodDisplayLabel,
  type CeoCommandCenterData,
} from "../src/lib/ceo/command-center.ts";
import type { DoubleVisitIdleManager, DoubleVisitManagerSummary } from "../src/lib/double-visit-analytics/types.ts";
import { stripComments } from "./support/comment-strip.ts";
import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import {
  buildCompanyWorkforceAggregateMetrics,
  canReadCompanyWorkforceAggregates,
} from "../src/lib/platform/metrics.ts";

// RETIRED 2026-08-28 (owner): the sfe skeleton-title array must NOT contain the Doctor coverage
// title any more. Titles must track RENDERED sections (see PHASE_B_SKELETON_TITLES's own comment
// in ceo-phase-b.tsx), and that section is gone — a skeleton row with nothing behind it reads as a
// load that never finishes. The regex is kept and its use inverted, so the pin still bites.
const PHASE_B_SKELETON_TITLES_SFE_SOURCE_CHECK = /sfe: \[[^\]]*"Doctor coverage & frequency"[^\]]*\]/;

export function runCeoCommandCenterTests() {
  // The CEO now lands on their dedicated, branded command center (was /sales).
  assert.equal(
    resolveLandingPathForRole("CEO"),
    "/admin/ceo-command-center",
    "CEO must land on the CEO Command Center",
  );
  // Landing normalizes case/whitespace, so variants resolve the same.
  assert.equal(resolveLandingPathForRole(" ceo "), "/admin/ceo-command-center");

  // Other roles' landings must be unchanged by this feature.
  assert.equal(resolveLandingPathForRole("Super Admin"), "/admin");
  // Changed 2026-08-10: the Finance Manager now has his own command center, peer to the CEO's and
  // the SFE Manager's above. He previously landed on /admin/outstation/expense-command — one
  // module of a job spanning payroll, direct orders, marketing execution, expenses and leave.
  assert.equal(
    resolveLandingPathForRole("Finance Manager"),
    "/admin/finance-command-center",
    "Finance Manager must land on the Finance Command Center",
  );
  assert.equal(resolveLandingPathForRole("Employee"), "/employee-portals");
  assert.equal(resolveLandingPathForRole("Medical Rep"), "/employee-portals");

  // The SFE Manager lands on his own overview, not the generic /admin shell. This rule arrived
  // incidentally inside an unrelated vacation-typography commit and had no coverage, so nothing
  // stopped a later edit to landing.ts from dropping it silently.
  assert.equal(
    resolveLandingPathForRole("SFE Manager"),
    "/admin/sfe-command-center",
    "SFE Manager must land on the SFE Manager Overview",
  );
  assert.equal(resolveLandingPathForRole(" sfe manager "), "/admin/sfe-command-center");

  // …and the sidebar logo must return him there too. The admin shell's generic home is
  // /admin/access, which hard-asserts admin_access:read — a grant the SFE Manager does not hold,
  // so falling back to it renders an error card instead of a home page.
  const sidebarSource = readFileSync("src/components/layout/sidebar.tsx", "utf8");
  const homeRoles = /const commandCenterHomeRoles = new Set<PhoenixRole>\(\[([^\]]*)\]\)/
    .exec(sidebarSource)?.[1] ?? "";
  assert.ok(
    homeRoles.includes('"SFE Manager"') && homeRoles.includes('"CEO"'),
    "sidebar home must resolve via resolveLandingPathForRole for both CEO and SFE Manager",
  );
  assert.match(
    sidebarSource,
    /commandCenterHomeRoles\.has\(currentRole as PhoenixRole\)\s*\n?\s*\?\s*resolveLandingPathForRole\(currentRole\)/,
    "sidebar home path must come from resolveLandingPathForRole for command-center roles, not a hardcoded role check",
  );
  // A role with its own command center must not ALSO see the generic one — that put two
  // "Command Center" entries in the SFE Manager's sidebar, the second landing on the admin-wide
  // dashboard instead of his overview.
  const navSource = readFileSync("src/config/system-navigation.ts", "utf8");
  // Matched to end-of-line, not to the first `}` — the entry itself contains `{ resource: "admin" }`,
  // so a lazy brace match truncates before ever reaching excludedRoles.
  const genericCommandCenter = /^.*href: "\/admin", icon: LayoutDashboard, label: "Command Center".*$/m.exec(navSource)?.[0] ?? "";
  assert.ok(genericCommandCenter.length > 0, "the generic /admin Command Center nav entry must still be findable");
  for (const role of ["CEO", "SFE Manager"]) {
    assert.ok(
      genericCommandCenter.includes(`"${role}"`),
      `${role} has a dedicated command center, so must be excluded from the generic /admin one`,
    );
  }

  // The CEO's hero greeting names him personally and the hidden note is addressed to the Chief
  // Executive — neither may render for any other viewer of this shared component.
  const heroSource = readFileSync("src/components/admin/ceo-hero-identity.tsx", "utf8");
  assert.match(
    heroSource,
    /personal = false/,
    "the CEO's personal greeting/note must be opt-IN, so a new viewer cannot inherit it by default",
  );
  assert.match(
    heroSource,
    /\{personal \? <CeoHiddenNote \/> : null\}/,
    "the note written for the Chief Executive must not render for anyone else",
  );

  // The SFE overview is one role's personal page and must not sit on the Super Admin's or the
  // CEO's sidebar. `roles` alone does not achieve that: the system administrator's waiver skips
  // the `roles` gate, so Super Admin would be offered it regardless. `excludedRoles` is what stops
  // it, and navigationItemVisible honours that for EVERY role including them — assert both halves,
  // because either one alone silently stops working.
  //
  // Asked of the running code rather than of the source text. This was a regex pinned to the exact
  // shape of the old two-branch bypass in active-path.ts, which made it a tripwire on formatting
  // rather than on behaviour. What actually matters is that these two roles are not offered the
  // href, so ask getSections that directly.
  for (const role of ["Super Admin", "CEO"] as const) {
    const offered = getSections(
      getNavigationSections("admin"),
      "admin",
      buildPermissionLookup(permissionMatrix, role),
      role,
    )
      .flatMap((navSection) => navSection.items)
      .map((navItem) => navItem.href);
    assert.ok(offered.length > 20, `sanity: ${role} should be offered a real sidebar, got ${offered.length} items`);
    assert.equal(
      offered.includes("/admin/sfe-command-center"),
      false,
      `${role} must not be offered the SFE Manager Overview — excludedRoles must survive the roles-gate waiver`,
    );
  }
  const sfeNavEntry = /^.*href: "\/admin\/sfe-command-center".*$/m.exec(navSource)?.[0] ?? "";
  assert.ok(sfeNavEntry.length > 0, "the SFE command-center nav entry must still be findable");
  for (const role of ["Super Admin", "CEO"]) {
    assert.ok(
      new RegExp(`excludedRoles: \\[[^\\]]*"${role}"`).test(sfeNavEntry),
      `${role} must be excluded from the SFE Manager Overview sidebar entry`,
    );
  }

  // Hiding the nav entry is UX only — /admin itself must bounce these roles to their own page,
  // or a typed URL or stale bookmark still lands them on the generic admin dashboard.
  const adminPageSource = readFileSync("app/(admin)/admin/page.tsx", "utf8");
  const adminRedirectRoles = /const DEDICATED_COMMAND_CENTER_ROLES = new Set<PhoenixRole>\(\[([^\]]*)\]\)/
    .exec(adminPageSource)?.[1] ?? "";
  for (const role of ["CEO", "SFE Manager"]) {
    assert.ok(
      adminRedirectRoles.includes(`"${role}"`),
      `/admin must redirect ${role} to their own command center, not just hide the nav link`,
    );
  }
  assert.match(
    adminPageSource,
    /redirect\(resolveLandingPathForRole\(access\.role\)\)/,
    "/admin's redirect target must come from resolveLandingPathForRole so it cannot drift from the sidebar",
  );

  // ── The generic Admin Command Center is RETIRED (2026-08-30) ────────────────────────────────
  // A role sweep that day asked who actually LANDED on the generic /admin dashboard and found
  // nobody: every admin-shell role resolves to a landing page of its own. The only way in was a
  // "Command Center" sidebar row, and the two seats that could follow it — HR Advisory and HR
  // Operations — got a page of mostly EGP 0, because its payroll/sales/expense tiles render
  // unconditionally while those seats' scopes resolve to nothing behind them.
  //
  // Both halves are asserted because they fail in opposite directions: without the redirect a
  // typed URL still reaches the dead page, and without the nav exclusion the sidebar still offers
  // a row that now bounces.
  // HR Advisory left the list when the owner retired the HR Business Partner seat on 2026-10-08; the Talent Acquisition seat has its own page too.
  for (const role of ["HR Operations", "HR Resourcing"]) {
    assert.ok(
      adminRedirectRoles.includes(`"${role}"`),
      `/admin must redirect ${role} to /hr/admin/hr-command-center — the generic dashboard it used to `
        + `render is retired, and it could only ever answer EGP 0 for this seat anyway`,
    );
    assert.ok(
      genericCommandCenter.includes(`"${role}"`),
      `${role} has a landing page of their own, so must be excluded from the generic /admin nav row`,
    );
  }
  assert.doesNotMatch(
    adminPageSource,
    /admin-command-center/,
    "/admin must not render the retired Admin Command Center — the component is deleted, so an "
      + "import of it does not compile, but a stale lazy/dynamic reference would only fail at runtime",
  );
  assert.equal(
    existsSync("src/components/admin/admin-command-center.tsx"),
    false,
    "the retired Admin Command Center component must stay deleted — reinstating the file is how a "
      + "page nobody lands on comes back",
  );

  // The loop guard in /admin's fall-through. resolveLandingPathForRole ENDS in `: "/admin"`, so it
  // answers this very address for any role it does not enumerate — and that unenumerated role is
  // precisely the one that reaches the fall-through. Redirecting it unconditionally would be an
  // infinite redirect. Asserted as a property of every role rather than of the one line, because
  // the danger arrives when somebody ADDS a role, not when somebody edits this page.
  // Every role a person can hold. The retired HR Business Partner key (2026-10-08) resolves to /admin
  // too, and reaches nobody; the guard asserted below is what would answer a stale one, with the
  // access card rather than a loop.
  for (const role of assignablePhoenixRoles) {
    if (resolveLandingPathForRole(role) !== "/admin") continue;
    assert.equal(
      role,
      "Super Admin",
      `${role} resolves to /admin as its own landing page, so /admin's fall-through would redirect it `
        + `to itself forever. Give the role a landing path in resolveLandingPathForRole, or keep the `
        + `\`landing !== "/admin"\` guard that renders the access card instead`,
    );
  }
  assert.match(
    adminPageSource,
    /landing !== "\/admin"/,
    "/admin's fall-through must keep the loop guard — resolveLandingPathForRole defaults to /admin",
  );

  const accessPageSource = readFileSync("app/(admin)/admin/access/page.tsx", "utf8");
  assert.match(
    accessPageSource,
    /assertPermission\(access, "admin_access", "read"\)/,
    "the /admin/access gate is the reason command-center roles need their own home — if this assert goes, revisit commandCenterHomeRoles",
  );

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  const ceoCommandCenterSource = readFileSync("src/lib/ceo/command-center.ts", "utf8");
  const ceoComponentSource = readFileSync("src/components/admin/ceo-command-center.tsx", "utf8");
  const ceoPhaseBSource = readFileSync("src/components/admin/ceo-phase-b.tsx", "utf8");
  const attendanceAnalyticsPageSource = readFileSync("app/(admin)/attendance/analytics/page.tsx", "utf8");
  const probationPageSource = readFileSync("app/(admin)/probation/page.tsx", "utf8");
  const platformSource = readFileSync("src/lib/platform/metrics.ts", "utf8");
  assert.match(
    commandCenterSource,
    /activeEmployees: platformMetrics\.workforce\.activeEmployees/,
    "CEO Command Center HR cards must render shared platform workforce metrics",
  );
  assert.match(
    platformSource,
    /canReadCompanyWorkforceAggregates\(accessContext\)/,
    "CEO Command Center workforce metrics must use the CEO-safe aggregate path",
  );
  assert.match(
    ceoCommandCenterSource,
    /getPlatformMetrics\(access\)/,
    "Dedicated CEO Command Center must use shared platform metrics",
  );
  // Contracts, probation and coaching are no longer computed in this file. They are three of the
  // sources src/lib/needs-you owns, read through adaptersFor + loadNeedsYouSources, because two
  // copies of each rule had already drifted — the probation pair gave different answers. What must
  // still be proven is unchanged: the CEO reaches the right SERVICE. So the assertion follows the
  // rule to the file that now calls it, and a second one proves the CEO is still wired to it —
  // an adapter the CEO never asks for renders no tile at all.
  const needsYouSourcesSource = readFileSync("src/lib/needs-you/sources.ts", "utf8");
  assert.match(
    needsYouSourcesSource,
    /getContractRenewalDashboardData\(access\)/,
    "CEO contract risk must use the contract renewal dashboard service",
  );
  assert.match(
    ceoCommandCenterSource,
    /adaptersFor\(\[[^\]]*"contract-renewals"/,
    "the CEO contract tile must still ask for that source",
  );
  assert.match(
    needsYouSourcesSource,
    /getProbationRows\(access\)/,
    "CEO probation risk must use the service behind /probation, not a second aggregate",
  );
  assert.match(
    ceoCommandCenterSource,
    /adaptersFor\(\[[^\]]*"probation-decisions"/,
    "the CEO probation tile must still ask for that source",
  );
  // Inverted deliberately. This assertion used to REQUIRE the raw `from("probation_evaluations")`
  // scan, which is the defect itself: that scan counts rows whose probation window has already
  // closed, joins no employment status and applies no medical-representative rule, while
  // getProbationRows — the service behind /probation, the page this tile links to — filters all of
  // them out. The two sets were disjoint by construction, so the CEO clicked "22 overdue" and
  // landed on a table containing none of them. The count now comes from that same service; see
  // ceo-landing-seat-and-probation-counts.test.ts for the positive form.
  for (const [label, source] of [
    ["the CEO command centre", ceoCommandCenterSource],
    ["the needs-you probation adapter", needsYouSourcesSource],
  ] as const) {
    assert.doesNotMatch(
      source,
      /from\("probation_evaluations"\)/,
      `${label} must not re-scan probation_evaluations — it must reuse the /probation service, or the number and its destination describe different people`,
    );
  }
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /\.not\("decision"/,
    "CEO probation risk must not exclude null decisions with a PostgREST not-in filter",
  );
  assert.match(
    ceoCommandCenterSource,
    /getSalaryFlags\(\)/,
    "CEO salary flag signal must use the salary flag helper",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /from\("employee_contracts"\)/,
    "CEO contract risk must not query the empty employee_contracts table",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /from\("salary_batches"\)/,
    "CEO payroll signal must not raw-order salary_batches and pick fixture future years",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /health:\s*\{\s*salesLinkageRate:\s*0/,
    "CEO health metrics must not be hardcoded zero placeholders",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /trends:\s*\{\s*sales:\s*\[\],\s*financial:\s*\[\],\s*hireExit:\s*\[\]\s*\}/,
    "CEO trend metrics must not be hardcoded empty placeholders",
  );
  assert.match(ceoComponentSource, /const \{ attention, approvals, dataUnavailable, headcount, health, payroll, sos \} = data/);
  assert.match(ceoComponentSource, /Active employees/);
  assert.match(ceoComponentSource, /Total structure/);
  assert.match(ceoComponentSource, /Lookup-backed count/);
  assert.match(
    ceoCommandCenterSource,
    /const plansPending = pendingPlansR\.status === "fulfilled" \? pendingPlansR\.value : null/,
    "CEO weekly-plan failures must render unavailable instead of zero",
  );
  assert.match(
    ceoCommandCenterSource,
    /dataUnavailable\.push\("Pending weekly-plan approvals"\)/,
    "CEO fast path must surface pending-plan source failures",
  );
  assert.match(
    ceoCommandCenterSource,
    /dataUnavailable: Array\.from\(new Set\(dataUnavailable\)\)/,
    "CEO unavailable source metadata must be de-duplicated and returned",
  );
  // "Leave requests" approval tile: leave was moved off the action-center feed onto its own
  // approvals page, so getAwaitingMyActionItems(access, "admin") always filters module==="leave"
  // down to nothing. The tile's count must come from the real vacation-report aggregate instead,
  // or it silently reads "0 pending" forever no matter how many leave requests are waiting.
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /getAwaitingMyActionItems\(/,
    "CEO fast path must not call the action-center feed for its leave count — that feed excludes leave by design (see action-center/service.ts), so filtering it always yields zero",
  );
  assert.doesNotMatch(
    ceoCommandCenterSource,
    /item\.module === "leave"/,
    "CEO leavePending must not be computed by filtering module==='leave' out of an already leave-excluding feed",
  );
  assert.match(
    ceoCommandCenterSource,
    /const leavePending = adminSignals \? adminSignals\.leavePendingTotal : null;/,
    "CEO leavePending must be sourced from adminSignals.leavePendingTotal (the real vacation-report aggregate)",
  );
  assert.match(
    ceoCommandCenterSource,
    /const leavePendingTotal =\s*\n\s*leavePendingR\.status === "fulfilled" \? leavePendingR\.value\.pendingByStage\.total : null;/,
    "leavePendingTotal must read pendingByStage.total from getVacationPendingApprovalCounts (the leave report's own count), and be null (not 0) when that fetch fails",
  );
  assert.match(
    ceoCommandCenterSource,
    /leavePendingTotal: number \| null;/,
    "CeoAdminSignals must expose leavePendingTotal so the CEO fast path can read the real pending-leave count",
  );
  assert.match(
    ceoCommandCenterSource,
    /^\s*leavePendingTotal,\s*$/m,
    "getCeoAdminSignals must actually return leavePendingTotal on the CeoAdminSignals object, not just declare it on the type",
  );
  assert.match(
    ceoComponentSource,
    /href="\/admin\/approvals\/vacation"[\s\S]{0,600}Leave requests/,
    "CEO Leave requests tile must link to the dedicated vacation approvals page — /admin/approvals-hub no longer holds leave items (MIGRATED_DEEPLINK_BASES bounces leave deep-links away from it)",
  );
  assert.match(
    ceoCommandCenterSource,
    /href: "\/admin\/m-payroll"/,
    "CEO salary flag links must land on the CEO payroll console",
  );
  assert.match(
    ceoComponentSource,
    /<DataUnavailableNotice[^>]*sources=\{visibleDataUnavailable\}/,
    "CEO fast path must render unavailable-source warnings",
  );
  assert.match(
    ceoComponentSource,
    /const allClear = dataAvailable && visibleAttention\.length === 0 && totalApprovals === 0/,
    "CEO all-clear must be blocked while any source is unavailable",
  );
  assert.match(
    ceoComponentSource,
    /totalApprovals > 0 \|\| hasUnavailableApprovals/,
    "CEO approval counts must render unavailable values instead of hiding as zero",
  );
  assert.match(
    ceoPhaseBSource,
    /payroll\.net > 0 \|\| payroll\.gross > 0 \|\| payroll\.unresolvedSalaryFlags > 0/,
    "CEO Phase B must show payroll risk cards when only salary flags are present",
  );
  assert.match(
    ceoPhaseBSource,
    /RiskSourceWarning/,
    "CEO Phase B must render unavailable-source warnings",
  );
  assert.match(
    ceoPhaseBSource,
    /No risk cards can be declared clear while critical CEO sources are unavailable/,
    "CEO Phase B must not show no-risk language when critical sources fail",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/payroll"/,
    "CEO Phase B smart navigation must not link to operational payroll",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/sales\/weekly"/,
    "CEO Phase B smart navigation must not link to the redirecting weekly sales route",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /href: "\/sales\/monthly-dashboard"/,
    "CEO Phase B smart navigation must not link to the redirecting monthly sales route",
  );
  assert.match(ceoPhaseBSource, /SmartNavGrid access=\{access\} variant=\{variant\}/);
  assert.match(ceoPhaseBSource, /item\.href !== "\/employees" && item\.href !== "\/admin\/data-health"/);

  // ── SFE Manager variant scope ──────────────────────────────────────────────
  // /admin/sfe-command-center reuses these CEO components with variant="sfe". The SFE Manager's
  // permission matrix grants no `employees`, `organogram`, `vacancies`, `contracts`,
  // `resignations`, `admin` or payroll-console access, and canUseAdminOutstationWorkspace()
  // excludes him from the admin outstation workspace. Every partition below therefore has to
  // stay off his overview — each one previously linked him at a page that redirects to
  // /employee-portals or renders a Forbidden card.
  const sfeNavBlock = /const SFE_NAV_ITEMS = \[([\s\S]*?)\n\];/.exec(ceoPhaseBSource)?.[1] ?? "";
  assert.ok(sfeNavBlock.length > 0, "SFE quick navigation must be its own list, not the CEO list filtered");
  for (const denied of [
    "/employees",
    "/organogram",
    "/admin/data-health",
    "/admin/outstation/expense-command",
    "/admin/m-payroll",
  ]) {
    assert.ok(
      !sfeNavBlock.includes(`"${denied}"`),
      `SFE quick navigation must not link to ${denied} — the SFE Manager is denied that route`,
    );
  }
  assert.match(
    ceoPhaseBSource,
    /\{!isSfe \? <Section\s+title="Expense Snapshot"/,
    "SFE overview must not render the Expense Snapshot — admin outstation workspace excludes SFE Manager",
  );
  assert.match(
    ceoPhaseBSource,
    /includeExpense: !isSfe/,
    "SFE overview must skip the company-wide outstation expense fetch entirely",
  );
  assert.match(
    ceoPhaseBSource,
    /includeHeadcount=\{!isSfe\}/,
    "SFE trends must drop the hire/exit chart — employee-lifecycle data is out of SFE scope",
  );
  assert.match(
    ceoPhaseBSource,
    /includeEmployeeLinkage=\{!isSfe\}/,
    "SFE health breakdown must drop employee linkage — HR master-data quality is out of SFE scope",
  );
  assert.match(
    ceoComponentSource,
    /export const SFE_ATTENTION_KEYS = new Set\(\[([^\]]*)\]\)/,
    "SFE attention rows must be an explicit allow-list, not a deny-list",
  );
  const sfeAttentionKeys = /export const SFE_ATTENTION_KEYS = new Set\(\[([^\]]*)\]\)/
    .exec(ceoComponentSource)?.[1] ?? "";
  for (const denied of ["contracts", "resignations", "salaryFlags"]) {
    assert.ok(
      !sfeAttentionKeys.includes(`"${denied}"`),
      `SFE attention rows must exclude "${denied}" — that page redirects the SFE Manager to /employee-portals`,
    );
  }
  // `getCeoGreeting()` returns "Good morning, Dr. Anwar" and pairs with CeoHiddenNote — a greeting
  // and a note written for one named person. It belonged to the CEO variant and to no other, and
  // this pinned exactly that gate: first `personal={!isSfe}` (wrong the moment a third variant
  // arrived), then `personal={variant === "ceo"}` by name.
  //
  // THE BAND WENT on 2026-09-03 (96e12a53b) and CAME BACK on 2026-09-06, at the owner's
  // instruction both times: "remove from all pages this dump block", then "I WANT THE SFE AND THE
  // FINANCE AND CEO TO HAVE THEIR PREVIOUS IDENTITY BANNER, THE NEW ONE IS ONLY FOR HRs".
  //
  // While it was gone this pinned the ABSENCE, and the message it carried named the condition for
  // letting it back: gated on the CEO variant BY NAME. That is now the assertion, because the
  // absence stopped being the thing worth guarding the moment the band returned — a test pinning
  // "not mounted" against a mounted component is a test that has to be deleted to ship, which is
  // how a real guard gets thrown away with the stale one.
  //
  // The leak being prevented: `getCeoGreeting()` returns "Good morning, Dr. Anwar" and pairs with
  // CeoHiddenNote — a greeting and a note written for one named person. `personal={!isSfe}` handed
  // both to the Super Admin the moment the admin variant existed. `variant === "ceo"` cannot,
  // whatever fourth variant arrives later.
  assert.match(
    ceoComponentSource,
    /<CeoHeroIdentity/,
    "the identity band is mounted here again (owner, 2026-09-06) — if it is being removed, the "
      + "owner asked for it, and this assertion and the surrounding note must say so",
  );
  assert.match(
    ceoComponentSource,
    /personal=\{variant === "ceo"\}/,
    "the CEO's personal greeting must be gated on the CEO variant BY NAME — never on !isSfe, or "
      + "the Super Admin inherits 'Good morning, Dr. Anwar' and a note addressed to the Chief "
      + "Executive",
  );
  assert.match(
    ceoComponentSource,
    /const showApprovalTiles = !isSfe/,
    "SFE overview must hide the leave/weekly-plan approval tiles — the leave counter is structurally zero and weekly_plans:approve is CEO/Super Admin only",
  );
  assert.match(
    ceoComponentSource,
    /const totalApprovals = showApprovalTiles \?/,
    "SFE all-clear must not be driven by approval counters the page no longer shows",
  );
  // The SFE Manager is responsible for SALES and CRM. Leave and fingerprint attendance are HR
  // surfaces and must not reappear on his overview in any form — not as an attention row, not as
  // a hub card, not as a partition, and not as a fetch he pays for.
  assert.ok(
    !sfeAttentionKeys.includes('"leaveSla"'),
    "leave is HR, not sales or CRM — the leaveSla row must stay off the SFE overview",
  );
  assert.match(
    ceoPhaseBSource,
    /includeAttendance: !isSfe/,
    "the SFE overview must skip the company-wide fingerprint-attendance aggregate entirely",
  );
  assert.match(
    ceoPhaseBSource,
    /\{!isSfe \? <Section\s+title="Attendance & Leave"/,
    "the Attendance & Leave partition must not render for the SFE Manager",
  );
  assert.match(
    ceoPhaseBSource,
    /includeAttendanceReadiness=\{!isSfe\}/,
    "attendance readiness scores fingerprint device mappings — it must be off the SFE health breakdown",
  );
  const sfeSkeleton = /sfe: \[([^\]]*)\]/.exec(ceoPhaseBSource)?.[1] ?? "";
  assert.ok(
    !/attendance|leave/i.test(sfeSkeleton),
    "the SFE loading skeleton must not promise an attendance or leave partition that never arrives",
  );
  // The admin CRM workspace was Super-Admin-only; the owner granted it to the SFE Manager
  // (2026-08-02) because CRM data quality is his job. Every surface must go through the ONE
  // predicate — the previous shape was `access.role !== "Super Admin"` copied into 11 files, and a
  // page granted without its own API routes just yields buttons that 403.
  const crmAccessSource = readFileSync("src/lib/crm/admin-access.ts", "utf8");
  const crmRoles = /const ADMIN_CRM_WORKSPACE_ROLES = new Set<PhoenixRole>\(\[([^\]]*)\]\)/
    .exec(crmAccessSource)?.[1] ?? "";
  for (const role of ["Super Admin", "SFE Manager"]) {
    assert.ok(crmRoles.includes(`"${role}"`), `${role} must hold the admin CRM workspace`);
  }
  const crmGatedFiles = [
    "app/(admin)/admin/crm/page.tsx",
    "app/(admin)/admin/crm-integrity/page.tsx",
    "app/(admin)/admin/double-visit-data-integrity/page.tsx",
    "app/api/admin/crm/master-export/route.ts",
    "app/api/admin/crm/customer-mapping/import/route.ts",
    "app/api/admin/crm/customer-mapping/template/route.ts",
    "app/api/admin/crm/region-mapping/import/route.ts",
    "app/api/admin/crm/region-mapping/template/route.ts",
    "app/api/admin/crm/resolve-customer/route.ts",
    "app/api/admin/crm/resolve-region/route.ts",
    "app/api/admin/visits-report/resolve-identity/route.ts",
  ];
  for (const file of crmGatedFiles) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /canUseAdminCrmWorkspace\(access\)/, `${file} must gate on the shared CRM predicate`);
    assert.doesNotMatch(
      source,
      /access\.role !== "Super Admin"/,
      `${file} must not keep an inline Super-Admin check alongside the shared predicate — that is how the grant half-lands`,
    );
  }
  // A visits BACKFILL re-pulls from the vendor and rewrites the mirror in bulk. It is a platform
  // operation, not CRM analysis, and was deliberately left out of the grant.
  assert.match(
    readFileSync("app/api/admin/visits-report/backfill/route.ts", "utf8"),
    /access\.role !== "Super Admin"/,
    "the visits backfill must stay Super-Admin-only — it was excluded from the SFE CRM grant on purpose",
  );

  for (const hrHref of ['"/attendance"', '"/admin/approvals/vacation"']) {
    assert.ok(
      !sfeNavBlock.includes(hrHref),
      `SFE quick navigation must not link to ${hrHref} — leave and attendance are outside sales and CRM`,
    );
  }

  // Sales + CRM is what replaces them: a real week-over-week series instead of a click-through
  // shortcut, and CRM check-in start times instead of a fingerprint punch clock.
  assert.match(
    ceoPhaseBSource,
    /includeCrmField: isSfe/,
    "the SFE overview must load CRM field analytics",
  );
  assert.match(
    ceoPhaseBSource,
    /includeWeeklyTrend: isSfe/,
    "the SFE overview must load the real weekly sales series",
  );
  assert.doesNotMatch(
    ceoPhaseBSource,
    /includeDoctorCoverage: isSfe/,
    "the SFE overview must NOT request doctor coverage — the board is retired, so asking for it bills a query nothing renders",
  );
  assert.ok(
    !PHASE_B_SKELETON_TITLES_SFE_SOURCE_CHECK.test(ceoPhaseBSource),
    "the SFE skeleton must NOT announce a Doctor coverage section — it is retired, and a skeleton row with no section behind it reads as a stuck load",
  );
  // THE DECISION, and it now has two halves that pull in opposite directions.
  //
  // The SFE Manager gets the real week-over-week series (asserted just above via
  // `includeWeeklyTrend: isSfe`), never the click-through shortcut. The CEO, by contract in
  // tests/ceo-account-contract.test.ts, must keep a direct link to /sales/weekly/dashboard.
  //
  // Both used to be satisfied by `{!isSfe ? <QuickLinkCard title="Weekly Sales"`. On 2026-09-07 the
  // owner asked for the resignation-risk reps in that column — "put the resignation risk reps in
  // the place of weekly sales" — which is his board and the SFE's, never the CEO's. So the card is
  // now the FALLBACK for the one variant that is passed no column, which is the CEO, and the two
  // halves become one condition.
  assert.match(
    ceoComponentSource,
    /\{salesColumnSlot \?\?\s*\(\s*<QuickLinkCard\s+title="Weekly Sales"/,
    "the CEO must still reach the weekly sales dashboard from his own board — he is the variant that receives no column",
  );
  // The SFE never falls through to it, because his page passes a column.
  const sfePageSource = readFileSync("app/(admin)/admin/sfe-command-center/page.tsx", "utf8");
  assert.match(
    sfePageSource,
    /salesColumnSlot=/,
    "the SFE overview must pass the resignation-risk column, which is what keeps him off the click-through fallback",
  );
  const crmFieldSource = readFileSync("src/lib/crm/sfe-field-analytics.ts", "utf8");
  assert.match(
    crmFieldSource,
    /from "@\/lib\/crm\/reads"/,
    "CRM field analytics must read through the crm reads door (single-source rule), never the mirror directly",
  );
  assert.match(
    crmFieldSource,
    /collapseDuplicateVisitSubmissions/,
    "the SFE visit count must apply the same duplicate collapse as DV Analytics, or the two disagree",
  );
  assert.doesNotMatch(
    crmFieldSource,
    /new Date\([^)]*check_?[Dd]ate|toISOString\(\)/,
    "CRM timestamps are already Cairo wall-clock — parsing them through Date would shift every start time",
  );
  assert.match(attendanceAnalyticsPageSource, /canAccess\(access, "attendance", "read"\)/);
  assert.doesNotMatch(attendanceAnalyticsPageSource, /canAccess\(access, "employees", "read"\)/);
  assert.match(probationPageSource, /canReadAllProbation\(access\)/);
  assert.equal(
    canReadCompanyWorkforceAggregates({ role: "CEO", scope: "company", source: "session" }),
    true,
    "CEO must be allowed to read company workforce aggregates",
  );
  const workforce = buildCompanyWorkforceAggregateMetrics({
    employees: [
      { areaName: "Cairo", employmentStatus: "active", fullName: "Alpha", hrId: "A-1", lineName: "Line 1", managerHrId: "AA" },
      { areaName: "Giza", employmentStatus: "on_leave", fullName: "Beta", hrId: "A-2", lineName: "Line 1", managerHrId: "AA" },
    ],
    lookups: {
      workforceVacancies: [],
    },
  });
  assert.ok(
    workforce.activeEmployees > 0,
    "CEO Command Center must show non-zero workforce metrics when employees exist",
  );

  // ── The Source of Sales card shows the last PUBLISHED closing, not the newest upload ────────
  //
  // Measured on production 2026-08-30: August held ONE validated import batch worth EGP 290,387
  // while July held seventeen worth EGP 61,547,414. Passing `null` picks the newest period with
  // any data at all, so from the first upload of a new month this card rendered 0.5% of a real
  // month and the tables under it were nearly empty — which reads as "the company sold nothing",
  // not as "the month has barely started loading". That is the whole defect.
  //
  // Pinned as a source assertion because the alternative is a live database round-trip; the
  // behaviour it guards is one argument, and the pure label function below is tested for real.
  assert.match(
    ceoCommandCenterSource,
    /loadSourceOfSalesDashboard\(closingPeriod, \{ role: access\.role \}\)/,
    "the CEO/SFE/admin landing card must load the LAST PUBLISHED CLOSING, never loadSourceOfSalesDashboard(null) "
      + "— null picks the newest month holding any data, which during an in-progress upload is a near-empty "
      + "month rendered as though it were the company's real sales",
  );
  assert.match(
    ceoCommandCenterSource,
    /const closingPeriod = await closingPeriodPromise/,
    "the closing period must come from latestPublishedClosingPeriod() and be awaited before the SoS load",
  );

  // The upload console must keep seeing the NEWEST month — the person loading August has to watch
  // August arrive. If this ever changes, the fix above has been over-applied.
  const salesImportPageSource = readFileSync("app/(admin)/sales/import/page.tsx", "utf8");
  assert.match(
    salesImportPageSource,
    /loadSourceOfSalesDashboard\(undefined, \{ role: accessContext\.role \}\)/,
    "the Source of Sales IMPORT page must still show the newest uploaded month, not the last published closing "
      + "— it is the console someone uses to watch the month they are currently loading",
  );

  // Never call an unclosed month a closing. When nothing has been published the card falls back to
  // the newest data loaded and the label has to say so — a figure labelled "closing" is one the
  // owner will quote, and quoting a half-loaded month is the failure this change exists to prevent.
  // This is the real behaviour test: the label function is pure.
  const sosPayload = (
    period: string | null,
    periodBasis: "published-closing" | "latest-upload",
  ): CeoCommandCenterData["sos"] => ({
    period,
    periodBasis,
    newerPeriods: [],
    totalValue: 0,
    totalQty: 0,
    lineCount: 0,
    regionCount: 0,
    topLines: [],
    topRegions: [],
    byLine: [],
    byRegion: [],
    byProduct: [],
  });
  assert.equal(
    sosPeriodDisplayLabel(sosPayload("2026-07", "published-closing")),
    "2026-07 closing",
    "a published month must be labelled as a closing",
  );
  assert.equal(
    sosPeriodDisplayLabel(sosPayload("2026-08", "latest-upload")),
    "2026-08 · not closed yet",
    "an UNPUBLISHED month must never be labelled a closing — it is data still arriving, and the label is the "
      + "only thing telling the reader not to quote it",
  );
  assert.equal(
    sosPeriodDisplayLabel(sosPayload(null, "latest-upload")),
    null,
    "no period means no label, so the card falls back to its own 'no monthly sales loaded' copy",
  );
  assert.equal(sosPeriodDisplayLabel(null), null, "a missing SoS payload must not throw");

  assertCeoManagerCoverage();
}

/**
 * Owner, 2026-10-20: "when filter by manager u find no manager". The double-visit table listed only
 * managers who did a double visit, and "Managers on leave today" only those same field managers —
 * so the worst managers and every head-office manager could never appear.
 */
function assertCeoManagerCoverage() {
  const active = {
    managerHrId: "b-10",
    managerName: "Saad Salama",
    role: "District Sales Manager",
    roleCode: "DSM",
    lineName: "CNS",
    distinctMrs: 3,
    overFocusedMrCount: 1,
    neglectedMrCount: 2,
    teamMrCount: 5,
    daysSinceLastDv: 4,
    coveragePct: 60,
  } as unknown as DoubleVisitManagerSummary;
  const idle = (hrId: string, name: string, teamMrCount: number | null): DoubleVisitIdleManager => ({
    areaName: null,
    hrId,
    lineName: "CNS",
    name,
    role: "District Sales Manager",
    roleCode: "DSM",
    teamMrCount,
  });
  const dvRows = ceoDvManagerRows([active], [idle("b-99", "Idle Boss", 4), idle("b-10", "Saad Salama", 5), idle("b-98", "No Team", 0)]);
  assert.deepEqual(
    dvRows.map((row) => row.managerName),
    ["Saad Salama", "Idle Boss", "No Team"],
    "a manager with zero double visits must appear in the CEO table, and a manager already listed must not appear twice",
  );
  const idleRow = dvRows.find((row) => row.managerHrId === "b-99");
  assert.equal(idleRow?.distinctMrs, 0, "an idle manager visited nobody");
  assert.equal(idleRow?.neglectedMrCount, 4, "an idle manager's whole team is neglected");
  assert.equal(idleRow?.neglectIndex, 1, "an idle manager with a team reads 100% neglected, so the default sort puts him first");
  assert.equal(idleRow?.coveragePct, 0, "an idle manager with a team covered 0%");
  const noTeamRow = dvRows.find((row) => row.managerHrId === "b-98");
  assert.equal(noTeamRow?.neglectIndex, null, "with no team there is no neglect ratio to invent");
  assert.equal(dvRows[0].neglectIndex, 0.4, "an active manager's row is unchanged");

  const directory = [
    { hrId: "AA", managerHrId: null, displayName: "Anwar Gaweesh", fullName: "Anwar Gaweesh", jobTitle: "Chief Executive Officer" },
    { hrId: "B-20", managerHrId: "AA", displayName: "Head Office Lead", fullName: "Head Office Lead", jobTitle: "Finance Manager" },
    { hrId: "B-21", managerHrId: "B-20", displayName: "Accountant", fullName: "Accountant", jobTitle: "Accountant" },
    { hrId: "D-1", managerHrId: "AA", displayName: "Field Manager", fullName: "Field Manager", jobTitle: "District Sales Manager" },
    { hrId: "M-1", managerHrId: "d1", displayName: "Rep", fullName: "Rep", jobTitle: "Medical Representative" },
    { hrId: "S-1", managerHrId: "S-1", displayName: "Self Report", fullName: "Self Report", jobTitle: null },
  ];
  const candidates = managerOnLeaveCandidates(directory);
  assert.deepEqual(
    candidates.map((candidate) => candidate.hrId),
    ["AA", "D-1", "B-20"],
    "every active person someone reports to is a candidate — head office and field force alike — and nobody else",
  );
  assert.equal(
    candidates.find((candidate) => candidate.hrId === "B-20")?.role,
    "Finance Manager",
    "a candidate is labelled with his job title",
  );
  const onLeave = managersOnLeaveToday(
    candidates,
    new Map([
      ["B20", new Set(["2026-10-20"])],
      ["D1", new Set(["2026-10-19"])],
    ]),
    "2026-10-20",
  );
  assert.deepEqual(
    onLeave.map((candidate) => candidate.name),
    ["Head Office Lead"],
    "a head-office manager on leave today must be counted; leave on another day must not",
  );

  const source = stripComments(readFileSync("src/lib/ceo/command-center.ts", "utf8"));
  assert.match(
    source,
    /managerRows: ceoDvManagerRows\(dv\.managerSummaries, dv\.executiveSummary\.idleManagers\)/,
    "the CEO double-visit table must be built with the idle managers",
  );
  assert.match(
    source,
    /getEmployeeDirectoryRows\(\{ includeInactive: false \}\)/,
    "the managers-on-leave candidates must come from the active employee directory",
  );
  assert.doesNotMatch(
    source,
    /dv\.managerSummaries\.map\(\(s\) => s\.managerHrId\)/,
    "the managers-on-leave lookup must never again be limited to the double visitors",
  );
}
