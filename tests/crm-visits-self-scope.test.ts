import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  assert.match(dataLayer, /doubleHrIds:\s*\[hrId\]/, "fetchMyJointVisits must scope with doubleHrIds: [hrId]");
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
  assert.match(dataLayer, /export async function fetchMyJointVisits\(hrId: string, window: MyCrmWindow\)/);
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
  assert.doesNotMatch(page, /searchParams/, "the page must never read hrId (or anything else) from searchParams");
  assert.match(page, /if \(!hrId\) \{\s*redirect\(/, "the page must redirect when the caller has no hrId");
  assert.match(page, /canAccess\(access, "crm_visits", "read"\)/, "the page must gate on the crm_visits:read permission");
  assert.match(page, /fetchMyVisits\(hrId, window\)/, "the page must call fetchMyVisits with the resolved hrId");
  assert.match(page, /fetchMyJointVisits\(hrId, window\)/, "the page must call fetchMyJointVisits with the resolved hrId");
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
}
