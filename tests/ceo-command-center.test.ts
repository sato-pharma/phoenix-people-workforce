import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { createAccessContext, resolveNavigationMode } from "../src/lib/auth/permissions.ts";
import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";

// NOTE: Phase 1 intentionally uses the CEO's EXISTING permission matrix unchanged.
// These tests verify routing, navigation, and the server-side guard CONTRACT only.
// Governance lockdown (narrowing CEO approve/admin grants) is deferred to Phase 2.
export function runCeoCommandCenterTests() {
  // 1) CEO lands on the executive command center — never /ceo, never the employee portal.
  assert.equal(resolveLandingPathForRole("CEO"), "/admin/ceo-command-center");
  assert.equal(resolveLandingPathForRole("ceo"), "/admin/ceo-command-center");
  assert.notEqual(resolveLandingPathForRole("CEO"), "/employee-portals");

  // 2) CEO uses the EXISTING admin NavigationMode (not employee-portal, not a new mode).
  const ceo = createAccessContext({ hrId: "CEO-1", role: "CEO" });
  assert.equal(resolveNavigationMode(ceo), "admin");

  // 3) No other role's landing or navigation mode changes (surgical, CEO-only).
  assert.equal(resolveLandingPathForRole("Medical Rep"), "/employee-portals");
  assert.equal(resolveLandingPathForRole("Finance Manager"), "/employee-portals");
  assert.equal(resolveLandingPathForRole("Super Admin"), "/admin");
  assert.equal(resolveNavigationMode(createAccessContext({ hrId: "MR-1", role: "Medical Rep" })), "employee-portal");
  assert.equal(resolveNavigationMode(createAccessContext({ hrId: "FM-1", role: "Finance Manager" })), "employee-portal");
  assert.equal(resolveNavigationMode(createAccessContext({ hrId: "SA-1", role: "Super Admin" })), "admin");

  // 4) Executive / CEO Command Center is the first, role-gated item in Admin navigation.
  //    Index-based checks are robust to line endings (CRLF/LF) and incidental whitespace.
  const navigationSource = readFileSync("src/config/system-navigation.ts", "utf8");
  const adminSectionsIdx = navigationSource.indexOf("adminNavigationSections = [");
  const executiveIdx = navigationSource.indexOf('id: "executive"');
  const commandCenterIdx = navigationSource.indexOf('id: "command-center"');
  assert.ok(adminSectionsIdx !== -1, "adminNavigationSections must exist");
  assert.ok(executiveIdx > adminSectionsIdx, "Admin navigation must contain an executive section");
  assert.ok(
    executiveIdx < commandCenterIdx,
    "Executive section must be the first item in adminNavigationSections (before command-center)",
  );
  const executiveBlock = navigationSource.slice(executiveIdx, commandCenterIdx);
  assert.match(executiveBlock, /href: "\/admin\/ceo-command-center"/, "Executive section links to the CEO command center");
  assert.match(executiveBlock, /roles: \["CEO", "Super Admin"\]/, "Executive section is gated to CEO and Super Admin");

  // 5) Server-side route guard contract — the page enforces access itself, not via the sidebar.
  //    (Real cross-role denial is exercised by the phase23 browser walkthrough; this pins the source contract.)
  const pageSource = readFileSync("app/(admin)/admin/ceo-command-center/page.tsx", "utf8");
  assert.match(pageSource, /resolveAccessContextFromPage\(\)/, "page resolves access on the server");
  assert.match(pageSource, /access\.role === "CEO"/, "CEO is allowed");
  assert.match(pageSource, /access\.role === "Super Admin"/, "Super Admin is allowed (intended)");
  assert.match(pageSource, /access\.scope === "system"/, "system scope is allowed");
  assert.match(
    pageSource,
    /if \(!isExecutive\)\s*\{?\s*redirect\(resolveLandingPathForRole\(access\.role\)\)/,
    "non-executive roles are redirected away from the CEO command center",
  );
  // The admin shell is now provided by the (admin) route-group layout, not per page.
  const adminLayoutSource = readFileSync("app/(admin)/layout.tsx", "utf8");
  assert.match(adminLayoutSource, /navigationMode="admin"/, "the admin route-group layout renders the admin shell");

  // 6) The CEO surface is read-only — no write/approve/export controls, no client interactivity.
  const componentSource = readFileSync("src/components/admin/ceo-command-center.tsx", "utf8");
  assert.doesNotMatch(componentSource, /"use client"/, "CEO command center is a server component (read-only)");
  assert.doesNotMatch(componentSource, /<button/, "no action buttons on the read-only executive surface");
  assert.doesNotMatch(componentSource, /onClick/, "no click handlers on the read-only executive surface");
  assert.doesNotMatch(componentSource, /<form/, "no forms on the read-only executive surface");

  // 7) No separate /ceo route was created — the surface lives inside /admin.
  assert.ok(!existsSync("app/ceo"), "no /ceo route should exist (CEO lives under /admin)");
}
