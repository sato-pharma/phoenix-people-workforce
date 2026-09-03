import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import {
  buildPermissionLookup,
  permissionMatrix,
  resolveNavigationMode,
  scopeForRole,
  type AccessContext,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import {
  applyPersonalLayout,
  PERSONAL_LAYOUT_VERSION,
  type PersonalNavigationLayout,
} from "../src/lib/navigation/personal-layout.ts";
import { resolveShellNavigationMode } from "../src/lib/navigation/shell-mode.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The navigation-layout editor arranges the catalogue the viewer's OWN shell renders from.
//
// app/(admin)/admin/sidebar-layout/page.tsx hardcoded the admin catalogue. That is not the mode
// every caller renders under: AppShell pulls an HR seat onto /hr/admin/sidebar-layout and serves it
// HR chrome, whose rows are built from the hr catalogue instead.
//
// The failure is SILENT in both directions, which is why it needed a test rather than a look:
//
//   * resolveNavigationMode() answers about the PERSON and deliberately never returns "hr", so the
//     obvious one-line fix reproduces the bug while looking like it fixed it. The mode is a
//     property of the ADDRESS -- the x-phoenix-shell header -- and only resolveShellNavigationMode
//     combines the two.
//   * applyPersonalLayout indexes the gated catalogue by href and drops anything it does not hold.
//     The three modes use disjoint prefixes, so an HR seat arranging the admin catalogue saved a
//     perfectly valid layout -- a 200, a row in the database -- and their navigation did not move.
//     No error, anywhere. That is the same shape as the one-zone contradiction recorded in
//     personal-layout.ts: "I selected the layout, then I save, and nothing happens."
//
// So this file pins three things: the rule that resolves the mode, the premise that makes a wrong
// mode silent rather than loud, and the page actually asking for its own mode.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip comments before asserting on source.
 *
 * Every string pinned below is also spelled out in the prose that explains the fix -- including the
 * hardcoded call this file exists to forbid. Asserting against raw source would let a session
 * restore the hardcode, keep the comment, and stay green; and the "must NOT contain" assertion
 * would fail against a file that merely DESCRIBES the old defect. That trap has fired in this repo
 * before, where an overflow-x-auto assertion matched the comment forbidding it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function accessFor(role: PhoenixRole): AccessContext {
  return { hrId: "a-1", loginId: "a-1", role, scope: scopeForRole(role), source: "session" };
}

function gatedFor(role: PhoenixRole, mode: "admin" | "hr" | "employee-portal") {
  return getSections(
    getNavigationSections(mode),
    mode,
    buildPermissionLookup(permissionMatrix, role),
    role,
  );
}

function hrefsOf(sections: readonly { items: readonly { href: string }[] }[]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.href));
}

function layoutWithUpperRow(hrefs: readonly string[]): PersonalNavigationLayout {
  return {
    version: PERSONAL_LAYOUT_VERSION,
    strip: [],
    upperRow: hrefs,
    lowerRow: [],
    sections: [],
    hidden: [],
  };
}

export function runSidebarLayoutEditorModeTests() {
  const HR_SEAT: PhoenixRole = "HR Advisory";

  // -- 1. The rule --------------------------------------------------------------------------
  const hrAccess = accessFor(HR_SEAT);

  // The premise for the whole helper existing. If resolveNavigationMode ever started returning
  // "hr", a page could ask it directly and this module would be dead weight -- so state the
  // dependency out loud rather than letting it rot into a silently redundant layer.
  assert.notEqual(
    resolveNavigationMode(hrAccess),
    "hr",
    "resolveNavigationMode answers about the PERSON and must never return 'hr' -- resolveShellNavigationMode exists precisely because the mode is a property of the address",
  );

  assert.equal(
    resolveShellNavigationMode(hrAccess, "hr"),
    "hr",
    "an HR seat served under the /hr namespace renders HR chrome, so the shell header must decide the mode",
  );
  assert.equal(
    resolveShellNavigationMode(hrAccess, null),
    "admin",
    "off the /hr namespace there is no header, and the answer falls back to the question about the person",
  );
  // app/(admin)/layout.tsx passes navigationMode="admin" for the whole route group. If that prop
  // beat the header, every HR seat inside the group would render the admin catalogue again -- the
  // exact defect, reintroduced through the override argument.
  assert.equal(
    resolveShellNavigationMode(hrAccess, "hr", "admin"),
    "hr",
    "the shell header must outrank a caller-supplied mode: app/(admin)/layout.tsx states 'admin' for the whole group, and an HR seat inside it still renders HR chrome",
  );
  assert.equal(
    resolveShellNavigationMode(accessFor("Medical Rep"), null),
    "employee-portal",
    "a portal role with no shell header resolves to the portal, exactly as resolveNavigationMode does",
  );

  // -- 2. The premise: a wrong mode is SILENT, not loud --------------------------------------
  const adminGated = gatedFor(HR_SEAT, "admin");
  const hrGated = gatedFor(HR_SEAT, "hr");
  const adminHrefs = hrefsOf(adminGated);
  const hrHrefs = hrefsOf(hrGated);

  // Positive control. Both gated sets must be non-empty, or every assertion below passes vacuously
  // against an empty catalogue and this file certifies nothing.
  assert.ok(
    adminHrefs.length > 0 && hrHrefs.length > 0,
    `both catalogues must be non-empty for the comparison below to mean anything (admin=${adminHrefs.length}, hr=${hrHrefs.length})`,
  );

  const shared = adminHrefs.filter((href) => hrHrefs.includes(href));
  assert.deepEqual(
    shared,
    [],
    "the admin and hr catalogues must stay disjoint by href -- that disjointness is what makes serving the wrong one silent rather than an error, and it is the reason the editor has to resolve its own mode",
  );

  // The defect, reproduced end to end: an HR seat arranges the ADMIN catalogue, saves a valid
  // layout, and their HR rows come back empty.
  const arrangedFromAdminCatalogue = applyPersonalLayout(
    hrGated,
    layoutWithUpperRow(adminHrefs.slice(0, 3)),
  );
  assert.deepEqual(
    arrangedFromAdminCatalogue.upperRow,
    [],
    "an HR seat arranging admin hrefs must resolve to an EMPTY upper row -- this is the bug the page's hardcoded admin catalogue shipped, and it is why nothing appeared to happen when they saved",
  );

  // The control for that control: the same machinery, given the catalogue it belongs to, works.
  // Without this the assertion above would also pass if applyPersonalLayout were simply broken.
  const arrangedFromHrCatalogue = applyPersonalLayout(
    hrGated,
    layoutWithUpperRow(hrHrefs.slice(0, 3)),
  );
  assert.equal(
    arrangedFromHrCatalogue.upperRow.length,
    3,
    "the same layout machinery must place all three hrefs when they come from the viewer's OWN catalogue -- otherwise the empty row above proves nothing about the mode",
  );

  // -- 3. The page asks for its own mode ------------------------------------------------------
  const page = stripComments(readFileSync("app/(admin)/admin/sidebar-layout/page.tsx", "utf8"));

  // Positive control for the stripper: if it ever over-matches and eats the code, every assertion
  // below passes against an empty string.
  assert.ok(
    page.includes("SidebarLayoutEditor") && page.includes("getSections("),
    "comment stripping ate the page's real code -- every assertion below would pass vacuously",
  );

  assert.ok(
    !page.includes('getNavigationSections("admin")'),
    "the layout editor must not hardcode the admin catalogue: an HR seat reaches this page under HR chrome, and handing them admin hrefs makes every arrangement they save resolve to nothing",
  );
  assert.ok(
    page.includes("resolveShellNavigationMode(") && page.includes("getNavigationSections(navigationMode)"),
    "the layout editor must resolve its own shell mode and gate THAT catalogue -- resolveNavigationMode alone never returns 'hr' and would reproduce the defect while looking fixed",
  );
  // The security story the page's own doc comment states, and the property a topbar link to this
  // page depends on: one redirect, on source === "guest", and no role gate.
  assert.ok(
    page.includes('access.source === "guest"'),
    "the layout editor's guest redirect is gone -- reread the page's gate before trusting what links to it",
  );
  assert.equal(
    [...page.matchAll(/redirect\(/g)].length,
    1,
    "the layout editor must stay open to every signed-in viewer: a second redirect here is almost certainly a role gate, and it would strand exactly the non-Super-Admin seats the editor exists to serve",
  );

  // -- 4. One rule, not two -------------------------------------------------------------------
  // AppShell resolved this inline before the helper existed. If it forks back into a private copy,
  // the shell and the page can disagree about which mode a page is in -- and the symptom is once
  // again a page that looks right and does nothing.
  const shell = stripComments(readFileSync("src/components/layout/app-shell.tsx", "utf8"));
  assert.ok(
    shell.includes("resolveShellNavigationMode("),
    "AppShell must resolve the mode through the shared helper -- a second inline copy of the header-beats-person rule is how the shell and the editor drift apart",
  );
}
