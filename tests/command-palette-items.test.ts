import assert from "node:assert/strict";

import {
  phoenixRoles,
  buildPermissionLookup,
  permissionMatrix,
  type NavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { buildCommandPaletteItems } from "../src/lib/navigation/command-palette-items.ts";

/**
 * ONE ROW PER DESTINATION in Cmd/Ctrl+K.
 *
 * The palette folds `hubPageItemGroups` in on top of the sidebar so a collapsed hub does not hide
 * the twenty modules behind it. Several hrefs are deliberately listed in more than one group with
 * mutually-exclusive role gates, and `navigationItemVisible` waives the `roles` gate for the system
 * administrator — so both copies reached the Super Admin palette, rendered the same row twice, and
 * (the key being `href-label`, which both halves agree on) threw React's "two children with the
 * same key" on every admin page load. `/leave-management/vacation-report` and
 * `/admin/notification-confidence` are the two that were reported; the sweep below is what stops
 * the next pair, because a duplicate is a config edit away at any time and the symptom is a console
 * warning nobody reads.
 *
 * The sidebar half has had `dedupeSectionsByHref` since the Super Admin bypass was replaced. This
 * asserts the palette's own list, which is the sidebar plus the hub fold-in.
 */
export function runCommandPaletteItemsTests() {
  const modes: NavigationMode[] = ["admin", "employee-portal", "hr"];

  for (const role of phoenixRoles) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    for (const mode of modes) {
      const items = buildCommandPaletteItems(mode, lookup, role);
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.href, (counts.get(item.href) ?? 0) + 1);
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([href]) => href);
      assert.deepEqual(
        duplicates,
        [],
        `${role} / ${mode}: command palette offers the same href twice — ${duplicates.join(", ")}`,
      );

      // ...and no two rows READ the same either. A viewer picks a row by its two lines of text, so
      // two rows agreeing on both while pointing somewhere different is a coin flip — the same
      // defect as a duplicate href, one layer up, and invisible to the sweep above.
      const byText = new Map<string, string[]>();
      for (const item of items) {
        const text = `${item.label} | ${item.section}`;
        byText.set(text, [...(byText.get(text) ?? []), item.href]);
      }
      const ambiguous = [...byText.entries()]
        .filter(([, hrefs]) => hrefs.length > 1)
        .map(([text, hrefs]) => `${text} -> ${hrefs.join(" , ")}`);
      assert.deepEqual(
        ambiguous,
        [],
        `${role} / ${mode}: two palette rows read identically but go somewhere different — ${ambiguous.join("; ")}`,
      );
    }
  }

  // Anti-vacuity. An empty list would satisfy the sweep above, so pin the size and pin that the two
  // hrefs the duplicate-key error named are still OFFERED — deduping must not be a way to lose one.
  const superAdmin = buildCommandPaletteItems(
    "admin",
    buildPermissionLookup(permissionMatrix, "Super Admin"),
    "Super Admin",
  );
  assert.equal(
    superAdmin.length > 100,
    true,
    `Super Admin palette collapsed to ${superAdmin.length} destinations — the builder is not returning the hub fold-in`,
  );
  for (const href of ["/leave-management/vacation-report", "/admin/notification-confidence"]) {
    assert.equal(
      superAdmin.filter((item) => item.href === href).length,
      1,
      `${href} must appear exactly once in the Super Admin palette`,
    );
  }

  // THE MARKETING TWIN. /admin/marketing-requests and /workspace/marketing-requests render the
  // same component, so the palette collapses them to one row rather than naming a difference that
  // does not exist. Measured: Super Admin and SFE Manager are the only two offered both.
  const marketing = (role: PhoenixRole) =>
    buildCommandPaletteItems("admin", buildPermissionLookup(permissionMatrix, role), role).filter((item) =>
      ["/admin/marketing-requests", "/workspace/marketing-requests"].includes(item.href),
    );
  for (const role of ["Super Admin", "SFE Manager"] as const) {
    assert.deepEqual(
      marketing(role).map((item) => item.href),
      ["/workspace/marketing-requests"],
      `${role} must be offered the marketing workspace once, not once per shell`,
    );
  }
  // ...and the alias must never take the LAST row for a destination. The District Manager is not
  // on the sidebar row, so the hub card is his only way in: collapsing him to nothing would hide
  // the workspace from the role that files the most requests.
  assert.deepEqual(
    marketing("District Manager").map((item) => item.href),
    ["/admin/marketing-requests"],
    "the District Manager must keep his own route to the marketing workspace",
  );
}
