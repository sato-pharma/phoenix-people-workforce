import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  displayTitleForRole,
  hrBundleGrants,
  HR_ROLE_BUNDLES,
  HR_SEAT_JOB_TITLES,
  UNASSIGNED_HR_FUNCTIONS,
} from "../src/lib/auth/hr-functions.ts";
import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import {
  buildPermissionLookup,
  hrAuthorityRoles,
  hrNamespaceRoles,
  permissionMatrix,
  phoenixRoles,
  scopeForRole,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  assertPageOpenForRole,
  hrefOutsideSeatFence,
  isPageFencedForRole,
  SEAT_PAGE_FENCES,
} from "../src/lib/auth/seat-page-fences.ts";
import { canPrintBusinessCards } from "../src/lib/business-cards/access.ts";
import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections, navigationItemVisible, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  canExportProbation,
  canReadAllProbation,
  canViewAllProbation,
  canViewProbationAnalytics,
} from "../src/lib/probation/service.ts";
import {
  canReviewCandidateContacts,
  canSendWhatsAppTemplate,
  canViewInboundIntakeHealth,
  canViewWhatsAppOutboundLog,
  recruitmentAlertRoles,
  recruitmentManageRoles,
} from "../src/lib/recruitment/access.ts";
import { canViewOrganogramSensitiveFields } from "../src/lib/reports/organogram.ts";
import { canSeeDoctorCoverage, DOCTOR_COVERAGE_PORTAL_ROLES } from "../src/lib/crm/doctor-coverage-roles.ts";
import { seesWholeInterviewCalendar } from "../src/lib/recruitment/interview-calendar-types.ts";
import { canUseWhatsAppInbox } from "../src/lib/whatsapp-inbox/access.ts";

/**
 * The Talent Acquisition seat — role key "HR Resourcing" — built 2026-10-08 from the owner's own
 * ticks on the access blueprint. This pins what he chose, so a later edit cannot quietly hand her a
 * page he left out or take away one he ticked:
 *
 *   1. what the seat is composed of, and what it must NOT hold (employment documents, payroll,
 *      contracts, retention, the directory);
 *   2. the page fences — every page one of her keys opens that he did not tick — and the places
 *      that read them (the sidebar filter and AppShell), plus the API routes of fenced pages;
 *   3. the narrow by-name widenings: probation READ without export, the recruitment screens without
 *      the recruitment ALERT audience, Business Cards on the request desk rather than documents;
 *   4. the migration that lets an account be given the role at all.
 */

const SEAT = "HR Resourcing" as PhoenixRole;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function accessFor(role: PhoenixRole): AccessContext {
  return { role, scope: scopeForRole(role), hrId: "HR-SEAT-TEST", source: "session" } as AccessContext;
}

function source(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

export async function runHrResourcingSeatTests() {
  // ── 1. The composition and what it withholds ──────────────────────────────────────────────
  assert.deepEqual(
    [...HR_ROLE_BUNDLES["HR Resourcing"]],
    ["recruiting", "cv_lookup", "employee_requests", "workforce_context", "recognition"],
    "the Talent Acquisition seat is the recruiting pipeline, CV lookup, the two request desks and read-only workforce context",
  );
  assert.equal(HR_SEAT_JOB_TITLES["HR Resourcing"], "Talent Acquisition");
  assert.equal(displayTitleForRole("HR Resourcing"), "Talent Acquisition", "the key never reaches a person");
  assert.equal(resolveLandingPathForRole("HR Resourcing"), "/hr/admin/hr-command-center");
  assert.ok((phoenixRoles as readonly string[]).includes(SEAT), "HR Resourcing is a real role");
  assert.ok(hrNamespaceRoles.has(SEAT), "HR Resourcing works in the /hr namespace");
  assert.ok((hrAuthorityRoles as readonly string[]).includes(SEAT), "HR Resourcing is an HR authority role");

  const grants = hrBundleGrants("HR Resourcing") as Record<string, readonly string[] | undefined>;
  for (const withheld of [
    // Contracts and salary letters — the owner left Hiring Documents and HR Forms out of her seat.
    "employee_documents",
    "account_activation",
    "employees",
    "payroll",
    "deductions",
    "contracts",
    "retention",
    "resignations",
  ]) {
    assert.equal(grants[withheld], undefined, `the Talent Acquisition seat must not hold ${withheld}`);
  }
  assert.ok(grants.recruitment?.includes("approve"), "she may mark an application hired (owner: hire = yes)");
  assert.ok(grants.offers?.includes("create") && grants.offers?.includes("update"), "she builds and sends offers");
  assert.ok(!grants.offers?.includes("approve"), "she never approves an offer (owner: build, never approve)");
  for (const readOnly of ["organogram", "weekly_plans", "hr_calendar", "early_birds", "probation", "crm_visits"]) {
    assert.deepEqual([...(grants[readOnly] ?? [])], ["read"], `${readOnly} is reference for her, read only`);
  }

  // The split that made this seat possible: employment paperwork left `recruiting` for its own
  // function, so moving recruiting here never dragged contracts with it. When the HR Business
  // Partner seat was retired (2026-10-08) the paperwork stayed OFF this seat — it is one of the
  // functions left with the Super Admin ("Leave it for system administrator now").
  assert.ok(UNASSIGNED_HR_FUNCTIONS.includes("hiring_paperwork"), "the hiring paperwork is the Super Admin's");
  assert.equal(
    (HR_ROLE_BUNDLES["HR Resourcing"] as readonly string[]).includes("hiring_paperwork"),
    false,
    "and not this seat's",
  );

  // ── 2. The fences ─────────────────────────────────────────────────────────────────────────
  const fenced = [
    "/cv-database",
    "/recruitment/returned-cvs",
    "/recruitment/intake-health",
    "/recruitment/contact-review",
    "/recruitment/cv-lifecycle-sheet",
    "/probation",
    "/admin/weekly-plans",
    "/admin/approvals/plan",
    "/admin/field-workforce-compliance",
    "/admin/pm-products",
    "/attendance/analytics",
    "/attendance/disputes",
    "/attendance/employee-day-report",
    "/attendance/exceptions",
    "/attendance/fingerprint-report",
    "/attendance/weekly-review",
    "/leave-management/vacation-request",
    "/admin/payslips-center",
  ];
  assert.deepEqual(
    [...(SEAT_PAGE_FENCES["HR Resourcing"] ?? [])].sort(),
    [...fenced].sort(),
    "the fence list is exactly what the owner left out",
  );
  for (const page of fenced) {
    assert.ok(isPageFencedForRole(SEAT, page), `${page} is fenced for her`);
    assert.ok(isPageFencedForRole(SEAT, `/hr${page}`), `/hr${page} is fenced for her`);
    assert.ok(isPageFencedForRole(SEAT, `/hr${page}/?tab=1`), `/hr${page} with a trailing slash and a query is fenced for her`);
    for (const other of ["HR Advisory", "HR Operations", "Super Admin", "CEO"] as PhoenixRole[]) {
      assert.ok(!isPageFencedForRole(other, page), `the fence is HER seat's only — ${other} keeps ${page}`);
    }
  }
  assert.ok(isPageFencedForRole(SEAT, "/hr/admin/approvals/plan/abc"), "a detail page of a fenced list is fenced");
  // Exact, not prefix: the pages he DID tick beside a fenced one stay open.
  for (const open of [
    "/probation/dashboard",
    "/probation/analytics",
    "/admin/weekly-plans/calendar",
    "/workspace/fingerprint-report",
    "/workspace/leave-management/vacation-request",
    "/recruitment",
    "/recruitment/screening",
    "/business-cards",
  ]) {
    assert.ok(!isPageFencedForRole(SEAT, open), `${open} was ticked and stays open`);
    assert.ok(!isPageFencedForRole(SEAT, `/hr${open}`), `/hr${open} was ticked and stays open`);
  }
  assert.ok(
    !isPageFencedForRole(SEAT, resolveLandingPathForRole(SEAT)),
    "her landing page is never fenced — AppShell redirects a fenced address there",
  );

  assert.equal(hrefOutsideSeatFence(SEAT, "/hr/cv-database?candidate=1"), "/hr/recruitment");
  assert.equal(hrefOutsideSeatFence(SEAT, "/probation"), "/probation/dashboard");
  assert.equal(hrefOutsideSeatFence(SEAT, "/hr/admin/weekly-plans"), "/hr/admin/weekly-plans/calendar");
  assert.equal(hrefOutsideSeatFence(SEAT, "/hr/attendance/exceptions"), null, "a fenced page with no honest sibling is dropped");
  assert.equal(hrefOutsideSeatFence("HR Operations", "/hr/cv-database"), "/hr/cv-database");

  const everyKey = new Proxy({}, { get: () => true }) as PermissionLookup;
  const cvDatabaseRow = { href: "/hr/cv-database", icon: null, label: "CV Database" } as unknown as Parameters<
    typeof navigationItemVisible
  >[0];
  assert.equal(navigationItemVisible(cvDatabaseRow, everyKey, SEAT), false, "the sidebar never offers her a fenced row");
  assert.equal(navigationItemVisible(cvDatabaseRow, everyKey, "HR Operations"), true, "the same row stays for every other seat");

  assert.throws(() => assertPageOpenForRole(SEAT, "/hr/recruitment/returned-cvs"), /^Error: Forbidden:/);
  assert.doesNotThrow(() => assertPageOpenForRole("Super Admin", "/recruitment/returned-cvs"));

  // The bounce, and the check that makes it terminate. Until 2026-10-12 this pinned the redirect
  // alone and the "landing is never fenced" half lived only in the assertion above, so fencing a
  // seat's landing page would have sent every address to a page this same block fences again.
  assert.match(
    source("src/components/layout/app-shell.tsx"),
    /isPageFencedForRole\(access\.role, fencedPath\)\)\s*\{\s*const landing = resolveLandingPathForRole\(access\.role\);\s*if \(!isPageFencedForRole\(access\.role, landing\)\)\s*\{\s*redirect\(landing\)/,
    "AppShell sends a typed or bookmarked fenced address to the seat's landing page, and only when that landing page is not itself fenced",
  );
  for (const [route, page] of [
    ["app/api/recruitment/district-returns/[id]/resolve/route.ts", "/recruitment/returned-cvs"],
    ["app/api/cv-database/template/route.ts", "/cv-database"],
    ["app/api/recruitment/cv-lifecycle/share-links/route.ts", "/recruitment/cv-lifecycle-sheet"],
    ["app/api/recruitment/intake/analytics/route.ts", "/recruitment/intake-health"],
    ["app/api/recruitment/intake/retry/route.ts", "/recruitment/intake-health"],
  ] as const) {
    const text = source(route);
    const calls = text.split(`assertPageOpenForRole(access.role, "${page}")`).length - 1;
    const handlers = (text.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).length;
    assert.ok(handlers > 0, `${route}: no handler found — the route moved`);
    assert.equal(calls, handlers, `${route}: every handler refuses a seat fenced off ${page}`);
  }

  // ── 3. The by-name widenings stay narrow ──────────────────────────────────────────────────
  const her = accessFor(SEAT);
  assert.equal(canReadAllProbation(her), true, "she reads the probation dashboard and analytics");
  assert.equal(canViewProbationAnalytics(her), true);
  assert.equal(canViewAllProbation(her), false, "canViewAllProbation is the administrators' gate and was not widened");
  assert.equal(canExportProbation(her), false, "she was not given the company-wide probation export");

  // The owner's four answers in chat on 2026-10-08, each pinned at the gate that carries it.
  // Recruitment alerts: "Add her now". The managers' list stays without her — it also opens Inbound
  // Intake Health and Missing Contact Details, which he left out — so the alert list is its own.
  assert.ok((recruitmentAlertRoles as readonly string[]).includes(SEAT), "she receives the recruitment alerts");
  assert.ok(
    !(recruitmentManageRoles as readonly string[]).includes(SEAT),
    "the managers' list stays without her: it is also the gate of two screens he left out",
  );
  for (const reader of [
    "src/lib/recruitment/inbound/recruitment-notify.ts",
    "src/lib/recruitment/stale-send-check.ts",
    "src/lib/recruitment/triage-backlog-check.ts",
  ]) {
    assert.match(source(reader), /recruitmentAlertRoles/, `${reader} reads the alert audience`);
    assert.doesNotMatch(source(reader), /recruitmentManageRoles/, `${reader} must not fall back to the managers' list`);
  }
  // "Open all four": Needs You, WhatsApp Inbox, Milestones and Spotlight.
  assert.deepEqual([...(grants.spotlight ?? [])], ["read", "export"], "Spotlight, as the Super Admin holds it");
  assert.deepEqual([...(grants.milestones ?? [])], ["read", "export"], "Milestones, as the Super Admin holds it");
  assert.equal(canUseWhatsAppInbox(her), true, "the WhatsApp Inbox admits her");
  for (const other of ["HR Operations", "CEO"] as PhoenixRole[]) {
    assert.equal(canUseWhatsAppInbox(accessFor(other)), false, `the WhatsApp Inbox still refuses ${other}`);
  }
  assert.match(
    source("app/(admin)/admin/needs-you/page.tsx"),
    /!canAccessSystemAdministratorWorkspace\(access\) && access\.role !== "HR Resourcing"/,
    "the Needs You page admits her beside the Super Admin",
  );
  const needsYouSources = source("src/lib/needs-you/sources.ts");
  for (const queue of ["monthlyClosings", "salaryFlags", "orphanedRequests"]) {
    const body = needsYouSources.slice(needsYouSources.indexOf(`const ${queue}: NeedsYouAdapter`));
    assert.match(
      body.slice(0, 600),
      /ownerOnlyQueue\(access,/,
      `${queue} reads company-wide state with no permission of its own, so it must answer "not yours" to her`,
    );
  }
  // KPIs: "Give her KPIs" — a company seat, admin shell, not the portal.
  assert.equal(canSeeDoctorCoverage(SEAT), true, "the KPIs board admits her");
  assert.ok(!DOCTOR_COVERAGE_PORTAL_ROLES.includes(SEAT), "she reaches KPIs in the admin shell, not the portal");
  // Interview Calendar: "Full view built into her seat" — a Viewer, like the CEO.
  assert.equal(seesWholeInterviewCalendar(her), true, "she sees every interview");
  assert.equal(seesWholeInterviewCalendar(accessFor("HR Operations")), false, "the other HR seat is not widened");
  // "Just build the account. I will add her later." (owner, 2026-10-08): the seat is handed out in
  // User Access, so its picker has to offer it by the title he will look for — "Talent Acquisition" —
  // and never by its key. The option VALUE stays the key; only the words change.
  const userAccess = source("src/components/admin/access-control-manager.tsx");
  assert.match(
    userAccess,
    /<option key=\{role\} value=\{role\}>\s*\{displayTitleForRole\(role\)\}\s*<\/option>/,
    "the User Access role picker offers each seat by its job title",
  );
  assert.doesNotMatch(
    userAccess,
    /<option key=\{role\} value=\{role\}>\s*\{role\}\s*<\/option>/,
    "no role picker on User Access may print the bare key",
  );
  assert.equal(canViewWhatsAppOutboundLog(her), true);
  assert.equal(canSendWhatsAppTemplate(her), true);
  assert.equal(canViewInboundIntakeHealth(her), false, "Inbound Intake Health was left out");
  assert.equal(canReviewCandidateContacts(her), false, "Missing Contact Details was left out");

  assert.equal(canViewOrganogramSensitiveFields(her), false, "the money on an organogram node stays with the payroll seats");

  assert.equal(await canPrintBusinessCards(her), true, "she prints business cards from the request desk");
  for (const seat of ["HR Operations"] as PhoenixRole[]) {
    assert.equal(await canPrintBusinessCards(accessFor(seat)), true, `${seat} still prints business cards`);
  }
  assert.equal(await canPrintBusinessCards(accessFor("Medical Rep")), false, "printing stays with HR seats");

  // ── 4. The migration that opens the role in the database ──────────────────────────────────
  const migration = source("supabase/migrations/20261008193000_hr_resourcing_role_key.sql");
  const arrays = [...migration.matchAll(/array\[([^\]]*)\]/g)].map((match) =>
    [...match[1].matchAll(/'([^']+)'/g)].map((name) => name[1]),
  );
  assert.equal(arrays.length, 3, "the three role CHECK constraints are re-added");
  for (const names of arrays) {
    assert.deepEqual(names, [...phoenixRoles], "each constraint lists phoenixRoles exactly, in order");
  }
  assert.match(migration, /insert into public\.roles[\s\S]*'hr_resourcing',\s*'HR Resourcing'/);
  assert.doesNotMatch(
    migration,
    /update\s+public\.notification_role_policies|insert\s+into\s+public\.notification_role_policies/i,
    "no notification audience is changed",
  );

  // ── 5. Her rail, as it renders (premium sweep, 2026-10-16) ────────────────────────────────
  // The rail is the one thing she looks at all day, so what is pinned is its SHAPE rather than a
  // row list (the other suites pin every row's gate): no two rows share an icon — in the collapsed
  // rail the icon is all there is — no section is a wall, and the two places a reader looks first
  // are right: her own workspace opens its section, and the pipeline opens Recruitment.
  const railFor = (role: PhoenixRole) =>
    getSections(getNavigationSections("hr"), "hr", buildPermissionLookup(permissionMatrix, role), role);
  const rail = railFor(SEAT);
  const byIcon = new Map<unknown, string[]>();
  for (const row of rail.flatMap((section) => section.items)) {
    byIcon.set(row.icon, [...(byIcon.get(row.icon) ?? []), row.label]);
  }
  assert.deepEqual(
    [...byIcon.values()].filter((labels) => labels.length > 1),
    [],
    "no two rows on her rail share an icon",
  );
  for (const section of rail) {
    assert.ok(
      section.items.length <= 8,
      `"${section.label}" holds ${section.items.length} rows on her rail — split it, a crowded rail is the defect`,
    );
  }
  assert.deepEqual(
    rail.find((section) => section.id === "hr-recruitment")?.items.map((row) => row.label),
    ["Recruitment", "Screening Queue", "My Candidates", "Interview Calendar", "Job Offers", "Hiring Analytics", "Manager CV Engagement"],
    "Recruitment reads in the order the work runs",
  );
  assert.deepEqual(
    rail.find((section) => section.id === "hr-outreach")?.items.map((row) => row.label),
    ["WhatsApp Applicants", "WhatsApp Replies", "WhatsApp Inbox", "WhatsApp Templates", "Job Posts", "Screening Questions"],
    "the WhatsApp and posting tools are their own section",
  );
  assert.equal(
    rail.find((section) => section.id === "hr-self")?.items[0]?.label,
    "My Workspace",
    "her own workspace opens her own section",
  );
  assert.equal(
    railFor("HR Operations").some((section) => section.id === "hr-outreach"),
    false,
    "HR Operations is never shown the WhatsApp & Posts heading — it holds no recruitment grant",
  );
}
