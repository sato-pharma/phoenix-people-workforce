import assert from "node:assert/strict";

import { existsSync, readFileSync } from "node:fs";

import {
  employeePortalNavigationSections,
  recruitmentHiringPageItems,
  type NavigationSection,
} from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  createAccessContext,
  permissionActions,
  permissionMatrix,
  permissionResources,
  resolveNavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

const TALENT_ACQUISITION = "Talent Acquisition" satisfies PhoenixRole;

/**
 * Every tool on the Recruitment & Hiring hub must have a portal route Talent Acquisition can reach.
 *
 * The hub (app/(admin)/admin/recruitment-hiring/page.tsx) gates every tool to
 * hrAuthorityNavigationRoles = Super Admin + Talent Acquisition. That gate is not what decides
 * reachability. Talent Acquisition sits in portalNavigationRoles, so resolveNavigationMode puts
 * them in the portal shell, and app/(admin)/layout.tsx redirects portal-mode users out of the
 * ENTIRE (admin) route group before any page in it renders. The hub and every admin copy are
 * therefore Super-Admin-only in practice, however their `roles` read — and nothing failed, because
 * the config that names Talent Acquisition is true config and the redirect is somewhere else.
 *
 * That is how CV Extraction Accuracy and Inbound Intake Health shipped unreachable by the only role
 * that works them: the older tools happened to have portal mirrors, those two did not, and no check
 * compared the lists. Intake Health was the expensive half — it carries the retry action for
 * dead-lettered inbound CVs, i.e. real applicants who were silently never entered. (CV Extraction
 * Accuracy was removed on 2026-08-15; Intake Health is the survivor and the one that mattered.)
 *
 * So the invariant is a MAP, deliberately explicit and total: adding a hub tool fails here until
 * someone decides what Talent Acquisition's route to it is, and removing one fails here until the
 * twin goes too. Each twin is then checked three ways, because any one of them alone is passable
 * while the tool stays unreachable:
 *   1. the portal page file exists (no dead link),
 *   2. it is in the rendered portal sidebar (employee-portal-layout.tsx — the catalog in
 *      system-navigation.ts renders nothing on its own),
 *   3. getSections actually yields it for this role, permissions and all.
 */
const PORTAL_TWIN_BY_HUB_HREF: Readonly<Record<string, string>> = {
  "/recruitment": "/employee-portals/recruitment",
  "/cv-database": "/employee-portals/cv-database",
  "/hiring-documents": "/employee-portals/hiring-documents",
  "/hiring-pack": "/employee-portals/hiring-pack",
  "/offers": "/employee-portals/offers",
  "/recruitment/intake-health": "/employee-portals/intake-health",
  "/recruitment/contact-review": "/employee-portals/contact-review",
};

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const rolePermissions = permissionMatrix[role];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function portalHrefsFor(role: PhoenixRole): Set<string> {
  const sections = getSections(
    employeePortalNavigationSections as readonly NavigationSection[],
    "employee-portal",
    lookupForRole(role),
    role,
  );
  return new Set(sections.flatMap((section) => section.items.map((item) => item.href)));
}

function pageFileForPortalHref(href: string): string {
  return `app${href}/page.tsx`;
}

export function runRecruitmentHubPortalCoverageTests() {
  // ── The premise ─────────────────────────────────────────────────────────────────────────────
  // If this flips, Talent Acquisition reaches the admin hub directly and the mirrors below become
  // redundant rather than load-bearing. Deliberately pinned so that move is a decision someone
  // makes on purpose, having read this file, rather than a side effect of editing a role set.
  assert.equal(
    resolveNavigationMode(createAccessContext({ hrId: "TA", role: TALENT_ACQUISITION })),
    "employee-portal",
    "Talent Acquisition is a portal-shell role (owner decision, 2026-07-24) — the (admin) group is closed to them",
  );

  const layoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const portalHrefs = portalHrefsFor(TALENT_ACQUISITION);

  const hubItems = recruitmentHiringPageItems.filter((item) =>
    (item.roles ?? []).some((role) => role === TALENT_ACQUISITION),
  );
  assert.equal(
    hubItems.length,
    7,
    "the hub carries exactly seven Talent-Acquisition tools (Recruitment, CV Database, Hiring Documents, Contract & Form 1, Job Offers, Inbound Intake Health, Missing Contact Details) — if that count moves, decide the portal twin in the same change",
  );

  for (const item of hubItems) {
    const twin = PORTAL_TWIN_BY_HUB_HREF[item.href];
    assert.ok(
      twin,
      `hub tool "${item.label}" (${item.href}) has no portal route for Talent Acquisition — the admin copy is unreachable for them, so add a mirror under app/employee-portals/ and map it here`,
    );

    assert.ok(
      existsSync(pageFileForPortalHref(twin)),
      `${twin} is mapped as the portal route for "${item.label}" but ${pageFileForPortalHref(twin)} does not exist`,
    );

    assert.ok(
      layoutSource.includes(`"${twin}"`),
      `${twin} is missing from the rendered portal sidebar (employee-portal-layout.tsx), so "${item.label}" has a page but no way in`,
    );

    assert.ok(
      portalHrefs.has(twin),
      `getSections does not yield ${twin} for Talent Acquisition — check the item's roles/permissions in employeePortalNavigationSections`,
    );
  }

  // The map must not outlive the hub either: a stale entry here would keep asserting a mirror for a
  // tool that no longer exists, and quietly stop covering the tool that replaced it.
  // Set<string>, not the inferred Set<`/${string}`> — the keys being compared come from
  // Object.keys, which is plain string however the map literal is typed.
  const hubHrefs = new Set<string>(recruitmentHiringPageItems.map((item) => item.href));
  for (const hubHref of Object.keys(PORTAL_TWIN_BY_HUB_HREF)) {
    assert.ok(
      hubHrefs.has(hubHref),
      `${hubHref} is mapped to a portal twin but is no longer a hub tool — drop it from PORTAL_TWIN_BY_HUB_HREF`,
    );
  }

  // ── The one that was missing, and is now the only alarm on the front door ───────────────────
  // Named explicitly so the regression reads as itself in the output, not as a loop iteration.
  assert.ok(
    portalHrefs.has("/employee-portals/intake-health"),
    "Inbound Intake Health must be reachable by Talent Acquisition — it holds the retry for dead-lettered CVs",
  );

  // ── The removed tools must stay removed, on BOTH surfaces ───────────────────────────────────
  // The owner's ruling, 2026-08-15. Each of these had an admin page and a portal twin, and each
  // twin was wired into three separate places; a partial revert would leave a card or a sidebar row
  // pointing at a page that no longer exists.
  for (const gone of ["cv-review-queue", "cv-extraction-analytics", "cv-field-settings"]) {
    assert.ok(
      !portalHrefs.has(`/employee-portals/${gone}`),
      `/employee-portals/${gone} was removed on the owner's ruling — it must not reappear in the portal navigation`,
    );
    assert.ok(
      !existsSync(`app/employee-portals/${gone}/page.tsx`),
      `app/employee-portals/${gone}/page.tsx was removed on the owner's ruling — a restored page has no navigation entry to reach it`,
    );
    assert.ok(
      !layoutSource.includes(`/employee-portals/${gone}`),
      `${gone} is still listed in the rendered portal sidebar, so Talent Acquisition gets a row that opens nothing`,
    );
  }
}
