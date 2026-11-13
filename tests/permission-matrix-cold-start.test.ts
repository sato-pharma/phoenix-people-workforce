import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { passwordWeakness } from "../src/lib/auth/password-strength.ts";
import {
  canAccess,
  clearPermissionMatrixCache,
  coldStartPermissionMatrix,
  createAccessContext,
  getPermissionMatrix,
  permissionMatrix,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * REC-058, two server-side rules a person never sees until they matter.
 *
 * 1. THE PERMISSION MATRIX FAILS CLOSED ON A COLD START. When the override table cannot be read and
 *    no matrix was ever loaded, every role holds nothing — a permission an administrator revoked
 *    through an override can never come back from the compiled defaults — except the Super Admin,
 *    who keeps the defaults so the table can be repaired. The degraded matrix is not cached, so the
 *    next request with a readable table gets the real one. Driven against a stand-in database whose
 *    address cannot resolve, so nothing here reaches a real one.
 *
 * 2. A CHOSEN PASSWORD IS NOT ONE EVERY GUESSING LIST TRIES FIRST (password-strength.ts), on both
 *    doors that take one: changing it and setting it from a link.
 */

const STAND_IN_ORIGIN = "https://permission-cold-start.invalid";
const STAND_IN_SETTINGS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: STAND_IN_ORIGIN,
  SUPABASE_SERVICE_ROLE_KEY: "stand-in-service-role-key",
};

async function withStandInDatabase(answer: { overrides: "unreadable" | "empty" }, run: () => Promise<void>) {
  const env = process.env as Record<string, string | undefined>;
  const saved = Object.keys(STAND_IN_SETTINGS).map((name) => [name, env[name]] as const);
  const realFetch = globalThis.fetch;
  Object.assign(env, STAND_IN_SETTINGS);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(STAND_IN_ORIGIN)) throw new Error(`the stand-in refuses to reach ${url}`);
    if (new URL(url).pathname === "/rest/v1/role_permission_overrides" && answer.overrides === "empty") {
      return new Response("[]", { headers: { "content-type": "application/json" }, status: 200 });
    }
    return new Response(JSON.stringify({ code: "XX000", message: "stand-in read failure" }), {
      headers: { "content-type": "application/json" },
      status: 500,
    });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
    clearPermissionMatrixCache();
    for (const [name, value] of saved) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

function grantsOf(role: PhoenixRole): Array<[PermissionResource, PermissionAction]> {
  const map = permissionMatrix[role] ?? {};
  return (Object.entries(map) as Array<[PermissionResource, PermissionAction[] | undefined]>).flatMap(([resource, actions]) =>
    (actions ?? []).map((action) => [resource, action] as [PermissionResource, PermissionAction]),
  );
}

function sourceFilesUnder(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) sourceFilesUnder(path, found);
    else if (/\.(ts|tsx|mjs)$/.test(name)) found.push(path);
  }
  return found;
}

export async function runPermissionMatrixColdStartTests(): Promise<void> {
  // ── 1. The cold-start matrix itself ───────────────────────────────────────────────────────────
  const closed = coldStartPermissionMatrix();
  const roles = Object.keys(permissionMatrix) as PhoenixRole[];
  for (const role of roles) {
    if (role === "Super Admin") continue;
    assert.deepEqual(closed[role], {}, `HEADLINE: on a cold start with the override table unreadable, ${role} holds nothing`);
  }
  assert.deepEqual(closed["Super Admin"], permissionMatrix["Super Admin"], "the Super Admin keeps the compiled defaults, so the table can be repaired");

  // ── 2. Through the real loader and canAccess, with the table unreadable ───────────────────────
  const withGrants = roles.filter((role) => role !== "Super Admin" && grantsOf(role).length > 0);
  assert.ok(withGrants.length > 5, "the defaults grant something to most roles, so the refusals below mean something");
  await withStandInDatabase({ overrides: "unreadable" }, async () => {
    clearPermissionMatrixCache();
    const matrix = await getPermissionMatrix();
    for (const role of withGrants) {
      assert.deepEqual(matrix[role], {}, `${role} is served nothing when the first load fails`);
      const [resource, action] = grantsOf(role)[0]!;
      const context = createAccessContext({ hrId: "STAND-IN-1", loginId: "stand.in", role, source: "session" });
      assert.equal(await canAccess(context, resource, action), false, `${role} cannot ${action} ${resource} on a failed cold start`);
    }
    const [resource, action] = grantsOf("Super Admin")[0]!;
    const owner = createAccessContext({ hrId: "STAND-IN-0", loginId: "stand.owner", role: "Super Admin", source: "session" });
    assert.equal(await canAccess(owner, resource, action), true, "the Super Admin still gets in to repair it");
  });

  // ── 3. Not cached: a readable table on the next call serves the real matrix ──────────────────
  await withStandInDatabase({ overrides: "unreadable" }, async () => {
    clearPermissionMatrixCache();
    await getPermissionMatrix();
  });
  await withStandInDatabase({ overrides: "empty" }, async () => {
    const matrix = await getPermissionMatrix();
    for (const role of withGrants) {
      assert.deepEqual(matrix[role], permissionMatrix[role], `${role} gets its real grants back as soon as the table reads`);
    }
  });

  // ── 4. The test-runner seed is never called by the application ───────────────────────────────
  for (const path of [...sourceFilesUnder("app"), ...sourceFilesUnder("src")]) {
    if (path.replace(/\\/g, "/") === "src/lib/auth/permissions.ts") continue;
    assert.ok(
      !stripComments(readFileSync(path, "utf8")).includes("seedPermissionMatrixWithDefaultsForTests"),
      `${path} must not seed the permission matrix — only tests/run-tests.ts may`,
    );
  }

  // ── 5. A chosen password is not one every guessing list tries first ──────────────────────────
  for (const weak of ["12345678", "password", "Password123", "P@ssw0rd123", "qwertyuiop", "aaaaaaaa", "abcdefgh", "Phoenix2026!", "Sato@1234", "satopharma1", "Welcome@2026", "87654321"]) {
    assert.ok(passwordWeakness(weak), `HEADLINE: "${weak}" is refused`);
  }
  assert.ok(passwordWeakness("stand.in1", ["stand.in", "T-1"]), "the person's own login id, decorated, is refused");
  assert.ok(passwordWeakness("short1!"), "under 8 characters is still refused");
  for (const fine of ["Nile-lamp-orbit-42", "my cat eats figs daily", "Tr7#kLm2qZ", "Sato is where I work 2026"]) {
    assert.equal(passwordWeakness(fine, ["stand.in", "T-1"]), null, `"${fine}" is accepted`);
  }

  const change = stripComments(readFileSync("src/lib/auth/change-password.ts", "utf8"));
  assert.match(change, /passwordWeakness\(input\.newPassword, \[row\.login_id, row\.hr_id\]\)/, "changing a password runs the check");
  assert.match(change, /if \(weakness\) throw new WeakPasswordError\(weakness\);/, "and refuses with its own error");
  const changeRoute = stripComments(readFileSync("app/api/auth/change-password/route.ts", "utf8"));
  assert.match(changeRoute, /error instanceof WeakPasswordError[\s\S]{0,120}"weak_password"[\s\S]{0,80}status: 400/, "which the route answers 400 with the reason, never a 500");
  const setup = stripComments(readFileSync("src/lib/auth/password-setup.ts", "utf8"));
  assert.match(setup, /passwordWeakness\(password, \[tokenRow\.login_id, tokenRow\.hr_id\]\)/, "setting a password from a link runs the check");
}
