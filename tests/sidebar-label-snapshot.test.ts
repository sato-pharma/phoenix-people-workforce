import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  adminNavigationSections,
  employeePortalNavigationSections,
  hrNavigationSections,
} from "../src/config/system-navigation.ts";
import {
  MEASURE_SIDEBAR_LABELS_COMMAND,
  MEASURE_SIDEBAR_LABELS_WORKTREE_COMMAND,
  SIDEBAR_LABEL_SNAPSHOT_PATH,
  sidebarLabelsOf,
  type SidebarShell,
} from "../src/config/sidebar-metrics.ts";

/**
 * EVERY SIDEBAR LABEL HAS A MEASURED WIDTH — the half of the sidebar check a session can run before
 * it pushes.
 *
 * tests/sidebar-label-width.test.ts asserts two things: every label has a width in the snapshot, and
 * no label is wider than its row. Only the SECOND needs the permission matrix (it charges each label
 * the worst row it reaches across every role), and the matrix lives in permissions.ts, which pulls a
 * Supabase client in — so that test cannot run in `node scripts/check-contracts.mjs`. The first one
 * never needed it. It was still the whole of what went red: all 4 sidebar jobs of 18-25 Oct 2026
 * (four branches) were a label added without re-running the measure script, and none of them was a
 * label too wide for its row.
 *
 * So this file holds that first assertion alone, over the sections themselves rather than over the
 * per-role rows, and imports nothing that reaches a database. The label set is `sidebarLabelsOf`, the
 * same function the measure script measures, so this check can never ask for a label the script
 * does not measure. The /hr namespace is measured as "admin" (same rail, same type scale), as the
 * script and the width test both do.
 */
const SHELLS: [SidebarShell, string[]][] = [
  ["admin", sidebarLabelsOf([...adminNavigationSections, ...hrNavigationSections])],
  ["portal", sidebarLabelsOf(employeePortalNavigationSections)],
];

export function runSidebarLabelSnapshotTests() {
  const widths = JSON.parse(readFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, "utf8")) as Partial<
    Record<SidebarShell, Record<string, number>>
  >;
  const rerun = `run \`${MEASURE_SIDEBAR_LABELS_COMMAND}\` (from a worktree: \`${MEASURE_SIDEBAR_LABELS_WORKTREE_COMMAND}\`)`;
  assert.ok(widths.admin && widths.portal, `the snapshot must hold a per-shell map — ${rerun}`);

  const total = SHELLS.reduce((sum, [, labels]) => sum + labels.length, 0);
  assert.ok(total > 100, `expected the full nav to resolve, got ${total} labels`);

  const missing = SHELLS.flatMap(([shell, labels]) =>
    labels.filter((label) => typeof widths[shell]?.[label] !== "number").map((label) => `${shell}: ${label}`),
  );
  assert.deepEqual(
    missing,
    [],
    `every sidebar label needs a measured width IN ITS OWN SHELL — ${rerun} after adding or renaming one, and commit ${SIDEBAR_LABEL_SNAPSHOT_PATH}`,
  );
}
