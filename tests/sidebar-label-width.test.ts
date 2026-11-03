import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  adminNavigationSections,
  employeePortalNavigationSections,
  hrNavigationSections,
  type NavigationSection,
} from "../src/config/system-navigation.ts";
import { getSections, usesFlatSidebar, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  FALLBACK_LABEL_FONT_FAMILY,
  labelBudgetPx,
  PORTAL_GEOMETRY_CHECKPOINT,
  portalNavClientWidthFor,
  SIDEBAR_LABEL_SNAPSHOT_PATH,
  type SidebarShell,
} from "../src/config/sidebar-metrics.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  usesHrNamespace,
  type NavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * The owner's standing rule: sidebar text is NEVER truncated with an ellipsis and never wraps.
 *
 * It was being broken silently. On 2026-08-10 nine labels clipped — worst was
 * "Weekly / Monthly Plan Approvals" at 191px against a 118px budget, rendering as
 * "Weekly / Monthly Pl…". Nothing caught it because the admin label span carries Tailwind's
 * `truncate`, which turns an overflow into a tidy ellipsis rather than a visible layout break.
 *
 * That span keeps `truncate` as a last-resort net (a clipped label still beats one overlapping the
 * pin star). This test asserts the net is never reached. The PORTAL span has no `truncate` at all,
 * so there an over-long label does not ellipsise — it pushes its row's badge out and overflows. Same
 * assertion, uglier failure.
 *
 * Widths are MEASURED, not modelled: a per-character advance model was off by up to 9px on strings
 * like "Weekly / Monthly Plans" — more than the ~5px of slack the tightest label has.
 * `pnpm run ui:measure-sidebar-labels` re-measures in headless Chromium and rewrites the snapshot. A
 * label with no snapshot entry FAILS here rather than being skipped, so adding or renaming one cannot
 * quietly bypass the check.
 *
 * Each label has to fit in TWO faces. The font stack draws with the first family a machine can see, so
 * one width only ever described the machine that took it: the script's own browser sees Segoe UI, not
 * Aptos, and "Double Visit Data Integrity" passed here at 154px while a browser on Arial's metrics cut
 * it at 159px. The snapshot's `fallback` half holds Arial, and a label must fit its row in both.
 *
 * The missing-entry half also runs before the push: tests/sidebar-label-snapshot.test.ts holds it with
 * no database import, so `node scripts/check-contracts.mjs` can run it. This file still needs
 * permissions.ts for the per-role rows, so it stays in the PR's own CI.
 *
 * Both the budget and the measurement are PER SHELL. The admin rail and the employee portal share
 * no geometry and no type scale, and until #2353's follow-up this test charged every portal row an
 * admin budget — so widening the admin rail silently raised the allowance for portal labels that
 * live in a component the model had never seen. `labelBudgetPx` now requires a `shell` so that
 * substitution cannot happen again.
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

type Measured = { badge: boolean; hub: boolean; label: string; roles: string[]; shell: SidebarShell };

/**
 * A row's chrome depends on the role viewing it: in the admin rail a section that resolves to
 * exactly ONE visible item renders as a standalone hub row carrying the ↗, which costs 20px. So each
 * label is charged the WORST context it reaches across every role, not a nominal one.
 */
function worstCaseRows(): Measured[] {
  const byKey = new Map<string, Measured>();
  // The /hr namespace is charged the ADMIN budget because it renders in the same rail at the same
  // type scale — a separate shell here would have invented a second allowance for one component.
  const shells: [SidebarShell, readonly NavigationSection[], NavigationMode][] = [
    ["admin", adminNavigationSections, "admin"],
    ["admin", hrNavigationSections, "hr"],
    ["portal", employeePortalNavigationSections, "employee-portal"],
  ];
  for (const [shell, sections, mode] of shells) {
    for (const role of ROLES) {
      // An HR seat NEVER renders adminNavigationSections. `usesHrNamespace` is the same predicate
      // proxy.ts rewrites on and hr-url-namespace.test.ts pins, so the pairing below is not a
      // context this role "might" reach - it is one it provably cannot. Charging it anyway is not
      // conservatism, it is a false positive with a real cost: on 2026-09-01 it read a section of
      // the ADMIN rail that happened to hold exactly one row HR Advisory's grants admit, called
      // that a 20px hub chrome, and demanded "Manager CV Engagement" be renamed everywhere - a
      // page <h1>, a portal tab and two files of prose - to fit a rail she is never served.
      //
      // This narrows the model by exactly one role/shell pairing and nothing else. Every HR label
      // is still charged the ADMIN budget, through the `["admin", hrNavigationSections, "hr"]`
      // entry above; every other role still walks the admin rail; and the hub rule still applies
      // in full wherever a section really can collapse to one row.
      if (mode === "admin" && usesHrNamespace(role)) continue;
      for (const section of getSections(sections, mode, lookupForRole(role), role)) {
        // The ↗ is what the +hub 20px buys, and `SortableSectionBlock` renders it only on a row that
        // really is its section — so a role on the FLAT sidebar (SFE Manager) never sees one.
        // Charging it anyway is the same false positive the HR pairing above documents: it read a
        // single-row section of a rail whose only viewer gets no arrow, called that hub chrome, and
        // demanded a label be shortened to fit 20px it does not spend.
        const isHub = section.items.length === 1 && !usesFlatSidebar(role);
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
  type ShellWidths = Partial<Record<SidebarShell, Record<string, number>>>;
  const widths = JSON.parse(readFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, "utf8")) as ShellWidths & {
    fallback?: ShellWidths;
  };
  assert.ok(
    widths.admin && widths.portal,
    "the snapshot must hold a per-shell map — re-run `pnpm run ui:measure-sidebar-labels`",
  );
  assert.ok(
    widths.fallback?.admin && widths.fallback.portal,
    `the snapshot must hold a per-shell map in ${FALLBACK_LABEL_FONT_FAMILY} — re-run \`pnpm run ui:measure-sidebar-labels\``,
  );
  const faces: [string, ShellWidths][] = [
    ["the measuring machine's face", widths],
    [FALLBACK_LABEL_FONT_FAMILY, widths.fallback],
  ];

  const rows = worstCaseRows();
  assert.ok(rows.length > 100, `expected the full nav to resolve, got ${rows.length} rows`);

  const missing = faces.flatMap(([face, measured]) =>
    rows
      .filter((row) => typeof measured[row.shell]?.[row.label] !== "number")
      .map((row) => `${row.shell} in ${face}: ${row.label}`),
  );
  assert.deepEqual(
    [...new Set(missing)],
    [],
    "every sidebar label needs a measured width IN ITS OWN SHELL — run `pnpm run ui:measure-sidebar-labels` after adding or renaming one",
  );

  const clipped: string[] = [];
  for (const row of rows) {
    const budget = labelBudgetPx({ badge: row.badge, hub: row.hub, shell: row.shell });
    for (const [face, measured] of faces) {
      const width = measured[row.shell]![row.label];
      if (width > budget) {
        clipped.push(
          `"${row.label}" [${row.shell}${row.badge ? " +badge" : ""}${row.hub ? " +hub" : ""}] needs ${width}px in ${face} but gets ${budget}px ` +
            `(${width - budget}px over; first seen as ${row.roles[0]})`,
        );
      }
    }
  }
  assert.deepEqual(
    clipped,
    [],
    `sidebar labels must never clip — the owner's rule is no ellipsis, no wrap:\n  ${clipped.join("\n  ")}`,
  );

  // A row's budget above comes from the section as its role sees it, with no search typed. A query can
  // leave one match in a section of many, and if that row took the ↗ it would have 20px less than it
  // was measured against: on 3 Nov 2026 six labels were cut in the rail's search results, and eleven
  // more in Arial, with every row here passing. So the block must hold the arrow back while searching.
  assert.match(
    readFileSync("src/components/layout/sidebar.tsx", "utf8"),
    /standalone=\{[^}]*&& !query\}/,
    "a row left alone by a search is no hub: with the ↗ it gets 137px against the 157px its label was measured for",
  );

  // The budgets themselves must stay honest. If someone narrows a rail or grows an icon box
  // without re-checking, these pin the arithmetic that the assertions above depend on.
  assert.equal(labelBudgetPx({ badge: false, hub: false, shell: "admin" }), 157, "admin plain row budget");
  assert.equal(
    labelBudgetPx({ badge: false, hub: true, shell: "admin" }),
    137,
    "admin hub row budget (pays for the ↗)",
  );
  assert.equal(labelBudgetPx({ badge: true, hub: false, shell: "admin" }), 125, "admin badge row budget");
  assert.equal(
    labelBudgetPx({ badge: true, hub: true, shell: "admin" }),
    125,
    "an admin hub row with a badge drops the ↗, so it is charged the same as any badge row",
  );

  assert.equal(labelBudgetPx({ badge: false, hub: false, shell: "portal" }), 159, "portal plain row budget");
  assert.equal(labelBudgetPx({ badge: true, hub: false, shell: "portal" }), 121, "portal badge row budget");
  assert.equal(
    labelBudgetPx({ badge: false, hub: true, shell: "portal" }),
    159,
    "the portal renders no hub arrow, so a one-item section costs a portal label nothing",
  );

  // The portal nav's width is DERIVED from the aside rather than re-measured on every change. That
  // shortcut is only legitimate while the derivation still reproduces the one reading actually
  // taken in a browser — so pin it against that reading rather than trusting the chain on its word.
  assert.equal(
    portalNavClientWidthFor(PORTAL_GEOMETRY_CHECKPOINT.asideWidth),
    PORTAL_GEOMETRY_CHECKPOINT.navClientWidth,
    "the portal geometry chain no longer reproduces the measured 312px rail — re-measure in a browser before touching these constants",
  );

  // The two shells must not silently converge on one number again.
  assert.notEqual(
    labelBudgetPx({ badge: false, hub: false, shell: "admin" }),
    labelBudgetPx({ badge: false, hub: false, shell: "portal" }),
    "admin and portal budgets are different rails and must be modelled separately",
  );
}
