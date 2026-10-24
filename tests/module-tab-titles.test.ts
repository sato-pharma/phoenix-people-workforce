import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { moduleNameSource, resolveDocumentTitle, resolveModuleName } from "../src/lib/navigation/module-title.ts";
import { systemIdentity } from "../src/config/system-settings.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The browser tab is named after the module the viewer is in.
//
// Before 2026-09-04 the employee portal named nothing at all — all 118 of its routes
// rendered the bare brand, so a row of open portal tabs was 118 identical readings of
// "Phoenix Workforce". The admin shell named its tabs, but only after hydration, so a
// link opened in a NEW tab (and every bookmark and history entry) still read the brand.
//
// What this pins, in order of what actually broke:
//   1. no route in either shell resolves to the bare brand;
//   2. no two pages in one shell open tabs with the same name — an "Analytics" tab
//      you cannot tell from another "Analytics" tab is the same complaint one level down;
//   3. the WIRING — both shells mount the client sync and both layouts export
//      generateMetadata. A resolver nothing calls is the defect this replaced.
// ─────────────────────────────────────────────────────────────────────────────

const APP_DIR = new URL("../app/", import.meta.url);
const BRAND = systemIdentity.appName;

/**
 * Tab names deliberately shared by two pages. Each was checked by eye; a NEW name appearing
 * here is the bug this file exists to catch, because two tabs reading the same words is
 * precisely the state the owner asked to be rid of.
 *
 * ("Monthly Closing" and "Weekly Sales" were accepted here too, as the live portal page against its
 * `/employee-portals/sales-analytics/…` twin. The owner retired that module on 2026-09-17 and its
 * pages were deleted, so neither name is shared any more and both came off this list.)
 *
 * "Probation", "Payslips" and "Vacancies" are the admin module against the viewer's OWN copy of
 * it under `/workspace` (the "My Workspace" section). Both are genuinely that module, so the
 * name is right on each; what a rule could add is "My …", and it was rejected because it does
 * not survive the other eleven pages in that namespace — "My Organogram" is not the viewer's
 * organogram, and "My Submit Expense" is not English. Naming eleven pages badly to separate
 * three is the wrong trade.
 */
const ACCEPTED_DUPLICATE_TITLES: readonly string[] = [
  "Probation",
  "Payslips",
  "Vacancies",
];

/** Every `page.tsx` under `app/`, as the URL the browser asks for. */
function collectRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: URL, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const isRouteGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
        walk(new URL(`${entry.name}/`, dir), isRouteGroup ? segments : [...segments, entry.name]);
      } else if (entry.name === "page.tsx") {
        routes.push(`/${segments.join("/")}`);
      }
    }
  };
  walk(APP_DIR, []);
  // A dynamic segment stands for a real id at runtime; `1` is one, and exercises the
  // identifier-dropping path at the same time.
  return routes.map((route) => route.replace(/\[[^\]]+\]/g, "1"));
}

function readSource(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

export function runModuleTabTitlesTests() {
  const routes = collectRoutes();
  const portalRoutes = routes.filter((route) => route.startsWith("/employee-portals"));
  const adminRoutes = routes.filter(
    (route) =>
      !route.startsWith("/employee-portals") &&
      !route.startsWith("/api") &&
      !route.startsWith("/dev") &&
      // Outside both shells: these carry their own metadata and no navigation at all.
      !["/login", "/privacy", "/terms", "/", "/share", "/password-setup", "/whatsapp-connect", "/marketing-requests"].some(
        (standalone) => route === standalone || route.startsWith(`${standalone}/`),
      ),
  );

  assert.ok(portalRoutes.length > 100, `expected the portal to have a route set worth naming, found ${portalRoutes.length}`);
  assert.ok(adminRoutes.length > 100, `expected the admin shell to have a route set worth naming, found ${adminRoutes.length}`);

  // ── 1. No route in either shell falls back to the bare brand ────────────────
  const bare: string[] = [];
  for (const route of portalRoutes) {
    if (resolveDocumentTitle(route, "employee-portal") === BRAND) bare.push(`employee-portal ${route}`);
  }
  for (const route of adminRoutes) {
    if (resolveDocumentTitle(route, "admin") === BRAND) bare.push(`admin ${route}`);
  }
  assert.deepEqual(
    bare,
    [],
    `every route in a shell must name its module in the tab — these fell back to the bare brand:\n${bare.join("\n")}`,
  );

  // ── 2. Within one shell, no two pages open tabs with the SAME name ──────────
  // The headline requirement, restated as something a machine can check.
  // `/coaching/analytics` and `/probation/analytics` both end in the same segment and were
  // both simply "Analytics" until `nameFromSegments` composed the parent in — two tabs that
  // cannot be told apart, which is the entire complaint this work answers.
  for (const [mode, modeRoutes] of [
    ["employee-portal", portalRoutes],
    ["admin", adminRoutes],
  ] as const) {
    const byTitle = new Map<string, Set<string>>();
    for (const route of modeRoutes) {
      const name = resolveModuleName(route, mode);
      if (!name) continue;
      // Only names this resolver DERIVED from the address are its own to keep unique. Where a
      // sidebar row supplied the name, two pages sharing it means the config gives two rows the
      // same label — the app's own naming, which the tab is right to mirror rather than diverge
      // from. Those pairs are role-gated in practice, so no one rail shows both.
      if (moduleNameSource(route, mode) !== "address") continue;
      // A detail route is named after its module on purpose, so it counts as the same page.
      const withoutIds = route.replace(/\/1(?=\/|$)/g, "");
      byTitle.set(name, (byTitle.get(name) ?? new Set<string>()).add(withoutIds));
    }
    const collisions = [...byTitle.entries()]
      .filter(([name, paths]) => paths.size > 1 && !ACCEPTED_DUPLICATE_TITLES.includes(name))
      .map(([name, paths]) => `${name}  <-  ${[...paths].join("  |  ")}`);
    assert.deepEqual(
      collisions,
      [],
      `two ${mode} pages would open tabs with the same name — compose the parent segment in, or accept the pair explicitly in ACCEPTED_DUPLICATE_TITLES:\n${collisions.join("\n")}`,
    );
  }

  // ── 3. Two rows share one href; the viewer's own row is the one that names it ─
  assert.equal(
    resolveModuleName("/employee-portals/coaching", "employee-portal", "Medical Rep"),
    "My Coaching Reports",
    "a rep's coaching tab must carry the rep's own wording",
  );
  assert.equal(
    resolveModuleName("/employee-portals/coaching", "employee-portal", "District Manager"),
    "Team Coaching Reports",
    "a manager opening the same address must not be told these are 'My' reports — the tab would contradict the rail",
  );

  // ── 4. A detail route is named after its page, never after the id in it ─────
  const detail = resolveModuleName("/employee-portals/employee-360/a-12", "employee-portal");
  assert.ok(
    detail && !/^A 12$/i.test(detail),
    `a detail route must resolve to its module, not to the record id — got ${String(detail)}`,
  );

  // ── 4b. A COMPOSITE KEY is an identifier too ────────────────────────────────
  // The Call rate drill-down (Reps Plans' until the 2026-09-21 merge into Reps List) carries
  // `repKeyOf` as its whole path segment — `crm:1468`,
  // `hr:b-141`, `name:Bishoy Bahaa` — and none of the shapes above matches one. So the key
  // fell through to the humanizer and named the tab `Crm%3A1468` on a page whose body reads
  // "Bishoy Bahaa": the address, percent-encoding and all, printed as a module name.
  //
  // BOTH SPELLINGS, because there are two: `location.pathname` keeps the encoding, so the
  // CLIENT half sees `crm%3A1468` where the server sees `crm:1468`. One page, two names, and
  // the tab visibly renamed itself between the first paint and hydration.
  for (const spelling of ["crm:1468", "crm%3A1468", "hr:b-141", "name%3ABishoy%20Bahaa"]) {
    for (const mode of ["employee-portal", "admin"] as const) {
      const path =
        mode === "admin"
          ? `/admin/reps-list/call-rate/${spelling}`
          : `/employee-portals/reps-list/call-rate/${spelling}`;
      const name = resolveModuleName(path, mode);
      assert.ok(
        name && !/crm|%3a|:/i.test(name),
        `a drill-down key must never reach the tab name — ${path} gave ${String(name)}`,
      );
      assert.equal(name, "Call Rate", `and the page is named after the tab it opens from — ${path}`);
    }
  }
  // A malformed escape must not take the resolver down with it. `decodeURIComponent` throws on
  // a lone `%`, and a bad URL is exactly where a title resolver must not be the thing that breaks.
  assert.doesNotThrow(
    () => resolveModuleName("/employee-portals/reps-list/call-rate/100%", "employee-portal"),
    "an undecodable segment keeps its raw form rather than throwing",
  );

  // ── 5. A query string must not defeat the match ─────────────────────────────
  assert.equal(
    resolveModuleName("/employee-portals/direct-orders?from=inbox", "employee-portal"),
    resolveModuleName("/employee-portals/direct-orders", "employee-portal"),
    "a carried query parameter must not change which module the tab names",
  );

  // ── 6. The humanizer floor, for pages reached from a hub rather than a row ──
  assert.equal(resolveModuleName("/workspace/private-calendar", "admin"), "Private Calendar");
  assert.equal(
    resolveModuleName("/workspace/contact-hr-support", "admin"),
    "Contact HR Support",
    "HR must not be sentence-cased to 'Hr'",
  );
  assert.equal(resolveDocumentTitle("/workspace/vacancies", "admin"), `Vacancies · ${BRAND}`);

  // An address that names nothing is still the brand — never an empty tab.
  assert.equal(resolveDocumentTitle("", "admin"), BRAND);
  assert.equal(resolveDocumentTitle("not-a-path", "admin"), BRAND);

  // ── 7. The wiring. A resolver nothing calls is exactly the bug this replaced ─
  const adminLayout = readSource("app/(admin)/layout.tsx");
  const portalLayout = readSource("app/employee-portals/layout.tsx");
  for (const [name, source] of [
    ["app/(admin)/layout.tsx", adminLayout],
    ["app/employee-portals/layout.tsx", portalLayout],
  ] as const) {
    assert.ok(
      source.includes("export async function generateMetadata"),
      `${name} must export generateMetadata — it is the only thing that names a tab opened from a link, a bookmark or the history list, before any script of ours runs`,
    );
    assert.ok(
      source.includes("resolveDocumentTitle("),
      `${name} must name the tab through the shared resolver, so the server's name and the client's cannot disagree`,
    );
  }

  const appShell = readSource("src/components/layout/app-shell.tsx");
  const portalShell = readSource("src/components/employee-portal/employee-portal-server-shell.tsx");
  assert.ok(
    appShell.includes("<DocumentTitleSync mode={resolvedNavigationMode}"),
    "AppShell must mount DocumentTitleSync — without it the admin tab keeps whatever name the first paint gave it across every client navigation",
  );
  assert.ok(
    portalShell.includes('<DocumentTitleSync mode="employee-portal"'),
    "the portal shell must mount DocumentTitleSync — its absence is precisely why all 118 portal routes read 'Phoenix Workforce'",
  );
}
