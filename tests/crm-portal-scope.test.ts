import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CRM_SCOPE_ALL,
  crmScopeNothing,
  intersectHrIdAllowLists,
  intersectHrIdKeySets,
} from "../src/lib/crm/viewer-scope.ts";
import { LINE_SCOPED_PORTAL_CRM_ROLES, PORTAL_CRM_ROLES, isPortalCrmRole, toPortalCrmScopeView } from "../src/lib/crm/portal-crm-scope.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Guards for the scoped portal CRM (/employee-portals/crm). Two kinds:
 *
 *  (A) PURE, DB-free unit tests of the scope algebra — the ENTIRE security guarantee rests on
 *      intersectHrIdAllowLists behaving exactly right, because the viewer scope and the UI Line
 *      filter share one `allowedHrIds` slot in applyMasterFilters. Get the intersection wrong and a
 *      District Manager who picks "Line: Pedia" sees all of Pedia.
 *
 *  (B) SOURCE-CONTRACT guards — resolvePortalCrmScope, getCrmMasterData and the routes hit Supabase
 *      and can't be unit-tested without DB infra, so (as tests/crm-visits-self-scope.test.ts does)
 *      we pin the load-bearing wiring by asserting the source text. These catch a refactor that
 *      would quietly reintroduce the C1 substring-leak class or a fail-OPEN default.
 */
export function runCrmPortalScopeTests() {
  // ── (A) role set ────────────────────────────────────────────────────────────
  // The four field roles, and since 2026-10-20 the Product and Group Product Manager on their own line
  // (owner: every role a module applies to must find its people).
  assert.equal(PORTAL_CRM_ROLES.length, 6, "PORTAL_CRM_ROLES must be exactly the four field roles plus the two line-scoped product seats");
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager", "Group Product Manager"]) {
    assert.ok(isPortalCrmRole(role), `${role} must be a portal CRM role`);
  }
  for (const role of ["Manager", "Employee", "CEO", "Super Admin", "SFE Manager", "Training Manager", "Marketing Manager", "HR Advisory", "HR Operations"]) {
    assert.ok(!isPortalCrmRole(role), `${role} must NOT be a portal CRM role`);
  }
  assert.deepEqual([...LINE_SCOPED_PORTAL_CRM_ROLES], ["Product Manager", "Group Product Manager"], "only the two product seats resolve by line");
  // Their line scope is the doctor-coverage resolver (downward only, line overrides honoured), and a
  // non-list answer from it fails CLOSED, exactly like the {all:true} DV answer below.
  const portalScopeCode = stripComments(readFileSync("src/lib/crm/portal-crm-scope.ts", "utf8"));
  assert.match(
    portalScopeCode,
    /if \(lineScopedPortalCrmRoleSet\.has\(access\.role\)\) \{\s*const lineScope = await getDoctorCoverageScope\(access\);\s*if \(lineScope\.kind !== "agents"\) return crmScopeNothing\(\);/,
    "a product seat must resolve through getDoctorCoverageScope and fail closed on anything but an agent list",
  );
  assert.equal(toPortalCrmScopeView({ kind: "hr-ids", hrIds: ["A", "B"], keys: new Set(["a", "b"]), lineNames: [] }, "Product Manager").scopeSummary, "Your line · 2 team members", "a product seat's chip names his line");
  // The Head-Office "Manager" rung is the specific regression risk (isDistrictManager matches it).
  assert.ok(!isPortalCrmRole("Manager"), "the Head-Office Manager rung must be excluded (no field reps → empty grid)");

  // ── (A) intersectHrIdAllowLists: null = no restriction, [] = nobody ──────────
  assert.equal(intersectHrIdAllowLists(null, null), null, "no scope + no filter → null (unrestricted)");
  assert.deepEqual(intersectHrIdAllowLists(["a", "b"], null), ["a", "b"], "scope only → scope");
  assert.deepEqual(intersectHrIdAllowLists(null, ["a"]), ["a"], "filter only → filter");
  // The load-bearing case: a Line filter must NARROW the scope, never REPLACE it.
  assert.deepEqual(intersectHrIdAllowLists(["a", "b"], ["b", "c"]), ["b"], "scope ∩ filter narrows to the overlap");
  // An empty intersection is [], NOT null — [] matches nobody, null would match everybody.
  assert.deepEqual(intersectHrIdAllowLists(["a"], ["b"]), [], "disjoint scope/filter → [] (nobody), never null");
  assert.deepEqual(intersectHrIdAllowLists([], ["a"]), [], "empty scope stays empty (fail closed)");
  // Case-insensitive: HR ids drift in casing across the mirror.
  assert.deepEqual(intersectHrIdAllowLists(["A-1"], ["a-1"]), ["A-1"], "intersection is case-insensitive");

  // ── (A) intersectHrIdKeySets mirrors the same algebra for the computed tabs ──
  assert.equal(intersectHrIdKeySets(null, null), null, "no scope + no filter keys → null");
  assert.deepEqual([...(intersectHrIdKeySets(new Set(["a", "b"]), null) ?? [])], ["a", "b"], "scope keys only");
  assert.deepEqual([...(intersectHrIdKeySets(new Set(["a", "b"]), new Set(["b"])) ?? [])], ["b"], "key intersection narrows");
  assert.deepEqual([...(intersectHrIdKeySets(new Set(["a"]), new Set(["b"])) ?? [])], [], "disjoint keys → empty set (nobody)");

  // ── (A) the two sentinels ────────────────────────────────────────────────────
  assert.equal(CRM_SCOPE_ALL.kind, "company", "CRM_SCOPE_ALL is the only company-wide scope");
  const nothing = crmScopeNothing();
  assert.equal(nothing.kind, "hr-ids", "the fail-closed scope is an hr-ids scope");
  if (nothing.kind === "hr-ids") {
    assert.equal(nothing.hrIds.length, 0, "crmScopeNothing matches nobody (empty hrIds), not everybody");
  }

  // ── (A) scope view labels ────────────────────────────────────────────────────
  const emptyView = toPortalCrmScopeView(crmScopeNothing(), "District Manager");
  assert.equal(emptyView.agentCount, 0, "an empty scope reports zero agents");
  const companyView = toPortalCrmScopeView(CRM_SCOPE_ALL, "Super Admin");
  assert.equal(companyView.scopeSummary, "Company-wide", "company scope is labelled company-wide");

  // ── (B) source-contract guards ───────────────────────────────────────────────
  const master = readFileSync("src/lib/crm/master.ts", "utf8");
  // scope is a REQUIRED parameter on both entry points — an optional one defaulting to unrestricted
  // would be fail-OPEN by construction.
  assert.match(
    master,
    /export async function getCrmMasterData\(\s*input: CrmMasterFilter,\s*scope: CrmViewerScope,\s*viewer: PhoenixDetailViewer,/,
    "getCrmMasterData must take a required scope — and, since 2026-10-07, a required VIEWER: the Phoenix field set's location and timing half is not every reader's (golden rule #1)",
  );
  assert.match(
    master,
    /export async function\* streamCrmMasterExportPages\(\s*input: CrmMasterFilter,\s*scope: CrmViewerScope,\s*viewer: PhoenixDetailViewer,/,
    "the streaming export must take a required scope and the same required viewer",
  );
  // Scope and the Line filter are INTERSECTED, never one overwriting the other.
  assert.ok(master.includes("intersectHrIdAllowLists("), "master.ts must intersect scope with the Line/Hire filter, not overwrite one with the other");
  // The fail-closed empty-set sentinel the whole design leans on must still be in applyMasterFilters.
  assert.ok(master.includes('["__no_match__"]'), "applyMasterFilters must keep its fail-closed empty-allow-set sentinel");
  // The Vacations computed tab is memoised like Triples: a scoped viewer (down to a single Medical Rep)
  // must not re-scan the whole mirror on every page render / Next-Prev click. computeVacationPeriods
  // delegates to an uncached worker behind a short-TTL cache, exactly as computeTriplesInRange does.
  assert.ok(master.includes("vacationsCache"), "the Vacations computed tab must be memoised (vacationsCache), like triplesCache");
  assert.ok(
    master.includes("computeVacationPeriodsUncached"),
    "computeVacationPeriods must delegate to a cached wrapper over computeVacationPeriodsUncached",
  );

  const portalScope = readFileSync("src/lib/crm/portal-crm-scope.ts", "utf8");
  // Scope is expressed via the EXACT-match agent filter, NEVER the substring one (the C1 leak class).
  assert.doesNotMatch(portalScope, /agentHrIdILike/, "the portal scope must never use the substring agentHrIdILike filter (C1-class leak)");
  assert.doesNotMatch(portalScope, /\bilike\b/i, "the portal scope must never use an ilike substring match");
  // A {all:true} answer from resolveDoubleVisitAccessScope must fail CLOSED here, not widen to company.
  assert.match(portalScope, /if \(dvScope\.all\) return crmScopeNothing\(\)/, "an {all:true} DV scope must fail closed to nothing, never to company-wide");

  // ── (B) CRM_SCOPE_ALL is constructible in exactly the two admin surfaces ─────
  const adminPage = readFileSync("app/(admin)/admin/crm/page.tsx", "utf8");
  const adminExport = readFileSync("app/api/admin/crm/master-export/route.ts", "utf8");
  assert.ok(adminPage.includes("CRM_SCOPE_ALL"), "the admin /admin/crm page constructs the company scope");
  assert.ok(adminExport.includes("CRM_SCOPE_ALL"), "the admin export constructs the company scope");
  // The admin export keeps a HARD ROLE GATE in front of the company-wide scope — the scoped path
  // must not have loosened it. The gate moved from an inline `role !== "Super Admin"` to the shared
  // canUseAdminCrmWorkspace predicate when the owner granted the SFE Manager the CRM workspace
  // (2026-08-02); what this guards is that CRM_SCOPE_ALL is never reachable WITHOUT such a gate,
  // not which roles are on the list. The list itself is asserted in ceo-command-center.test.ts.
  assert.ok(
    adminExport.includes("canUseAdminCrmWorkspace(access)"),
    "the admin export must keep a hard role gate in front of the company-wide CRM scope",
  );
  // The admin export cover stamps the generated time in Cairo local too, never raw UTC — the same
  // house rule the portal twin holds below (both twins must match).
  assert.ok(adminExport.includes("cairoDateTimeSortable"), "the admin export cover must stamp the generated time in Cairo local");
  assert.ok(!adminExport.includes("UTC"), "the admin export cover must not stamp the generated time in UTC");
  assert.ok(
    adminPage.includes("canUseAdminCrmWorkspace(access)"),
    "the admin CRM page must keep a hard role gate in front of the company-wide CRM scope",
  );

  // ── (B) the portal page + export enforce the gate and never expose the panels ─
  const portalPage = readFileSync("app/employee-portals/crm/page.tsx", "utf8");
  assert.ok(portalPage.includes("isPortalCrmRole(access.role)"), "the portal page must gate on isPortalCrmRole");
  assert.ok(portalPage.includes('assertPermission(access, "crm_visits", "read")'), "the portal page must assert crm_visits:read");
  // A revoked crm_visits:read (role_permission_overrides) must redirect to the role's landing page,
  // NOT throw an uncaught 500 — assertPermission runs before the shell's error boundary. Matches the
  // scoped export route, which returns a clean 403 for the identical case.
  assert.ok(
    portalPage.includes("isForbiddenError"),
    "the portal page must catch a ForbiddenError from assertPermission and redirect, never surface it as a 500",
  );
  assert.ok(portalPage.includes("resolvePortalCrmScope(access)"), "the portal page must resolve the per-viewer scope");
  // A manager reads the mirror on a decision surface, so the portal shows the sync freshness panel.
  // getCrmMasterData already loads the sync runs this renders from. Its backfill control went with
  // the vendor (2026-11-06), so there is no read-only switch left to pin.
  assert.ok(portalPage.includes("<CrmSyncStatusPanel"), "the portal page must render the CRM sync-status panel for a freshness signal");
  const syncPanel = readFileSync("src/components/crm/crm-sync-status-panel.tsx", "utf8");
  assert.equal(syncPanel.includes("/api/admin/visits-report/backfill"), false, "no surface of the sync panel can start a vendor backfill");
  assert.ok(portalPage.includes("extraTabs={[]}"), "the portal page must pass extraTabs={[]} so the unscoped governance panels never render");
  assert.ok(portalPage.includes("showMappingFilter={false}"), "the portal page must hide the agent-unmapped Mapping filter");
  // The page must not implement a `view` param at all, so ?view=unmapped can't reach a governance panel.
  assert.doesNotMatch(portalPage, /viewParam|params\.view/, "the portal page must never read a ?view= param");
  assert.ok(!portalPage.includes("CRM_SCOPE_ALL"), "the portal page must never construct the company-wide scope");

  const portalExport = readFileSync("app/api/employee-portals/crm/master-export/route.ts", "utf8");
  assert.ok(portalExport.includes("isPortalCrmRole(access.role)"), "the portal export must gate on isPortalCrmRole");
  assert.ok(
    portalExport.includes("streamCrmMasterExportPages(filter, scope, viewer)"),
    "the portal export must stream with the resolved scope and the reader's own tier",
  );
  assert.ok(
    portalExport.includes("crmMasterExportColumnsFor(filter, viewer)"),
    "and build its header from the SAME viewer — a header for a column the shaper refuses to fill reads as 'there was no reading'",
  );
  // Must stay row-by-row streaming — no buffering the whole result (the PR #1473 corruption regression).
  assert.doesNotMatch(portalExport, /await streamCrmMasterExportPages/, "the portal export must not await/buffer the generator");
  assert.doesNotMatch(portalExport, /Array\.from\(/, "the portal export must not collect the stream into an array");
  assert.ok(portalExport.includes("maxDuration = 300"), "the portal export keeps the 300s streaming budget");
  // The export cover stamps the generated time in Cairo local, never raw UTC (house rule).
  assert.ok(portalExport.includes("cairoDateTimeSortable"), "the export cover must stamp the generated time in Cairo local");
  assert.ok(!portalExport.includes("UTC"), "the export cover must not stamp the generated time in UTC");

  // ── (B) the reusable grid's admin default is unchanged ───────────────────────
  const table = readFileSync("src/components/crm/crm-master-table.tsx", "utf8");
  assert.ok(table.includes('exportPath = "/api/admin/crm/master-export"'), "CrmMasterTable's default exportPath must stay the admin route (admin page unchanged)");
}
