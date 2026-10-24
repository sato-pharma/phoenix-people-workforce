import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import { createAccessContext, phoenixRoles, resolveNavigationMode, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { isPortalShellRole, portalShellRoles } from "../src/lib/auth/portal-shell-roles.ts";
import { notificationHrefForViewerRole } from "../src/lib/notifications/hrefs.ts";

// The two pages that bounce a signed-in viewer between them, modelled on their real guards:
//   /overview           → redirect(resolveLandingPathForRole(access.role))       app/overview/page.tsx
//   /employee-portals   → "/overview" when resolveNavigationMode(access) is not the portal,
//                         otherwise it renders                                    app/employee-portals/page.tsx
// A Training Manager signs in to /employee-portals/training-manager again (owner, 2026-10-24), but the
// portal home itself never bounces her, so the Command Center row still opens it.
// Every other address is a page that renders (for this pair's purposes).
function nextHop(path: string, role: PhoenixRole): string | null {
  const access = createAccessContext({ hrId: "HR-1", loginId: "login-1", role });
  if (path === "/overview") return resolveLandingPathForRole(access.role);
  if (path === "/employee-portals") {
    if (resolveNavigationMode(access) !== "employee-portal") return "/overview";
    return null;
  }
  return null;
}

function signIn(role: PhoenixRole): string[] {
  const seen = ["/overview"];
  let path: string | null = "/overview";
  while ((path = nextHop(path, role)) !== null) {
    assert.ok(
      !seen.includes(path),
      `a ${role} is bounced between /overview and the portal home forever: ${[...seen, path].join(" -> ")}. ` +
        "The landing path and the navigation mode disagree about whether this role belongs in the portal — " +
        "the same two-sources loop that grew a dev server to 9.9 GB on the expense pages on 2026-09-21.",
    );
    seen.push(path);
  }
  return seen;
}

export function runPortalShellRolesTests() {
  // 1. No role loops, and every role lands in the shell its navigation mode says it is in.
  for (const role of phoenixRoles) {
    const trail = signIn(role);
    const landed = trail[trail.length - 1];
    const mode = resolveNavigationMode(createAccessContext({ hrId: "HR-1", loginId: "login-1", role }));
    assert.equal(
      landed.startsWith("/employee-portals"),
      mode === "employee-portal",
      `${role} lands on ${landed} but its navigation mode is "${mode}" — the landing path and the shell must read the same list`,
    );
    assert.ok(trail.length <= 3, `${role} takes more than two hops to land: ${trail.join(" -> ")}`);
  }

  // 2. The shared list itself: real roles only, never the CEO, and both readers agree with it.
  for (const role of portalShellRoles) {
    assert.ok((phoenixRoles as readonly string[]).includes(role), `${role} on the portal list is not a real role`);
    assert.equal(isPortalShellRole(role.toUpperCase()), true, "the list is read case-insensitively by the landing path");
  }
  assert.equal(isPortalShellRole("CEO"), false, "the CEO is an admin-shell account, never on the portal list");
  assert.equal(resolveNavigationMode(createAccessContext({ hrId: "HR-1", loginId: "login-1", role: "CEO" })), "admin");
  assert.equal(resolveLandingPathForRole("CEO"), "/admin/ceo-command-center");
  assert.equal(isPortalShellRole(null), false);
  assert.equal(isPortalShellRole(""), false);

  // 3. The notification links read the same list: a portal manager's old planner link opens the
  //    portal plan page; an admin-shell role's link is left alone.
  for (const role of portalShellRoles) {
    assert.equal(
      notificationHrefForViewerRole({ fallbackHref: "/admin/weekly-plans?plan=p-1", role }),
      "/employee-portals/approvals/plan/p-1",
      `${role} is on the portal list, so its old planner link must open the portal plan page`,
    );
  }
  for (const role of ["SFE Manager", "Super Admin", "CEO"]) {
    assert.equal(
      notificationHrefForViewerRole({ fallbackHref: "/admin/weekly-plans?plan=p-1", role }),
      "/admin/weekly-plans?plan=p-1",
      `${role} is not on the portal list, so its planner link stays in the admin shell`,
    );
  }

  // 4. Source pins — one list, three readers, no second copy anywhere.
  const listSource = readFileSync("src/lib/auth/portal-shell-roles.ts", "utf8");
  assert.doesNotMatch(
    listSource,
    /^import (?!type )/m,
    "portal-shell-roles.ts takes no runtime import: landing.ts ships to the browser and must not pull permissions.ts in",
  );
  // Each reader's own second-copy shape: permissions.ts keeps the full role catalogue (phoenixRoles),
  // so there the pin is the retired lists' names, not any run of role names.
  const readers: Array<[string, RegExp, RegExp]> = [
    [
      "src/lib/auth/landing.ts",
      /import \{ isPortalShellRole \} from "@\/lib\/auth\/portal-shell-roles";/,
      /new Set\(|"district manager"/,
    ],
    [
      "src/lib/auth/permissions.ts",
      /import \{ isPortalShellRole \} from "@\/lib\/auth\/portal-shell-roles";/,
      /portalNavigationRoles|portalLandingRoleNames/,
    ],
    [
      "src/lib/notifications/hrefs.ts",
      /import \{ portalShellRoles \} from "@\/lib\/auth\/portal-shell-roles";/,
      /"District Manager"|"Medical Rep"/,
    ],
  ];
  for (const [file, importLine, secondCopy] of readers) {
    const source = readFileSync(file, "utf8");
    assert.match(source, importLine, `${file} must read the one portal-role list`);
    assert.doesNotMatch(source, secondCopy, `${file} keeps its own copy of the portal-role list again`);
  }
  assert.match(
    readFileSync("src/lib/auth/permissions.ts", "utf8"),
    /return isPortalShellRole\(context\.role\) \? "employee-portal" : "admin";/,
    "resolveNavigationMode decides the shell from the shared list",
  );
  assert.match(
    readFileSync("src/lib/auth/landing.ts", "utf8"),
    /return isPortalShellRole\(normalized\) \? "\/employee-portals" : "\/admin";/,
    "resolveLandingPathForRole decides the portal landing from the shared list",
  );
}
