import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { normalizeHrId } from "../src/lib/auth/permissions.ts";
import {
  computeApprovalScopePeople,
  excuseApprovalHref,
  vacationApprovalHref,
  vacationApprovalsBasePath,
  excuseApprovalsBasePath,
  planApprovalHref,
  planApprovalsBasePath,
} from "../src/lib/approvals-hub/service.ts";
import { slaTone, APPROVALS_SLA_THRESHOLDS } from "../src/components/approvals-hub/sla-thresholds.ts";
import { viewedPersonCanApproveOutstation } from "../src/lib/outstation/admin-access.ts";
import { stripComments } from "./support/comment-strip.ts";

const superAdmin: AccessContext = { hrId: "S-1", role: "Super Admin", scope: "system", source: "system" };
const ceo: AccessContext = { hrId: "C-1", role: "CEO", scope: "company", source: "session" };
const financeManager: AccessContext = { hrId: "F-1", role: "Finance Manager", scope: "company", source: "session" };
const districtManager: AccessContext = { hrId: "D-1", role: "District Manager", scope: "team", source: "session" };
const medicalRep: AccessContext = { hrId: "M-1", role: "Medical Rep", scope: "self", source: "session" };

export function runApprovalsHubTests() {
  // ── URL helpers route to the correct shell and encode ids ────────────────────
  // Admin-shell approver roles → /admin/approvals/*
  assert.equal(vacationApprovalsBasePath(superAdmin), "/admin/approvals/vacation");
  assert.equal(vacationApprovalsBasePath(ceo), "/admin/approvals/vacation");
  assert.equal(vacationApprovalsBasePath(financeManager), "/admin/approvals/vacation");
  assert.equal(excuseApprovalsBasePath(superAdmin), "/admin/approvals/excuse");
  // Portal-shell approver roles → /employee-portals/approvals/*
  assert.equal(vacationApprovalsBasePath(districtManager), "/employee-portals/approvals/vacation");
  assert.equal(excuseApprovalsBasePath(districtManager), "/employee-portals/approvals/excuse");

  assert.equal(vacationApprovalHref(superAdmin, "abc"), "/admin/approvals/vacation/abc");
  assert.equal(vacationApprovalHref(districtManager, "abc"), "/employee-portals/approvals/vacation/abc");
  assert.equal(excuseApprovalHref(medicalRep, "req 12/x"), "/employee-portals/approvals/excuse/req%2012%2Fx");
  assert.equal(excuseApprovalHref(superAdmin, "e-1"), "/admin/approvals/excuse/e-1");

  // ── "Who I Approve" (computeApprovalScopePeople): direct reports only, seat-aware ──
  // Org: CEO-1 → DSM-1 → MR-DEEP (MR-DEEP is two levels below the CEO). Separately,
  // DSM-2 resigned: its report MR-HELD was reassigned UP to RM-1 and stamped with the
  // vacant-seat marker pointing at DSM-2; DSM-2's own row is gone.
  const approvalScopeFixture = [
    { hrId: "CEO-1", managerHrId: null, pendingManagerReplacementForHrId: null, displayName: "Chief Exec", fullName: "Chief Exec", jobTitle: "CEO" },
    { hrId: "DSM-1", managerHrId: "CEO-1", pendingManagerReplacementForHrId: null, displayName: "District One", fullName: "District One", jobTitle: "District Manager" },
    { hrId: "MR-DEEP", managerHrId: "DSM-1", pendingManagerReplacementForHrId: null, displayName: "Rep Deep", fullName: "Rep Deep", jobTitle: "Medical Rep" },
    { hrId: "RM-1", managerHrId: null, pendingManagerReplacementForHrId: null, displayName: "Regional One", fullName: "Regional One", jobTitle: "Regional Manager" },
    { hrId: "MR-HELD", managerHrId: "RM-1", pendingManagerReplacementForHrId: "DSM-2", displayName: "Rep Held", fullName: "Rep Held", jobTitle: "Medical Rep" },
  ] as unknown as Parameters<typeof computeApprovalScopePeople>[0];

  // (a) The vacant DSM-2 seat still "approves" the report it held before resigning,
  // via the continuity marker — even though DSM-2's row no longer exists.
  const vacantSeatScope = computeApprovalScopePeople(approvalScopeFixture, normalizeHrId("DSM-2") as string);
  assert.deepEqual(
    vacantSeatScope.map((person) => person.hrId).sort(),
    ["MR-HELD"],
    "the vacant DSM seat still approves the report it held before the manager resigned",
  );

  // (b) The CEO approves only their DIRECT report (DSM-1), never the rep two levels
  // down (MR-DEEP). Locks "Who I Approve" to TEAM-only — no manager-of-manager chain.
  const ceoScope = computeApprovalScopePeople(approvalScopeFixture, normalizeHrId("CEO-1") as string);
  assert.deepEqual(
    ceoScope.map((person) => person.hrId).sort(),
    ["DSM-1"],
    "the CEO approves only their direct report, not the rep two levels down (TEAM-only)",
  );
  assert.ok(
    !ceoScope.some((person) => person.hrId === "MR-DEEP"),
    "a report two levels below the viewer is never in the direct-approval set",
  );

  // ── Service module exposes the responder buckets + view builders ─────────────
  const svc = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  for (const fn of [
    "getVacationApprovalsForResponder",
    "getExcuseApprovalsForResponder",
    "getVacationWorkspaceData",
    "getExcuseWorkspaceData",
    "getVacationApprovalDetail",
    "getExcuseApprovalDetail",
    "countVacationAwaiting",
    "countExcuseAwaiting",
  ]) {
    assert.match(svc, new RegExp(`export async function ${fn}\\(`), `service must export ${fn}`);
  }
  // Vacation partitions awaiting vs coming-to-you by whether any action is enabled. Own
  // submissions are NOT a pending-tab bucket — they live on the dedicated "My Requests" tab
  // (pending + decided, one report) so a decided request never just vanishes from view.
  assert.match(svc, /awaiting: VacationActionCenterRow\[\]/, "vacation buckets expose an awaiting list");
  assert.match(svc, /upcoming: VacationActionCenterRow\[\]/, "vacation buckets expose a coming-to-you list");
  assert.doesNotMatch(svc, /mine: VacationRequestRecord\[\]/, "own requests are no longer a pending-tab bucket — replaced by the My Requests tab");
  assert.match(svc, /export async function getMyVacationRequestItems/, "My Requests tab has a dedicated vacation data source");
  assert.match(svc, /export async function getMyExcuseRequestItems/, "My Requests tab has a dedicated excuse data source");
  assert.match(
    svc,
    /getMyRequestItems, decodeDecision \} from "@\/lib\/action-center\/service"/,
    "My Requests reuses the existing cross-module getMyRequestItems (same data the old combined hub's tab showed), not a reimplementation",
  );

  // ── Swallowed loader failures log at the RIGHT severity ──────────────────────
  // A "Forbidden: …" rejection is the permission gate working, not a fault. Logging it at
  // ERROR made a single unauthenticated GET of an approvals page emit ERROR-severity Cloud Run
  // entries, polluting error dashboards and Sentry error-rate alerting. Every catch-and-log in
  // this service must therefore go through logLoadFailure, which downgrades permission denials
  // to DEBUG and keeps genuine failures at ERROR.
  assert.doesNotMatch(
    svc,
    /\blogError\(/,
    "no catch-and-log site may call logError directly — an expected Forbidden would be logged as an ERROR",
  );
  assert.match(
    svc,
    /logStructured\(forbidden \? "DEBUG" : "ERROR", message/,
    "logLoadFailure downgrades forbidden failures to DEBUG and keeps everything else at ERROR",
  );
  assert.match(
    svc,
    /classification: forbidden \? "forbidden" : "error"/,
    "downgraded failures stay searchable via a classification label",
  );
  assert.match(
    svc,
    /error\.message\.toLowerCase\(\)\.startsWith\("forbidden:"\)/,
    "forbidden detection keys off the same 'Forbidden:' prefix as isForbiddenError in @/lib/auth/server",
  );
  // (The individual loader call sites — including the two confirmed emitting false-positive
  // ERRORs on production revision phoenix-hr-00661-yuw, 2026-07-30 — are asserted further down,
  // alongside the "never silently swallowed" guarantee.)

  // ── Grouped pending sections (Awaiting / Coming to you) + the My Requests tab ─
  const vacBody = readFileSync("src/components/approvals-hub/vacation-approvals-body.tsx", "utf8");
  assert.match(vacBody, /Awaiting your response/, "vacation pending shows an 'Awaiting your response' group");
  assert.match(vacBody, /Coming to you/, "vacation pending shows a 'Coming to you' group");
  assert.doesNotMatch(vacBody, /Your own requests/, "own requests are no longer a subsection of the pending tab — moved to the dedicated My Requests tab");
  assert.match(vacBody, /myRequests=\{data\.myRequests\}/, "vacation page wires its own-requests data into the My Requests tab");
  const workspaceComponent = readFileSync("src/components/approvals-hub/approvals-workspace.tsx", "utf8");
  assert.match(workspaceComponent, /label: "My Requests"/, "a dedicated 'My Requests' tab exists");
  assert.match(workspaceComponent, /<MyRequestsList items=\{myRequests\}/, "the My Requests tab reuses the existing MyRequestsList component verbatim");
  assert.match(
    workspaceComponent,
    /import \{ MyRequestsList \} from "@\/components\/action-center\/my-requests-list"/,
    "My Requests reuses the same list component as the old combined hub's tab, not a new one",
  );

  // ── Every action confirms; reject/return require a reason; HR acknowledge ────
  const actions = readFileSync("src/components/approvals-hub/decision-actions.tsx", "utf8");
  assert.match(actions, /reject: true/, "reject requires a reason");
  assert.match(actions, /return: true/, "return requires a reason");
  assert.match(actions, /A reason is required/, "reject/return block submission without a reason");
  assert.match(actions, /Acknowledge \(HR\)/, "HR acknowledge action is available");
  assert.match(actions, /Confirm \$\{LABEL/, "every action goes through a confirm step");

  // ── Phase 2.1: attachment evidence links, widened to the active-turn approver ─
  assert.match(svc, /canReviewAttachments: isAllVacationVisibility\(access\) \|\| \(actionable && !own\)/, "attachment gate widens to the active-turn approver, in addition to HR/Super Admin");
  assert.match(svc, /canReviewAttachments: isAllVacationVisibility\(access\),/, "the read-only\\/decided branch keeps attachments HR\\/Super-Admin-only");
  const attachmentLinks = readFileSync("src/components/approvals-hub/vacation-attachment-links.tsx", "utf8");
  assert.match(attachmentLinks, /if \(!canReviewAttachments\) return null;/, "attachment links component respects the canReviewAttachments gate");
  const detailComponent = readFileSync("src/components/approvals-hub/vacation-request-detail.tsx", "utf8");
  assert.match(detailComponent, /VacationAttachmentLinks/, "vacation detail page renders the attachment links");

  // ── Phase 2.3: overdue highlighting — exact thresholds from action-center-hub.tsx ────
  assert.equal(APPROVALS_SLA_THRESHOLDS.leave, 3, "leave overdue threshold matches action-center-hub.tsx's SLA_THRESHOLDS.leave");
  assert.equal(APPROVALS_SLA_THRESHOLDS.excuse, 2, "excuse overdue threshold matches action-center-hub.tsx's SLA_THRESHOLDS.excuse");
  assert.equal(slaTone(0, 3), "none", "fresh leave request (0 days) is not overdue or due");
  assert.equal(slaTone(1, 3), "none", "1-day-old leave request is comfortably within the 3-day threshold");
  assert.equal(slaTone(2, 3), "due", "leave request 1 day from threshold is flagged 'due'");
  assert.equal(slaTone(3, 3), "overdue", "leave request at the threshold is overdue");
  assert.equal(slaTone(5, 3), "overdue", "leave request past the threshold stays overdue");
  assert.equal(slaTone(1, 2), "due", "excuse request 1 day from its 2-day threshold is flagged 'due'");
  assert.equal(slaTone(2, 2), "overdue", "excuse request at its 2-day threshold is overdue");

  const workspace = readFileSync("src/components/approvals-hub/approvals-workspace.tsx", "utf8");
  assert.match(workspace, /!readOnly && typeof card\.ageDays === "number"/, "overdue chip only renders for the actionable (non-read-only) section");
  const tracker = readFileSync("src/components/approvals-hub/request-tracker.tsx", "utf8");
  assert.match(tracker, /SlaAgeBadge/, "request tracker uses the shared overdue-aware age badge");

  // ── Notifications repointed to the new per-request pages ─────────────────────
  const vacService = readFileSync("src/lib/vacation/service.ts", "utf8");
  assert.match(vacService, /\/admin\/approvals\/vacation\//, "vacation notifications point to the new page");
  assert.doesNotMatch(vacService, /leave-management\/vacation-action-center/, "no vacation-action-center links remain");
  const excService = readFileSync("src/lib/excuses/service.ts", "utf8");
  assert.match(excService, /\/admin\/approvals\/excuse\//, "excuse notifications point to the new page");
  assert.doesNotMatch(excService, /approvals-hub\?module=excuse/, "no legacy excuse approvals-hub links remain");

  // Legacy + new URLs remap to the correct shell per reader role.
  const hrefs = readFileSync("src/lib/notifications/hrefs.ts", "utf8");
  assert.match(hrefs, /\/employee-portals\/approvals\/vacation/, "portal readers get the portal vacation page");
  assert.match(hrefs, /\/employee-portals\/approvals\/excuse/, "portal readers get the portal excuse page");
  assert.match(hrefs, /vacation-action-center/, "legacy vacation-action-center notifications are still remapped");

  // ── Navigation: two links present with badges; Vacation Action Center gone ───
  const nav = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.match(nav, /\/admin\/approvals\/vacation/, "admin nav exposes Vacation Approvals");
  assert.match(nav, /\/admin\/approvals\/excuse/, "admin nav exposes Excuse Approvals");
  assert.match(nav, /vacation-approvals-pending/, "vacation link has its own pending badge");
  assert.match(nav, /excuse-approvals-pending/, "excuse link has its own pending badge");
  assert.doesNotMatch(nav, /vacation-action-center/, "Vacation Action Center nav entries are removed");

  // ── Phase 2.2: portal sidebar carries the same live badge as admin ────────────
  const portalLayout = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.match(portalLayout, /navBadge: "vacation-approvals-pending" as const/, "portal Vacation Approvals link carries its pending badge");
  assert.match(portalLayout, /navBadge: "excuse-approvals-pending" as const/, "portal Excuse Approvals link carries its pending badge");
  assert.match(portalLayout, /import \{ NavBadge \} from "@\/components\/layout\/nav-badge";/, "portal reuses the exact same NavBadge polling client as admin, not a new mechanism");
  assert.match(portalLayout, /<NavBadge src="\/api\/approvals\/vacation\/pending-count" \/>/, "portal vacation badge points at the same count API as admin");
  assert.match(portalLayout, /<NavBadge src="\/api\/approvals\/excuse\/pending-count" \/>/, "portal excuse badge points at the same count API as admin");
  // NavBadge's definition moved to ./nav-badge on 2026-08-29, so the horizontal nav rows could use
  // it without pulling the whole sidebar module (dnd-kit, the layout editor) into their bundle.
  //
  // Until 2026-09-04 the portal still reached it through a re-export in sidebar.tsx, which undid
  // the point of the move for every portal page: importing the NAME from sidebar.tsx pulls the
  // MODULE. The portal now imports it directly (asserted above) and the re-export is gone, so what
  // is pinned here is the arrangement that keeps the bundle honest — one definition, imported at
  // first hand, with no surface reaching it back through the sidebar.
  const sidebarSource = readFileSync("src/components/layout/sidebar.tsx", "utf8");
  const navBadgeSource = readFileSync("src/components/layout/nav-badge.tsx", "utf8");
  assert.match(navBadgeSource, /export function NavBadge/, "NavBadge is exported so the portal layout can reuse it verbatim");
  assert.ok(
    !/export \{[^}]*\bNavBadge\b[^}]*\} from/.test(sidebarSource),
    "sidebar.tsx must not re-export NavBadge — that is what dragged dnd-kit and the layout editor into every portal page's bundle",
  );

  // ── Phase 2.4: history filter + export, type enrichment without touching shared code ─
  assert.match(svc, /export type ResponderHistoryItem = HistoricalApprovalItem & \{ subtype: string \| null \}/, "history items carry an enrichment-only subtype field, not on the shared type");
  assert.doesNotMatch(
    readFileSync("src/components/action-center/types.ts", "utf8"),
    /subtype/,
    "the shared, cross-module HistoricalApprovalItem type stays untouched by the vacation/excuse type filter",
  );
  assert.match(svc, /async function fetchVacationTypesForIds/, "vacation type enrichment is a small direct query, not a shared-query change");
  assert.match(svc, /async function fetchExcuseTypesForIds/, "excuse type enrichment is a small direct query, not a shared-query change");
  const historyList = readFileSync("src/components/approvals-hub/history-list.tsx", "utf8");
  assert.match(historyList, /ExportXlsxButton/, "history tab reuses the existing ExportXlsxButton verbatim");
  assert.match(historyList, /setEmployee|employeeLower/, "history filter bar supports filtering by employee");
  assert.match(historyList, /setDateFrom[\s\S]*setDateTo|dateFrom[\s\S]*dateTo/, "history filter bar supports filtering by date range");
  assert.match(historyList, /setDecision/, "history filter bar supports filtering by decision");
  assert.match(historyList, /setType/, "history filter bar supports filtering by type");
  const workspaceSource = readFileSync("src/components/approvals-hub/approvals-workspace.tsx", "utf8");
  assert.match(workspaceSource, /<HistoryList/, "the Response History tab renders the filterable/exportable list");

  // ── Phase 2.5: company-wide "All Decisions" tab, Super Admin / system-scope only ────
  assert.match(svc, /export async function getAllVacationDecisionsCompanyWide/, "company-wide vacation decisions query exists");
  assert.match(svc, /export async function getAllExcuseDecisionsCompanyWide/, "company-wide excuse decisions query exists");
  assert.match(
    svc,
    /if \(!isAllVacationVisibility\(access\)\) \{\s*throw new Error\("Forbidden: only HR or Super Admin can view company-wide decision history\."\);/,
    "company-wide vacation query is gated to Super Admin / system-scope, defense-in-depth alongside the tab-visibility gate",
  );
  assert.match(svc, /import \{ getMyApprovalHistory, getMyRequestItems, decodeDecision \} from "@\/lib\/action-center\/service";/, "company-wide queries reuse the shared decodeDecision helper rather than reimplementing it");
  const actionCenterSvc = readFileSync("src/lib/action-center/service.ts", "utf8");
  assert.match(actionCenterSvc, /export function decodeDecision/, "decodeDecision is hoisted to module scope and exported so it can be reused, not duplicated");
  assert.match(svc, /showCompanyWide = isAllVacationVisibility\(access\)/, "company-wide data is only fetched for Super Admin / system-scope viewers");
  assert.match(workspaceSource, /showCompanyWideTab = Array\.isArray\(companyWide\)/, "the 'All Decisions' tab itself is hidden entirely (not just its data) for every other role");
  assert.match(workspaceSource, /showDecidedBy/, "the company-wide tab shows who decided each request");

  // ── Access registry: new API + page surfaces are registered ──────────────────
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(registry, /\/api\/approvals\/vacation\/pending-count/, "vacation count API is registered");
  assert.match(registry, /\/api\/approvals\/excuse\/pending-count/, "excuse count API is registered");
  assert.match(registry, /\/admin\/approvals\/\*\*/, "admin approval pages are registered (leave:read, not admin:read)");

  // ── Phase 2.6: blank-HR-ID system-actor defensive fallback ────────────────────
  // A Super Admin / system-scope actor (e.g. a shared HR login with no personal HR_ID) must always
  // resolve to the true company-wide bucket — nothing in the visibility chain may key off hrId.
  const vacationSvc = readFileSync("src/lib/vacation/service.ts", "utf8");
  const vacationScope = readFileSync("src/lib/vacation/visibility-scope.ts", "utf8");
  assert.match(
    vacationScope,
    /function isAllVacationVisibilityAccess\(access: Pick<AccessContext, "role" \| "scope">\) \{\s*return access\.scope === "system" \|\| access\.role === "Super Admin";/,
    "vacation visibility is role/scope-gated, never hrId-gated — a blank hrId Super Admin must still see company-wide",
  );
  assert.match(
    vacationSvc,
    /function isAllVacationVisibility\(access: AccessContext\) \{\s*return isAllVacationVisibilityAccess\(access\);/,
    "the service's company-wide check is the same role/scope rule, delegated — never an hrId test",
  );
  assert.match(
    vacationSvc,
    /function canSeeVacation\(access: AccessContext,[^)]*\) \{\s*if \(isAllVacationVisibility\(access\)\) return true;/,
    "canSeeVacation short-circuits true for system-authority actors before any hrId-based check runs",
  );
  const shouldScopeMatch = /const shouldScopeEmployees = !isAllVacationVisibility\(input\.access\);/;
  assert.match(vacationSvc, shouldScopeMatch, "the report RPC's employee scoping is role/scope-gated, not hrId-gated");

  // Never silently collapse a real failure to an empty bucket without at least one server log line
  // — a swallowed error must not look identical to "nothing pending" for this actor. (Severity is
  // decided by logLoadFailure: DEBUG for an expected Forbidden, ERROR for everything else.)
  assert.match(svc, /logLoadFailure\("Approvals hub vacation action-center data load failed"/, "vacation bucket failures are logged, not silently swallowed");
  assert.match(svc, /logLoadFailure\("Approvals hub vacation report data load failed"/, "vacation report failures are logged, not silently swallowed");
  assert.match(svc, /logLoadFailure\("Approvals hub count vacation awaiting failed"/, "vacation badge-count failures are logged, not silently swallowed");
  assert.match(svc, /logLoadFailure\("Approvals hub count excuse awaiting failed"/, "excuse badge-count failures are logged, not silently swallowed");
  assert.match(svc, /logLoadFailure\("Approvals hub manager pending excuses load failed"/, "excuse pending failures are logged, not silently swallowed");

  // ──────────────────────────────────────────────────────────────────────────
  // Weekly / Monthly Plan approvals (consolidation only — routing unchanged)
  // ──────────────────────────────────────────────────────────────────────────

  // URL helpers route to the correct shell and encode ids, same as vacation/excuse.
  assert.equal(planApprovalsBasePath(superAdmin), "/admin/approvals/plan");
  assert.equal(planApprovalsBasePath(ceo), "/admin/approvals/plan");
  assert.equal(planApprovalsBasePath(districtManager), "/employee-portals/approvals/plan");
  assert.equal(planApprovalHref(superAdmin, "abc"), "/admin/approvals/plan/abc");
  assert.equal(planApprovalHref(districtManager, "p 1/x"), "/employee-portals/approvals/plan/p%201%2Fx");

  // Service exposes the plan responder buckets, detail, history, My Requests, company-wide + counts.
  for (const fn of [
    "getPlanApprovalsForResponder",
    "getPlanWorkspaceData",
    "getPlanApprovalDetail",
    "countPlanAwaiting",
    "getResponderPlanHistory",
    "getMyPlanRequestItems",
    "getAllPlanDecisionsCompanyWide",
  ]) {
    assert.match(svc, new RegExp(`export async function ${fn}\\(`), `service must export ${fn}`);
  }
  // Plans reuse the same cross-module My Requests / history sources as vacation/excuse.
  assert.match(svc, /\.filter\(\(item\) => item\.module === "weekly_plan"\)/, "plan My Requests/history filter the shared getMyRequestItems/getMyApprovalHistory output, not a reimplementation");
  // Consolidation only: the plan responder reuses the existing plan authority rule; no new workflow.
  assert.match(svc, /import \{ resolveApproverPlanStage[^}]*\} from "@\/lib\/weekly-planning\/service";/, "plan buckets reuse the existing server-side approver authority rule (no workflow change)");
  // HR acknowledge authority for plans is Super Admin / system only (mirrors weekly-planning).
  assert.match(svc, /function isPlanHrActor\(access[^)]*\): boolean \{\s*return access\.role === "Super Admin" \|\| access\.scope === "system";/, "plan HR-acknowledge authority is Super Admin / system only");

  // SLA overdue threshold for plans matches action-center-hub.tsx (weekly_plan = 2).
  assert.equal(APPROVALS_SLA_THRESHOLDS.plan, 2, "plan overdue threshold matches action-center-hub.tsx's SLA_THRESHOLDS.weekly_plan");
  assert.equal(slaTone(1, 2), "due", "plan 1 day from its 2-day threshold is flagged 'due'");
  assert.equal(slaTone(2, 2), "overdue", "plan at its 2-day threshold is overdue");

  // Plan page body: grouped pending (Awaiting / Coming to you), My Requests wired, plan SLA module.
  const planBody = readFileSync("src/components/approvals-hub/plan-approvals-body.tsx", "utf8");
  assert.match(planBody, /Awaiting your response/, "plan pending shows an 'Awaiting your response' group");
  assert.match(planBody, /Coming to you/, "plan pending shows a 'Coming to you' group");
  assert.match(planBody, /slaModule="plan"/, "plan body uses the plan SLA module");
  assert.match(planBody, /myRequests=\{data\.myRequests\}/, "plan page wires its own-submissions data into the My Requests tab");

  // Plan decision actions: approve/reject/return map to the existing stage-prefixed workflow tokens;
  // HR acknowledge posts to the separate acknowledge endpoint. Every action confirms; reason gated.
  const planActions = readFileSync("src/components/approvals-hub/plan-decision-actions.tsx", "utf8");
  assert.match(planActions, /\$\{decisionStage\}_\$\{action\}/, "approve/reject map to the existing manager_*/ceo_* workflow tokens — no new workflow");
  assert.match(planActions, /\/api\/weekly-plans\/\$\{encodeURIComponent\(planId\)\}\/decision/, "approve/reject/return reuse the existing plan decision endpoint");
  assert.match(planActions, /\/api\/weekly-plans\/\$\{encodeURIComponent\(planId\)\}\/acknowledge/, "HR acknowledge reuses the existing plan acknowledge endpoint");
  assert.match(planActions, /reject: true/, "plan reject requires a reason");
  assert.match(planActions, /Add an overall reason/, "returning a plan requires an overall reason");
  assert.match(planActions, /A reason is required/, "plan reject blocks submission without a reason");
  assert.match(planActions, /Acknowledge \(HR\)/, "plan HR acknowledge action is available");
  assert.match(planActions, /Confirm \$\{SIMPLE_LABEL/, "every simple plan action goes through a confirm step");

  // Company-wide "All Decisions" for plans is gated to Super Admin / system, defense-in-depth.
  assert.match(
    svc,
    /export async function getAllPlanDecisionsCompanyWide[\s\S]*?if \(!isPlanHrActor\(access\)\) \{\s*throw new Error\("Forbidden: only HR or Super Admin can view company-wide decision history\."\);/,
    "company-wide plan query is gated to Super Admin / system-scope",
  );

  // ── "Company Plans" tab: CEO + Super Admin, ALL roles (pending + decided), no action buttons ──
  // getCompanyPlanRequests and getCompanyDistrictManagerPlanRequests (the read-only "District
  // Manager Plans" tab) share one query via fetchCompanyPlanRequestItems -- the auth gate and
  // the field-force-inclusion property below live there now, not in either thin wrapper. Since 2026-10-17
  // it also merges the regional, national and product managers' Phoenix CRM weeks beside the legacy ones.
  assert.match(
    svc,
    /export async function getCompanyPlanRequests[\s\S]*?fetchCompanyPlanRequestItems\(access\),\s*\n\s*fetchCrmManagerPlanRequestItems\(access, null, "others"\),[\s\S]*?return mergeCompanyPlanFeeds\(legacy, crm\);/,
    "getCompanyPlanRequests must delegate to the shared fetchCompanyPlanRequestItems helper, with the non-DM Phoenix CRM weeks merged beside it",
  );
  assert.match(
    svc,
    /async function fetchCompanyPlanRequestItems\([\s\S]*?if \(!canSeeCeoApprovalTabs\(access\)\) \{\s*throw new Error\("Forbidden: only the CEO or Super Admin can view the company-wide request feed\."\);/,
    "the shared company-plan-request helper is gated by the same canSeeCeoApprovalTabs check as the vacation/excuse company-requests views",
  );
  {
    const companyPlanFnMatch = svc.match(/async function fetchCompanyPlanRequestItems\([\s\S]*?return items;\n}/);
    assert.ok(companyPlanFnMatch, "fetchCompanyPlanRequestItems function body is present");
    assert.doesNotMatch(
      companyPlanFnMatch![0],
      /isExcludedFieldForce/,
      "unlike vacation/excuse, plan company requests must NOT exclude the field force — a District Manager's own plans belong here",
    );
  }
  assert.match(svc, /companyRequests: CompanyRequestItem\[\] \| null;/, "PlanWorkspaceData exposes the Company Plans data alongside companyWide");
  assert.match(planBody, /companyRequestsTabLabel="Company Plans"/, "the plan hub's oversight tab is labeled 'Company Plans', not the generic 'Company Requests'");
  assert.match(workspaceSource, /companyRequestsTabLabel/, "ApprovalsWorkspace supports overriding the Company Requests tab label per module");

  // The self-contained per-plan page reuses the extracted shared calendar renderer (one source).
  const planDetail = readFileSync("src/components/approvals-hub/plan-request-detail.tsx", "utf8");
  assert.match(planDetail, /import \{ WeeklyPlanCalendar \} from "@\/components\/action-center\/weekly-plan-calendar"/, "plan detail reuses the extracted shared WeeklyPlanCalendar, not a re-built grid");
  const combinedHub = readFileSync("src/components/action-center/action-center-hub.tsx", "utf8");
  assert.match(combinedHub, /import \{ WeeklyPlanCalendar \} from "@\/components\/action-center\/weekly-plan-calendar"/, "the combined hub renders the same extracted calendar — single source of truth");

  // ── "View as" impersonation gate: Super Admin only. "HR Manager" is a job title
  // (phoenixCompanyJobTitles), not an app_auth_users.role value — no user account has ever
  // held it, so including it in a role gate/query is silent dead weight, not defense in depth. ──
  assert.match(combinedHub, /const canViewAs = callerRole === "Super Admin";/, "view-as switcher must gate on Super Admin only");
  assert.doesNotMatch(combinedHub, /"HR Manager"/, "\"HR Manager\" must not appear in the view-as gate");
  const approvalsHubManagersRoute = readFileSync("app/api/approvals-hub/managers/route.ts", "utf8");
  assert.match(approvalsHubManagersRoute, /const ALLOWED_CALLER_ROLES = new Set\(\["Super Admin"\]\);/, "managers endpoint caller allowlist must be Super Admin only");
  const approvalsHubDataRoute = readFileSync("app/api/approvals-hub/hub-data/route.ts", "utf8");
  assert.match(approvalsHubDataRoute, /const ALLOWED_VIEW_AS_ROLES = new Set\(\["Super Admin"\]\);/, "hub-data view-as allowlist must be Super Admin only");

  // ── F-31: the view-as outstation feed follows the VIEWED person, not the caller ──
  // listOutstationRequests() is a company-wide read with no access context, so until 2026-09-19
  // every submitted trip appeared in the queue of whichever manager the Super Admin picked. Only
  // someone who can decide outstation requests has any in their queue.
  assert.equal(viewedPersonCanApproveOutstation("Super Admin"), true, "a Super Admin decides outstation requests, so his queue holds them");
  for (const role of ["CEO", "Finance Manager", "National Sales Manager", "Regional Manager", "District Manager", "Manager", "HR Operations", "HR Advisory", "Employee"]) {
    assert.equal(viewedPersonCanApproveOutstation(role), false, `a ${role} cannot decide an outstation request, so none may appear in their queue`);
  }
  for (const missing of [null, undefined, "", "Not A Role"]) {
    assert.equal(viewedPersonCanApproveOutstation(missing), false, `an unknown role (${String(missing)}) fails closed`);
  }
  assert.match(
    approvalsHubDataRoute,
    /options\.includeOutstation \? listOutstationRequests\(\)\.catch\(\(\) => null\) : Promise\.resolve\(null\)/,
    "hub-data reads the outstation list only behind includeOutstation",
  );
  assert.equal(
    stripComments(approvalsHubDataRoute).match(/listOutstationRequests\(/g)?.length,
    1,
    "hub-data has exactly one outstation read (comments aside), the gated one",
  );
  assert.match(
    approvalsHubDataRoute,
    /const viewedRole = await authRoleForHrId\(viewAs\);[\s\S]*?includeOutstation: viewedPersonCanApproveOutstation\(viewedRole\)/,
    "the gate is decided from the VIEWED person's own role, never the caller's Super Admin context",
  );

  // Plan notifications repoint approver-facing CTAs to the new plan pages; employee-facing stays.
  const planSvc = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  assert.match(planSvc, /\/admin\/approvals\/plan\//, "plan approver notifications point to the new admin plan page");
  assert.match(planSvc, /\/employee-portals\/approvals\/plan\//, "portal-shell plan managers get the new portal plan page");
  assert.match(hrefs, /\/employee-portals\/approvals\/plan/, "portal readers get the portal plan page");
  assert.match(hrefs, /\/admin\/approvals\/plan/, "admin readers get the admin plan page");

  // Combined "Other Approvals" inbox no longer surfaces plans — they live only on the new page.
  assert.match(actionCenterSvc, /item\.module !== "weekly_plan"/, "weekly/monthly plans are excluded from the residual combined inbox");

  // Navigation: plan link present in both shells with its own badge; portal flag + registry wired.
  assert.match(nav, /\/admin\/approvals\/plan/, "admin nav exposes Weekly / Monthly Plan Approvals");
  assert.match(nav, /\/employee-portals\/approvals\/plan/, "portal nav exposes Weekly / Monthly Plan Approvals");
  assert.match(nav, /plan-approvals-pending/, "plan link has its own pending badge");
  assert.match(portalLayout, /navBadge: "plan-approvals-pending" as const/, "portal plan link carries its pending badge");
  assert.match(portalLayout, /<NavBadge src="\/api\/approvals\/plan\/pending-count" \/>/, "portal plan badge points at the plan count API");
  const portalNav = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
  assert.match(portalNav, /showPlanApprovalsTab:/, "portal navigation resolves a dedicated plan-approvals visibility flag");
  const navRegistry = readFileSync("src/components/employee-portal/employee-portal-nav-registry.ts", "utf8");
  assert.match(navRegistry, /\/employee-portals\/approvals\/plan/, "the portal nav registry lists the plan approvals destination (keeps bottom-nav in sync)");

  // ── Vacation/Excuse now have SEPARATE portal visibility flags (no longer a single shared
  // showApprovalsTab) so one module can be hidden for a role without touching the other ──
  assert.doesNotMatch(portalNav, /showApprovalsTab/, "the old shared vacation+excuse flag is fully retired, not left dangling alongside the split ones");
  {
    const vacationFlagMatch = portalNav.match(/showVacationApprovalsTab:\s*([\s\S]*?),\n\s*\/\//);
    assert.ok(vacationFlagMatch, "showVacationApprovalsTab computation is present");
    assert.match(vacationFlagMatch![1], /National Sales Manager/, "National Sales Manager still sees Vacation Approvals");
    const excuseFlagMatch = portalNav.match(/showExcuseApprovalsTab:\s*([\s\S]*?),\n\s*\/\//);
    assert.ok(excuseFlagMatch, "showExcuseApprovalsTab computation is present");
    assert.match(vacationFlagMatch![1], /District Manager/, "District Manager still sees Vacation Approvals");
    assert.match(vacationFlagMatch![1], /Regional Manager/, "Regional Manager still sees Vacation Approvals");
    assert.doesNotMatch(excuseFlagMatch![1], /National Sales Manager/, "National Sales Manager does NOT see Excuse Approvals (reps under a DM never route excuses to the NSM; NSM-level goes through Head Office)");
    // Owner decision 2026-07-30: DSM and RM left the excuse ladder entirely (they cannot submit an
    // excuse either) — the whole field sales ladder is now out of this module. Enforced server-side
    // by EXCUSE_EXCLUDED_ROLES in src/lib/excuses/service.ts; this flag only hides the link.
    for (const role of ["District Manager", "Regional Manager"]) {
      assert.doesNotMatch(excuseFlagMatch![1], new RegExp(role), `${role} must NOT see Excuse Approvals`);
    }
    for (const role of ["Product Manager", "Group Product Manager", "Marketing Manager", "Manager"]) {
      assert.match(excuseFlagMatch![1], new RegExp(role), `${role} still sees Excuse Approvals`);
    }
  }
  assert.match(portalLayout, /showVacationApprovalsTab \? \[\{ href: "\/employee-portals\/approvals\/vacation"/, "the Vacation Approvals link is gated on the vacation-specific flag");
  assert.match(portalLayout, /showExcuseApprovalsTab \? \[\{ href: "\/employee-portals\/approvals\/excuse"/, "the Excuse Approvals link is gated on the excuse-specific flag");
  assert.match(navRegistry, /flags: \["showVacationApprovalsTab"\]/, "the nav registry (bottom-nav/quick-nav) uses the vacation-specific flag");
  assert.match(navRegistry, /flags: \["showExcuseApprovalsTab"\]/, "the nav registry (bottom-nav/quick-nav) uses the excuse-specific flag");

  // Access registry: plan count API is registered (weekly_plans:read, not the admin:read catch-all).
  assert.match(registry, /\/api\/approvals\/plan\/pending-count/, "plan count API is registered");

  // ── Portal sidebar: dedicated "Approvals Hub" section (matches the admin shell's own
  // named section) instead of bundling the 3 links into the generic "My Workspace" group ──
  assert.match(portalLayout, /title: "Approvals Hub"/, "portal sidebar has its own dedicated Approvals Hub section, mirroring the admin shell");
  {
    const hubSectionMatch = portalLayout.match(/title: "Approvals Hub",\s*items: \[([\s\S]*?)\],\s*\}/);
    assert.ok(hubSectionMatch, "Approvals Hub section body is present");
    const hubBody = hubSectionMatch![1];
    assert.match(hubBody, /approvals\/vacation/, "Vacation Approvals lives inside the Approvals Hub section");
    assert.match(hubBody, /approvals\/excuse/, "Excuse Approvals lives inside the Approvals Hub section");
    assert.match(hubBody, /approvals\/plan/, "Plan Approvals lives inside the Approvals Hub section");
    // "Other Approvals" (residual combined inbox) and the Marketing Requests Inbox also live
    // in Approvals Hub now (owner request), not in My Workspace / Marketing & ROI.
    assert.match(hubBody, /approvals-hub.*Other Approvals/, "Other Approvals (residual combined hub) lives inside the Approvals Hub section");
    assert.match(hubBody, /marketing-requests\/inbox.*Marketing Inbox/, "the Marketing Requests Inbox lives inside the Approvals Hub section, under its renamed label");
  }
  const myWorkspaceMatch = portalLayout.match(/title: "My Workspace",\s*items: \[([\s\S]*?)\],\s*\}/);
  assert.ok(myWorkspaceMatch, "My Workspace section body is present");
  assert.doesNotMatch(myWorkspaceMatch![1], /approvals\/vacation|approvals\/excuse|approvals\/plan/, "the 3 approval links moved out of My Workspace into the dedicated Approvals Hub section");
  assert.doesNotMatch(myWorkspaceMatch![1], /approvals-hub/, "Other Approvals moved out of My Workspace into the dedicated Approvals Hub section");
  const marketingSectionMatch = portalLayout.match(/title: "Marketing & ROI",\s*items: \[([\s\S]*?)\],\s*\}/);
  assert.ok(marketingSectionMatch, "Marketing & ROI section body is present");
  assert.doesNotMatch(marketingSectionMatch![1], /marketing-requests\/inbox/, "the Marketing Requests Inbox moved out of Marketing & ROI into the Approvals Hub section");
  assert.match(portalLayout, /if \(title === "Approvals Hub"\) return \w+;/, "the collapsed-rail icon map has an entry for the new section");
  // The collapsed rail renders ONLY these icons, so two sections sharing one are indistinguishable.
  // Approvals Hub and Leave & HR both returned CalendarDays until 2026-07-30. Pin uniqueness rather
  // than any specific icon — the icon choice is cosmetic, the distinctness is not.
  {
    const railIcons = Array.from(
      portalLayout.matchAll(/if \(title === "[^"]+"\) return (\w+);/g),
      (match) => match[1],
    );
    assert.ok(railIcons.length >= 10, "every portal sidebar section needs a rail icon entry");
    assert.equal(
      new Set(railIcons).size,
      railIcons.length,
      `collapsed-rail icons must be unique per section; duplicates found in [${railIcons.join(", ")}]`,
    );
  }

  // The page heading deliberately stays LONG. Only the nav surfaces get the short label — the
  // sidebar column is ~117px behind a pending badge, a page heading has the full width — so
  // "Marketing Inbox" in the sidebar and "Marketing Requests Inbox" on the page is the owner's
  // intent (2026-08-09), not drift. Do not "fix" these back into a match.
  const portalInboxPage = readFileSync("app/employee-portals/marketing-requests/inbox/page.tsx", "utf8");
  assert.match(portalInboxPage, /title="Marketing Requests Inbox"/, "the portal inbox page keeps the full heading; only the nav label is shortened");
  assert.doesNotMatch(portalInboxPage, /title="Approval Inbox"/, "the old page title is fully replaced, not left alongside the new one");
  assert.match(navRegistry, /fullLabel: "Marketing Inbox"/, "the nav registry's full label matches the rename too (bottom-nav/quick-nav consistency)");

  // The Training Manager's own section leads the sidebar (owner request) — ahead of "My Workspace".
  // For non-TM roles the Training Manager section is empty and dropped by the items.length filter,
  // so their first visible section is unchanged. My Workspace still precedes the conditional
  // Approvals Hub section.
  {
    const myWorkspaceIdx = portalLayout.indexOf('title: "My Workspace"');
    const trainingManagerIdx = portalLayout.indexOf('title: "Training Manager"');
    const approvalsHubIdx = portalLayout.indexOf('title: "Approvals Hub"');
    assert.ok(myWorkspaceIdx > -1 && trainingManagerIdx > -1 && approvalsHubIdx > -1, "all three section titles are present");
    assert.ok(trainingManagerIdx < myWorkspaceIdx, "Training Manager section leads, ahead of My Workspace");
    assert.ok(myWorkspaceIdx < approvalsHubIdx, "My Workspace is ordered before Approvals Hub");
  }

  // ── Plan Phase 2 enhancements ────────────────────────────────────────────────
  // Edit-request stage + overdue-first sort, all reusing the existing plan workflow (no new routing).
  // "list_removal" joined 2026-10-16: a district manager's ask to remove a customer from Manager's own
  // list waits on his RSM/NSM in this same queue (docs/phoenix-crm-manager-plan.md). "single_visit_day"
  // joined 2026-10-20: his ask for a second or third day of single visits waits there too.
  assert.match(svc, /export type PlanApprovalStage = "manager" \| "ceo" \| "hr" \| "edit_request" \| "list_removal" \| "single_visit_day";/, "the edit-request decision is surfaced as its own stage");
  assert.match(svc, /PLAN_ACTIVE_STATUSES[\s\S]*?"edit_requested"/, "edit_requested plans are fetched into the responder buckets");
  assert.match(svc, /const byMostOverdue = /, "the awaiting list sorts most-overdue first");
  assert.match(svc, /function computePlanComposition\(/, "plan composition summary is computed server-side");
  assert.match(svc, /function computePeriodStatus\(/, "plan period status (upcoming/current/past) is computed server-side");
  assert.match(svc, /function buildReturnableActivities\(/, "per-activity ids are carried for the return composer");
  for (const field of [
    "isEditRequestDecision: boolean;",
    "canRequestVisitDetails: boolean;",
    "returnableActivities: PlanReturnableActivity\\[\\];",
    "isOwner: boolean;",
    "plannerHref: string;",
    "composition: PlanComposition;",
    "periodStatus: PlanPeriodStatus;",
  ]) {
    assert.match(svc, new RegExp(field), `PlanApprovalDetail exposes ${field}`);
  }

  // Premium return composer + niche actions + refresh-on-conflict, all via existing endpoints.
  assert.match(planActions, /openNotes/, "the return composer tracks per-activity flagged notes");
  assert.match(planActions, /Return with notes/, "the Return action opens the per-activity composer");
  assert.match(planActions, /returnNotes/, "return submits per-activity notes through the existing returnNotes workflow");
  assert.match(planActions, /\/edit-request-decision/, "edit-request decisions post to the existing edit-request endpoint");
  assert.match(planActions, /\/request-visit-details/, "request-visit-details posts to the existing endpoint");
  assert.match(planActions, /router\.refresh\(\)[\s\S]*?return;/, "a conflict/stale decide refreshes so the card self-corrects (refresh-on-conflict)");

  // Owner planner button + approver context (approvers only) + summary/period badge on the detail.
  const planDetailCmp = readFileSync("src/components/approvals-hub/plan-request-detail.tsx", "utf8");
  assert.match(planDetailCmp, /Open in my planner/, "the submitter gets a button to their planner from the plan page");
  assert.match(planDetailCmp, /detail\.isOwner && detail\.plannerHref/, "the planner button only shows for the plan's own submitter");
  assert.match(planDetailCmp, /!detail\.isOwner \? <PlanApproverContext/, "the approver context panel is hidden from the submitter viewing their own plan");
  assert.match(planDetailCmp, /<PlanCompositionSummary/, "the detail shows the plan composition summary");
  assert.match(planDetailCmp, /<PlanPeriodBadge/, "the detail shows the period status badge");
  const planContext = readFileSync("src/components/approvals-hub/plan-approver-context.tsx", "utf8");
  assert.match(planContext, /\/api\/approvals-hub\/employee-context/, "approver context reuses the existing employee-context endpoint, not a new backend");

  // ── Sidebar badge graduated urgency (SLA-overdue → red/faster pump) ───────────
  assert.match(svc, /export async function isVacationAwaitingOverdue/, "vacation exposes an SLA-overdue check for the sidebar badge");
  assert.match(svc, /export async function isExcuseAwaitingOverdue/, "excuse exposes an SLA-overdue check for the sidebar badge");
  assert.match(svc, /export async function isPlanAwaitingOverdue/, "plan exposes an SLA-overdue check for the sidebar badge");
  assert.match(svc, /slaTone\(row\.slaAgeDays, APPROVALS_SLA_THRESHOLDS\.leave\)/, "vacation overdue check reuses the shared SLA threshold, not a hardcoded number");
  assert.match(svc, /slaTone\(daysSinceCalendar\(req\.createdAt\), APPROVALS_SLA_THRESHOLDS\.excuse\)/, "excuse overdue check reuses the shared SLA threshold and age helper");
  assert.match(svc, /slaTone\(item\.ageDays, APPROVALS_SLA_THRESHOLDS\.plan\)/, "plan overdue check reuses the shared SLA threshold");

  const vacationCountRoute = readFileSync("app/api/approvals/vacation/pending-count/route.ts", "utf8");
  assert.match(vacationCountRoute, /isVacationAwaitingOverdue/, "vacation pending-count route computes overdue");
  assert.match(vacationCountRoute, /NextResponse\.json\(\{ count, overdue \}/, "vacation pending-count route returns overdue alongside count");
  const excuseCountRoute = readFileSync("app/api/approvals/excuse/pending-count/route.ts", "utf8");
  assert.match(excuseCountRoute, /isExcuseAwaitingOverdue/, "excuse pending-count route computes overdue");
  const planCountRoute = readFileSync("app/api/approvals/plan/pending-count/route.ts", "utf8");
  assert.match(planCountRoute, /isPlanAwaitingOverdue/, "plan pending-count route computes overdue");

  const navBadgeStore = readFileSync("src/lib/nav-badge-store.ts", "utf8");
  assert.match(navBadgeStore, /type Listener = \(count: number \| null, overdue: boolean\) => void;/, "the badge poll store threads overdue through to listeners");

  assert.match(navBadgeSource, /nav-badge-alarm-overdue/, "NavBadge switches to the overdue alarm class once any awaiting item breaches its SLA");

  // ── Stuck approvals — needs reassignment (HR / Super Admin only, Part C) ──────
  assert.match(
    svc,
    /export async function getStuckApprovalsForReassignment\(/,
    "service must export getStuckApprovalsForReassignment",
  );
  assert.match(
    svc,
    /export async function getStuckApprovalsForReassignment[\s\S]*?if \(!isAllVacationVisibility\(access\)\) \{\s*throw new Error\("Forbidden: only HR or Super Admin can view stuck approvals for reassignment\."\);/,
    "stuck-approvals data is gated to HR / Super Admin (isAllVacationVisibility), defense-in-depth alongside the page gate",
  );
  assert.match(
    svc,
    /getStuckApprovalsForReassignment[\s\S]*?listWeeklyPlanManagerGapRecords\(\)/,
    "stuck approvals aggregate the weekly-plan gap listing",
  );
  assert.match(
    svc,
    /getStuckApprovalsForReassignment[\s\S]*?listExcuseManagerGapRecords\(\)/,
    "stuck approvals aggregate the excuse gap listing",
  );

  // Page gates to HR / Super Admin on the server BEFORE fetching (sidebar visibility is UX only).
  const stuckPage = readFileSync("app/(admin)/admin/approvals/stuck/page.tsx", "utf8");
  assert.match(
    stuckPage,
    /if \(!isAllVacationVisibility\(access\)\) redirect\(/,
    "the stuck-approvals page redirects non-HR/Super-Admin viewers before any data fetch",
  );
  assert.match(stuckPage, /getStuckApprovalsForReassignment\(access\)/, "the page loads the gated stuck-approvals data");
  assert.match(stuckPage, /<StuckApprovalsPanel/, "the page renders the StuckApprovalsPanel");

  // The panel's Reassign action calls the two new reassignment routes (reassignment, not deciding).
  const stuckPanel = readFileSync("src/components/approvals-hub/stuck-approvals-panel.tsx", "utf8");
  assert.match(
    stuckPanel,
    /\/api\/weekly-plans\/\$\{encodeURIComponent\(plan\.planId\)\}\/reassign/,
    "the panel reassigns plans via the new weekly-plan reassign route",
  );
  assert.match(
    stuckPanel,
    /\/api\/excuses\/\$\{encodeURIComponent\(excuse\.requestId\)\}\/reassign/,
    "the panel reassigns excuses via the new excuse reassign route",
  );
  assert.match(stuckPanel, /newManagerHrId/, "the panel sends the picked new active manager to the reassign route");
}
