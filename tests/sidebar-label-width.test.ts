import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  adminNavigationSections,
  employeePortalNavigationSections,
  type NavigationSection,
} from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import { labelBudgetPx, SIDEBAR_LABEL_SNAPSHOT_PATH } from "../src/config/sidebar-metrics.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * The owner's standing rule: sidebar text is NEVER truncated with an ellipsis and never wraps.
 *
 * It was being broken silently. On 2026-08-10 nine labels clipped — worst was
 * "Weekly / Monthly Plan Approvals" at 191px against a 118px budget, rendering as
 * "Weekly / Monthly Pl…". Nothing caught it because the label span carries Tailwind's `truncate`,
 * which turns an overflow into a tidy ellipsis rather than a visible layout break.
 *
 * The span keeps `truncate` as a last-resort net (a clipped label still beats one overlapping the
 * pin star). This test asserts the net is never reached.
 *
 * Widths are MEASURED, not modelled: the app resolves to Aptos, and a per-character advance model
 * was off by up to 9px on strings like "Weekly / Monthly Plans" — more than the ~5px of slack the
 * tightest label has. `pnpm run ui:measure-sidebar-labels` re-measures in headless Chromium and
 * rewrites the snapshot. A label with no snapshot entry FAILS here rather than being skipped, so
 * adding or renaming one cannot quietly bypass the check.
 */

const ROLES = Object.keys(permissionMatrix) as PhoenixRole[];

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role][resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

type Measured = { badge: boolean; hub: boolean; label: string; roles: string[]; shell: string };

/**
 * A row's chrome depends on the role viewing it: a section that resolves to exactly ONE visible
 * item renders as a standalone hub row carrying the ↗, which costs 20px. So each label is charged
 * the WORST context it reaches across every role, not a nominal one.
 */
function worstCaseRows(): Measured[] {
  const byKey = new Map<string, Measured>();
  const shells: [string, readonly NavigationSection[], "admin" | "employee-portal"][] = [
    ["admin", adminNavigationSections, "admin"],
    ["portal", employeePortalNavigationSections, "employee-portal"],
  ];
  for (const [shell, sections, mode] of shells) {
    for (const role of ROLES) {
      for (const section of getSections(sections, mode, lookupForRole(role), role)) {
        const isHub = section.items.length === 1;
        for (const navItem of section.items) {
          const key = `${shell}|${navItem.href}|${navItem.label}`;
          const existing = byKey.get(key);
          if (existing) {
            existing.hub ||= isHub;
            if (!existing.roles.includes(role)) existing.roles.push(role);
          } else {
            byKey.set(key, {
              badge: Boolean(navItem.navBadge),
              hub: isHub,
              label: navItem.label,
              roles: [role],
              shell,
            });
          }
        }
      }
    }
  }
  return [...byKey.values()];
}

export function runSidebarLabelWidthTests() {
  const widths = JSON.parse(readFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, "utf8")) as Record<string, number>;
  const rows = worstCaseRows();
  assert.ok(rows.length > 100, `expected the full nav to resolve, got ${rows.length} rows`);

  const missing = rows.filter((row) => typeof widths[row.label] !== "number").map((row) => row.label);
  assert.deepEqual(
    [...new Set(missing)],
    [],
    "every sidebar label needs a measured width — run `pnpm run ui:measure-sidebar-labels` after adding or renaming one",
  );

  const clipped: string[] = [];
  for (const row of rows) {
    const budget = labelBudgetPx({ badge: row.badge, hub: row.hub });
    const width = widths[row.label];
    if (width > budget) {
      clipped.push(
        `"${row.label}" [${row.shell}${row.badge ? " +badge" : ""}${row.hub ? " +hub" : ""}] needs ${width}px but gets ${budget}px ` +
          `(${width - budget}px over; first seen as ${row.roles[0]})`,
      );
    }
  }
  assert.deepEqual(
    clipped,
    [],
    `sidebar labels must never clip — the owner's rule is no ellipsis, no wrap:\n  ${clipped.join("\n  ")}`,
  );

  // The budgets themselves must stay honest. If someone narrows the rail or grows the icon box
  // without re-checking, these pin the arithmetic that the assertions above depend on.
  assert.equal(labelBudgetPx({ badge: false, hub: false }), 156, "plain row budget");
  assert.equal(labelBudgetPx({ badge: false, hub: true }), 136, "hub row budget (pays for the ↗)");
  assert.equal(labelBudgetPx({ badge: true, hub: false }), 124, "badge row budget");
  assert.equal(
    labelBudgetPx({ badge: true, hub: true }),
    124,
    "a hub row with a badge drops the ↗, so it is charged the same as any badge row",
  );
}
