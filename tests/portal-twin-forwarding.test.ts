import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { PORTAL_HOME, portalTwinRules, resolvePortalTwin } from "../src/lib/navigation/portal-twins.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A portal-mode viewer lands on the portal twin of what they asked for.
//
// app/(admin)/layout.tsx redirects every portal-mode viewer away before any page in
// the group runs. Forty-one of those pages name the exact portal page such a viewer
// belongs on, and not one of those lines could ever execute — the viewer was gone
// before the page was reached. src/lib/navigation/portal-twins.ts moves that answer
// up to the layout, where it can actually fire.
//
// WHY THIS IS A TEST AND NOT A NOTE
// The table is only correct while it agrees with the pages, and nothing about adding
// a new admin page reminds anyone it exists. So the test does not read the table and
// check it looks sensible — it RE-DERIVES the whole set from the pages themselves and
// fails on any disagreement in either direction:
//
//   * a page names a twin that the table does not carry  -> red
//   * the table carries a twin the page no longer names  -> red
//   * a page changes its destination                     -> red
//
// The premise checks below matter just as much. If proxy.ts stopped setting
// x-phoenix-path, or the layout stopped consulting the table, every twin would
// quietly revert to the portal home and no assertion about the table itself would
// notice — the failure mode is silence, which is exactly how the original defect
// survived. So the wiring is pinned too.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_GROUP = path.join("app", "(admin)");
const PORTAL_ROOT = path.join("app", "employee-portals");
const GROUP_LAYOUT = path.join(ADMIN_GROUP, "layout.tsx");
const PROXY = "proxy.ts";

/**
 * Two rules have no page declaration behind them, on purpose. Both leave-management
 * vacation pages carried a portal branch that RENDERED the portal shell inline instead
 * of redirecting; it was unreachable for the same reason and was deleted 2026-08-30
 * (PR #2777). Their destinations are the rows the portal sidebar links for those two
 * features in employee-portal-nav-registry.ts.
 *
 * Anything else appearing here is a rule somebody invented, and the test says so.
 */
const RULES_WITHOUT_A_PAGE_DECLARATION = new Set([
  "/leave-management/vacation-report -> /employee-portals/vacation-report",
  "/leave-management/vacation-request -> /employee-portals/vacation-request",
]);

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walkPages(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkPages(full, out);
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

/** app/(admin)/admin/approvals/excuse/[id]/page.tsx -> /admin/approvals/excuse/:id */
function routeTemplateOf(file: string): string {
  const segments = file
    .split(path.sep)
    .slice(1) // drop "app"
    .filter((segment) => segment && segment !== "page.tsx" && !/^\(.*\)$/.test(segment))
    .map((segment) => (/^\[.+\]$/.test(segment) ? `:${segment.slice(1, -1)}` : segment));
  return `/${segments.join("/")}`;
}

/**
 * The literal a page hands to redirect(), reduced to a comparable template.
 *
 *   `/employee-portals/approvals/excuse/${encodeURIComponent(id)}` -> /employee-portals/approvals/excuse/:id
 *   `/employee-portals/approvals-hub${preservedQuery(params)}`     -> /employee-portals/approvals-hub
 */
function destinationTemplateOf(raw: string): string {
  return raw
    .replace(/\$\{preservedQuery\([^)]*\)\}/g, "")
    .replace(/\$\{encodeURIComponent\(\s*([A-Za-z_$][\w$]*)\s*\)\}/g, ":$1")
    .replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, ":$1");
}

/** Every (admin route -> portal destination) pair the pages themselves declare. */
function declaredPairs(): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  for (const file of walkPages(ADMIN_GROUP)) {
    const source = stripComments(readFileSync(file, "utf8"));
    const route = routeTemplateOf(file);
    for (const match of source.matchAll(/redirect\(\s*[`"]([^`"]*\/employee-portals\/[^`"]*)[`"]/g)) {
      const destination = destinationTemplateOf(match[1]);
      const list = pairs.get(route) ?? [];
      if (!list.includes(destination)) list.push(destination);
      pairs.set(route, list);
    }
  }
  return pairs;
}

/** Route shapes that actually exist under app/employee-portals, with params blanked to `*`. */
function portalRouteShapes(): Set<string> {
  const shapes = new Set<string>();
  for (const file of walkPages(PORTAL_ROOT)) {
    shapes.add(routeTemplateOf(file).replace(/:[^/]+/g, "*"));
  }
  return shapes;
}

function key(from: string, to: string): string {
  return `${from} -> ${to}`;
}

function sampleFor(template: string): string {
  return template.replace(/:([^/]+)/g, (_all, name: string) => `sample-${name}`);
}

export async function runPortalTwinForwardingTests() {
  // ── 0. The detector must be able to fail ───────────────────────────────────
  // Every assertion below is a comparison against text scraped out of the repo. If
  // the scrapers silently returned nothing, all of it would pass vacuously.
  assert.equal(
    destinationTemplateOf("/employee-portals/approvals/excuse/${encodeURIComponent(id)}"),
    "/employee-portals/approvals/excuse/:id",
    "destinationTemplateOf must reduce an encodeURIComponent interpolation to a named param",
  );
  assert.equal(
    destinationTemplateOf("/employee-portals/approvals-hub${preservedQuery(params)}"),
    "/employee-portals/approvals-hub",
    "destinationTemplateOf must drop a query helper, which is not part of the path",
  );
  assert.equal(
    routeTemplateOf(path.join("app", "(admin)", "admin", "approvals", "excuse", "[id]", "page.tsx")),
    "/admin/approvals/excuse/:id",
    "routeTemplateOf must drop the route group and name the dynamic segment",
  );
  assert.equal(
    stripComments('const a = 1; // redirect("/employee-portals/ghost")').includes("ghost"),
    false,
    "stripComments must remove a line comment, so commented-out code cannot be read as a declaration",
  );

  const pairs = declaredPairs();
  assert.ok(
    pairs.size >= 30,
    `expected the admin group to declare portal twins on at least 30 pages, found ${pairs.size} — the scraper is probably broken, not the app`,
  );

  // ── 1. Premise: the wiring this whole table depends on is still in place ───
  const layout = readFileSync(GROUP_LAYOUT, "utf8");
  assert.match(
    layout,
    /resolveNavigationMode\(access\)\s*===\s*"employee-portal"/,
    `${GROUP_LAYOUT} must still bounce portal-mode viewers out of the admin shell — that guard is the security boundary, not this table`,
  );
  assert.match(
    layout,
    /resolvePortalTwin\(/,
    `${GROUP_LAYOUT} must consult resolvePortalTwin, or every page's declared twin is dead again and nothing else here would notice`,
  );
  assert.match(
    layout,
    /\?\?\s*PORTAL_HOME/,
    `${GROUP_LAYOUT} must fall back to PORTAL_HOME for an unmapped address, which is the behaviour that existed before this table`,
  );

  const proxySource = readFileSync(PROXY, "utf8");
  assert.match(
    proxySource,
    /headers\.delete\(PATH_HEADER\)/,
    `${PROXY} must delete any inbound x-phoenix-path before writing its own, or the redirect target becomes client-controlled`,
  );
  assert.match(
    proxySource,
    /headers\.set\(PATH_HEADER,\s*`\$\{pathname\}\$\{search\}`\)/,
    `${PROXY} must set x-phoenix-path to the requested path and query — the layout reads it to know where the viewer was going`,
  );

  // ── 2. No rule can send a viewer anywhere but the portal ───────────────────
  // A destination inside (admin) would re-enter this same layout: an infinite redirect.
  for (const rule of portalTwinRules) {
    assert.ok(
      rule.to.startsWith("/employee-portals/"),
      `rule ${key(rule.from, rule.to)} must resolve inside /employee-portals — anything else re-enters the admin layout and loops`,
    );
  }

  // ── 3. Every destination is a page that exists ─────────────────────────────
  const shapes = portalRouteShapes();
  assert.ok(shapes.size > 20, `expected many portal routes, found ${shapes.size} — the portal scraper is broken`);
  for (const rule of portalTwinRules) {
    const shape = rule.to.replace(/:[^/]+/g, "*");
    assert.ok(
      shapes.has(shape),
      `rule ${key(rule.from, rule.to)} points at a portal page that does not exist (looked for ${shape})`,
    );
  }

  // ── 4. Every rule resolves to itself, and nothing shadows it ───────────────
  // Resolving a rule's own sample address must return that rule's own destination.
  // A more specific rule that wrongly swallowed a less specific one shows up here.
  const probeRoles = ["District Manager", "Regional Manager"] as const;
  for (const rule of portalTwinRules) {
    const sample = sampleFor(rule.from);
    const expected = sampleFor(rule.to);
    const roles = rule.roles ?? probeRoles;
    for (const role of roles) {
      assert.equal(
        resolvePortalTwin(sample, role),
        expected,
        `resolving ${sample} as ${role} must give ${expected} — another rule is shadowing ${key(rule.from, rule.to)}`,
      );
    }
  }

  // ── 5. Table vs pages, both directions ─────────────────────────────────────
  const declared = new Set<string>();
  for (const [route, destinations] of pairs) {
    for (const destination of destinations) declared.add(key(route, destination));
  }
  const inTable = new Set(portalTwinRules.map((rule) => key(rule.from, rule.to)));

  const missingFromTable = [...declared].filter((entry) => !inTable.has(entry)).sort();
  assert.deepEqual(
    missingFromTable,
    [],
    "these pages name a portal twin that src/lib/navigation/portal-twins.ts does not carry, so it stays dead — add a rule for each",
  );

  const unbacked = [...inTable]
    .filter((entry) => !declared.has(entry) && !RULES_WITHOUT_A_PAGE_DECLARATION.has(entry))
    .sort();
  assert.deepEqual(
    unbacked,
    [],
    "these rules are backed by no page declaration — either the page changed and the rule is stale, or the rule was invented",
  );

  // The allowance itself must not rot into cover for a rule nobody can justify.
  for (const entry of RULES_WITHOUT_A_PAGE_DECLARATION) {
    assert.ok(
      inTable.has(entry),
      `${entry} is listed as a deliberate exception but is no longer in the table — remove the exception too`,
    );
  }

  // ── 6. The role-scoped rules say what the coaching pages say ───────────────
  // Coaching is the only place a page sends different portal viewers to different
  // pages, so it is the only place the table is allowed to branch on role.
  const roleScoped = portalTwinRules.filter((rule) => rule.roles);
  for (const rule of roleScoped) {
    assert.ok(
      rule.from.startsWith("/coaching"),
      `${key(rule.from, rule.to)} is role-scoped but is not a coaching route — role branching belongs in the pages, not here`,
    );
  }
  const coachingSource = readFileSync(path.join(ADMIN_GROUP, "coaching", "page.tsx"), "utf8");
  assert.match(
    coachingSource,
    /access\.role === "Training Manager"/,
    "the coaching page must still branch on Training Manager — the role-scoped rules mirror that branch",
  );
  assert.match(
    coachingSource,
    /access\.role === "Employee" \|\| access\.role === "Medical Rep"/,
    "isEmployeePortalRole must still mean Employee or Medical Rep — COACHING_PORTAL_ROLES mirrors it",
  );

  // ── 7. Behaviour, spelled out ──────────────────────────────────────────────
  // A shared deep link keeps its record.
  assert.equal(
    resolvePortalTwin("/admin/approvals/plan/abc-123", "Medical Rep"),
    "/employee-portals/approvals/plan/abc-123",
    "a portal viewer opening a shared plan approval link must reach that plan, not the portal home",
  );
  // The return context survives, which is the thing the direct-order page's own comment asks for.
  assert.equal(
    resolvePortalTwin("/admin/direct-orders/o-9?from=%2Fadmin%2Fdirect-orders%2Freport", "Medical Rep"),
    "/employee-portals/direct-orders/o-9?from=%2Fadmin%2Fdirect-orders%2Freport",
    "the ?from= return context must cross the hop",
  );
  // Only the allowlisted parameters cross.
  assert.equal(
    resolvePortalTwin("/admin/approvals-hub?module=leave&id=7&secret=x", "Medical Rep"),
    "/employee-portals/approvals-hub?module=leave&id=7",
    "only module/id/tab may cross to the approvals hub, matching the page's own preservedQuery",
  );
  // A query on a rule with no allowlist is dropped rather than replayed.
  assert.equal(
    resolvePortalTwin("/sales/targets?line=CNS", "Medical Rep"),
    "/employee-portals/source-of-sales",
    "a nearest-equivalent hop must not replay the admin query against a different screen",
  );
  // Same address, two roles, two answers.
  assert.equal(
    resolvePortalTwin("/coaching", "Training Manager"),
    "/employee-portals/training-manager/field-coaching",
    "a Training Manager belongs in the training-manager area",
  );
  assert.equal(
    resolvePortalTwin("/coaching", "Medical Rep"),
    "/employee-portals/coaching",
    "a Medical Rep belongs on the plain portal coaching screen",
  );
  assert.equal(
    resolvePortalTwin("/coaching/r-1/edit", "Medical Rep"),
    "/employee-portals/coaching/r-1",
    "the portal coaching screen is read-only for a rep, so /edit is dropped — as the page itself does",
  );
  // A role with no declared coaching answer keeps the old behaviour rather than guessing.
  assert.equal(
    resolvePortalTwin("/coaching", "Regional Manager"),
    null,
    "a role no coaching page names must resolve to nothing, so the layout falls back to the portal home",
  );
  // The /hr namespace resolves to the same twin.
  assert.equal(
    resolvePortalTwin("/hr/probation", "Medical Rep"),
    "/employee-portals/probation",
    "an /hr-namespaced address must resolve to the same twin as its bare form",
  );
  // Absent, unmapped, and malformed all mean "no twin", never a wrong guess.
  assert.equal(resolvePortalTwin(null, "Medical Rep"), null, "an absent header must resolve to nothing");
  assert.equal(resolvePortalTwin("", "Medical Rep"), null, "an empty header must resolve to nothing");
  assert.equal(
    resolvePortalTwin("https://evil.example/admin/direct-orders", "Medical Rep"),
    null,
    "a value that is not a path must resolve to nothing — the fallback is the portal home, never an absolute URL",
  );
  assert.equal(
    resolvePortalTwin("/admin/payroll-management", "Medical Rep"),
    null,
    "a page that names no twin must resolve to nothing, leaving today's portal-home behaviour untouched",
  );
  assert.equal(PORTAL_HOME, "/employee-portals", "the fallback must stay the portal home");
}
