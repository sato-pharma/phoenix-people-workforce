import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

import { API_NO_UI, API_PAGE_MAP, resolveApiPage } from "../src/lib/system-audit/api-page-map.ts";
import { resolveSidebarLabel } from "../src/lib/system-audit/sidebar-label.ts";

/**
 * The API map names the module behind an API error when the person's page trail cannot. Two rules
 * hold it honest:
 *
 *   1. EVERY route under app/api is covered — mapped to the page that calls it, or listed in
 *      API_NO_UI with the reason no screen owns it. A new top-level API turns this red until someone
 *      says which page it belongs to; it never silently becomes "Not in sidebar".
 *   2. EVERY page the map names is a real sidebar row (or sits under one) in that shell — not merely
 *      under the shell's own root row, which lights for every address and would name nothing.
 */

const SHELL_ROOTS = new Set(["/", "/admin", "/hr", "/employee-portals"]);

/** `app/api/**\/route.ts` as request paths, route groups `(x)` removed, dynamic segments kept. */
function apiRoutes(): string[] {
  const files = readdirSync("app/api", { recursive: true, encoding: "utf8" });
  return files
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => file === "route.ts" || file.endsWith("/route.ts"))
    .map((file) => `/api/${file.slice(0, -"route.ts".length)}`.replace(/\/\([^)]*\)/g, "").replace(/\/+$/, ""))
    .sort();
}

export function runSystemAuditApiPageMapTests() {
  // ── Longest prefix, on whole segments ──────────────────────────────────────────────────────────
  assert.equal(resolveApiPage("/api/approvals/vacation/123")?.prefix, "/api/approvals/vacation");
  assert.equal(resolveApiPage("/api/approvals/badge-counts")?.kind, "no_ui", "a badge count every page polls names no module");
  assert.equal(resolveApiPage("/api/cron/anything")?.kind, "no_ui");
  assert.notEqual(
    resolveApiPage("/api/admin/errors-and-more")?.prefix,
    "/api/admin/errors",
    "a prefix matches whole segments only — /api/admin/errors must not own /api/admin/errors-and-more",
  );
  assert.equal(resolveApiPage("/api/zzz-never-mapped"), null);

  // ── Every route is covered ─────────────────────────────────────────────────────────────────────
  const routes = apiRoutes();
  assert.ok(routes.length > 500, `the walk must find the API tree (found ${routes.length})`);
  const uncovered = routes.filter((route) => resolveApiPage(route) === null);
  assert.deepEqual(
    uncovered,
    [],
    `API routes with no page and no reason — add each to API_PAGE_MAP or API_NO_UI in src/lib/system-audit/api-page-map.ts:\n  ${uncovered.join("\n  ")}`,
  );

  // ── No prefix is listed twice, and none is dead ────────────────────────────────────────────────
  for (const prefix of Object.keys(API_PAGE_MAP)) {
    assert.equal(prefix in API_NO_UI, false, `${prefix} is both mapped and listed as no-UI`);
  }
  const dead = [...Object.keys(API_PAGE_MAP), ...Object.keys(API_NO_UI)].filter(
    (prefix) => !routes.some((route) => route === prefix || route.startsWith(`${prefix}/`)),
  );
  assert.deepEqual(dead, [], `prefixes that match no route any more:\n  ${dead.join("\n  ")}`);

  // ── Every target is a row of its own shell ─────────────────────────────────────────────────────
  const badTargets: string[] = [];
  for (const [prefix, targets] of Object.entries(API_PAGE_MAP)) {
    const checks: { page: string | undefined; role: string; shell: "admin" | "hr" | "portal" }[] = [
      { page: targets.admin, role: "Super Admin", shell: "admin" },
      { page: targets.hr, role: "HR Operations", shell: "hr" },
      { page: targets.portal, role: "Medical Rep", shell: "portal" },
    ];
    for (const { page, role, shell } of checks) {
      if (!page) continue;
      const label = resolveSidebarLabel({ route: page, role });
      const ok = label.source !== "none" && label.shell === shell && (!label.href || !SHELL_ROOTS.has(label.href) || label.href === page);
      if (!ok) badTargets.push(`${prefix} → ${shell} ${page} reads "${label.label}" (${label.source}, row ${label.href ?? "none"})`);
    }
  }
  assert.deepEqual(badTargets, [], `API map targets that are not sidebar rows of their shell:\n  ${badTargets.join("\n  ")}`);
}
