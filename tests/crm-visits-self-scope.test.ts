import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Regression guard for the employee portal's self-scoped "My Visits" CRM module
 * (src/lib/employee-portal/my-crm-visits.ts, app/employee-portals/visits/page.tsx).
 *
 * This repo has already shipped, and fixed, a real substring-HR_ID self-service data
 * leak (see attendance-self-scope.test.ts, incident "C1": an employee whose ID
 * prefixed another's received colleagues' rows in their own "My Attendance" view).
 * This module is deliberately built on src/lib/crm/reads.ts's EXACT-match
 * agentHrIds/doubleHrIds filters — never src/lib/crm/master.ts's substring `ilike`
 * agent filter — so these are source-contract guards pinning that wiring, the same
 * pattern attendance-self-scope.test.ts uses (the reads hit Supabase and cannot be
 * unit-tested without DB infra).
 */
export function runCrmVisitsSelfScopeTests() {
  const dataLayer = readFileSync("src/lib/employee-portal/my-crm-visits.ts", "utf8");

  assert.match(dataLayer, /agentHrIds:\s*\[hrId\]/, "fetchMyVisits/fetchMyCheckins must scope with agentHrIds: [hrId]");
  assert.match(dataLayer, /doubleHrIds:\s*\[hrId\]/, "fetchMyDoubleVisits must scope with doubleHrIds: [hrId]");
  assert.doesNotMatch(
    dataLayer,
    /agentHrIdILike/,
    "must never use the substring-adjacent agentHrIdILike filter (the admin master table's C1-class risk)",
  );
  assert.doesNotMatch(
    dataLayer,
    /\.from\(\s*["'`]ireports360_/,
    "must read only through src/lib/crm/reads.ts, never query the mirror tables directly",
  );

  // hrId must be a required, single, non-array function argument on every exported
  // fetcher — never a filter-object field a future edit could leave unset or widen.
  assert.match(dataLayer, /export async function fetchMyVisits\(hrId: string, window: MyCrmWindow\)/);
  assert.match(dataLayer, /export async function fetchMyDoubleVisits\(hrId: string, window: MyCrmWindow\)/);
  assert.match(dataLayer, /export async function fetchMyCheckins\(hrId: string, window: MyCrmWindow\)/);

  // The exported row/window types must carry no hrId-shaped field — scope is only ever
  // the function argument above, never an object field a caller could tamper with.
  assert.doesNotMatch(
    dataLayer,
    /export type My\w+ = \{[^}]*(?:hrId|agentHrId)/,
    "exported types must not carry a client-settable hrId/agentHrId field",
  );

  const page = readFileSync("app/employee-portals/visits/page.tsx", "utf8");
  assert.match(page, /const hrId = access\.hrId;/, "the page must source hrId only from the resolved access context");
  // The address may choose WHICH tab and page is open (12 Nov 2026, "slim My Visits": only the 25 rows on
  // screen travel), and nothing else. Whose visits they are never comes from it.
  assert.match(
    page,
    /type PageProps = \{ searchParams\?: Promise<\{ tab\?: string \| string\[\]; page\?: string \| string\[\] \}> \};/,
    "🔴 the page's searchParams may name a tab and a page, and nothing else",
  );
  const paramReads = [...page.matchAll(/\bparams\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(paramReads)].sort(), ["page", "tab"], "🔴 the page reads only the tab and the page from the address");
  for (const line of page.split("\n")) {
    assert.ok(!(/hrId/i.test(line) && /params/i.test(line)), `🔴 the page must never read hrId (or whose visits) from searchParams: ${line.trim()}`);
  }
  assert.match(page, /if \(!hrId\) \{\s*redirect\(/, "the page must redirect when the caller has no hrId");
  assert.match(page, /canAccess\(access, "crm_visits", "read"\)/, "the page must gate on the crm_visits:read permission");
  assert.match(page, /fetchMyVisits\(hrId, window\)/, "the page must call fetchMyVisits with the resolved hrId");
  assert.match(page, /fetchMyDoubleVisits\(hrId, window\)/, "the page must call fetchMyDoubleVisits with the resolved hrId");
  assert.match(page, /fetchMyCheckins\(hrId, window\)/, "the page must call fetchMyCheckins with the resolved hrId");

  // The nav entry and permission resource must exist, gated by permission only (no
  // roles/excludedRoles restriction) — every employee-portal role can reach their own visits.
  const navConfig = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.match(
    navConfig,
    /\{ href: "\/employee-portals\/visits", icon: MapPinned, label: "My Visits", permissions: \[\{ resource: "crm_visits", action: "read" \}\] \}/,
    "the My Visits nav entry must exist, permission-gated only",
  );

  // The employee portal's actual sidebar chrome (EmployeePortalChrome) does NOT render
  // from system-navigation.ts — it builds its own hardcoded section list in
  // buildEmployeePortalSections, gated by resolveEmployeePortalNavVisibility flags. My
  // Visits must be listed there too, unconditionally, or it is unreachable from the
  // real portal sidebar despite the system-navigation.ts entry above.
  const portalLayout = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.match(
    portalLayout,
    /\{ href: "\/employee-portals\/visits", label: "My Visits", icon: MapPinned \}/,
    "the employee-portal sidebar (employee-portal-layout.tsx) must list My Visits unconditionally",
  );

  const permissions = readFileSync("src/lib/auth/permissions.ts", "utf8");
  assert.match(permissions, /\| "crm_visits"/, "crm_visits must be a declared PermissionResource");

  // ── Team Visits (manager tab) — the one deliberate exception to "single hrId" ──────────────
  // A manager's tab is about OTHER people by definition, so fetchTeamVisits takes a set. The
  // exception is only safe while these properties hold, so they are pinned here rather than left to
  // a code comment.

  // 1. The set is a required POSITIONAL argument the caller resolves — never derived in this file,
  //    so the module still cannot widen its own scope.
  assert.match(
    dataLayer,
    /export async function fetchTeamVisits\(hrIds: string\[\], window: MyCrmWindow\)/,
    "fetchTeamVisits must take the hrId set as a required positional argument",
  );
  assert.doesNotMatch(
    dataLayer,
    /getEmployeeDirectory|isWithinManagerHierarchy|reportsToManagerSeat/,
    "my-crm-visits.ts must NOT resolve a subtree itself — the caller passes the set in",
  );

  // 2. It FAILS CLOSED: an empty set must return before touching the database, so a caller that
  //    forgets to resolve a subtree gets nothing rather than every visit in the company.
  assert.match(
    dataLayer,
    /if \(agentHrIds\.length === 0\) return \[\];/,
    "fetchTeamVisits must fail closed on an empty hrId set",
  );

  // 3. It is HARD-CAPPED. The live Regional Manager's 17-person subtree logged 9,253 visits in a
  //    90-day window — an uncapped fetch rendered a 5.1 MB payload in 43s. Must use the bounded,
  //    DB-ordered reader, never the full-scan queryVisits the self tabs use.
  // The cap itself lives in the client-safe constants module (see below) and is re-exported here,
  // so assert on that module — but still require this file to expose the name, because
  // fetchTeamVisits reads it and a silent removal would uncap the feed.
  const visitConstants = readFileSync("src/lib/employee-portal/my-crm-visits-constants.ts", "utf8");
  assert.match(visitConstants, /export const TEAM_VISIT_ROW_CAP = \d+;/, "the team feed must declare a row cap");
  assert.match(dataLayer, /TEAM_VISIT_ROW_CAP/, "the data layer must still expose/apply the row cap");

  // The cap constant must NOT be declared in this server-only module. my-crm-visits.ts reaches
  // node:crypto (crm/reads -> employee-directory -> employee-photo), so the "use client" workspace
  // importing a VALUE from here pulls that chain into the browser bundle and hard-fails the webpack
  // dev build with UnhandledSchemeError — which then poisons every route compiled afterwards, not
  // just /employee-portals/visits. Production (Turbopack) tolerated it, so it broke only local dev,
  // silently. Keep the value import pointed at the constants module.
  const visitsWorkspace = readFileSync("src/components/employee-portal/my-visits-workspace.tsx", "utf8");
  assert.doesNotMatch(
    visitsWorkspace,
    /import\s*\{[^}]*\}\s*from\s*["']@\/lib\/employee-portal\/my-crm-visits["']/,
    "the client workspace must not VALUE-import the server-only my-crm-visits module (use my-crm-visits-constants; `import type` is fine)",
  );
  const teamFnIdx = dataLayer.indexOf("export async function fetchTeamVisits(");
  // Slice to the END of fetchTeamVisits, not a fixed byte count — a byte count measures how long
  // the function happens to be, not whether it still uses the bounded reader.
  const teamRest = dataLayer.slice(teamFnIdx + 1);
  const nextDecl = teamRest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  const teamFnBody = dataLayer.slice(teamFnIdx, nextDecl >= 0 ? teamFnIdx + 1 + nextDecl : dataLayer.length);
  assert.match(teamFnBody, /queryVisitsLimited</, "the team feed must use the bounded reader");
  assert.match(teamFnBody, /limit: TEAM_VISIT_ROW_CAP/, "the team feed must pass the declared cap");

  // 4. The page resolves the subtree with the canonical seat-continuity-aware helper, and only for
  //    roles whose scope actually extends past themselves.
  assert.match(page, /async function resolveVisitsTeamHrIds\(access: AccessContext\)/);
  assert.match(page, /isWithinManagerHierarchy\(/, "hierarchy viewers must get their whole subtree");
  assert.match(page, /reportsToManagerSeat\(/, "team viewers must get their direct reports");
  assert.match(
    page,
    /access\.scope !== "hierarchy" && access\.scope !== "team"/,
    "a viewer with neither scope must resolve to an empty team (no tab)",
  );

  // 4b. The National Sales Manager is line-scoped, so the subtree rule gave him an empty tab while
  //     every manager beneath him had one (owner, 2026-10-20). He resolves through the doctor-coverage
  //     line scope — downward-only, override-aware — and fails closed on anything but an agent list,
  //     BEFORE the scope gate that would otherwise return nobody. Read with comments stripped, so a
  //     commented-out branch cannot satisfy it.
  const pageCode = stripComments(page);
  const nsmIdx = pageCode.indexOf('if (access.role === "National Sales Manager") {');
  const gateIdx = pageCode.indexOf('if (access.scope !== "hierarchy" && access.scope !== "team") return [];');
  assert.ok(nsmIdx >= 0, "the Team Visits resolver must carry a National Sales Manager branch");
  assert.ok(gateIdx > nsmIdx, "the NSM branch must run before the hierarchy/team scope gate");
  const nsmBranch = pageCode.slice(nsmIdx, gateIdx);
  assert.match(nsmBranch, /const lineScope = await getDoctorCoverageScope\(access\);/, "the NSM's team is his doctor-coverage line scope");
  assert.match(nsmBranch, /if \(lineScope\.kind !== "agents"\) return \[\];/, "a scope that is not an agent list resolves to nobody");
  assert.match(
    nsmBranch,
    /lineScope\.agentHrIds\.filter\(\(hrId\) => normalizeHrIdForAccess\(hrId\) !== viewerKey\)/,
    "the NSM's own visits stay on his own tabs",
  );

  // 5. A truncated list must never read as a complete one.
  // Since 12 Nov 2026 ("slim My Visits") the server counts the whole team feed and sends the flag.
  const workspace = readFileSync("src/components/employee-portal/my-visits-workspace.tsx", "utf8");
  assert.match(
    readFileSync("src/lib/employee-portal/my-visits-view.ts", "utf8"),
    /teamCapped: input\.teamVisits\.length >= TEAM_VISIT_ROW_CAP/,
    "the Team Visits tab must tell the viewer when the cap was hit",
  );
  assert.match(workspace, /\{teamCapped \? \(/, "the Team Visits tab must tell the viewer when the cap was hit");
  assert.match(
    workspace,
    /TABS\.filter\(\(item\) => item\.id !== "team" \|\| hasTeam\)/,
    "the Team Visits tab must not render for a viewer with no team",
  );
}
