import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  __setPermissionSharedVersionReaderForTests,
  clearPermissionMatrixCache,
  getPermissionMatrix,
  seedPermissionMatrixWithDefaultsForTests,
} from "../src/lib/auth/permissions.ts";
import {
  permissionSharedVersionFrom,
  permissionSharedVersionMoved,
  type PermissionSharedVersion,
} from "../src/lib/auth/permission-matrix-version.ts";
import { stripComments } from "./support/comment-strip.ts";

// THE PERMISSION CACHE HEARS ANOTHER SERVER'S CHANGE (REC-083 phase 2, 19 Nov 2026).
//
// Each server keeps the effective permission matrix for 30 seconds, and saving a change on Access Control
// cleared it only on the server that saved it — so another server kept a revoked grant for up to 30 s.
// It now gets the signal the employee directory got (#355): a copy held past the check interval asks the
// override table's shared version (newest updated_at + row count) and is reloaded when it moved. These
// cases run the real cache with a stand-in for the table and for the version read.

type OverrideRow = { action: string; is_allowed: boolean; resource: string; role_name: string };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

export async function runPermissionMatrixSharedVersionTests() {
  // ── The pure rule ──────────────────────────────────────────────────────────────────────────────
  const v = permissionSharedVersionFrom("2026-11-19T10:00:00.000Z", 12);
  assert.deepEqual(v, { fingerprint: "2026-11-19T10:00:00.000Z|12", latestChangeMs: Date.parse("2026-11-19T10:00:00.000Z") });
  assert.notEqual(permissionSharedVersionFrom("2026-11-19T10:00:00.000Z", 11).fingerprint, v.fingerprint, "a removed override moves the version although no stamp did");
  assert.equal(permissionSharedVersionFrom(null, 0).latestChangeMs, null, "an empty table has no stamp");
  const now = Date.parse("2026-11-19T10:05:00Z");
  assert.equal(permissionSharedVersionMoved({ copyLoadStartedAt: now - 60_000, current: v, now, previousFingerprint: v.fingerprint }), false, "the same version: nothing moved");
  assert.equal(permissionSharedVersionMoved({ copyLoadStartedAt: now - 60_000, current: permissionSharedVersionFrom("2026-11-19T10:04:00Z", 12), now, previousFingerprint: v.fingerprint }), true, "a newer stamp: moved");
  assert.equal(permissionSharedVersionMoved({ copyLoadStartedAt: Date.parse("2026-11-19T10:04:00Z"), current: v, now, previousFingerprint: null }), false, "first look: a change stamped well before the copy loaded is in it");
  assert.equal(permissionSharedVersionMoved({ copyLoadStartedAt: Date.parse("2026-11-19T09:59:00Z"), current: v, now, previousFingerprint: null }), true, "first look: a change stamped after the copy began loading may be missing from it");
  assert.equal(permissionSharedVersionMoved({ copyLoadStartedAt: 0, current: permissionSharedVersionFrom("2027-01-01T00:00:00Z", 1), now, previousFingerprint: null }), false, "a stamp in the future says nothing usable");

  // ── The real cache, against a stand-in table and version ───────────────────────────────────────
  const saved = { fetch: globalThis.fetch, key: process.env.SUPABASE_SERVICE_ROLE_KEY, log: console.log, url: process.env.NEXT_PUBLIC_SUPABASE_URL };
  const base = `https://permission-version-${Date.now()}.example.supabase.co`;
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-permission-version";
  let rows: OverrideRow[] = [];
  let tableDown = false;
  let loads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === base && url.pathname.endsWith("/rest/v1/role_permission_overrides")) {
      loads += 1;
      return tableDown ? json(500, { code: "57P01", message: "terminating connection" }) : json(200, rows);
    }
    return json(200, []);
  }) as typeof fetch;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  let version: PermissionSharedVersion | null = permissionSharedVersionFrom(new Date(Date.now() - 60 * 60_000).toISOString(), 0);
  let versionReads = 0;
  __setPermissionSharedVersionReaderForTests(async () => {
    versionReads += 1;
    if (version === null) throw new Error("the version read failed");
    return version;
  }, { checkEveryMs: 0 });

  try {
    clearPermissionMatrixCache();
    const defaults = await getPermissionMatrix();
    assert.equal(loads, 1, "the first read loads the matrix");

    // A grant the overrides can take away (not a portal floor, not a hard boundary) — found, not assumed.
    let pick: { action: string; resource: string; role: string } | null = null;
    for (const role of Object.keys(defaults).filter((name) => name !== "Super Admin")) {
      const grants = defaults[role as keyof typeof defaults] as Record<string, string[] | undefined>;
      for (const [resource, actions] of Object.entries(grants)) {
        for (const action of actions ?? []) {
          rows = [{ action, is_allowed: false, resource, role_name: role }];
          clearPermissionMatrixCache();
          const probe = (await getPermissionMatrix())[role as keyof typeof defaults] as Record<string, string[] | undefined>;
          if (!(probe[resource] ?? []).includes(action)) pick = { action, resource, role };
          if (pick) break;
        }
        if (pick) break;
      }
      if (pick) break;
    }
    assert.ok(pick, "some default grant can be revoked by an override");
    const holds = (matrix: Awaited<ReturnType<typeof getPermissionMatrix>>) =>
      ((matrix[pick!.role as keyof typeof matrix] as Record<string, string[] | undefined>)[pick!.resource] ?? []).includes(pick!.action);

    // This server loads the matrix with the grant in place.
    rows = [];
    clearPermissionMatrixCache();
    __setPermissionSharedVersionReaderForTests(async () => {
      versionReads += 1;
      if (version === null) throw new Error("the version read failed");
      return version;
    }, { checkEveryMs: 0 });
    loads = 0;
    assert.equal(holds(await getPermissionMatrix()), true, "the grant is in place");
    assert.equal(loads, 1);

    // ANOTHER server revokes it (the table changes; this server's copy was not cleared). While the
    // version has not moved, the copy is served as before — no reload.
    rows = [{ action: pick.action, is_allowed: false, resource: pick.resource, role_name: pick.role }];
    versionReads = 0;
    assert.equal(holds(await getPermissionMatrix()), true, "an unmoved version keeps serving the copy");
    assert.equal(loads, 1, "and costs no reload");
    assert.equal(versionReads, 1, "the shared version was asked once");

    // The version moves: the copy is reloaded at once, not after its 30 seconds.
    version = permissionSharedVersionFrom(new Date().toISOString(), 1);
    assert.equal(holds(await getPermissionMatrix()), false, "the revoked grant is gone on this server too");
    assert.equal(loads, 2, "by one reload");
    assert.ok(lines.some((line) => line.includes("permission_matrix_shared_version_moved")), "the reload says why");

    // Unmoved again: served, no reload. A version that cannot be read changes nothing.
    assert.equal(holds(await getPermissionMatrix()), false);
    assert.equal(loads, 2, "an unmoved version costs no reload");
    version = null;
    assert.equal(holds(await getPermissionMatrix()), false);
    assert.equal(loads, 2, "an unreadable version changes nothing");

    // The version moves while the table cannot be read: the LAST-KNOWN matrix is served, never the
    // fail-closed cold start (which empties every role but the Super Admin).
    version = permissionSharedVersionFrom(new Date(Date.now() + 1_000).toISOString(), 2);
    tableDown = true;
    const duringOutage = await getPermissionMatrix();
    assert.equal(loads, 3, "the moved version asked for a reload");
    assert.equal(holds(duringOutage), false, "the reload failed and the last-known matrix is served");
    const someoneElse = Object.keys(defaults).find((role) => role !== "Super Admin" && role !== pick!.role && Object.keys(defaults[role as keyof typeof defaults] ?? {}).length > 0)!;
    assert.ok(Object.keys(duringOutage[someoneElse as keyof typeof duringOutage] ?? {}).length > 0, "every other role keeps its grants — not the cold start");

    // The wiring.
    const code = stripComments(readFileSync(new URL("../src/lib/auth/permissions.ts", import.meta.url), "utf8"));
    assert.match(code, /async function resolvePermissionMatrix\(\): Promise<PermissionMatrix> \{\s*await reconcileSharedPermissionVersion\(\);/, "every read asks the shared version first");
    assert.match(code, /\.from\("role_permission_overrides"\)\s*\.select\("updated_at", \{ count: "exact" \}\)\s*\.order\("updated_at", \{ ascending: false \}\)\s*\.limit\(1\);/, "the version is the table's newest stamp and its row count, in one read");
    assert.match(code, /permissionCache = \{ \.\.\.copy, fetchedAt: 0 \};/, "a moved version marks the copy stale — never drops it");
  } finally {
    __setPermissionSharedVersionReaderForTests(null);
    console.log = saved.log;
    globalThis.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
    if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    clearPermissionMatrixCache();
    seedPermissionMatrixWithDefaultsForTests();
  }
}
