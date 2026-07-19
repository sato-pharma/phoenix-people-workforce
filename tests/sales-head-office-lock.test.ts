import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canViewHeadOfficeLine,
  isHeadOfficeLine,
  stripHeadOfficeRows,
} from "../src/lib/sales/access-scope.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The Head Office product line is confidential — only CEO / Super Admin may ever see it or its
// products. This pins the central helpers plus that every line-bearing sales surface applies the
// strip (Source of Sales engine, Weekly, Analytics, Sales-Marketing Intelligence).
export function runSalesHeadOfficeLockTests() {
  // ── Role gate ───────────────────────────────────────────────────────────────
  for (const role of ["CEO", "Super Admin"] as const) {
    assert.equal(canViewHeadOfficeLine(role), true, `${role} may see Head Office`);
  }
  for (const role of [
    "SFE Manager",
    "Marketing Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "District Manager",
    "Regional Manager",
    "Medical Rep",
  ] as const) {
    assert.equal(canViewHeadOfficeLine(role), false, `${role} must NOT see Head Office`);
  }

  // ── isHeadOfficeLine variants ────────────────────────────────────────────────
  for (const name of ["Head Office", "head office", "  HEAD OFFICE ", "office", "HQ", "headoffice"]) {
    assert.equal(isHeadOfficeLine(name), true, `"${name}" is Head Office`);
  }
  for (const name of ["Pedia", "CNS", "Anti infective", "", null, undefined]) {
    assert.equal(isHeadOfficeLine(name), false, `"${String(name)}" is not Head Office`);
  }

  // ── stripHeadOfficeRows ──────────────────────────────────────────────────────
  const rows = [
    { line: "Pedia", v: 1 },
    { line: "Head Office", v: 2 },
    { line: "office", v: 3 },
    { line: null, v: 4 }, // no line → always kept
  ];
  // enabled (a non-CEO/SA viewer): Head Office rows dropped, line-less row kept.
  assert.deepEqual(
    stripHeadOfficeRows(rows, (r) => r.line, true).map((r) => r.v),
    [1, 4],
    "strips Head Office rows when enabled, keeps line-less rows",
  );
  // disabled (CEO / Super Admin): everything kept.
  assert.deepEqual(
    stripHeadOfficeRows(rows, (r) => r.line, false).map((r) => r.v),
    [1, 2, 3, 4],
    "keeps all rows when disabled",
  );

  // ── Surface source-pins ──────────────────────────────────────────────────────
  const analytics = readSource("../src/lib/analytics/service.ts");
  for (const fn of ["loadSosByLine", "loadSosByProduct", "loadSosByCustomer", "loadClosingByEmployee", "loadCrossSource", "loadWeeklyFact"]) {
    assert.ok(analytics.includes(fn), `analytics still defines ${fn}`);
  }
  assert.ok(
    (analytics.match(/stripHeadOfficeRows\(/g) ?? []).length >= 6,
    "every line-bearing analytics loader (incl. weekly) applies stripHeadOfficeRows",
  );

  // analytics_sos_by_period / analytics_sos_by_area aggregate the line dimension AWAY, so their
  // result rows have no line to strip in TS. They must instead push the Head Office exclusion into
  // the RPC via p_exclude_head_office (fail-closed: absent canViewHeadOffice ⇒ exclude). Pin both.
  assert.ok(
    (analytics.match(/p_exclude_head_office:\s*!filters\.canViewHeadOffice/g) ?? []).length >= 2,
    "loadSosByPeriod and loadSosByArea pass p_exclude_head_office to the RPC",
  );

  // The by-area analytics dashboard must resolve canViewHeadOffice from the role so CEO/Super Admin
  // still see Head Office while everyone else (the RPC default) fails closed. The logic lives in the
  // shared dashboard component (rendered at both the admin and portal mounts).
  const byAreaDashboard = readSource("../src/components/analytics/dashboards/source-sales-by-area-dashboard.tsx");
  assert.ok(
    byAreaDashboard.includes("canViewHeadOffice: canViewHeadOfficeLine(role)"),
    "by-area dashboard passes canViewHeadOffice resolved from the role",
  );

  // The weekly analytics dashboards (overview, detail, by-distributor) carry the Head Office strip
  // ENTIRELY in TS: the analytics_weekly_fact RPC and analytics.weekly_fact view have no Head
  // Office exclusion, so loadWeeklyFact strips it and each dashboard must thread the role's flag.
  for (const rel of [
    "../src/components/analytics/dashboards/weekly-sales-dashboard.tsx",
    "../src/components/analytics/dashboards/weekly-sales-detail-dashboard.tsx",
    "../src/components/analytics/dashboards/weekly-sales-by-distributor-dashboard.tsx",
  ]) {
    assert.ok(
      readSource(rel).includes("canViewHeadOffice: canViewHeadOfficeLine(role)"),
      `weekly analytics dashboard ${rel} passes canViewHeadOffice resolved from the role`,
    );
  }

  const weekly = readSource("../src/lib/sales/weekly/access.ts");
  assert.ok(
    weekly.includes("scope.canViewHeadOffice") && weekly.includes("isHeadOfficeLine(row.officialLine)"),
    "weekly applyWeeklyAccessScope strips Head Office unless allowed",
  );
  assert.ok(
    weekly.includes("canViewHeadOffice: canViewHeadOfficeLine(ctx.role)"),
    "weekly scope resolves canViewHeadOffice from the role",
  );

  const si = readSource("../src/lib/sales-marketing-intelligence/service.ts");
  assert.ok(
    si.includes("stripHeadOfficeFromMarketingSnapshot"),
    "SI dashboard strips Head Office from the snapshot for non-CEO/SA",
  );
}
