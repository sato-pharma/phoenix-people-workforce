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
  recruitmentDeskAlertRoles,
  recruitmentManageRoles,
} from "../src/lib/recruitment/access.ts";
import {
  noticeFetchLimit,
  noticeHiddenFromSeat,
  seatNeedsOtherKindsRead,
  seatNoticeWindow,
  TALENT_ACQUISITION_FLOODING_EVENT_TYPE,
  TALENT_ACQUISITION_HIDDEN_EVENT_TYPES,
} from "../src/lib/notifications/seat-notice-filter.ts";
import { stripComments } from "./support/comment-strip.ts";
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
    ["recruiting", "cv_lookup", "employee_requests", "workforce_context", "recognition", "team_reminders"],
    "the Talent Acquisition seat is the recruiting pipeline, CV lookup, the two request desks, read-only workforce context, and the HR team's shared reminders (owner, 2026-10-17)",
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
  // 2026-10-16 narrowed that to ONE alert: her notification center holds a new CV, an interview
  // request and an accepted offer, so the new-CV sender alone reads the list she is on and every
  // other recruitment alert reads the desk list without her.
  assert.ok(!(recruitmentDeskAlertRoles as readonly string[]).includes(SEAT), "the other recruitment alerts do not address her");
  const notifySource = source("src/lib/recruitment/inbound/recruitment-notify.ts");
  assert.equal(
    (notifySource.match(/hrIdsForRoles\(recruitmentAlertRoles\)/g) ?? []).length,
    1,
    "exactly one sender in recruitment-notify.ts reads the audience she is on: the new-CV alert",
  );
  assert.ok(
    (notifySource.match(/hrIdsForRoles\(recruitmentDeskAlertRoles\)/g) ?? []).length >= 6,
    "every other alert in recruitment-notify.ts reads the desk list",
  );
  for (const reader of [
    "src/lib/recruitment/stale-send-check.ts",
    "src/lib/recruitment/triage-backlog-check.ts",
  ]) {
    assert.match(source(reader), /recruitmentDeskAlertRoles/, `${reader} reads the desk audience`);
    assert.doesNotMatch(source(reader), /recruitmentAlertRoles/, `${reader} must not address the Talent Acquisition seat`);
    assert.doesNotMatch(source(reader), /recruitmentManageRoles/, `${reader} must not fall back to the managers' list`);
  }
  // ...and the older alerts already written for her stay out of her band. A deny-list, so her own
  // personal notices (a vacation decision) are never taken with them, and only HER seat is touched.
  for (const type of TALENT_ACQUISITION_HIDDEN_EVENT_TYPES) {
    assert.equal(noticeHiddenFromSeat(SEAT, type), true, `${type} is hidden from her band`);
    for (const other of ["Super Admin", "HR Operations", "CEO"] as PhoenixRole[]) {
      assert.equal(noticeHiddenFromSeat(other, type), false, `${type} still reaches ${other}`);
    }
  }
  for (const kept of [
    "recruitment_inbound_cv",
    "interview_request_created",
    "accepted_offer_alert",
    "vacation_decision",
    null,
  ]) {
    assert.equal(noticeHiddenFromSeat(SEAT, kept), false, `${kept ?? "an untyped notice"} stays in her band`);
  }
  assert.equal(noticeFetchLimit(SEAT, 20) > 20, true, "her list reads past the notices it hides");
  assert.equal(noticeFetchLimit("Super Admin", 20), 20, "every other seat reads exactly the limit it asked for");
  assert.match(
    source("src/lib/notifications/in-app.ts"),
    /\.filter\(\(row\) => !noticeHiddenFromSeat\(access\.role, row\.event_type\)\)/,
    "the notice list drops her hidden kinds",
  );
  // A new CV reaches her about three times an hour, so a newest-20 window held nothing else after
  // seven hours: the two interview requests of 17 Oct 2026 sat at positions 23 and 24 of her feed
  // and neither the bell nor the band showed them (measured on production, 18 Oct 2026). The window
  // keeps room for every other kind, whatever the new CVs do.
  {
    const cv = TALENT_ACQUISITION_FLOODING_EVENT_TYPE;
    const feed = [
      ...Array.from({ length: 30 }, (_, index) => ({ id: `cv-${index}`, event_type: cv })),
      { id: "request-2", event_type: "interview_request_created" },
      { id: "request-1", event_type: "interview_request_created" },
      { id: "offer", event_type: "accepted_offer_alert" },
      { id: "personal", event_type: null },
    ];
    const hers = seatNoticeWindow(SEAT, feed, 20).map((row) => row.id);
    assert.equal(hers.length, 20, "her window is still the 20 the band serves");
    for (const kept of ["request-2", "request-1", "offer", "personal"]) {
      assert.ok(hers.includes(kept), `${kept} stays in her window under a flood of new CVs`);
    }
    assert.deepEqual(
      hers,
      feed.map((row) => row.id).filter((id) => hers.includes(id)),
      "the window keeps newest-first order",
    );
    assert.equal(hers.filter((id) => id.startsWith("cv-")).length, 16, "the new CVs take the rest of the window");
    assert.deepEqual(
      seatNoticeWindow("Super Admin", feed, 20).map((row) => row.id),
      feed.slice(0, 20).map((row) => row.id),
      "every other seat is served exactly the newest 20",
    );
    assert.equal(
      seatNoticeWindow(SEAT, feed.slice(0, 30), 20).length,
      20,
      "with no other kind to hold room for, the new CVs fill her window",
    );
    assert.equal(seatNoticeWindow(SEAT, feed.slice(30), 20).length, 4, "a short feed is served whole");
    assert.equal(seatNeedsOtherKindsRead(SEAT), true, "her list reads her other kinds on their own");
    assert.equal(seatNeedsOtherKindsRead("Super Admin"), false, "no other seat pays for that second read");
    const listSource = stripComments(source("src/lib/notifications/in-app.ts"));
    assert.match(listSource, /seatNoticeWindow\(access\.role, newestFirst, boundedLimit\)/, "the list is cut by the seat window");
    assert.match(
      listSource,
      /seatNeedsOtherKindsRead\(access\.role\)[\s\S]{0,400}event_type\.neq\.\$\{TALENT_ACQUISITION_FLOODING_EVENT_TYPE\}/,
      "her other kinds are read on their own, so an old interview request is still reachable",
    );
  }
  // "Open all four": Needs You, WhatsApp Inbox, Milestones and Spotlight — Needs You was TAKEN BACK
  // on 2026-10-16 ("remove needs you and hide from ta account"), the other three stand.
  assert.deepEqual([...(grants.spotlight ?? [])], ["read", "export"], "Spotlight, as the Super Admin holds it");
  assert.deepEqual([...(grants.milestones ?? [])], ["read", "export"], "Milestones, as the Super Admin holds it");
  assert.equal(canUseWhatsAppInbox(her), true, "the WhatsApp Inbox admits her");
  for (const other of ["HR Operations", "CEO"] as PhoenixRole[]) {
    assert.equal(canUseWhatsAppInbox(accessFor(other)), false, `the WhatsApp Inbox still refuses ${other}`);
  }
  // Needs You: the owner took it back from her on 2026-10-16. The page's own gate is the security
  // boundary (the sidebar is UX only), so it must not name her, and neither sidebar catalogue may
  // offer her a row for it.
  const needsYouPage = source("app/(admin)/admin/needs-you/page.tsx");
  assert.doesNotMatch(needsYouPage, /HR Resourcing/, "the Needs You page no longer admits her");
  assert.match(
    needsYouPage,
    /if \(!canAccessSystemAdministratorWorkspace\(access\)\) \{\s*redirect\("\/admin"\);/,
    "the Needs You page is the system administrator's alone and redirects everyone else",
  );
  const navigation = source("src/config/system-navigation.ts");
  assert.doesNotMatch(navigation, /href: "\/hr\/admin\/needs-you"/, "the HR sidebar offers her no Needs You row");
  assert.match(
    navigation,
    /href: "\/admin\/needs-you", icon: BellRing, label: "Needs You", roles: \["Super Admin"\]/,
    "the admin sidebar's Needs You row is the Super Admin's alone",
  );
  // Her rail's one-row section (Overview) is an ORDINARY row: owner, 2026-10-16, "make the overview
  // button in her sidebar … its appearance is diff than others" — the hub arrow and tint made it read
  // as a different kind of button from every row around it. The HR shell draws one-row sections plain.
  const sidebarSource = source("src/components/layout/sidebar.tsx");
  assert.match(
    sidebarSource,
    /plainSingleRow=\{mode === "hr"\}/,
    "the HR shell tells every section block to draw a one-row section as an ordinary row",
  );
  assert.match(
    sidebarSource,
    /standalone={!flatSidebar && !tiled && !plainSingleRow}/,
    "a one-row section in the HR shell carries no hub arrow and no hub tint",
  );
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
  // The role list AS OF that migration: every role except the HR Operations Specialist seat (HR
  // Administration), which the 2026-10-20 migration below added. A migration is history and is never
  // edited, so this pins what it wrote rather than what phoenixRoles holds today.
  const rolesOn20261008 = phoenixRoles.filter((role) => role !== "HR Administration");
  for (const names of arrays) {
    assert.deepEqual(names, [...rolesOn20261008], "each constraint lists phoenixRoles as of 2026-10-08 exactly, in order");
  }
  // ...and the newest constraint migration lists phoenixRoles exactly, so an account can be given
  // every role the code knows and none it does not.
  const latestRoleMigration = source("supabase/migrations/20261020064831_hr_operations_specialist_seat.sql");
  const latestArrays = [...latestRoleMigration.matchAll(/array\[([^\]]*)\]/g)]
    .map((match) => [...match[1].matchAll(/'([^']+)'/g)].map((name) => name[1]))
    .filter((names) => names.length > 1);
  assert.equal(latestArrays.length, 3, "the 2026-10-20 migration re-adds the three role CHECK constraints");
  for (const names of latestArrays) {
    assert.deepEqual(names, [...phoenixRoles], "each 2026-10-20 constraint lists phoenixRoles exactly, in order");
  }
  assert.match(latestRoleMigration, /insert into public\.roles[\s\S]*'hr_administration',\s*'HR Administration'/);
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
  assert.deepEqual(
    rail.map((section) => section.label),
    ["Overview", "People", "Recruitment", "WhatsApp & Posts", "Employee Requests", "Calendars", "Probation", "Performance", "My Requests"],
    "four People rows, then her job, and every heading names what she finds under it",
  );
  assert.deepEqual(
    rail.find((section) => section.id === "hr-people")?.items.map((row) => row.label),
    ["Employee 360", "Organogram", "Vacancies Report", "CV Lookup"],
    "People holds the people pages only — the request desks have their own heading",
  );
  assert.deepEqual(
    rail.find((section) => section.id === "hr-probation")?.items.map((row) => row.label),
    ["Probation Dashboard", "Probation Analytics"],
    "her Probation heading holds the two pages she reads — the hub row opened a page of those same two rows and is gone (owner, 2026-10-16)",
  );
  assert.equal(
    rail.some((section) => section.items.some((row) => row.href === "/hr/admin/ceo-probation")),
    false,
    "no row on her rail opens the Probation hub",
  );
  assert.equal(
    railFor("HR Operations").find((section) => section.id === "hr-attendance")?.label,
    "Attendance & Calendars",
    "the Calendars heading is hers alone — HR Operations works attendance under that band",
  );
  assert.equal(
    railFor("HR Operations").some((section) => section.id === "hr-outreach"),
    false,
    "HR Operations is never shown the WhatsApp & Posts heading — it holds no recruitment grant",
  );
}
