import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  createAccessContext,
  permissionActions,
  permissionMatrix,
  permissionResources,
  assignablePhoenixRoles,
  resolveNavigationMode,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  resolveEmployeePortalNavVisibility,
} from "../src/lib/employee-portal/navigation.ts";
import {
  pageFileFor as resolvePageFile,
  permissionGateKeys,
  roleSetGates,
} from "./support/page-gate-reader.ts";

/**
 * EVERY LINK A ROLE IS OFFERED MUST OPEN FOR THAT ROLE.
 *
 * ## The defect class this closes
 *
 * A page in this app is reachable only when three independently-edited things agree:
 *
 *   1. the permission matrix     — src/lib/auth/permissions.ts
 *   2. the navigation entry      — see "two shells, two nav systems" below
 *   3. the destination page gate — app/**\/page.tsx
 *
 * Nothing checked that they agree, so they drift, and every drift is a defect in one of two
 * shapes: GRANTED BUT UNREACHABLE (matrix allows, no link offered — invisible to every
 * permission test, because every permission assertion passes) or OFFERED BUT BOUNCED (link
 * renders, page guard rejects — the user clicks and gets Forbidden). This test is the general
 * form of the second shape. The first shape is page-specific and stays with the tests below.
 *
 * ## The evidence
 *
 * Talent Acquisition, 2026-05-01 → 2026-08-28: 66 commits touching the role, 32 of them fixes.
 * Thirteen of those 32 were this class and nothing else. It is in the production error table:
 *
 *     "Forbidden: Talent Acquisition cannot read probation."
 *     25 hits · 8 route variants · /employee-portals/probation · 2026-07-25 → 2026-07-26
 *
 * The portal offered her the Probation link while the matrix withheld `probation:read`, so the
 * page's own `assertPermission(access, "probation", "read")` threw on every visit until 41c24ede
 * added the missing line. Same account, same shape, in a source comment rather than a test:
 * `showMyCandidatesTab` records that the page, the grant and a notification deep-link all
 * shipped while no nav link ever did.
 *
 * ## Two shells, two nav systems — and only one of them was ever tested this way
 *
 * ADMIN roles are gated by `system-navigation.ts`, whose entries carry a `permissions:` list
 * read from the same matrix the page reads. Those two can barely drift, and this test confirms
 * they do not.
 *
 * PORTAL roles are gated by something else entirely: ~40 hand-written booleans
 * (`showProbationTab`, `showPeopleManagementTab`, …) computed from ROLE NAMES in
 * resolveEmployeePortalNavVisibility, with no reference to the permission matrix at all. That
 * disconnect is the root cause of the 25 errors above and of most of the thirteen: a flag says
 * "show her Probation", the matrix says "she may not read probation", and nothing compares them.
 *
 * The four reachability tests already in this suite all pin ONE page each —
 * organogram-nav-link-exists-for-every-role-that-can-open-it, recruitment-hub-portal-coverage,
 * crm-hub-cards-are-reachable-by-the-roles-they-name, sfe-manager-nav-dead-links — and the first
 * one's docstring states the general rule, then points at the fourth "for other pages". The rule
 * was written down four times and generalised none of them, which is how one role paid for it
 * thirteen times. Keep all four: each pins page-specific gates (canAccessCompanyOrganogram, hub
 * card lists, hard Super-Admin-only guards) that no generic reader can evaluate.
 *
 * ## What this can and cannot see — read before trusting a green run
 *
 * SEES the two unconditional top-level page gates, at exactly two-space indentation, which is
 * where a page-level guard lives in this codebase:
 *
 *     await assertPermission(access, "<resource>", "<action>");
 *     if (!await canAccess(access, "<resource>", "<action>")) { redirect(...) }
 *
 * ALSO SEES, since 2026-09-05, the ROLE-SET gate — the admit list a page states by name rather
 * than by permission, in either of the two spellings the codebase uses:
 *
 *     if (!VIEW_ROLES.has(access.role)) redirect(...);          // a named set, 6 pages
 *     if (access.role !== "Super Admin") redirect(...);         // an inequality, 18 pages
 *
 * This was listed here as a blind spot until the shared reader learned to read it. The direction
 * of that miss was the same one described below for permission gates: an unread role gate is an
 * empty admit list, and an empty admit list bounces nobody, so a page admitting one role by name
 * read as safe for all 17.
 *
 * **`sfe-manager-nav-dead-links.test.ts` still has a job — do not delete it in favour of this.**
 * It pins the guard's literal source text on six specific pages, and it covers `app/api/**` route
 * handlers, which have no nav link and are therefore invisible here.
 *
 * CANNOT SEE a role gate hoisted into a boolean (`!canReadPlans && access.role !== "CEO" && …`,
 * 5 pages — the reader refuses those on purpose, because the hoisted half is an alternative way
 * IN and reducing it would make this test accuse links that work), gates inside conditionals,
 * gates in imported child components, and scope filters that render an empty page rather than
 * bouncing.
 *
 * The portal registry is read as SOURCE TEXT, not imported: it pulls in lucide-react, which a
 * node test cannot load. employee-portal-bottom-nav.test.ts reads it the same way for the same
 * reason, and is what keeps the registry in sync with the sidebar that actually renders.
 *
 * Portal flags are resolved with a neutral line/department and no hr id, so line-conditional
 * entries (Head Office, CNS) and the A-3 carve-out resolve to their DEFAULT state. A link that
 * only appears for one line is therefore out of scope here rather than silently covered.
 *
 * Anything that cannot be resolved is COUNTED and reported, never silently skipped — a resolver
 * that quietly matched nothing would make this test vacuously green, which is the worst possible
 * outcome for a test whose entire job is to notice an absence.
 */

type RequiredGrant = { resource: PermissionResource; action: PermissionAction };
type PortalEntry = { href: string; flags: string[] };

const resourceSet = new Set<string>(permissionResources);
const actionSet = new Set<string>(permissionActions);
const PORTAL_REGISTRY_FILE = "src/components/employee-portal/employee-portal-nav-registry.ts";

function permissionLookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/** Admin shell: exactly what the sidebar computes — no replica of the filter. */
function adminOfferedHrefs(role: PhoenixRole): string[] {
  const sections = getSections(getNavigationSections("admin"), "admin", permissionLookupFor(role), role);
  return sections.flatMap((section) => section.items.map((item) => item.href));
}

/** Portal shell: parse the registry's `href` + `flags` pairs out of its source. */
function parsePortalRegistry(): PortalEntry[] {
  const source = readFileSync(PORTAL_REGISTRY_FILE, "utf8");
  const entries: PortalEntry[] = [];
  for (const line of source.split("\n")) {
    const href = line.match(/href:\s*"(\/[^"]+)"/)?.[1];
    if (!href) continue;
    const flagBlock = line.match(/flags:\s*\[([^\]]*)\]/)?.[1] ?? "";
    entries.push({
      href,
      flags: Array.from(flagBlock.matchAll(/"([^"]+)"/g)).map((match) => match[1]),
    });
  }
  return entries;
}

/** Mirrors isEntryVisible in the registry: no flags = always visible, else ANY flag truthy. */
function portalOfferedHrefs(role: PhoenixRole, registry: readonly PortalEntry[]): string[] {
  const visibility = resolveEmployeePortalNavVisibility(null, role) as Record<string, unknown>;
  return registry
    .filter((entry) => entry.flags.length === 0 || entry.flags.some((flag) => Boolean(visibility[flag])))
    .map((entry) => entry.href);
}

/**
 * Resolve a nav href to the page file serving it. `(admin)` is a route group: part of the path
 * on disk, absent from the URL. Everything else maps directly under app/.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function pageFileFor(href: string): string | null {
  return resolvePageFile(href, { repoRoot: REPO_ROOT });
}

/**
 * Extract the page-scope entry gates, via the SHARED reader in tests/support/page-gate-reader.ts.
 *
 * This function used to carry its own patterns, and they were weaker than the ones in
 * hr-seat-route-coherence.test.ts in two ways: they matched `!await canAccess(` but not the
 * `!(await canAccess(…))` form this codebase actually writes, and they anchored to a two-space
 * indent so a gate one level deeper was dropped. Measured on 2026-08-29 across the 377 page files:
 * this reader saw a gate on 86 pages, the shared one sees 157.
 *
 * That gap mattered here more than anywhere, because of the DIRECTION of the miss. A gate this
 * function cannot see becomes an empty grant list, and an empty grant list means "no role can be
 * bounced by this page" — so 72 gated pages were being reported as safe for every role without
 * anything ever being checked. The test was green on them because it had nothing to compare.
 */
function requiredGrantsFor(file: string): RequiredGrant[] {
  const source = readFileSync(file, "utf8");
  const grants: RequiredGrant[] = [];
  for (const key of permissionGateKeys(source)) {
    const [resource, action] = key.split(":");
    // Anything outside the real unions is ignored: a renamed resource must surface as a type
    // error in the source, never as a silent miss here.
    if (resource && action && resourceSet.has(resource) && actionSet.has(action)) {
      grants.push({ resource: resource as PermissionResource, action: action as PermissionAction });
    }
  }
  return grants;
}

function roleHolds(role: PhoenixRole, grant: RequiredGrant): boolean {
  return permissionMatrix[role]?.[grant.resource]?.includes(grant.action) ?? false;
}

/**
 * The admit lists the page states by ROLE NAME. Each one is an independent requirement — a page
 * carrying two admits the intersection — so the visitor must appear in every list.
 *
 * Unlike a permission gate there is nothing to look up: the page names who gets in, so a role
 * absent from the literal is redirected. That is what makes this shape worth reading here and
 * unreadable by the permission matrix, which is the only thing `system-navigation.ts` consults.
 */
function admitListsFor(file: string): string[][] {
  return roleSetGates(readFileSync(file, "utf8"));
}

export function runEveryOfferedLinkOpensTests() {
  const registry = parsePortalRegistry();

  // Anti-vacuity, checked before anything depends on it: if the registry parser returns nothing
  // the portal half of this test silently covers zero links while still reporting success.
  assert.ok(
    registry.length >= 40,
    `parsed only ${registry.length} entries from ${PORTAL_REGISTRY_FILE} — the registry parser is ` +
      "broken, so any green result below proves nothing about the portal shell",
  );

  const deadLinks: string[] = [];
  const unresolved = new Set<string>();
  let hrefsChecked = 0;
  let gatesRead = 0;
  let admitListsRead = 0;
  let portalHrefsChecked = 0;

  // Every role a person can actually hold. A retired seat (HR Advisory, 2026-10-08) is a dormant key
  // User Access refuses to give anyone, so the links its empty grant set would be offered reach nobody.
  for (const role of assignablePhoenixRoles) {
    const mode = resolveNavigationMode(createAccessContext({ hrId: "T-1", role }));
    const offered =
      mode === "admin" ? adminOfferedHrefs(role) : portalOfferedHrefs(role, registry);

    for (const href of new Set(offered)) {
      const file = pageFileFor(href);
      if (!file) {
        unresolved.add(href);
        continue;
      }
      hrefsChecked += 1;
      if (mode === "employee-portal") portalHrefsChecked += 1;
      for (const grant of requiredGrantsFor(file)) {
        gatesRead += 1;
        if (!roleHolds(role, grant)) {
          deadLinks.push(
            `${role} (${mode}) is offered ${href} — the page demands ` +
              `${grant.resource}:${grant.action}, which ${role} does not hold  ` +
              `[${path.relative(REPO_ROOT, file).split(path.sep).join("/")}]`,
          );
        }
      }
      for (const admits of admitListsFor(file)) {
        admitListsRead += 1;
        if (!admits.includes(role)) {
          deadLinks.push(
            `${role} (${mode}) is offered ${href} — the page admits only ` +
              `${admits.join(", ")} by name and redirects everyone else  ` +
              `[${path.relative(REPO_ROOT, file).split(path.sep).join("/")}]`,
          );
        }
      }
    }
  }

  // ── 1. The headline ──────────────────────────────────────────────────────────────────────
  // Break any offered link's grant and THIS fires, naming the role, the link, the missing grant
  // and the file. That is the 25 production Forbidden errors, caught in CI instead of by a user.
  assert.deepEqual(
    deadLinks,
    [],
    `${deadLinks.length} role/link pairs are offered a link the destination page will bounce:\n  ` +
      deadLinks.join("\n  "),
  );

  // ── 2. Anti-vacuity for the rest of the machinery ────────────────────────────────────────
  // A green result above only means something if the href resolver and the gate parser both
  // worked. Without these, renaming a route group or reformatting a guard turns this test into a
  // no-op that still reports success.
  assert.ok(
    hrefsChecked >= 100,
    `resolved only ${hrefsChecked} offered links to page files — the href resolver is broken`,
  );
  assert.ok(
    portalHrefsChecked >= 50,
    `resolved only ${portalHrefsChecked} PORTAL links — the portal half is the half that carries ` +
      "the evidence, and it is not being exercised",
  );
  assert.ok(gatesRead >= 50, `parsed only ${gatesRead} page gates — the gate reader is broken`);
  // The role-set arm needs its own floor for the same reason, and it cannot borrow the one above:
  // `gatesRead` counts PERMISSION gates only, so it stays comfortably over 50 while every admit
  // list silently stops being read. Measured 2026-09-05: 24 admit lists across 511 offered links
  // (278 permission gates), so the floor sits well under the live figure and ordinary nav churn
  // will not trip it.
  assert.ok(
    admitListsRead >= 10,
    `parsed only ${admitListsRead} role-name admit lists across every offered link — a page that ` +
      "names who gets in bounces everyone else, so with none of them read this test is back to " +
      "reporting those pages as safe for all 17 roles",
  );

  // ── 3. Report the blind spot rather than implying it is covered ──────────────────────────
  // Printed every run, not only when something is unresolved: these four counts are the evidence
  // that the green above was earned rather than vacuous, and a reader should not have to break the
  // test to find out how much it looked at. An unresolved href is not an assertion — a nav target
  // with no page.tsx is legitimate (route handlers, external links, dynamic segments) — so it is
  // appended to the same line rather than failing.
  console.log(
    `    [every-offered-link-opens] ${hrefsChecked} links checked ` +
      `(${portalHrefsChecked} portal), ${gatesRead} permission gates and ${admitListsRead} ` +
      `role-name admit lists read` +
      (unresolved.size > 0
        ? `; ${unresolved.size} hrefs have no page.tsx and were not checked: ` +
          `${[...unresolved].sort().join(", ")}`
        : "; every offered href resolved to a page file"),
  );
}
