import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { hrBundleGrants, HR_ROLE_BUNDLES, type HrBundleName } from "../src/lib/auth/hr-functions.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  resolveNavigationMode,
  scopeForRole,
  type AccessContext,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  blankOut,
  hasEntryExit,
  isShellGated,
  pageFileFor as resolvePageFile,
  permissionGateKeys,
  roleSetGates,
} from "./support/page-gate-reader.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * HR SEAT ROUTE COHERENCE — "nothing they are offered will bounce them".
 *
 * A permission matrix is checked one resource:action pair at a time, but a route handler is not
 * gated one pair at a time: POST /api/employees/[hrId]/resign asserts employees:update AND
 * resignations:create AND vacancies:create, all three, before it does anything. A seat holding two
 * of the three does not get two thirds of a resignation — it gets a 403, from a page its own
 * sidebar offered it.
 *
 * That is exactly what shipped. HR Operations owns offboarding (ops 6) and held
 * employees:update + resignations:create; HR Advisory held vacancies:create through recruiting.
 * NEITHER seat could record a single resignation, and no per-pair test could see it, because every
 * individual grant was correct on its own. The defect lived in the gap between them.
 *
 * So this test reads the ROUTES rather than the matrix: for every HTTP handler in app/api, if a
 * seat holds SOME of the permissions that handler asserts, it must hold ALL of them. Holding NONE
 * is fine and is the normal case — that is a boundary doing its job. Holding SOME is the bug shape.
 *
 * The second half makes the same claim one layer up, about PAGES. A page decides on arrival whether
 * to render or redirect, and it does not have to decide with a permission: /hr/admin/deductions
 * admitted {Super Admin, CEO} by name, so the HR sidebar offered HR Operations a Deductions link on
 * `deductions:read` — a grant she really holds — and the page sent her to /employee-portals. No
 * permission test could see that either, because the gate was never a permission. This half reads
 * each offered row's page, resolves whichever gate shape it uses, and requires the seat to pass it;
 * the shapes it cannot parse are listed by name rather than skipped, so "unchecked" can never be
 * mistaken for "fine".
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

type Handler = { method: string; body: string };

function handlers(source: string): Handler[] {
  const blank = blankOut(source);
  const found: Handler[] = [];
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(blank))) {
    let i = match.index + match[0].length - 1;
    let parens = 0;
    for (; i < blank.length; i += 1) {
      if (blank[i] === "(") parens += 1;
      else if (blank[i] === ")") {
        parens -= 1;
        if (parens === 0) {
          i += 1;
          break;
        }
      }
    }
    while (i < blank.length && blank[i] !== "{") i += 1;
    const start = i;
    let braces = 0;
    for (; i < blank.length; i += 1) {
      if (blank[i] === "{") braces += 1;
      else if (blank[i] === "}") {
        braces -= 1;
        if (braces === 0) {
          i += 1;
          break;
        }
      }
    }
    found.push({ method: match[1], body: source.slice(start, i) });
  }
  return found;
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/**
 * Handlers whose assertions are NOT one hard gate, so "some but not all" is correct there. Each
 * entry names a specific file and its reason — never a pattern, so a new offender cannot hide
 * behind an existing exemption.
 */
const NOT_A_HARD_GATE: Record<string, string> = {
  // Added 2026-10-20 with the HR Operations Specialist seat (HR Administration), which holds
  // employees:update and NOT employees:create (owner: she does not add an employee).
  "app/api/employees/route.ts":
    "POST asserts employees:update on every save and employees:create ONLY when the save carries no " +
    "originalHrId, which is an ADD. An edit therefore needs update alone, so a seat holding update " +
    "without create edits the master and is refused only the add, which the Employee screen hides " +
    "from her (canCreate). GET asserts employees:read alone",
};

/**
 * A seat that holds PART of a route's hard gate ON PURPOSE, keyed `<seat> <file> <METHOD>`. The
 * grant it holds is for OTHER routes; the route itself is one the owner kept away from the seat, so
 * what makes the split safe is that no screen offers her the button that calls it — and that is
 * pinned below rather than trusted. Each entry must still be partial, or it fails as stale.
 */
const DELIBERATELY_PARTIAL: Record<string, string> = {
  "HR Administration app/api/employees/[hrId]/resign/route.ts POST":
    "employees:update is hers for editing the Employee Master (owner, 2026-10-20). Recording a " +
    "resignation is not — the owner submits it and she follows it up — so she holds no " +
    "resignations:create and no vacancies:create, and the Employee screen must not offer her Resign",
  "HR Administration app/api/employees/[hrId]/decline-offer/route.ts POST":
    "the same three grants as Resign, for a hire who never joined. Recording that departure is the " +
    "owner's, like a resignation, and the Employee screen must not offer her Declined",
};

/** The dense resource:action lookup the shells build, so an absent grant reads false, never undefined. */
function lookupForSeat(seat: HrBundleName): PermissionLookup {
  const rolePermissions = permissionMatrix[seat as unknown as PhoenixRole];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/**
 * The minimum AccessContext resolveNavigationMode reads: it branches on `source`, `scope` and
 * `role`, nothing else. Built from the real scopeForRole rather than a literal, so a scope change
 * for either seat shows up here instead of being papered over by a hard-coded "self".
 */
function accessFor(seat: HrBundleName): AccessContext {
  const role = seat as unknown as PhoenixRole;
  return { role, scope: scopeForRole(role), hrId: "HR-SEAT-TEST", source: "session" } as AccessContext;
}

/** The HR shell mounts these pages under /hr, so the prefix is stripped before resolving. */
function pageFileFor(href: string): string | null {
  return resolvePageFile(href, { repoRoot: REPO_ROOT, stripHrPrefix: true });
}

/**
 * Indent for a multi-line assertion message, built from a char code rather than an escape. This
 * repository is edited through shells that halve backslashes in a heredoc (AGENTS.md 2.1), and a
 * swallowed escape here turns the separator into a real line break mid-template-literal — which is
 * a syntax error that takes the whole suite down before one test runs. It already did, once, while
 * this section was being written. tests/hr-function-governance.test.ts carries the same constant
 * for the same reason.
 */
const NAV_SEP = String.fromCharCode(10) + "  ";

/**
 * The fewest HR rail rows a seat can be offered before the shell is assumed broken: 10, except for
 * the HR Operations Specialist (HR Administration, 2026-10-20), a deliberately narrow seat. Her rail
 * read on that day as Overview, Employee Directory, Organogram, Contract Renewal, Resignations, HR
 * Reminders, Request Vacation, Submit Excuse and Report It — nine — with company attendance,
 * Employee 360, the deductions and the Payslips Center fenced off her (seat-page-fences.ts).
 */
const HR_RAIL_FLOOR: Partial<Record<HrBundleName, number>> = { "HR Administration": 8 };

/**
 * The gate patterns and both readers now live in tests/support/page-gate-reader.ts. They moved there
 * on 2026-08-29 because every-offered-link-opens.test.ts had grown a second, weaker copy: measured
 * across the 377 page files, this reader saw a gate on 157 pages and that one on 86. Its misses were
 * fail-OPEN — a gate it could not parse read as "this page needs no grant" — so the two parsers
 * disagreeing was not a tidiness problem. See that module's header for the full account.
 */

/**
 * Pages an HR seat is offered whose entry gate this file cannot read, each hand-verified on
 * 2026-08-28 against both seats by calling the gate's own predicate. They are listed rather than
 * skipped: an unreadable gate that nobody has written down is an unchecked page, and the assertion
 * below requires this list to match the unreadable set EXACTLY — so a new unreadable page fails
 * loudly, and one that becomes readable has to be removed from here.
 */
const GATE_SHAPE_NOT_MACHINE_READABLE: Record<string, string> = {
  "/hr/admin/hr-command-center":
    "hrBundleForRole(access.role) — the same lookup that decides the seat's grants, so it admits " +
    "exactly the two seats by construction rather than by a second list agreeing with the first",
  "/hr/probation": "canReadAllProbation(access) — true for both seats",
  // NO distribution-lists / sato-email entries since 2026-10-08. Both /hr rows carried
  // roles: ["HR Advisory"] alone — the owner gave the HR Business Partner those two screens on
  // 2026-09-11 and 2026-09-12 — and both rows left the HR shell when he retired that seat. The pages
  // and their admin-shell entries are untouched; the Super Admin reaches them there.
  // All three added 2026-09-01 with the owner's module opening, and all three verified by CALLING
  // the predicate for each seat rather than by reading it.
  "/hr/probation/dashboard":
    "canReadAllProbation(access) — the same predicate as /hr/probation above, true for BOTH seats. " +
    "The page is the read-only outcomes view of the tracker beside it and has no write path",
  "/hr/admin/weekly-plans/calendar":
    'an OR chain — canAccess(weekly_plans, read) || role is CEO || role is Super Admin — which is ' +
    "why it cannot be parsed. TRUE for BOTH seats after the two 2026-09-01 changes were merged: " +
    "Advisory has held weekly_plans:read all along through workforce_insight, and Operations gained " +
    "it that day through time_attendance at the owner's request. The row therefore carries no roles " +
    "gate. Read-only either way — approving a plan belongs to the sales ladder and neither seat " +
    "holds any weekly_plans write action",
  // The rebuilt Recruitment workspace (owner, 2026-10-20) gates on the named workspace viewer rather
  // than a resource, because it also admits the CEO read-only without candidates:read.
  "/hr/recruitment":
    "workspaceViewer(access).canRead — TRUE for HR Resourcing (a work role that may decide, send and " +
    "file). HR Operations holds no recruitment grant, so the row never renders for it",
  "/hr/recruitment/manager-engagement":
    "canViewManagerCvEngagement(access) — a ROLE SET, not a resource, so the row carries roles: " +
    '["HR Advisory"] beside its recruitment permission and the two must be read together. TRUE for ' +
    "Advisory by the owner's own amendment that day, FALSE for Operations. The report is read-only " +
    "and holds no salary, personnel record or payroll figure" +
    ". Since 2026-10-08 the row also names HR Resourcing, and the predicate is TRUE for her (called, not read)",
  "/hr/recruitment/mr-hiring":
    "mrViewer(access).readsAll — a ROLE SET (Super Admin, HR Resourcing, CEO), not a resource, beside " +
    "the row's recruitment:read. TRUE for HR Resourcing, who works the Medical Rep workflow; FALSE for " +
    "HR Operations, which the row never names and the page redirects to the portal. Both called, not " +
    "read, in tests/recruitment-mr-hiring-access.test.ts. The NSM's salary reaches her by the owner's " +
    "answer of 7 Nov 2026",
  // NO contact-review / intake-health entries. Both were listed here while the rail carried them;
  // the owner cut both rows on 2026-09-01 as intake plumbing that crowded the sidebar, so there
  // is no longer an HR row pointing at either page and nothing for this map to answer for. The
  // PAGES and their gates are untouched — canReviewCandidateContacts and canViewInboundIntakeHealth
  // still admit Advisory — so if a row is ever restored, restore the two lines with it.
  "/hr/recruitment/whatsapp-replies":
    "canViewWhatsAppOutboundLog(access) — true for Advisory, the only seat offered it. Verified by " +
    "CALLING the predicate for each seat, not by reading it: recruitmentManageRoles is [Super Admin, " +
    "HR Advisory], and Operations holds no recruitment grant so the row is never offered to her" +
    ". TRUE for HR Resourcing since 2026-10-08 through recruitmentWorkRoles (called, not read)",
  // Added 2026-09-08 with the HR-shell row. The owner asked to "show this tab to the HR Business
  // Partner" — which is the JOB TITLE for the "HR Advisory" key, so her gate never needed widening;
  // what she lacked was a row in the shell she actually works in.
  "/hr/recruitment/whatsapp-templates":
    "canSendWhatsAppTemplate(access) — TRUE for Advisory, FALSE for Operations, and the row carries " +
    "roles: [\"HR Advisory\"] so Operations is never offered it. Verified by CALLING both predicates " +
    "for both seats rather than by reading them: Advisory send=true/manage=false, Operations " +
    "send=false/manage=false. The seat can SEND a message from a template but cannot rewrite what " +
    "the templates say — canManageWhatsAppTemplates admits the Super Admin and system scope only " +
    "(Advisory is scope=self and not the Super Admin), and the editor is hidden from her rather " +
    "than merely failing server-side, so no row her sidebar offers 403s her halfway" +
    ". HR Resourcing (2026-10-08) reads the same as Advisory: send=true/manage=false, called rather than read",
  // Added 2026-10-15 with the Job Posts page. Verified by CALLING the predicate for each seat, not
  // by reading it: the gate is canBuildJobPosts (system scope, or a role in recruitmentWorkRoles =
  // Super Admin + HR Resourcing), and the page carries an entry redirect this file cannot parse.
  "/hr/recruitment/job-posts":
    "canBuildJobPosts(access) — TRUE for HR Resourcing, the only seat offered the row (roles: " +
    "[\"HR Resourcing\"]), FALSE for Advisory and Operations. The API routes re-check the same " +
    "predicate, so no row her sidebar offers 403s her",
  // Added 2026-09-18 with the Interview Calendar row. The owner's own ruling that day: "Only you +
  // people you share with" — so the gate is the calendar's own sharing, not a permission, and that
  // is why it cannot be parsed.
  "/hr/recruitment/interview-calendar":
    "resolveInterviewCalendarRole(access) — owner for the Super Admin AND for HR Operations (the " +
    "owner made her the calendar's admin, 2026-09-21), otherwise the seat holder's row in " +
    "ats_interview_calendar_shares, otherwise null. Verified by CALLING the predicate for each seat " +
    "rather than by reading it: isInterviewCalendarOwner is TRUE for Operations and FALSE for " +
    "Advisory, so Operations opens it as an owner and Advisory needs a share row. Advisory is " +
    "offered the Recruitment row (permissions: [recruitment]); Operations, who holds no recruitment " +
    "grant and is never shown that heading, is offered a copy under People (roles: [HR Operations]). A null " +
    "role renders a plain 'not been shared with you' notice — never a redirect and never a 403 — " +
    "and every API route asserts the same gate, so the screen is presentation and never the boundary. " +
    "Talent Acquisition (HR Resourcing) is an owner too since 2026-10-21 (isInterviewCalendarOwner is TRUE " +
    "for her), so she opens it as an owner from the Recruitment row (permissions: [recruitment]) and needs " +
    "no share row",
  // Both added 2026-09-05 by the owner's ruling that no rail row may open a page of modules: each
  // was a card on the /hr/attendance hub, and the hub row that fronted them is gone, so they are
  // rail rows in their own right now. Both verified by CALLING the predicate for each seat rather
  // than by reading it, and both are offered to HR Operations only.
  "/hr/attendance/fingerprint-report":
    "canAccessFingerprintReport(access) — TRUE for both seats, though only Operations is offered the " +
    "row. The page reads attendance punches and the deduction each one implies; there is no write " +
    "path on it to withhold from her. FALSE for the HR Operations Specialist (HR Administration) " +
    "since 2026-10-20 — she is salary-blind and is not offered the row",
  "/hr/attendance/holiday-calendar":
    'canAccessAttendanceSetup(access, "read") — the same predicate as the two rows below, true for ' +
    "Operations, the only seat offered it. She also holds the setup UPDATE the page reads separately " +
    "and hands the manager component as canEdit, so the editing this one offers is real for her " +
    "rather than a control that 403s on use",
  "/hr/attendance/device-user-mapping": 'canAccessAttendanceSetup(access, "read") — true for Operations, the only seat offered it',
  "/hr/attendance/policies": 'canAccessAttendanceSetup(access, "read") — true for Operations, the only seat offered it',
  "/hr/admin/support-requests": "hoisted const canRead = await canAccess(access, support_requests, read) — true for both",
  "/hr/admin/business-card-requests": "hoisted const canRead = await canAccess(access, business_card_requests, read) — true for both",
  "/hr/offers": "destructured Promise.all, gate is !canRead = offers:read — true for Advisory, the only seat offered it",
  "/hr/hiring-documents":
    "destructured Promise.all, gate is isHiringPaperworkRole && employee_documents:read — true for " +
    "HR Operations and, since 2026-11-02, the HR Operations Specialist (hiring_desk)",
  "/hr/hiring-pack":
    "hrFormsAccessFor(access).canRead — for the HR authority seats the same isHrAuthorityRole && " +
    "employee_documents:read as before — true for HR Operations; HR Resourcing holds no " +
    "employee_documents and is not offered the row. Since 2026-11-02 it is ALSO true for the HR " +
    "Operations Specialist (HR Administration), who holds employee_documents through hiring_desk and " +
    "works the whole module; isHiringPaperworkRole admits her and her salary box is read only",
  // Both added 2026-08-29 with the owner's company-scope ruling, and both verified by CALLING the
  // predicate for each seat rather than by reading it: Operations true, Advisory false, on both.
  // Neither predicate is admitting her by scope — each short-circuits on scope === "system" only,
  // and hers is "company" — so membership of the reader set is the whole reason, which is what
  // makes it reviewable. The WRITE side is deliberately not moved with the read side.
  "/hr/admin/vacation-report":
    "canReadCompanyVacationReport(access) — true for Operations, false for Advisory; the row is " +
    "offered to Operations only. canApproveCompanyVacationReportRow is FALSE for her, so she reads " +
    "the report and approves nothing from it",
  // ── The Talent Acquisition seat (HR Resourcing), 2026-10-08 ─────────────────────────────────
  // Each row below is offered to HER ALONE (roles: ["HR Resourcing"], excludedRoles: ["Super
  // Admin"]), and each verdict was taken by CALLING the predicate for all three seats on 2026-10-08.
  "/hr/business-cards":
    "canPrintBusinessCards(access) (src/lib/business-cards/access.ts) — an HR seat holding " +
    "employee_documents:read, or HR Resourcing holding business_card_requests:update. TRUE for all " +
    "three seats; Advisory and Operations pass on employee_documents exactly as before, HR " +
    "Resourcing on the request desk — employee_documents is FALSE for her, so Hiring Documents and " +
    "HR Forms stay shut. POST /api/business-cards calls the same predicate",
  "/hr/admin/company-calendar":
    "an inline const allowed = Finance Manager || HR Resourcing || the HR Operations Specialist || " +
    "canAccessSystemAdministratorWorkspace — TRUE for the two seats offered it, FALSE for Operations. " +
    "A read: neither is in CALENDAR_MANAGER_ROLES, so /api/calendar refuses their edits",
  "/hr/admin/private-calendars":
    "canUsePrivateCalendarAdminSurface(access) -> isPrivateCalendarGlobalViewer — TRUE for HR " +
    "Resourcing and the HR Operations Specialist, the two seats offered it, FALSE for Advisory and " +
    "Operations",
  "/hr/probation/analytics":
    "canViewProbationAnalytics(access) — TRUE for all three seats through canReadAllProbation; offered " +
    "to HR Resourcing only. Read-only outcomes; the export gate (canExportProbation) is not hers",
  "/hr/recruitment/whatsapp-inbox":
    "canUseWhatsAppInbox(access) — Super Admin or HR Resourcing: TRUE for HR Resourcing, the only seat " +
    "offered it, FALSE for Advisory and Operations. Every /api/whatsapp-inbox route asks the same rule",
  "/hr/recruitment/hiring-analytics":
    "loadHiringAnalytics asserts candidates:read inside the domain module, behind the page's shell " +
    "gate — TRUE for HR Resourcing (and Advisory), FALSE for Operations; offered to HR Resourcing only",
  "/hr/admin/company-activity-report":
    "canReadCompanyActivityReport(access) — true for Operations, false for Advisory; the row is " +
    "offered to Operations only. The page is read-only, with no write path to withhold",
  // "/hr/admin/payroll-management", "/hr/attendance" and "/hr/leave-management" were all three here
  // until 2026-09-05. Every one of them was a HUB row, and the owner's ruling that day — "I don't
  // want any subtitle to be the one that when I press, it redirects me to a page with big modules"
  // — took all three off the rail and put their cards on it instead. This map answers only for rows
  // a rail still offers: a verdict kept for a route nobody is offered is a claim nothing re-checks,
  // which is the same reason approvals-hub and the two intake rows left it before them.
  //
  // The PAGES and their gates are untouched, so the verdicts stay true and are recorded here rather
  // than lost — payroll-management is still any-of payroll:read || payslips:read || deductions:read
  // and both seats hold deductions:read; the other two still carry a shell gate with no permission
  // gate underneath. If any of the three is ever a row again, its line comes back with it.
  // "/hr/admin/approvals-hub" was here until 2026-09-01. The row left the HR rail that day (owner:
  // "Remove other approvals from the sidebar"), and this map only covers rows the rail still
  // offers — a verdict kept for a route nobody is offered is a claim nothing re-checks. The ADMIN
  // rail keeps /admin/approvals-hub; if the /hr row is ever restored, its verdict comes back too.
};

/**
 * The SHELL gate (`isShellGated`) asks which shell the viewer belongs in, not what they may do, so
 * it is satisfied or not by the seat's role alone — and this file settles it by CALLING
 * resolveNavigationMode rather than assuming both seats are admin-shell roles. If either ever
 * stopped being one, every page carrying that line would close at once and the sidebar would go on
 * offering all of them.
 *
 * `hasEntryExit` is what separates "carries no entry gate at all" from "gated in a shape the reader
 * cannot parse". A page with no redirect and no notFound is not a defect: the admin shell is the
 * gate for those, and the row only renders for a seat the navigation already admitted.
 */

export async function runHrSeatRouteCoherenceTests() {
  const apiRoot = path.join(REPO_ROOT, "app", "api");
  const files = routeFiles(apiRoot);
  assert.ok(files.length > 300, `expected the whole api tree, found ${files.length} route files`);

  const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];
  const held = new Map<HrBundleName, Set<string>>();
  for (const seat of seats) {
    const grants = hrBundleGrants(seat);
    const keys = new Set<string>();
    for (const [resource, actions] of Object.entries(grants)) {
      for (const action of actions ?? []) keys.add(`${resource as PermissionResource}:${action as PermissionAction}`);
    }
    held.set(seat, keys);
  }

  let handlersScanned = 0;
  let gatedHandlers = 0;
  let multiGrantHandlers = 0;
  const failures: string[] = [];
  const partialSeen = new Set<string>();

  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const source = readFileSync(file, "utf8");
    for (const handler of handlers(source)) {
      handlersScanned += 1;
      const required = new Set<string>();
      const re = /assertPermission\(\s*[A-Za-z_$][\w$]*\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(handler.body))) {
        required.add(`${match[1]}:${match[2]}`);
      }
      if (required.size === 0) continue;
      gatedHandlers += 1;
      if (required.size < 2) continue;
      multiGrantHandlers += 1;
      if (NOT_A_HARD_GATE[relative]) continue;

      for (const seat of seats) {
        const seatKeys = held.get(seat)!;
        const has = [...required].filter((key) => seatKeys.has(key));
        if (has.length === 0 || has.length === required.size) continue;
        const partialKey = `${seat} ${relative} ${handler.method}`;
        if (DELIBERATELY_PARTIAL[partialKey]) {
          partialSeen.add(partialKey);
          continue;
        }
        const missing = [...required].filter((key) => !seatKeys.has(key));
        failures.push(
          `${relative} ${handler.method} requires ${[...required].sort().join(" + ")} — ` +
            `"${seat}" holds ${has.sort().join(", ")} but NOT ${missing.sort().join(", ")}, ` +
            "so a page offered to that seat 403s halfway",
        );
      }
    }
  }

  // Floors, so a walk that silently stopped finding routes cannot pass by scanning nothing.
  assert.ok(handlersScanned > 400, `expected the api handlers, found ${handlersScanned}`);
  assert.ok(gatedHandlers > 200, `expected assertPermission-gated handlers, found ${gatedHandlers}`);
  assert.ok(
    multiGrantHandlers >= 2,
    `expected handlers asserting more than one permission, found ${multiGrantHandlers}`,
  );

  assert.deepEqual(
    failures,
    [],
    `HR seat(s) hold PART of a route's permission set:\n  ${failures.join("\n  ")}`,
  );
  assert.deepEqual(
    Object.keys(DELIBERATELY_PARTIAL).filter((key) => !partialSeen.has(key)).sort(),
    [],
    "a DELIBERATELY_PARTIAL entry no longer matches a partial grant — the seat now holds all of the " +
      "route's permissions, or none, or the route moved. Remove the stale entry",
  );
  // The condition every DELIBERATELY_PARTIAL entry rests on: the Employee screen offers Resign and
  // Declined only to a viewer who can record a departure. Gated on canEdit (employees:update) alone,
  // both buttons render for the HR Operations Specialist and 403 her on press, so the page that
  // mounts the screen must read resignations:create and hand the screen that answer.
  const employeesPage = stripComments(
    readFileSync(path.join(REPO_ROOT, "app", "(admin)", "employees", "page.tsx"), "utf8"),
  );
  assert.ok(
    /canAccess\(\s*access\s*,\s*"resignations"\s*,\s*"create"\s*\)/.test(employeesPage),
    "app/(admin)/employees/page.tsx must read resignations:create and hide Resign and Declined from a " +
      "viewer without it. The HR Operations Specialist holds employees:update (the screen's canEdit) " +
      "and not resignations:create, so a Resign button gated on canEdit alone 403s her on press",
  );

  // The resignation route is why this test exists. Pin it by name so a refactor that moves the
  // third grant elsewhere cannot quietly take this test's only real subject away.
  const resign = readFileSync(path.join(apiRoot, "employees", "[hrId]", "resign", "route.ts"), "utf8");
  for (const resource of ["employees", "resignations", "vacancies"]) {
    assert.ok(
      resign.includes(`assertPermission(access, "${resource}"`),
      `the resignation route no longer asserts ${resource} — re-check which seat can record a departure`,
    );
  }
  const opsKeys = held.get("HR Operations" as HrBundleName)!;
  for (const key of ["employees:update", "resignations:create", "vacancies:create"]) {
    assert.ok(opsKeys.has(key), `HR Operations owns offboarding but lacks ${key}`);
  }

  // The role-set extractor's live subject, and as of 2026-09-03 it is live in both senses. The
  // Deductions page is the page that taught this test — it admitted {Super Admin, CEO} by name
  // while the HR sidebar offered HR Operations a link on `deductions:read`, a grant she really
  // holds, and the page bounced her to /employee-portals. The owner closed that on 2026-09-03
  // ("yes give HR access to the deductions screen") by adding her to the SET rather than by
  // swapping the set for a permission check, which would have handed the page back to the Finance
  // Manager he revoked on 2026-08-11.
  //
  // So this pin does two jobs now. It still proves the extractor can see a role-name gate at all —
  // if it stops reading this page the pattern has rotted and every role-name gate goes invisible
  // without saying so — and it additionally pins WHO that gate admits, which the nav half below
  // then checks she can actually reach.
  const deductionsPage = readFileSync(
    path.join(REPO_ROOT, "app", "(admin)", "admin", "deductions", "page.tsx"),
    "utf8",
  );
  assert.deepEqual(
    roleSetGates(deductionsPage),
    [["Super Admin", "CEO", "HR Operations"]],
    "the role-set gate extractor no longer reads app/(admin)/admin/deductions/page.tsx — either the " +
      "page changed shape, or the pattern broke and every role-name gate is now invisible to this test",
  );

  // ── The same claim one layer up: the PAGE a rendered sidebar row points at ────────────────────
  // The API half above cannot see this. A page carries its own entry gate and redirects before it
  // renders, so a nav row can pass every permission clause in the navigation config and still bounce
  // the seat on arrival — the offered-but-closed shape, with no 403 anywhere to find it by.
  const catalog = getNavigationSections("hr");
  const navFailures: string[] = [];
  const unreadable = new Set<string>();
  let rowsOffered = 0;
  let gatedPages = 0;

  for (const seat of seats) {
    const keys = held.get(seat)!;
    const rows = getSections(catalog, "hr", lookupForSeat(seat), seat as unknown as PhoenixRole)
      .flatMap((section) => section.items);
    const floor = HR_RAIL_FLOOR[seat] ?? 10;
    assert.ok(rows.length >= floor, `"${seat}" is offered only ${rows.length} HR nav rows (floor ${floor}) — the shell did not build`);
    for (const row of rows) {
      rowsOffered += 1;
      const file = pageFileFor(row.href);
      if (!file) {
        navFailures.push(`${seat}: "${row.label}" -> ${row.href} has no page file`);
        continue;
      }
      const source = readFileSync(file, "utf8");

      const needs = permissionGateKeys(source);

      // A role-set gate admits by NAME, so the seat is either in the literal or it is redirected.
      const roleSets = roleSetGates(source);

      const shellGated = isShellGated(source);
      if (shellGated && resolveNavigationMode(accessFor(seat)) === "employee-portal") {
        navFailures.push(
          `${seat}: "${row.label}" (${row.href}) is in the sidebar, but the page sends anyone whose ` +
            "navigation mode is employee-portal away, and that is now this seat",
        );
      }

      // The shell gate deliberately does NOT count as reading the page. A page can carry it AND a
      // predicate gate underneath (probation does), so letting it satisfy the classification would
      // quietly drop that page out of the hand-verified list while its real gate stayed unread.
      if (needs.size || roleSets.length) gatedPages += 1;
      else if (hasEntryExit(source)) unreadable.add(row.href);

      const missing = [...needs].filter((key) => !keys.has(key));
      if (missing.length) {
        navFailures.push(
          `${seat}: "${row.label}" (${row.href}) is in the sidebar, but the page gates on ` +
            `${[...needs].sort().join(" + ")} and the seat lacks ${missing.sort().join(", ")}`,
        );
      }
      for (const names of roleSets) {
        if (!names.includes(seat)) {
          navFailures.push(
            `${seat}: "${row.label}" (${row.href}) is in the sidebar, but the page admits only ` +
              `${names.join(", ")} by name and redirects everyone else — put the same list in the ` +
              "nav entry's `roles`, or ask the owner to widen the page's set",
          );
        }
      }
    }
  }

  // Floor on the EXTRACTOR, not just the result. If the gate patterns ever stop matching — a page
  // style changes, a helper is renamed — `needs` is empty everywhere and this whole section passes
  // by checking nothing. That silent pass is the failure mode worth guarding, and it is not
  // hypothetical: the first version of this check read 8 gated pages where there are 12, because
  // its pattern missed `!(await canAccess(…))`.
  assert.ok(rowsOffered >= 30, `expected both seats' HR sidebars, got ${rowsOffered} rows`);
  assert.ok(
    gatedPages >= 12,
    `only ${gatedPages} of ${rowsOffered} offered rows matched an entry-gate pattern — the ` +
      "extractor has probably stopped seeing gates, which would make this check pass by doing nothing",
  );

  // The unreadable set has to match the hand-verified list EXACTLY. A page whose gate shape this
  // file cannot parse is an unchecked page; listing it is what keeps "unchecked" from meaning
  // "silently assumed fine".
  assert.deepEqual(
    [...unreadable].sort(),
    Object.keys(GATE_SHAPE_NOT_MACHINE_READABLE).sort(),
    "the set of HR pages whose entry gate cannot be read from source has changed — verify each new " +
      "one by calling its gate's own predicate for both seats, then record the verdict in " +
      `GATE_SHAPE_NOT_MACHINE_READABLE (or drop the entry if the gate is now readable)`,
  );

  assert.deepEqual(
    navFailures,
    [],
    `HR sidebar rows that bounce on arrival:${NAV_SEP}${navFailures.join(NAV_SEP)}`,
  );
}
