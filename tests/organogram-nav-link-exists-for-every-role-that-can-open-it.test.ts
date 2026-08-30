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
 * For EVERY role, in its OWN navigation mode, using the real production filter
 * (`getSections`, the same call the sidebar and the command palette make):
 *
 *   grant + page gates say the role can open the organogram  <->  a link to it is rendered
 *
 * Both directions. The forward direction is the bug above. The reverse catches a dead link —
 * an entry offered to a role the page then bounces, which is the failure
 * tests/sfe-manager-nav-dead-links.test.ts exists for on other pages.
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
  for (const role of ["HR Advisory", "HR Operations", "Training Manager"] as const) {
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
  }

  // ── 2. The general invariant, across every role and both shells ──────────────────────
  const stranded: string[] = [];
  const dead: string[] = [];
  for (const role of phoenixRoles) {
    const access = createAccessContext({ hrId: "T-1", role });
    const mode = resolveNavigationMode(access);
    const canOpen =
      (await canAccess(access, "organogram", "read")) &&
      (canAccessCompanyOrganogram(access) || isLineScopedOrganogramRole(access));
    const offered = organogramLinkIsOffered(role, mode);

    if (canOpen && !offered) stranded.push(`${role} (${mode})`);
    if (!canOpen && offered) dead.push(`${role} (${mode})`);
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
  }

  // ── 4. Marketing Manager is the untouched control ────────────────────────────────────
  // He was already listed on the portal entry, which is why he was never stranded. If a
  // refactor of that entry breaks him, this says so rather than letting the two roles above
  // look like the whole story.
  assert.equal(organogramLinkIsOffered("Marketing Manager", "employee-portal"), true);
}
