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

  // ── Confidential-product reveal (LA003/LA004/SS001) ──────────────────────────
  // The exclusion used to be baked into analytics.sos_fact, so Analytics could never reveal while
  // the SoS dashboard could — the same month read 5.76x smaller on one screen than the other for a
  // CEO. Migration 20260801114237 moved it to a per-call argument; these pins stop a call site or a
  // dashboard silently dropping back to the hidden default.
  assert.equal(
    (analytics.match(/\.\.\.confidentialRevealArg\(filters\)/g) ?? []).length,
    4,
    "all four money RPCs (period/area/line/product) carry the confidential reveal argument",
  );

  // Reveal must be expressed as an EMPTY exclusion list. Passing the codes explicitly would hide
  // them, which is the exact inversion this lock exists to catch.
  assert.ok(
    /p_exclude_codes: \[\]/.test(analytics),
    "reveal is p_exclude_codes: [] (exclude nothing), never the code list",
  );

  // Hiding must OMIT the key rather than pass the codes: the RPC default is the fail-closed answer,
  // and an omitted key keeps the argument set compatible with the pre-migration signature.
  assert.ok(
    /return filters\.canViewRestrictedProducts \? \{ p_exclude_codes: \[\] \} : \{\};/.test(analytics),
    "non-privileged viewers omit p_exclude_codes entirely and inherit the RPC's hidden default",
  );

  // analytics_sos_by_customer measures active_batches (a COUNT) off a different view and has no
  // value column, so it must NOT gain the argument — its signature never grew one.
  const byCustomerLoader = analytics.slice(analytics.indexOf("loadSosByCustomerUncached"));
  assert.ok(
    !byCustomerLoader.slice(0, 900).includes("confidentialRevealArg"),
    "by_customer is a count view with no value column — it must not take the confidential argument",
  );

  // Every money dashboard must resolve the reveal from the role, or the RPC default hides it.
  for (const name of [
    "source-sales-dashboard",
    "source-sales-by-area-dashboard",
    "source-sales-by-line-dashboard",
    "source-sales-by-product-dashboard",
  ]) {
    const source = readSource(`../src/components/analytics/dashboards/${name}.tsx`);
    assert.ok(
      source.includes("canViewRestrictedProducts: canViewRestrictedProducts(role)"),
      `${name} passes canViewRestrictedProducts resolved from the role`,
    );
  }

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
