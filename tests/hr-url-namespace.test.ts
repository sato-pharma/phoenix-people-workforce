import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  adminNavigationSections,
  employeePortalNavigationSections,
  getNavigationSections,
  hrNavigationSections,
  hubPageItemGroups,
  navigationHomePathByMode,
  type AdminToolsPageItem,
} from "../src/config/system-navigation.ts";
import {
  getActiveHref,
  getSections,
  navigationPathPrefix,
  normalizePathnameForMode,
  permissionAllowed,
  roleAllowed,
  roleNotExcluded,
  usesAdminChrome,
  type PermissionLookup,
} from "../src/lib/navigation/active-path.ts";
import {
  HR_NAMESPACE_PREFIX,
  PATH_HEADER,
  SHELL_HEADER,
  isHrNamespacePath,
  toHrNamespacePath,
} from "../src/lib/navigation/shell-headers.ts";
import {
  hrNamespaceRoles,
  permissionActions,
  permissionMatrix,
  permissionResources,
  usesHrNamespace,
  type NavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * The `/hr` URL namespace (owner instruction, 2026-08-28).
 *
 * The two HR seats must not sit on the admin addresses — "due to security reasons and due to not
 * see things they are not should be able to see". This file pins the three things that make that
 * true and that nothing else can check:
 *
 *   1. the namespace navigation can only ever NARROW what the permission matrix allows,
 *   2. every row in it points at a page that actually exists,
 *   3. the shell header that selects HR chrome cannot be forged by a client.
 *
 * Why an AUTHORED nav list needs a test at all: the alternative — filtering the admin sidebar by
 * the HR permission matrix — was built first and measured, and it admits three rows neither seat
 * should see, because `permissionAllowed` FAILS OPEN on a resource an item never names. Section 4
 * pins those three by name so nobody "simplifies" the authored list back into a derived one.
 */

const HR_ROLES: PhoenixRole[] = ["HR Advisory", "HR Operations"];
const ALL_MODES: NavigationMode[] = ["admin", "employee-portal", "hr"];

function lookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/** The sidebar a role actually gets in a shell, as a flat href list. */
function sidebarHrefs(sections: readonly { items: readonly { href: string }[] }[], mode: NavigationMode, role: PhoenixRole) {
  return getSections(sections as never, mode, lookupFor(role), role).flatMap((section) =>
    section.items.map((item) => item.href),
  );
}

/**
 * What the OLD, derived approach would have shown this role: the admin sidebar plus every hub card
 * behind it that the role's grants admit. This is the set the authored namespace must be a subset
 * of — that subset relation is what "can only narrow, never widen" means concretely.
 */
function derivedAdminClosure(role: PhoenixRole): Set<string> {
  const lookup = lookupFor(role);
  const closure = new Set<string>(sidebarHrefs(adminNavigationSections, "admin", role));
  for (const group of hubPageItemGroups) {
    for (const item of group.items as readonly AdminToolsPageItem[]) {
      if (
        permissionAllowed(lookup, item.permissions) &&
        roleAllowed(role, item.roles) &&
        roleNotExcluded(role, item.excludedRoles)
      ) {
        closure.add(item.href);
      }
    }
  }
  return closure;
}

/** `/hr/admin/deductions` -> `/admin/deductions`. The address the App Router actually renders. */
function underlyingPath(href: string): string {
  assert.ok(isHrNamespacePath(href), `expected an /hr href, got ${href}`);
  return href === HR_NAMESPACE_PREFIX ? "/" : href.slice(HR_NAMESPACE_PREFIX.length);
}

export function runHrUrlNamespaceTests() {
  const hrItems = hrNavigationSections.flatMap((section) => section.items);

  // 1 ── The prefix contract. Every other section leans on these four functions agreeing.
  assert.equal(HR_NAMESPACE_PREFIX, "/hr");
  assert.equal(isHrNamespacePath("/hr"), true);
  assert.equal(isHrNamespacePath("/hr/probation"), true);
  assert.equal(isHrNamespacePath("/probation"), false);
  // The near-miss that a naive startsWith("/hr") gets wrong: a real top-level route beginning
  // with the same two letters. `/hr-calendar` is a page in this app TODAY.
  assert.equal(isHrNamespacePath("/hr-calendar"), false, "/hr-calendar is a page, not the namespace");
  assert.equal(toHrNamespacePath("/probation"), "/hr/probation");
  assert.equal(toHrNamespacePath("/"), "/hr");
  // Idempotent: the layout redirect must not be able to build /hr/hr/probation on a retry.
  assert.equal(toHrNamespacePath("/hr/probation"), "/hr/probation");
  assert.equal(toHrNamespacePath(toHrNamespacePath("/probation")), "/hr/probation");

  // 2 ── Every NavigationMode resolves to a real home path, asserted at RUNTIME.
  // `navigationHomePathByMode` is a Record over the union, and an exhaustive Record does NOT gate
  // the build here (next.config sets typescript.ignoreBuildErrors), so a missing key would compile,
  // deploy, and hand the sidebar logo `undefined` as an href.
  for (const mode of ALL_MODES) {
    const home = navigationHomePathByMode[mode];
    assert.equal(typeof home, "string", `navigationHomePathByMode.${mode} must be a string`);
    assert.ok(home.startsWith("/"), `navigationHomePathByMode.${mode} must be a path, got ${home}`);
  }
  assert.deepEqual(
    Object.keys(navigationHomePathByMode).sort(),
    [...ALL_MODES].sort(),
    "navigationHomePathByMode must hold exactly the NavigationMode union — no more, no fewer",
  );
  assert.ok(
    isHrNamespacePath(navigationHomePathByMode.hr),
    `the hr home must be inside the namespace, got ${navigationHomePathByMode.hr}`,
  );

  // 3 ── getNavigationSections routes each mode to its own list.
  assert.equal(getNavigationSections("hr"), hrNavigationSections);
  assert.equal(getNavigationSections("admin"), adminNavigationSections);
  assert.equal(getNavigationSections("employee-portal"), employeePortalNavigationSections);

  // 4 ── HEADLINE A: the three pages a DERIVED namespace would have leaked are gone.
  //
  // Each is a presentation leak, not a permission leak — the pages behind them re-assert their own
  // grants — but the owner asked for a surface with nothing on it these seats should not see.
  // Asserted in BOTH directions: present in the derived closure (so this is a real subtraction, not
  // a list of hrefs that never applied), absent from the authored namespace.
  const LEAKED_BY_DERIVATION: { href: string; roles: PhoenixRole[]; why: string }[] = [
    {
      href: "/admin/pharmacovigilance",
      roles: HR_ROLES,
      why: "no permission gate at all — only excludedRoles: ['Finance Manager'], so every other role passes",
    },
    {
      href: "/admin/field-coaching",
      roles: HR_ROLES,
      why: "a sales-management hub reached on the coaching grant",
    },
    {
      href: "/admin/crm-tools",
      roles: ["HR Operations"],
      why: "a CRM hub whose only reachable card is Workforce Compliance, which she already has",
    },
  ];
  const stillLeaking: string[] = [];
  const neverApplied: string[] = [];
  for (const { href, roles, why } of LEAKED_BY_DERIVATION) {
    for (const role of roles) {
      if (!derivedAdminClosure(role).has(href)) {
        neverApplied.push(`${role} -> ${href} (${why})`);
      }
    }
    if (hrItems.some((item) => underlyingPath(item.href) === href)) {
      stillLeaking.push(`${href} (${why})`);
    }
  }
  assert.deepEqual(
    neverApplied,
    [],
    "this test claims these hrefs leak through a DERIVED namespace — if one no longer does, the claim is stale and the reason must be re-checked, not the assertion deleted",
  );
  assert.deepEqual(
    stillLeaking,
    [],
    "the /hr namespace is an AUTHORED allowlist precisely to keep these out — do not re-derive it from the permission matrix",
  );

  // 5 ── HEADLINE B: the namespace can only NARROW. Every authored row is (a) under /hr, (b) a page
  // that exists on disk, and (c) already inside what the permission matrix admits for at least one
  // seat. (c) is the fail-closed proof: the authored list cannot smuggle in a page the matrix would
  // have refused.
  const closureByRole = new Map(HR_ROLES.map((role) => [role, derivedAdminClosure(role)] as const));
  const notPrefixed: string[] = [];
  const missingPage: string[] = [];
  const widened: string[] = [];
  for (const item of hrItems) {
    if (!isHrNamespacePath(item.href)) {
      notPrefixed.push(item.href);
      continue;
    }
    const target = underlyingPath(item.href);
    const rel = target.replace(/^\//, "");
    const inGroup = existsSync(new URL(`../app/(admin)/${rel}/page.tsx`, import.meta.url));
    const atRoot = existsSync(new URL(`../app/${rel}/page.tsx`, import.meta.url));
    if (!inGroup && !atRoot) missingPage.push(item.href);
    // The personal workspace home has no nav row anywhere in the app, so it is not in any derived
    // closure — it is the shell's own landing page, reached by the logo. Exempt by name, not by a
    // pattern that could quietly exempt something else.
    if (target === "/workspace") continue;
    if (![...closureByRole.values()].some((closure) => closure.has(target))) {
      widened.push(`${item.href} -> ${target}`);
    }
  }
  assert.deepEqual(notPrefixed, [], "every /hr nav href must be authored under the namespace prefix");
  assert.deepEqual(missingPage, [], "every /hr nav href must resolve to a page file that exists");
  assert.deepEqual(
    widened,
    [],
    "an /hr row points at a page NEITHER seat's permissions admit — the namespace may narrow the matrix, never widen it",
  );

  // 6 ── Every authored row is reachable by at least one seat, and every section renders non-empty
  // for at least one seat. A row nobody can open is a dead link with a permission gate on it.
  const unreachable: string[] = [];
  for (const item of hrItems) {
    const reachable = HR_ROLES.some(
      (role) =>
        permissionAllowed(lookupFor(role), item.permissions) &&
        roleAllowed(role, item.roles) &&
        roleNotExcluded(role, item.excludedRoles),
    );
    if (!reachable) unreachable.push(`${item.href} (${item.label})`);
  }
  assert.deepEqual(unreachable, [], "no /hr row may be invisible to BOTH seats");

  const emptySections: string[] = [];
  for (const section of hrNavigationSections) {
    const anyoneSeesIt = HR_ROLES.some((role) =>
      getSections(hrNavigationSections, "hr", lookupFor(role), role).some((rendered) => rendered.id === section.id),
    );
    if (!anyoneSeesIt) emptySections.push(section.id);
    // Section headings double as the sidebar search key and the drag-handle aria text.
    assert.ok(section.label.trim().length > 0, `/hr section ${section.id} needs a real label`);
  }
  assert.deepEqual(emptySections, [], "every /hr section must render for at least one seat");

  // 7 ── Both seats get a real sidebar, and it is a strict subset of the authored list.
  for (const role of HR_ROLES) {
    const hrefs = sidebarHrefs(hrNavigationSections, "hr", role);
    assert.ok(hrefs.length >= 10, `${role} should see a populated /hr sidebar, got ${hrefs.length} rows`);
    assert.equal(new Set(hrefs).size, hrefs.length, `${role}'s /hr sidebar must not repeat an href`);
    for (const href of hrefs) {
      assert.ok(isHrNamespacePath(href), `${role} sees a non-namespace href in /hr mode: ${href}`);
    }
  }

  // 8 ── Active-row detection survives EITHER usePathname() behaviour after a middleware rewrite.
  // Whether the client router reports the browser path (/hr/probation) or the rewritten one
  // (/probation) is a Next.js implementation detail that has changed between releases, and getting
  // it wrong means no sidebar row ever lights up. normalizePathnameForMode makes both correct.
  const probation = hrItems.find((item) => item.href === "/hr/probation");
  assert.ok(probation, "expected /hr/probation in the namespace nav");
  for (const reported of ["/hr/probation", "/probation"]) {
    const normalized = normalizePathnameForMode(reported, "hr");
    assert.equal(normalized, "/hr/probation", `normalizing ${reported} in hr mode`);
    assert.equal(
      getActiveHref(normalized, hrNavigationSections, null),
      "/hr/probation",
      `the Probation row must light up when usePathname() reports ${reported}`,
    );
  }
  // ...and it is a no-op in the other two modes, so nothing existing moves.
  assert.equal(navigationPathPrefix("admin"), "");
  assert.equal(navigationPathPrefix("employee-portal"), "");
  assert.equal(navigationPathPrefix("hr"), "/hr");
  assert.equal(normalizePathnameForMode("/probation", "admin"), "/probation");
  assert.equal(normalizePathnameForMode("/employee-portals", "employee-portal"), "/employee-portals");
  assert.equal(normalizePathnameForMode("/", "hr"), "/hr");

  // 9 ── Chrome: hr renders the ADMIN look, not a third design and not the portal's.
  assert.equal(usesAdminChrome("admin"), true);
  assert.equal(usesAdminChrome("hr"), true);
  assert.equal(usesAdminChrome("employee-portal"), false);
  assert.equal(usesAdminChrome(undefined), false);

  // 10 ── Namespace membership is by BUNDLE NAME, on purpose. A derived membership test ("does this
  // role hold HR grants") fails OPEN: any future role granted an HR resource would silently be
  // redirected into a namespace nobody designed for it.
  const inNamespace = (Object.keys(permissionMatrix) as PhoenixRole[]).filter((role) => usesHrNamespace(role));
  assert.deepEqual(
    inNamespace.sort(),
    [...HR_ROLES].sort(),
    "exactly the two HR seats use the /hr namespace — adding a third is a decision, not a side effect",
  );
  assert.equal(hrNamespaceRoles.size, 2);

  // 11 ── The shell header cannot be forged. A client can set any header it likes, and downstream
  // code TRUSTS this one to pick the navigation — so middleware must delete both of ours from every
  // inbound request before writing its own, on the non-rewritten path too. Source-pinned because
  // there is no way to exercise Next.js middleware from this harness.
  const middlewareSource = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  for (const fragment of [
    `headers.delete(SHELL_HEADER);`,
    `headers.delete(PATH_HEADER);`,
    `headers.set(PATH_HEADER,`,
    `headers.set(SHELL_HEADER, "hr");`,
  ]) {
    assert.ok(middlewareSource.includes(fragment), `middleware.ts must contain: ${fragment}`);
  }
  // Both deletes must come BEFORE the early return, or a non-rewritten request forwards a forged
  // header straight to the layout — which would let anyone put any account into HR chrome.
  const earlyReturn = middlewareSource.indexOf("return NextResponse.next(");
  assert.ok(earlyReturn > 0, "expected middleware's pass-through return");
  assert.ok(
    middlewareSource.indexOf("headers.delete(SHELL_HEADER);") < earlyReturn,
    "the shell header must be stripped BEFORE middleware's pass-through return",
  );
  assert.ok(
    middlewareSource.indexOf("headers.delete(PATH_HEADER);") < earlyReturn,
    "the path header must be stripped BEFORE middleware's pass-through return",
  );
  // The two header names live in one module for both sides; a hand-typed literal in either place
  // fails silently (the layout simply never sees the header and renders admin chrome).
  assert.ok(middlewareSource.includes(`from "@/lib/navigation/shell-headers"`));
  assert.equal(SHELL_HEADER, "x-phoenix-shell");
  assert.equal(PATH_HEADER, "x-phoenix-path");

  // 12 ── The redirect that catches every pre-existing link. Source-pinned for the same reason:
  // a route-group layout cannot be rendered from this harness.
  const layoutSource = readFileSync(new URL("../app/(admin)/layout.tsx", import.meta.url), "utf8");
  assert.ok(
    layoutSource.includes(`requestHeaders.get(SHELL_HEADER) !== "hr" && usesHrNamespace(access.role)`),
    "the (admin) layout must send an HR seat on a bare admin address into the namespace",
  );
  assert.ok(
    layoutSource.includes(`redirect(toHrNamespacePath(requestedPath))`),
    "the redirect target must be built with toHrNamespacePath, which is idempotent — a hand-built `/hr` + path is how a redirect loop starts",
  );
  // AppShell, not the layout, is where the header picks the chrome — so the dual-mode pages outside
  // the (admin) group honour it too.
  const shellSource = readFileSync(new URL("../src/components/layout/app-shell.tsx", import.meta.url), "utf8");
  assert.ok(
    shellSource.includes(`(await headers()).get(SHELL_HEADER) === "hr" ? "hr"`),
    "AppShell must resolve the shell from the middleware header",
  );

  // 13 ── The iPhone 16px input floor reaches the HR shell on day one, and does so by CONSTRUCTION
  // rather than by a rule someone has to remember to add.
  //
  // `app/globals.css` scopes that floor (and the admin scrollbars, table rules and radius reset) to
  // `.admin-shell`, a class AppShell applies from `isAdminMode`. Wiring `isAdminMode` to
  // `usesAdminChrome` — which is true for `hr` — is therefore what carries every mobile and visual
  // rule across to the new namespace. Had it stayed `=== "admin"` the HR seats would have shipped
  // with unstyled tables and inputs that zoom the page on every tap on an iPhone, with nothing
  // failing anywhere to say so.
  assert.ok(
    shellSource.includes(`const isAdminMode = usesAdminChrome(resolvedNavigationMode);`),
    "AppShell's .admin-shell class must come from usesAdminChrome — that is what gives /hr the 16px mobile input floor",
  );
  const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.ok(
    globalCss.includes(`.admin-shell input:not([type="checkbox"]):not([type="radio"])`),
    "the admin-shell 16px input floor must still exist — it is what the assertion above inherits",
  );
}
