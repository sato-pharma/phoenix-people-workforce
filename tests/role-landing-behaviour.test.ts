import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveLandingPathForRole } from "../src/lib/auth/landing.ts";
import { assignablePhoenixRoles, canAccess, createAccessContext, type PermissionAction, type PermissionResource } from "../src/lib/auth/permissions.ts";
import { isPortalShellRole } from "../src/lib/auth/portal-shell-roles.ts";
import { isPageFencedForRole } from "../src/lib/auth/seat-page-fences.ts";
import { pageFileFor, permissionGateKeys, roleSetGates } from "./support/page-gate-reader.ts";
import { withPostgrestStandIn } from "./support/postgrest-stand-in.ts";

// REC-078 (phase 2): where each role lands after signing in — every role, not a handful.
//
// resolveLandingPathForRole (src/lib/auth/landing.ts) is called for EVERY assignable role, and each
// answer is checked against the app as it is: the address must be served by a real page, in the
// role's own shell, outside its seat fence, and through that page's own entry gate — the permission
// keys and role lists it asserts, judged by canAccess against the permission matrix the real loader
// builds (an empty override table, via the shared in-memory PostgREST). A role whose landing page
// turned it away would sign in to a redirect loop or a 403; this fails, naming the role, first.

const REPO_ROOT = process.cwd();

export async function runRoleLandingBehaviourTests(): Promise<void> {
  assert.ok(assignablePhoenixRoles.length >= 18, "every assignable seat is checked, so a missing one cannot pass by absence");

  let gatesChecked = 0;
  await withPostgrestStandIn({ tables: { role_permission_overrides: [], user_module_locks: [] } }, async () => {
    for (const role of assignablePhoenixRoles) {
      const landing = resolveLandingPathForRole(role);
      assert.ok(landing.startsWith("/"), `${role} lands on an address, not "${landing}"`);

      // 1. A real page serves it (the HR seats' /hr/… addresses are a proxy rewrite onto the bare page).
      const file = pageFileFor(landing, { repoRoot: REPO_ROOT, stripHrPrefix: true });
      assert.ok(file, `HEADLINE: ${role} lands on ${landing}, and a page must serve it`);

      // 2. In the role's own shell: the portal roles land in the portal, every other role outside it.
      assert.equal(
        landing.startsWith("/employee-portals"),
        isPortalShellRole(role),
        `${role} lands in ${landing.startsWith("/employee-portals") ? "the portal" : "the admin shell"}, which must be its own shell`,
      );

      // 3. Never on a page its seat is fenced out of.
      assert.equal(isPageFencedForRole(role, landing), false, `${role} must not land on a page its seat fence closes`);

      // 4. Through the landing page's own entry gate.
      const source = readFileSync(file, "utf8");
      const context = createAccessContext({ hrId: "STAND-IN-L", loginId: "stand.in.landing", role, source: "session" });
      for (const key of permissionGateKeys(source)) {
        const [resource, action] = key.split(":") as [PermissionResource, PermissionAction];
        assert.equal(await canAccess(context, resource, action), true, `HEADLINE: ${role}'s landing ${landing} asks ${key}, and ${role} must hold it`);
        gatesChecked += 1;
      }
      for (const admitted of roleSetGates(source)) {
        assert.ok(admitted.includes(role), `${role}'s landing ${landing} admits only ${admitted.join(", ")} — ${role} must be one of them`);
        gatesChecked += 1;
      }
    }
  });
  // "Nothing objected" is not "a gate was consulted": the landing pages carry real gates, and they were read.
  assert.ok(gatesChecked >= 5, `the landing pages' entry gates were read and judged (${gatesChecked})`);

  // The address is decided by the role alone, however the stored role is spelled.
  for (const role of assignablePhoenixRoles) {
    assert.equal(resolveLandingPathForRole(`  ${role.toUpperCase()}  `), resolveLandingPathForRole(role), `${role} lands in the same place whatever its casing or padding`);
  }
  // The three HR seats land on the HR command centre through the /hr address, which is what selects the HR shell.
  for (const role of ["HR Operations", "HR Resourcing", "HR Administration"] as const) {
    assert.equal(resolveLandingPathForRole(role), "/hr/admin/hr-command-center");
  }
}
