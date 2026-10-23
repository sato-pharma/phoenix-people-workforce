import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EMPLOYEE_PORTAL_EXACT_ONLY_HREFS, EMPLOYEE_PORTAL_SIDEBAR_ROWS } from "../src/lib/employee-portal/sidebar-rows.ts";

/**
 * The portal sidebar's rows, mirrored for the server (src/lib/employee-portal/sidebar-rows.ts),
 * held level with the rail itself in BOTH directions.
 *
 * The rail is built by `buildEmployeePortalSections` in a `"use client"` file the System Audit
 * cannot import, so the audit reads a mirror — and a mirror that drifts names a person's module
 * wrongly without a sound. This test re-reads the layout's own source, the way
 * mobile-module-directory.test.ts does, and fails on a row missing from the mirror, a row the rail
 * no longer draws, a label or heading one character off, or rows out of the rail's order.
 */

type RailRow = { href: string; label: string; section: string };

function railRows(): RailRow[] {
  const source = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const start = source.indexOf("}: EmployeePortalNavVisibility): EmployeePortalNavSection[] {");
  assert.ok(start > 0, "buildEmployeePortalSections must still be findable in the layout");
  const end = source.indexOf(".filter(", start);
  assert.ok(end > start, "the section builder must still end with its empty-section filter");
  const body = source.slice(start, end);

  const rows: RailRow[] = [];
  let section: string | null = null;
  const pattern = /title:\s*"([^"]+)"|\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1]) {
      section = match[1];
    } else if (match[2] && match[3]) {
      assert.ok(section, `the row ${match[2]} must sit under a section title`);
      rows.push({ href: match[2], label: match[3], section });
    }
  }
  return rows;
}

function describe(row: RailRow): string {
  return `${row.section} › ${row.label} (${row.href})`;
}

export function runSystemAuditPortalSidebarRowsDriftTests() {
  const rail = railRows();
  assert.ok(rail.length >= 40, `the layout parse must find the rail's rows (found ${rail.length})`);

  const mirror = EMPLOYEE_PORTAL_SIDEBAR_ROWS.map((row) => ({ href: row.href, label: row.label, section: row.section }));
  const railKeys = new Set(rail.map(describe));
  const mirrorKeys = new Set(mirror.map(describe));

  const missing = rail.filter((row) => !mirrorKeys.has(describe(row))).map(describe);
  assert.deepEqual(missing, [], `rail rows missing from src/lib/employee-portal/sidebar-rows.ts:\n  ${missing.join("\n  ")}`);

  const stale = mirror.filter((row) => !railKeys.has(describe(row))).map(describe);
  assert.deepEqual(stale, [], `rows in sidebar-rows.ts the rail no longer draws:\n  ${stale.join("\n  ")}`);

  assert.deepEqual(
    mirror.map(describe),
    rail.map(describe),
    "sidebar-rows.ts must list the rows in the rail's own order",
  );

  // The portal root lights only on itself (resolveDeepestActiveHref's exact-only list).
  assert.ok(EMPLOYEE_PORTAL_EXACT_ONLY_HREFS.has("/employee-portals"));
  assert.ok(
    rail.some((row) => row.href === "/employee-portals"),
    "the exact-only root must be a row the rail really draws",
  );
}
