import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  excuseApprovalHref,
  vacationApprovalHref,
  vacationApprovalsBasePath,
  excuseApprovalsBasePath,
  planApprovalHref,
  planApprovalsBasePath,
} from "../src/lib/approvals-hub/service.ts";
import { slaTone, APPROVALS_SLA_THRESHOLDS } from "../src/components/approvals-hub/sla-thresholds.ts";

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
  assert.match(portalLayout, /import \{ NavBadge \} from "@\/components\/layout\/sidebar";/, "portal reuses the exact same NavBadge polling client as admin, not a new mechanism");
  assert.match(portalLayout, /<NavBadge src="\/api\/approvals\/vacation\/pending-count" \/>/, "portal vacation badge points at the same count API as admin");
  assert.match(portalLayout, /<NavBadge src="\/api\/approvals\/excuse\/pending-count" \/>/, "portal excuse badge points at the same count API as admin");
  const sidebarSource = readFileSync("src/components/layout/sidebar.tsx", "utf8");
  assert.match(sidebarSource, /export function NavBadge/, "NavBadge is exported so the portal layout can reuse it verbatim");

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
  assert.match(
    vacationSvc,
    /function isAllVacationVisibility\(access: AccessContext\) \{\s*return access\.scope === "system" \|\| access\.role === "Super Admin";/,
    "vacation visibility is role/scope-gated, never hrId-gated — a blank hrId Super Admin must still see company-wide",
  );
  assert.match(
    vacationSvc,
    /function canSeeVacation\(access: AccessContext,[^)]*\) \{\s*if \(isAllVacationVisibility\(access\)\) return true;/,
    "canSeeVacation short-circuits true for system-authority actors before any hrId-based check runs",
  );
  const shouldScopeMatch = /const shouldScopeEmployees = !isAllVacationVisibility\(input\.access\);/;
  assert.match(vacationSvc, shouldScopeMatch, "the report RPC's employee scoping is role/scope-gated, not hrId-gated");

  // Never silently collapse a real failure to an empty bucket without at least one server log line
  // — a swallowed error must not look identical to "nothing pending" for this actor.
  assert.match(svc, /console\.error\("\[approvals-hub\] getVacationActionCenterData failed"/, "vacation bucket failures are logged, not silently swallowed");
  assert.match(svc, /console\.error\("\[approvals-hub\] getVacationReportData failed"/, "vacation report failures are logged, not silently swallowed");
  assert.match(svc, /console\.error\("\[approvals-hub\] countVacationAwaiting failed"/, "vacation badge-count failures are logged, not silently swallowed");
  assert.match(svc, /console\.error\("\[approvals-hub\] countExcuseAwaiting failed"/, "excuse badge-count failures are logged, not silently swallowed");
  assert.match(svc, /console\.error\("\[approvals-hub\] getManagerPendingExcuses failed"/, "excuse pending failures are logged, not silently swallowed");

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
  assert.match(svc, /import \{ resolveApproverPlanStage \} from "@\/lib\/weekly-planning\/service";/, "plan buckets reuse the existing server-side approver authority rule (no workflow change)");
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

  // The self-contained per-plan page reuses the extracted shared calendar renderer (one source).
  const planDetail = readFileSync("src/components/approvals-hub/plan-request-detail.tsx", "utf8");
  assert.match(planDetail, /import \{ WeeklyPlanCalendar \} from "@\/components\/action-center\/weekly-plan-calendar"/, "plan detail reuses the extracted shared WeeklyPlanCalendar, not a re-built grid");
  const combinedHub = readFileSync("src/components/action-center/action-center-hub.tsx", "utf8");
  assert.match(combinedHub, /import \{ WeeklyPlanCalendar \} from "@\/components\/action-center\/weekly-plan-calendar"/, "the combined hub renders the same extracted calendar — single source of truth");

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
    assert.doesNotMatch(excuseFlagMatch![1], /National Sales Manager/, "National Sales Manager does NOT see Excuse Approvals (reps under a DM never route excuses to the NSM; NSM-level goes through Head Office)");
    for (const role of ["District Manager", "Regional Manager", "Product Manager", "Group Product Manager", "Marketing Manager", "Manager"]) {
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
    assert.match(hubBody, /marketing-requests\/inbox.*Marketing Requests Inbox/, "the Marketing Requests Inbox lives inside the Approvals Hub section, under its renamed label");
  }
  const myWorkspaceMatch = portalLayout.match(/title: "My Workspace",\s*items: \[([\s\S]*?)\],\s*\}/);
  assert.ok(myWorkspaceMatch, "My Workspace section body is present");
  assert.doesNotMatch(myWorkspaceMatch![1], /approvals\/vacation|approvals\/excuse|approvals\/plan/, "the 3 approval links moved out of My Workspace into the dedicated Approvals Hub section");
  assert.doesNotMatch(myWorkspaceMatch![1], /approvals-hub/, "Other Approvals moved out of My Workspace into the dedicated Approvals Hub section");
  const marketingSectionMatch = portalLayout.match(/title: "Marketing & ROI",\s*items: \[([\s\S]*?)\],\s*\}/);
  assert.ok(marketingSectionMatch, "Marketing & ROI section body is present");
  assert.doesNotMatch(marketingSectionMatch![1], /marketing-requests\/inbox/, "the Marketing Requests Inbox moved out of Marketing & ROI into the Approvals Hub section");
  assert.match(portalLayout, /if \(title === "Approvals Hub"\) return CalendarDays;/, "the collapsed-rail icon map has an entry for the new section");

  // The rename applies to the portal route's own page heading too (not the separate admin-shell
  // "Approval Inbox" at /admin/marketing-requests/inbox, which is untouched).
  const portalInboxPage = readFileSync("app/employee-portals/marketing-requests/inbox/page.tsx", "utf8");
  assert.match(portalInboxPage, /title="Marketing Requests Inbox"/, "the portal inbox page's own heading matches the renamed sidebar label");
  assert.doesNotMatch(portalInboxPage, /title="Approval Inbox"/, "the old page title is fully replaced, not left alongside the new one");
  assert.match(navRegistry, /fullLabel: "Marketing Requests Inbox"/, "the nav registry's full label matches the rename too (bottom-nav/quick-nav consistency)");

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
  assert.match(svc, /export type PlanApprovalStage = "manager" \| "ceo" \| "hr" \| "edit_request";/, "the edit-request decision is surfaced as its own stage");
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
}
