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
  hrNamespaceRemainder,
  isHrRewritablePath,
  isHrNamespacePath,
  toHrNamespacePath,
} from "../src/lib/navigation/shell-headers.ts";
import {
  hrNamespaceRoles,
  permissionActions,
  permissionMatrix,
  permissionResources,
  scopeForRole,
  usesHrNamespace,
  type NavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { resolvePersonalWorkspaceTabs } from "../src/lib/workspace/personal-workspace-nav.ts";

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
 * What the OLD, derived approach would have shown this role: the admin sidebar, every hub card
 * behind it that the role's grants admit, and the personal-workspace tabs the role resolves. This
 * is the set the authored namespace must be a subset of — that subset relation is what "can only
 * narrow, never widen" means concretely.
 *
 * The workspace tabs are the third source because on 2026-08-30 the doors to the personal pages
 * MOVED. `/workspace/leave-management/vacation-request` and `/workspace/excuses` were the only two
 * of those fifteen pages with a sidebar row; the tab strip replaced both rows and gave the other
 * thirteen a door for the first time. Reading only the sidebar after that, this closure lost two
 * pages the matrix still admits, and the /hr rows pointing at them read as WIDENINGS — the exact
 * inversion of what this test is for, since the change opened pages rather than smuggling any in.
 *
 * `resolvePersonalWorkspaceTabs` is the right source and not a loophole: it filters against the
 * same `lookup` built from `permissionMatrix` that everything else here uses, so a tab can only
 * enter this closure when the matrix already admits it for that seat.
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
  for (const tab of resolvePersonalWorkspaceTabs({ role, scope: scopeForRole(role) }, lookup)) {
    closure.add(tab.href);
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
    // The HR command centre, same shape and a stronger reason. It has no ADMIN nav row by design —
    // it is the HR shell's own landing page and exists only for the two seats — so no closure
    // derived from admin navigation can contain it. It cannot be a widening even in principle:
    // this rule catches a row reaching a page the MATRIX would refuse, and that page's gate is not
    // a permission at all but `hrBundleForRole`, which admits the two seats and nobody else.
    // Narrower than any grant, so there is nothing here to widen. The gate itself is verified in
    // tests/hr-seat-route-coherence.test.ts, which lists it among the gates it cannot parse.
    if (target === "/admin/hr-command-center") continue;
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

  // 11 ── The shell header cannot be forged, and `/hr` cannot become a second spelling of the API.
  //
  // A client can set any header it likes, and the shell TRUSTS this one to pick the navigation —
  // so proxy.ts must delete both of ours from every inbound request before writing its own, on the
  // non-rewritten path too. Source-pinned because there is no way to exercise a Next.js proxy from
  // this harness.
  //
  // This logic lives in proxy.ts, NOT a middleware.ts: Next 16 renamed the file, this repo already
  // had a proxy.ts carrying the CSRF guard and the root 307, and shipping both files is a hard
  // build error ("Both middleware file and proxy file are detected"). Pinning the filename here is
  // what stops a future session recreating the collision.
  const proxySource = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  for (const fragment of [
    `headers.delete(SHELL_HEADER);`,
    `headers.delete(PATH_HEADER);`,
    `headers.set(PATH_HEADER,`,
    `headers.set(SHELL_HEADER, "hr");`,
  ]) {
    assert.ok(proxySource.includes(fragment), `proxy.ts must contain: ${fragment}`);
  }
  // Both deletes must come BEFORE every return that forwards request headers, or a non-rewritten
  // request hands a forged header straight to AppShell — which would let anyone put any account
  // into HR chrome.
  const shellDelete = proxySource.indexOf("headers.delete(SHELL_HEADER);");
  const pathDelete = proxySource.indexOf("headers.delete(PATH_HEADER);");
  for (const [label, marker] of [
    ["the pass-through return", "return NextResponse.next({ request: { headers } });"],
    ["the rewrite", "return NextResponse.rewrite(url, { request: { headers } });"],
    ["the security-proxy call", "const intervention = isSecurityProxyPath(pathname)"],
  ] as const) {
    const at = proxySource.indexOf(marker);
    assert.ok(at > 0, `expected proxy.ts to contain ${label}`);
    assert.ok(shellDelete > 0 && shellDelete < at, `the shell header must be stripped before ${label}`);
    assert.ok(pathDelete > 0 && pathDelete < at, `the path header must be stripped before ${label}`);
  }
  // The two header names live in one module for both sides; a hand-typed literal in either place
  // fails silently (AppShell simply never sees the header and renders admin chrome).
  assert.ok(proxySource.includes(`from "@/lib/navigation/shell-headers"`));
  assert.equal(SHELL_HEADER, "x-phoenix-shell");
  assert.equal(PATH_HEADER, "x-phoenix-path");

  // 11b ── `/hr/api/**` must NEVER rewrite. This one is a real security boundary rather than a
  // tidiness rule, and unlike the pins above it is EXECUTED, not read.
  //
  // proxy.ts scopes its CSRF guard to paths starting `/api/`. Had the namespace rewritten
  // `/hr/api/x` to `/api/x`, a cross-site POST could reach any API route on this platform through
  // the `/hr` spelling with that guard never running. Refusing the rewrite makes `/hr/api/x`
  // resolve to nothing at all, so the API has exactly one address.
  assert.equal(isHrRewritablePath("/hr/api/payroll/run"), false, "/hr/api/** must never rewrite — it would bypass the CSRF guard");
  assert.equal(isHrRewritablePath("/hr/api"), false, "/hr/api must never rewrite either");
  assert.equal(isHrRewritablePath("/hr/apiary"), true, "the exclusion is the /api SEGMENT, not the prefix");
  assert.equal(isHrRewritablePath("/hr/probation"), true);
  assert.equal(isHrRewritablePath("/hr"), true);
  assert.equal(isHrRewritablePath("/probation"), false);
  assert.equal(isHrRewritablePath("/hr-calendar"), false, "a page whose name merely starts with hr is not the namespace");
  assert.equal(hrNamespaceRemainder("/hr"), "/", "an empty pathname is invalid and throws inside NextURL");
  assert.equal(hrNamespaceRemainder("/hr/probation"), "/probation");
  // And widening the matcher must not have widened the CSRF rule onto every server action, which
  // POSTs to a page URL. The guard's own scope is kept explicit in the source for exactly that.
  assert.ok(
    proxySource.includes("const intervention = isSecurityProxyPath(pathname) ? securityProxy(request) : null;"),
    "the CSRF/preview/root guard must stay scoped to the paths it covered before the matcher widened",
  );
  for (const fragment of [`pathname === "/"`, `pathname.startsWith("/api/")`, `(accept|reject)`]) {
    assert.ok(proxySource.includes(fragment), `isSecurityProxyPath must still cover: ${fragment}`);
  }

  // 12 ── The redirect that catches every pre-existing link, and the header that picks the chrome.
  //
  // BOTH live in AppShell rather than in app/(admin)/layout.tsx, and that placement is the fix for
  // a measured gap: production notification links point at pages OUTSIDE that route group —
  // /payslips (123 rows), /marketing-requests/<id> — which mount their own shell. From the layout,
  // an HR seat following one of those links would have landed on the right page wearing the ADMIN
  // sidebar. Source-pinned because a server component cannot be rendered from this harness.
  const shellSource = readFileSync(new URL("../src/components/layout/app-shell.tsx", import.meta.url), "utf8");
  assert.ok(
    shellSource.includes(`requestHeaders.get(SHELL_HEADER) !== "hr" && usesHrNamespace(access.role)`),
    "AppShell must send an HR seat on a bare address into the namespace",
  );
  assert.ok(
    shellSource.includes(`redirect(toHrNamespacePath(requestedPath))`),
    "the redirect target must be built with toHrNamespacePath, which is idempotent — a hand-built `/hr` + path is how a redirect loop starts",
  );
  assert.ok(
    shellSource.includes(`requestHeaders.get(SHELL_HEADER) === "hr" ? "hr"`),
    "AppShell must resolve the shell from the proxy header",
  );
  // The header check must beat the explicit `navigationMode="admin"` the (admin) layout passes in,
  // or every page in that group would render admin chrome under an /hr address.
  const headerCheck = shellSource.indexOf(`requestHeaders.get(SHELL_HEADER) === "hr" ? "hr"`);
  assert.ok(
    headerCheck > 0 && shellSource.indexOf("navigationMode ?? resolveNavigationMode(access)", headerCheck) > headerCheck,
    "the shell header must take precedence over the navigationMode prop",
  );
  // The redirect must not ALSO be left in the route-group layout: two redirects on one request is
  // how a loop gets built by accident.
  const adminLayoutSource = readFileSync(new URL("../app/(admin)/layout.tsx", import.meta.url), "utf8");
  assert.ok(
    !adminLayoutSource.includes("toHrNamespacePath"),
    "the /hr redirect belongs in AppShell only — leaving a copy in the (admin) layout duplicates it",
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
