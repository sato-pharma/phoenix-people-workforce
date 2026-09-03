import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The way back to an emptied navigation row.
 *
 * An empty nav row renders nothing, and the row's own "+" panel is what offers remove as well as
 * add — so emptying a row also removes the only control that would refill it. Every role in admin
 * chrome can do that: `canAdd` is `carriesNavRows(navigationMode)`, not a Super Admin check. The
 * one other door, Admin Tools -> Navigation Layout, sits in a Super-Admin-only hub. That left every
 * non-Super-Admin admin/hr viewer able to empty a row and unable to restore it.
 *
 * The fix is a Navigation Layout entry in the topbar user menu. These tests pin the three things
 * that must stay true for it to keep working: the link exists and is scoped to admin chrome, the
 * page behind it still admits a non-Super-Admin, and the premise still holds — that a
 * non-Super-Admin can empty a row in the first place.
 */

/**
 * Strip comments before asserting.
 *
 * Every string these tests look for — the href, the guard, `canAdd: carriesNavRows` — is also
 * spelled out in the prose that explains the fix. Asserting against the raw file would let a
 * session delete the code, keep the comment, and stay green. That exact trap fired once already on
 * this branch's sibling work, where a `overflow-x-auto` assertion matched the comment forbidding it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

export function runNavRowWayBackTests() {
  const topbar = stripComments(readFileSync("src/components/layout/topbar.tsx", "utf8"));

  // Positive control. If stripComments ever over-matches and eats the JSX, every assertion below
  // would pass against an empty string and this file would certify nothing.
  assert.ok(
    topbar.includes("My Profile") && topbar.includes("usesAdminChrome"),
    "comment stripping ate the topbar's real code — every assertion below would pass vacuously",
  );

  const guardOpen = topbar.indexOf("{isAdminMode ? (");
  assert.ok(
    guardOpen >= 0,
    "the topbar must keep an isAdminMode-guarded block — it is what scopes the Navigation Layout link to the modes that can actually reach the page",
  );
  const guardClose = topbar.indexOf(") : null}", guardOpen);
  assert.ok(
    guardClose > guardOpen,
    "the isAdminMode block in the topbar no longer closes with ') : null}' — reread it before trusting the assertion below, which slices between the two",
  );

  const guarded = topbar.slice(guardOpen, guardClose);
  assert.ok(
    guarded.includes('href="/admin/sidebar-layout"'),
    "the Navigation Layout link must sit INSIDE the isAdminMode guard: admin and hr are the modes that both carry nav rows and can reach the (admin) route group, and app/(admin)/layout.tsx redirects a portal-mode viewer straight back out, so an unguarded link would only bounce them home",
  );

  // The link is only worth having while the page behind it still admits the people it is for.
  const page = stripComments(readFileSync("app/(admin)/admin/sidebar-layout/page.tsx", "utf8"));
  assert.ok(
    page.includes('access.source === "guest"'),
    "the layout editor's guest redirect is gone — reread the page's gate before trusting what the topbar link exposes",
  );
  assert.equal(
    [...page.matchAll(/redirect\(/g)].length,
    1,
    "the layout editor must stay open to every signed-in viewer: a second redirect here is almost certainly a role gate, and it would turn the topbar's Navigation Layout link into a dead end for exactly the non-Super-Admin roles it exists to serve",
  );

  // The premise. If only a Super Admin could ever empty a row, none of the above would be needed.
  const rows = stripComments(readFileSync("src/components/layout/horizontal-nav-rows.tsx", "utf8"));
  assert.ok(
    rows.includes("canAdd: carriesNavRows(navigationMode)"),
    "the + panel offers remove as well as add and is gated on carriesNavRows, not on Super Admin — that is precisely why every admin-chrome role needs the way back this file pins",
  );
}
