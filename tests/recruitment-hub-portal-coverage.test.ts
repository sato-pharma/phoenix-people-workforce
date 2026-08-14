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
 * The hub (app/(admin)/admin/recruitment-hiring/page.tsx) lists seven tools and gates each one to
 * hrAuthorityNavigationRoles = Super Admin + Talent Acquisition. That gate is not what decides
 * reachability. Talent Acquisition sits in portalNavigationRoles, so resolveNavigationMode puts
 * them in the portal shell, and app/(admin)/layout.tsx redirects portal-mode users out of the
 * ENTIRE (admin) route group before any page in it renders. The hub and all six admin copies are
 * therefore Super-Admin-only in practice, however their `roles` read — and nothing failed, because
 * the config that names Talent Acquisition is true config and the redirect is somewhere else.
 *
 * That is how CV Extraction Accuracy and Inbound Intake Health shipped unreachable by the only role
 * that works them: the four older tools happened to have portal mirrors, these two did not, and no
 * check compared the lists. Intake Health was the expensive half — it carries the retry action for
 * dead-lettered inbound CVs, i.e. real applicants who were silently never entered.
 *
 * So the invariant is a MAP, deliberately explicit and total: adding a hub tool fails here until
 * someone decides what Talent Acquisition's route to it is. That is exactly what happened to CV
 * Field Settings, the seventh tool (owner's ruling 2026-08-14) — it arrived Super-Admin-only, and
 * widening it to Talent Acquisition meant landing the mirror in the same change rather than
 * discovering months later that the card never opened. Each twin is then checked three ways,
 * because any one of them alone is passable while the tool stays unreachable:
 *   1. the portal page file exists (no dead link),
 *   2. it is in the rendered portal sidebar (employee-portal-layout.tsx — the catalog in
 *      system-navigation.ts renders nothing on its own),
 *   3. getSections actually yields it for this role, permissions and all.
 */
const PORTAL_TWIN_BY_HUB_HREF: Readonly<Record<string, string>> = {
  "/recruitment": "/employee-portals/recruitment",
  "/cv-database": "/employee-portals/cv-database",
  "/hiring-documents": "/employee-portals/hiring-documents",
  "/recruitment/cv-review-queue": "/employee-portals/cv-review-queue",
  "/recruitment/cv-extraction-analytics": "/employee-portals/cv-extraction-analytics",
  "/recruitment/intake-health": "/employee-portals/intake-health",
  "/recruitment/cv-field-settings": "/employee-portals/cv-field-settings",
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
  assert.ok(hubItems.length >= 7, "the hub should still gate its tools to Talent Acquisition");

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

  // ── The two that were missing ───────────────────────────────────────────────────────────────
  // Named explicitly so the regression reads as itself in the output, not as a loop iteration.
  assert.ok(
    portalHrefs.has("/employee-portals/cv-extraction-analytics"),
    "CV Extraction Accuracy must be reachable by Talent Acquisition — it measures their own correction rate",
  );
  assert.ok(
    portalHrefs.has("/employee-portals/intake-health"),
    "Inbound Intake Health must be reachable by Talent Acquisition — it holds the retry for dead-lettered CVs",
  );
  // The one the owner ruled on (2026-08-14). Named for the same reason: this tool decides what the
  // extractor asks for on every future CV, and a field switched off leaves a gap nothing marks
  // afterwards — so "Talent Acquisition can open it" is a decision worth a failing assertion, not a
  // loop iteration that happens to pass.
  assert.ok(
    portalHrefs.has("/employee-portals/cv-field-settings"),
    "CV Field Settings must be reachable by Talent Acquisition — she decides which fields the CV reader asks for",
  );
}
