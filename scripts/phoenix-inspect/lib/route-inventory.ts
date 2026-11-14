/**
 * The route inventory: every sidebar row each role is offered, derived from the SAME code the
 * sidebars run — never typed by hand (Phoenix Visual Intelligence, phase B).
 *
 * Three rails, three sources:
 *
 *   - ADMIN rail  → `getSections(getNavigationSections("admin"), …)`, exactly what AppShell computes,
 *                   with the permission lookup built from `permissionMatrix` the way
 *                   tests/every-offered-link-opens.test.ts builds it.
 *   - HR rail     → the same call on the "hr" catalogue, for the three HR seats (`hrNamespaceRoles`).
 *                   A `/hr/<x>` address is rewritten by proxy.ts onto `/<x>`, so `pagePath` drops the
 *                   prefix.
 *   - PORTAL rail → the rows of `buildEmployeePortalSections` in employee-portal-layout.tsx, READ AS
 *                   SOURCE TEXT (it is a "use client" file carrying Lucide icons, which node cannot
 *                   load), each row's `...(flag ? [row] : [])` condition evaluated against
 *                   `resolveEmployeePortalNavVisibility(null, role)`.
 *
 * What the portal half cannot know, it says. The flags are resolved with no line, no department and
 * no hr id, so a row that depends on one of those resolves to its DEFAULT and is marked
 * `approximate: true`; a condition this reader cannot evaluate is marked `"unevaluated"`, never
 * guessed. The admin and HR halves are exact.
 *
 * Pure: reads source files and imports configuration only. No database, no network, no env.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { getNavigationSections } from "../../../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../../../src/lib/navigation/active-path.ts";
import {
  assignablePhoenixRoles,
  hrNamespaceRoles,
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../../../src/lib/auth/permissions.ts";
import { isPortalShellRole } from "../../../src/lib/auth/portal-shell-roles.ts";
import { resolveLandingPathForRole } from "../../../src/lib/auth/landing.ts";
import { resolveEmployeePortalNavVisibility } from "../../../src/lib/employee-portal/navigation.ts";
import { KPI_TABS, PORTAL_KPI_SUMMARY_TABS } from "../../../src/lib/crm/kpis-tabs.ts";
import { permissionGateKeys, roleSetGates } from "../../../tests/support/page-gate-reader.ts";

export type Portal = "admin" | "hr" | "employee-portal";

export type RouteInventoryEntry = {
  portal: Portal;
  role: PhoenixRole;
  section: string;
  sidebarLabel: string;
  /** The address the sidebar links to, query string included. */
  route: string;
  /** The page the address is served by, after the /hr rewrite and with the query dropped. */
  pagePath: string;
  pageFile: string | null;
  nestedRoutes: string[];
  visibleTabs: string[] | "not derivable from source";
  entryState: { landing: boolean; defaultTab: string | null };
  authRequirements: {
    signedIn: true;
    shell: Portal;
    navRoles?: string[];
    navExcludedRoles?: string[];
    navPermissions?: string[];
    portalCondition?: string;
    pagePermissionGates: string[];
    pageRoleGates: string[][];
  };
  /** Where this row's existence was read. */
  source: string;
  /** True when a portal flag depends on line, department or hr id and was resolved to its default. */
  approximate: boolean;
};

export type RouteInventory = {
  generatedFrom: string;
  roles: PhoenixRole[];
  entries: RouteInventoryEntry[];
  unevaluated: { role: PhoenixRole; route: string; condition: string }[];
  notes: string[];
};

const ADMIN_NAV_FILE = "src/config/system-navigation.ts";
const PORTAL_LAYOUT_FILE = "src/components/employee-portal/employee-portal-layout.tsx";

/**
 * Tabs a module's own source declares, keyed by page path. One entry per module the explorer
 * covers; every other page's tabs are observed at run time, never invented here.
 */
export const MODULE_TABS: Record<string, { tabs: readonly string[]; defaultTab: string; source: string }> = {
  "/admin/kpis": { tabs: KPI_TABS, defaultTab: "summary", source: "src/lib/crm/kpis-tabs.ts (KPI_TABS)" },
  "/employee-portals/kpis": {
    tabs: PORTAL_KPI_SUMMARY_TABS,
    defaultTab: "summary",
    source: "src/lib/crm/kpis-tabs.ts (PORTAL_KPI_SUMMARY_TABS)",
  },
};

export function permissionLookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

export function shellFor(role: PhoenixRole): Portal {
  if (hrNamespaceRoles.has(role)) return "hr";
  if (role === "CEO") return "admin";
  return isPortalShellRole(role) ? "employee-portal" : "admin";
}

/** `/hr/admin/kpis?tab=x` → `/admin/kpis`. */
export function pagePathFor(route: string): string {
  const bare = route.split("?")[0].split("#")[0];
  if (bare === "/hr") return "/";
  return bare.startsWith("/hr/") ? bare.slice(3) : bare;
}

// ---------------------------------------------------------------------------------------------
// The app/ directory: every page route, with route groups dropped.

export type PageFile = { route: string; file: string };

/** Every page under app/ (route groups dropped, dynamic segments kept as written), api/ excluded. */
export function listPageFiles(repoRoot: string): PageFile[] {
  const appDir = path.join(repoRoot, "app");
  const pages: PageFile[] = [];
  const walk = (dir: string, segments: string[], relDir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "api" && segments.length === 0) continue;
        if (name.startsWith("_") || name.startsWith("@")) continue;
        const isGroup = name.startsWith("(") && name.endsWith(")");
        walk(full, isGroup ? segments : [...segments, name], `${relDir}/${name}`);
      } else if (name === "page.tsx" || name === "page.ts") {
        pages.push({ route: `/${segments.join("/")}`.replace(/\/$/, "") || "/", file: `${relDir}/${name}` });
      }
    }
  };
  walk(appDir, [], "app");
  return pages.sort((a, b) => a.route.localeCompare(b.route));
}

export function listPageRoutes(repoRoot: string): string[] {
  return [...new Set(listPageFiles(repoRoot).map((page) => page.route))];
}

function routeMatches(pattern: string, pagePath: string): boolean {
  const want = pattern.split("/").filter(Boolean);
  const have = pagePath.split("/").filter(Boolean);
  for (let i = 0; i < want.length; i += 1) {
    const segment = want[i];
    if (/^\[\[?\.\.\./.test(segment)) return true;
    if (i >= have.length) return false;
    if (/^\[.+\]$/.test(segment)) continue;
    if (segment !== have[i]) return false;
  }
  return want.length === have.length;
}

/** The page that serves `pagePath`: an exact route first, then a dynamic one (`[module]`, `[...slug]`). */
export function pageFileForPath(pages: readonly PageFile[], pagePath: string): string | null {
  const exact = pages.find((page) => page.route === pagePath);
  if (exact) return exact.file;
  const dynamic = pages.find((page) => page.route.includes("[") && routeMatches(page.route, pagePath));
  return dynamic ? dynamic.file : null;
}

/**
 * The routes under `pagePath` that are reached from THIS row: a route under a deeper row the same
 * role is offered belongs to that row instead. Without this a hub (the portal home, `/admin`) would
 * list every page of its shell.
 */
export function nestedRoutesOf(
  pagePath: string,
  allRoutes: readonly string[],
  rolePagePaths: readonly string[] = [],
): string[] {
  if (pagePath === "/") return [];
  const prefix = `${pagePath}/`;
  const deeper = rolePagePaths.filter((other) => other !== pagePath && other.startsWith(prefix));
  return allRoutes.filter(
    (route) =>
      route.startsWith(prefix) && !deeper.some((other) => route === other || route.startsWith(`${other}/`)),
  );
}

// ---------------------------------------------------------------------------------------------
// The portal rail, read from its source.

export type PortalRailRow = { section: string; href: string; label: string; condition: string | null };

export function parsePortalRail(source: string): PortalRailRow[] {
  const start = source.indexOf("}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {");
  if (start < 0) throw new Error("buildEmployeePortalSections is no longer findable in the portal layout");
  const end = source.indexOf(".filter(", start);
  const body = source.slice(start, end > start ? end : undefined);
  const rows: PortalRailRow[] = [];
  let section: string | null = null;
  // A row is either `...(COND ? [{ href, label …}] : [])` or a bare `{ href, label …}`.
  const pattern =
    /title:\s*"([^"]+)"|\.\.\.\(\s*([^?]+?)\s*\?\s*\[\s*\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"|(?<![\w.])\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1]) {
      section = match[1];
    } else if (match[3] && match[4]) {
      rows.push({ section: section ?? "(no heading)", href: match[3], label: match[4], condition: match[2].trim() });
    } else if (match[5] && match[6]) {
      rows.push({ section: section ?? "(no heading)", href: match[5], label: match[6], condition: null });
    }
  }
  return rows;
}

/**
 * Evaluates a row condition made only of flag names, `!`, `&&`, `||` and parentheses. Anything else
 * returns null (unevaluated) rather than a guess.
 */
export function evaluateCondition(condition: string, flags: Record<string, unknown>): boolean | null {
  // A small recursive-descent reader, so nothing from source text is ever executed.
  //   or := and ("||" and)* ; and := unary ("&&" unary)* ; unary := "!" unary | "(" or ")" | flag
  const tokens = condition.match(/\|\||&&|[!()]|[A-Za-z_]\w*|\S/g) ?? [];
  let at = 0;
  const fail = Symbol("unevaluated");
  type Result = boolean | typeof fail;
  const unary = (): Result => {
    const token = tokens[at++];
    if (token === "!") {
      const inner = unary();
      return inner === fail ? fail : !inner;
    }
    if (token === "(") {
      const inner = or();
      return tokens[at++] === ")" ? inner : fail;
    }
    if (token && /^[A-Za-z_]\w*$/.test(token) && Object.hasOwn(flags, token)) return Boolean(flags[token]);
    return fail;
  };
  const and = (): Result => {
    let left = unary();
    while (left !== fail && tokens[at] === "&&") {
      at += 1;
      const right = unary();
      left = right === fail ? fail : left && right;
    }
    return left;
  };
  const or = (): Result => {
    let left = and();
    while (left !== fail && tokens[at] === "||") {
      at += 1;
      const right = and();
      left = right === fail ? fail : left || right;
    }
    return left;
  };
  if (tokens.length === 0) return null;
  const result = or();
  return result === fail || at !== tokens.length ? null : result;
}

/**
 * The person-level facts a portal flag can depend on. A row is "depends on the person" when its
 * verdict for this role changes under any of these; the base case is the role alone.
 * Arguments follow resolveEmployeePortalNavVisibility's signature after (roleLabel, accessRole):
 * line, department, viewerHrId, then seven account facts.
 */
const PERSON_VARIANTS: readonly (readonly unknown[])[] = [
  ["CNS", "Sales"],
  ["Anti Infective", "Sales"],
  ["Pedia", "Sales"],
  ["Head Office", "Head Office"],
  [null, "Pharmacovigilance"],
  [null, "Production"],
  [null, "Marketing"],
  [null, "Human Resources"],
  [null, null, null, true, true, true, true, true, true, true],
];

export function portalFlagsFor(role: PhoenixRole) {
  const base = resolveEmployeePortalNavVisibility(null, role) as unknown as Record<string, unknown>;
  const variants = PERSON_VARIANTS.map(
    (args) =>
      (resolveEmployeePortalNavVisibility as unknown as (...a: unknown[]) => Record<string, unknown>)(null, role, ...args),
  );
  return { base, variants };
}

// ---------------------------------------------------------------------------------------------

export function buildRouteInventory(repoRoot: string): RouteInventory {
  const pages = listPageFiles(repoRoot);
  const allRoutes = [...new Set(pages.map((page) => page.route))];
  const portalSource = readFileSync(path.join(repoRoot, PORTAL_LAYOUT_FILE), "utf8");
  const portalRail = parsePortalRail(portalSource);
  const roles = [...assignablePhoenixRoles] as PhoenixRole[];
  const entries: RouteInventoryEntry[] = [];
  const unevaluated: RouteInventory["unevaluated"] = [];
  const gateCache = new Map<string, { perms: string[]; roles: string[][] }>();

  const pageGates = (pageFile: string | null) => {
    if (!pageFile) return { perms: [], roles: [] };
    const cached = gateCache.get(pageFile);
    if (cached) return cached;
    const source = readFileSync(path.join(repoRoot, pageFile), "utf8");
    const result = { perms: [...permissionGateKeys(source)].sort(), roles: roleSetGates(source) };
    gateCache.set(pageFile, result);
    return result;
  };

  const tabsFor = (route: string, pagePath: string, siblings: readonly string[]) => {
    const declared = MODULE_TABS[pagePath];
    if (declared) return { tabs: [...declared.tabs], defaultTab: declared.defaultTab };
    const fromQuery = siblings
      .filter((href) => pagePathFor(href) === pagePath)
      .map((href) => new URLSearchParams(href.split("?")[1] ?? "").get("tab"))
      .filter((tab): tab is string => Boolean(tab));
    if (fromQuery.length > 0) return { tabs: [...new Set(fromQuery)], defaultTab: null };
    return { tabs: "not derivable from source" as const, defaultTab: null };
  };

  for (const role of roles) {
    const shell = shellFor(role);
    const landing = resolveLandingPathForRole(role);

    if (shell === "employee-portal") {
      const { base, variants } = portalFlagsFor(role);
      const siblings = portalRail.map((row) => row.href);
      for (const row of portalRail) {
        let visibleForRole = true;
        let dependsOnPerson = false;
        if (row.condition) {
          const verdict = evaluateCondition(row.condition, base);
          if (verdict === null) {
            unevaluated.push({ role, route: row.href, condition: row.condition });
            continue;
          }
          const others = variants.map((flags) => evaluateCondition(row.condition as string, flags));
          dependsOnPerson = others.some((other) => other !== verdict);
          // Kept when the role alone shows it, or when some person on this role would see it.
          visibleForRole = verdict || others.some((other) => other === true);
        }
        if (!visibleForRole) continue;
        const pagePath = pagePathFor(row.href);
        const pageFile = pageFileForPath(pages, pagePath);
        const gates = pageGates(pageFile);
        const tabs = tabsFor(row.href, pagePath, siblings);
        entries.push({
          portal: "employee-portal",
          role,
          section: row.section,
          sidebarLabel: row.label,
          route: row.href,
          pagePath,
          pageFile,
          nestedRoutes: nestedRoutesOf(pagePath, allRoutes),
          visibleTabs: tabs.tabs,
          entryState: { landing: pagePathFor(landing) === pagePath, defaultTab: tabs.defaultTab },
          authRequirements: {
            signedIn: true,
            shell: "employee-portal",
            ...(row.condition ? { portalCondition: row.condition } : {}),
            pagePermissionGates: gates.perms,
            pageRoleGates: gates.roles,
          },
          source: PORTAL_LAYOUT_FILE,
          approximate: dependsOnPerson,
        });
      }
      continue;
    }

    const mode = shell === "hr" ? "hr" : "admin";
    const sections = getSections(getNavigationSections(mode), mode, permissionLookupFor(role), role);
    const siblings = sections.flatMap((section) => section.items.map((item) => item.href));
    for (const section of sections) {
      for (const item of section.items) {
        const pagePath = pagePathFor(item.href);
        const pageFile = pageFileForPath(pages, pagePath);
        const gates = pageGates(pageFile);
        const tabs = tabsFor(item.href, pagePath, siblings);
        const activeTab = (item as { activeTab?: string }).activeTab ?? null;
        entries.push({
          portal: shell,
          role,
          section: section.label,
          sidebarLabel: item.label,
          route: item.href,
          pagePath,
          pageFile,
          nestedRoutes: nestedRoutesOf(pagePath, allRoutes),
          visibleTabs: tabs.tabs,
          entryState: { landing: pagePathFor(landing) === pagePath, defaultTab: activeTab ?? tabs.defaultTab },
          authRequirements: {
            signedIn: true,
            shell,
            ...(item.roles ? { navRoles: [...item.roles] } : {}),
            ...(item.excludedRoles ? { navExcludedRoles: [...item.excludedRoles] } : {}),
            ...(item.permissions
              ? { navPermissions: item.permissions.map((p) => `${p.resource}:${p.action ?? "read"}`) }
              : {}),
            pagePermissionGates: gates.perms,
            pageRoleGates: gates.roles,
          },
          source: ADMIN_NAV_FILE,
          approximate: false,
        });
      }
    }
  }

  // Second pass: each nested route belongs to the deepest row the same role is offered.
  const pathsByRole = new Map<PhoenixRole, string[]>();
  for (const entry of entries) {
    pathsByRole.set(entry.role, [...(pathsByRole.get(entry.role) ?? []), entry.pagePath]);
  }
  for (const entry of entries) {
    entry.nestedRoutes = nestedRoutesOf(entry.pagePath, allRoutes, pathsByRole.get(entry.role) ?? []);
  }

  return {
    generatedFrom: "src/config/system-navigation.ts, src/components/employee-portal/employee-portal-layout.tsx, app/",
    roles,
    entries,
    unevaluated,
    notes: [
      "Admin and HR rows are exactly what getSections returns for the role.",
      "Portal rows are the layout's own rows, each condition evaluated for the role alone and again for nine person variants (four lines, four departments, every account fact on). A row any variant disagrees on is marked approximate: whether a particular person on that role sees it depends on their line, department or account. Rows gated on a named person's hr id are not enumerable and follow the role default.",
      "visibleTabs comes from a module's own tab list where one is registered, otherwise from ?tab= links in the sidebar; anything else is 'not derivable from source' and is observed by the explorer at run time.",
      "'M2' (named in the kickoff) is not a role anywhere in the source; the only matches are an Ibn Sina depot code and an archived milestone label.",
      "The sign-in gate for every row is proxy.ts: no valid session cookie on /admin or /employee-portals → 307 to /login.",
    ],
  };
}
