import assert from "node:assert/strict";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  canAccess,
  createAccessContext,
  permissionActions,
  permissionMatrix,
  permissionResources,
  phoenixRoles,
  resolveNavigationMode,
  type NavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { canAccessCompanyOrganogram, isLineScopedOrganogramRole } from "../src/lib/reports/organogram.ts";

/**
 * A role that can OPEN the organogram must be OFFERED it.
 *
 * ## The bug this pins
 *
 * On 2026-08-25 the owner reported the Head Office organogram missing from the Talent
 * Acquisition account. The branch was live, the deploy was real, and BOTH of the page's gates
 * passed for her: `organogram: ["read"]` had been in her matrix since 2026-07-24 — whose own
 * comment names "org chart" among what it granted — and `canAccessCompanyOrganogram` returns
 * true for her. Requesting /employee-portals/organogram directly rendered the whole chart.
 *
 * She simply had no link. Talent Acquisition is a PORTAL-mode role, so the admin sidebar's
 * /organogram entry never reaches her, and the portal's own Organogram entry listed six field
 * roles and not her. Training Manager sat in exactly the same hole, and the portal page's own
 * source comment names him as one of the company-wide roles that reach it.
 *
 * ## Why a permission test could never have caught it
 *
 * Every access assertion about her passed. `canAccess(access, "organogram", "read")` is true,
 * `canAccessCompanyOrganogram(access)` is true, the page returns 200. Nothing in the security
 * model was wrong — the product was simply unreachable, which is invisible to any test that
 * asks "is she allowed" instead of "is she offered".
 *
 * `system-navigation.ts` hiding a link is UX only and never a security boundary (CLAUDE.md), so
 * the failure mode is not exposure. It is a page nobody can find — and this repo has now paid
 * for that twice on the same page.
 *
 * ## What this asserts
 *
 * For EVERY role, in its OWN navigation mode, on BOTH surfaces that can offer the link:
 *
 *   grant + page gates say the role can open the organogram  <->  a link to it is rendered
 *
 * Both directions. The forward direction is the bug above. The reverse catches a dead link —
 * an entry offered to a role the page then bounces, which is the failure
 * tests/sfe-manager-nav-dead-links.test.ts exists for on other pages.
 *
 * ## Why "both surfaces" — the 2026-09-10 repeat
 *
 * This file originally asserted `getSections(getNavigationSections(mode), …)` alone, describing it
 * as "the same call the sidebar and the command palette make". That is true in the ADMIN shell and
 * false in the PORTAL one, where `employee-portal-layout.tsx` builds its rail from
 * `resolveEmployeePortalNavVisibility`'s flags and the seed reaches only Cmd+K. So the 2026-08-25
 * fix for the Training Manager edited the seed, this test went green on the seed, and his sidebar
 * row still did not exist — the owner reported the same missing organogram again sixteen days
 * later. A test that measures the wrong surface does not merely miss a bug; it certifies it.
 */

/** Where the organogram lives in each shell. The admin page redirects portal-mode roles here. */
const ORGANOGRAM_HREF: Record<NavigationMode, string> = {
  admin: "/organogram",
  "employee-portal": "/employee-portals/organogram",
  // The `/hr` namespace serves the same admin page under a prefixed address. `resolveNavigationMode`
  // never returns "hr" (the mode is a property of the ADDRESS, not the person), so this entry is
  // never exercised by the sweep below — it exists so adding a shell cannot silently leave a mode
  // with no organogram link. That is the same exhaustiveness this whole file exists to enforce.
  hr: "/hr/organogram",
};

function permissionLookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/** Exactly what the sidebar renders for this role — no replica of the filter. */
function organogramLinkIsOffered(role: PhoenixRole, mode: NavigationMode): boolean {
  const sections = getSections(getNavigationSections(mode), mode, permissionLookupFor(role), role);
  return sections.some((section) => section.items.some((item) => item.href === ORGANOGRAM_HREF[mode]));
}

/**
 * The SECOND surface, and the one the owner actually looks at.
 *
 * `getSections` above reads `system-navigation.ts`. In the ADMIN shell that seed is the sidebar.
 * In the PORTAL shell it is not: `employee-portal-layout.tsx` builds its own rail out of the
 * boolean flags `resolveEmployeePortalNavVisibility` returns, and the seed feeds only the command
 * palette. So a portal role can be listed on the seed's Organogram entry, pass both page gates,
 * and still have no row in the sidebar — which is precisely what happened to the Training Manager
 * between 2026-08-25 and 2026-09-10. The 2026-08-25 fix added him to the seed, this file went
 * green, and the link he was missing was never the one being asserted.
 *
 * `viewerHrId` is deliberately a neutral id: `showOrganogramTab` also fires for the A-3 account
 * pin, and passing A-3 here would make every role look offered.
 */
function portalRailOffersOrganogram(role: PhoenixRole): boolean {
  return resolveEmployeePortalNavVisibility(role, role, null, null, "T-1").showOrganogramTab === true;
}

export async function runOrganogramNavLinkExistsTests() {
  // ── 1. The headline: the two roles that were stranded ────────────────────────────────
  // Break the fix (drop either nav entry) and THESE are the asserts that fire.
  // "Talent Acquisition" was one of the two stranded roles this test was written for. BOTH HR seats
  // are its successor for the organogram, by the owner's instruction of 2026-08-30 ("the 2 new hrs
  // should have the organogram full company appearing 2 them").
  //
  // HR Operations was pinned here as the opposite control until that ruling — the reasoning being
  // that organogram:read comes from workforce_insight, an HR Advisory function, so a rename sweep
  // moving her into this loop was a find-and-replace rather than an answer about which FUNCTION
  // carried the grant. That reading of the split was right about the mechanism and wrong about the
  // seat: she was named in canAccessCompanyOrganogram, canAccessHeadOffice AND
  // canViewOrganogramSensitiveFields the whole time, so the page's second gate always let her in
  // and only the matrix bounced her. The grant now comes from people_records — her own function,
  // ops 5 and ops 6 — and NOT by handing her workforce_insight, which would have dragged
  // weekly_plans along with it.
  //
  // The pairing this test exists to enforce is unchanged: grant and nav entry move together, and
  // tests/hr-seats-see-the-company-organogram.test.ts is the other half, pinning company mode and
  // Head Office for both seats.
  // HR Advisory was the first of these until the owner retired the seat on 2026-10-08; the Talent
  // Acquisition seat holds organogram:read and the company chart, so she takes its place here.
  // The HR Operations Specialist seat (HR Administration) joined 2026-10-20: "show organogram".
  for (const role of ["HR Operations", "HR Resourcing", "HR Administration", "Training Manager"] as const) {
    const access = createAccessContext({ hrId: "T-1", role });
    const mode = resolveNavigationMode(access);
    assert.equal(
      await canAccess(access, "organogram", "read"),
      true,
      `${role} must hold organogram:read — if this ever goes false the nav entry below is the dead link, not the fix`,
    );
    assert.equal(canAccessCompanyOrganogram(access), true, `${role} must pass the page's second gate`);
    assert.equal(
      organogramLinkIsOffered(role, mode),
      true,
      `${role} can open the organogram and must be OFFERED it. She/he holds organogram:read AND passes ` +
        `canAccessCompanyOrganogram, so ${ORGANOGRAM_HREF[mode]} renders the whole chart on request — but with ` +
        "no sidebar entry there is no way to reach it. This is exactly what the owner hit on 2026-08-25.",
    );
    if (mode === "employee-portal") {
      assert.equal(
        portalRailOffersOrganogram(role),
        true,
        `${role} is a PORTAL role, so the assert above is not the surface he uses. The portal sidebar is ` +
          "built from resolveEmployeePortalNavVisibility's flags, and showOrganogramTab is what puts the row " +
          "in it. This is what the owner hit on 2026-09-10 for A-7: seed entry present, both page gates open, " +
          "sidebar row absent.",
      );
    }
  }

  // ── 2. The general invariant, across every role and both shells ──────────────────────
  const stranded: string[] = [];
  const dead: string[] = [];
  // The same two directions again, on the portal RAIL rather than the seed — see
  // portalRailOffersOrganogram. Tracked apart so a failure names which surface is wrong; the two
  // disagreeing IS the bug, and folding them into one boolean would hide exactly that.
  const railStranded: string[] = [];
  const railDead: string[] = [];
  for (const role of phoenixRoles) {
    const access = createAccessContext({ hrId: "T-1", role });
    const mode = resolveNavigationMode(access);
    const canOpen =
      (await canAccess(access, "organogram", "read")) &&
      (canAccessCompanyOrganogram(access) || isLineScopedOrganogramRole(access));
    const offered = organogramLinkIsOffered(role, mode);

    if (canOpen && !offered) stranded.push(`${role} (${mode})`);
    if (!canOpen && offered) dead.push(`${role} (${mode})`);

    if (mode === "employee-portal") {
      const onRail = portalRailOffersOrganogram(role);
      if (canOpen && !onRail) railStranded.push(role);
      if (!canOpen && onRail) railDead.push(role);
    }
  }
  assert.deepEqual(
    stranded,
    [],
    "these roles can open the organogram but are offered no link to it — granted on paper, unreachable in the product: " +
      stranded.join(", "),
  );
  assert.deepEqual(
    dead,
    [],
    "these roles are offered an Organogram link the page will bounce them from: " + dead.join(", "),
  );
  assert.deepEqual(
    railStranded,
    [],
    "these portal roles can open the organogram but get no row in the portal sidebar (showOrganogramTab is " +
      "false for them), whatever system-navigation.ts says: " + railStranded.join(", "),
  );
  assert.deepEqual(
    railDead,
    [],
    "these portal roles get a sidebar Organogram row the page will bounce them from: " + railDead.join(", "),
  );

  // ── 3. Controls: the roles that must NOT be offered it ───────────────────────────────
  // If the fix were implemented by widening the entry's role list carelessly, or by dropping
  // `roles` altogether, these are what fail.
  // HR Operations was a control here until 2026-08-30 and is now asserted in block 1 with the
  // other two — see the note there. The controls that remain are roles holding no organogram
  // grant at all, which is what catches a fix implemented by dropping the entry's gate.
  for (const role of ["Medical Rep", "Employee"] as const) {
    assert.equal(
      organogramLinkIsOffered(role, resolveNavigationMode(createAccessContext({ hrId: "T-1", role }))),
      false,
      `${role} holds no organogram grant and must not be offered the link`,
    );
    assert.equal(
      portalRailOffersOrganogram(role),
      false,
      `${role} holds no organogram grant and must get no portal sidebar row either — this is what fails if ` +
        "showOrganogramTab is widened by deleting its role list rather than by adding one role to it",
    );
  }

  // ── 4. Marketing Manager is the untouched control ────────────────────────────────────
  // He was already listed on the portal entry, which is why he was never stranded. If a
  // refactor of that entry breaks him, this says so rather than letting the two roles above
  // look like the whole story. He is the control on BOTH surfaces: he was on the seed AND on the
  // rail throughout, which is the difference between him and the Training Manager beside him.
  assert.equal(organogramLinkIsOffered("Marketing Manager", "employee-portal"), true);
  assert.equal(portalRailOffersOrganogram("Marketing Manager"), true);
}
