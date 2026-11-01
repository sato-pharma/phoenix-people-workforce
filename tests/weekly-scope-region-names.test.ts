import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { buildDetailScopeSummary } from "../src/lib/sales/weekly/depot-detail-service.ts";
import { buildWeeklyScopeSummary } from "../src/lib/sales/weekly/portal-weekly-dashboard.ts";
import {
  WEEKLY_SCOPE_REGION_FALLBACK,
  loadWeeklyScopeRegionNames,
  selectWeeklyScopeRegionNames,
  weeklyScopeRegionPart,
  type WeeklyScopeRegionRow,
} from "../src/lib/sales/weekly/scope-region-names.ts";
import { buildStockScopeSummary } from "../src/lib/sales/weekly/stock-dashboard-service.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

// The weekly scope line names a manager's one bound region from the organogram, on all three screens.
//
// Measured on production 2026-09-17 (read-only): depot rows keep the region label they were mapped with
// ("Upper Egypt"), never Upper Egypt 1, Upper Egypt 2 or Delta (3), so a name lookup built from the rows missed
// exactly those regions. Depot Detail read "Pedia · 1 region · District Manager", the Weekly Sales dashboard
// printed every single-region manager's code ("UE-1 region", "GZ region"), and Weekly Stock fell back to the code.
//
// This suite runs with PRODUCTION credentials, so nothing here reaches a database: every organogram read goes
// through an injected in-memory client.

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The organogram's region names as production held them on 2026-09-17 (au_v_org_tree): one row per seat. */
const ORG_ROWS: WeeklyScopeRegionRow[] = [
  { region_code: null, region_name: null },
  { region_code: "AB", region_name: "Alex-BHR" },
  { region_code: "CA", region_name: "Cairo" },
  { region_code: "D1", region_name: "Delta (1)" },
  { region_code: "D2", region_name: "Delta (2)" },
  { region_code: "D3", region_name: "Delta (3)" },
  { region_code: "GZ", region_name: "Giza" },
  { region_code: "OT", region_name: "Others" },
  { region_code: "UE", region_name: "Upper Egypt" },
  { region_code: "UE-1", region_name: "Upper Egypt 1" },
  { region_code: "UE-1", region_name: "Upper Egypt 1" },
  { region_code: "UE-2", region_name: "Upper Egypt 2" },
];

const orgClient = () => fakeSupabaseClient({ au_v_org_tree_sales: ORG_ROWS.map((row) => ({ ...row })) });

function territory(line: string, regionCodes: string[] | null): WeeklyAccessScope {
  return {
    tier: "territory",
    allowedLineNames: new Set([line]),
    allowedRegionCodes: regionCodes ? new Set(regionCodes) : null,
    allowedAreaCodes: null,
    canViewHeadOffice: false,
  };
}

/** The scope line each of the three screens prints for one viewer, from one set of region names. */
function scopeLines(scope: WeeklyAccessScope, role: PhoenixRole, regionNames: ReadonlyMap<string, string>) {
  return {
    depotDetail: buildDetailScopeSummary(scope, role, regionNames),
    weeklySales: buildWeeklyScopeSummary(scope, role, regionNames),
    weeklyStock: buildStockScopeSummary(scope, role, regionNames),
  };
}

function everywhere(line: string) {
  return { depotDetail: line, weeklySales: line, weeklyStock: line };
}

/** Wraps a client and records every table read through it. */
function countingClient(inner: { from(name: string): unknown }) {
  const reads: string[] = [];
  return {
    reads,
    client: {
      from(name: string) {
        reads.push(name);
        return inner.from(name);
      },
    },
  };
}

export async function runWeeklyScopeRegionNamesTests() {
  const ue1 = territory("Pedia", ["UE-1"]);

  // Headline: a district manager bound to Upper Egypt 1 reads its name on all three screens.
  const ue1Names = await loadWeeklyScopeRegionNames(ue1, orgClient() as never);
  assert.deepEqual(
    scopeLines(ue1, "District Manager", ue1Names),
    everywhere("Pedia · Upper Egypt 1 · District Manager"),
    "a UE-1-bound manager's scope line reads Upper Egypt 1 on Depot Detail, Weekly Sales and Weekly Stock alike",
  );

  // The five district managers measured on production, then two ordinary regions: the Weekly Sales dashboard
  // printed every single-region manager's code, not just these five.
  const managers = [
    { line: "Pedia", code: "UE-1", name: "Upper Egypt 1" },
    { line: "Pedia", code: "UE-2", name: "Upper Egypt 2" },
    { line: "Anti Infective", code: "UE-1", name: "Upper Egypt 1" },
    { line: "Anti Infective", code: "UE-2", name: "Upper Egypt 2" },
    { line: "Anti Infective", code: "D3", name: "Delta (3)" },
    { line: "CNS", code: "GZ", name: "Giza" },
    { line: "Pedia", code: "AB", name: "Alex-BHR" },
  ];
  for (const manager of managers) {
    const scope = territory(manager.line, [manager.code]);
    const names = await loadWeeklyScopeRegionNames(scope, orgClient() as never);
    assert.deepEqual(
      scopeLines(scope, "District Manager", names),
      everywhere(`${manager.line} · ${manager.name} · District Manager`),
      `${manager.line} ${manager.name}: all three screens name the region, never its code`,
    );
  }

  // The depot rows' own label is "Upper Egypt", which is a different region, so the line never borrows it for an
  // Upper Egypt 1 manager: with no name for his region it reads words, never the code.
  assert.equal(WEEKLY_SCOPE_REGION_FALLBACK, "1 region");
  assert.deepEqual(
    scopeLines(ue1, "District Manager", new Map([["UE", "Upper Egypt"]])),
    everywhere("Pedia · 1 region · District Manager"),
    "a lookup that only knows the depot label names no region rather than the wrong one or the code",
  );

  // Fails soft: an organogram read that answers an error, throws, or rejects leaves the lookup empty, and all three
  // lines still read in words.
  const failures: Array<{ label: string; client: unknown }> = [
    {
      label: "answers an error",
      client: fakeSupabaseClient({ au_v_org_tree_sales: ORG_ROWS }, { failOn: { au_v_org_tree_sales: "permission denied for view au_v_org_tree_sales" } }),
    },
    {
      label: "throws",
      client: {
        from() {
          throw new TypeError("fetch failed");
        },
      },
    },
    {
      label: "rejects",
      client: {
        from() {
          return { select: () => Promise.reject(new Error("socket hang up")) };
        },
      },
    },
  ];
  for (const failure of failures) {
    const loading = loadWeeklyScopeRegionNames(ue1, failure.client as never);
    await assert.doesNotReject(loading, `an organogram read that ${failure.label} never fails the page`);
    const names = await loading;
    assert.equal(names.size, 0, `an organogram read that ${failure.label} yields no names`);
    const lines = scopeLines(ue1, "District Manager", names);
    assert.deepEqual(
      lines,
      everywhere("Pedia · 1 region · District Manager"),
      `an organogram read that ${failure.label}: all three lines fall back to "1 region"`,
    );
    for (const line of Object.values(lines)) {
      assert.doesNotMatch(line, /UE-1/, `an organogram read that ${failure.label} never puts the region code on screen`);
    }
  }

  // Only a viewer bound to exactly one region costs an organogram read; every other line names no region.
  const oneRegion = countingClient(orgClient());
  assert.equal((await loadWeeklyScopeRegionNames(ue1, oneRegion.client as never)).get("UE-1"), "Upper Egypt 1");
  assert.deepEqual(oneRegion.reads, ["au_v_org_tree_sales"], "a one-region viewer reads the organogram exactly once");

  const noRead: Array<{ label: string; scope: WeeklyAccessScope; role: PhoenixRole; weeklySales: string; detailAndStock: string }> = [
    {
      label: "a full-access viewer",
      scope: { tier: "full", canViewRestricted: true, canViewHeadOffice: true },
      role: "CEO",
      weeklySales: "All lines · all regions · CEO",
      detailAndStock: "All tracked lines · all regions · CEO",
    },
    {
      label: "a product-scoped viewer",
      scope: { tier: "product", productCodes: new Set(["P1", "P2"]), canViewHeadOffice: false },
      role: "Product Manager",
      weeklySales: "2 products · Product Manager",
      detailAndStock: "2 products · Product Manager",
    },
    {
      label: "a line viewer with no region bound",
      scope: territory("CNS", null),
      role: "National Sales Manager",
      weeklySales: "CNS · all regions · National Sales Manager",
      detailAndStock: "CNS · all regions · National Sales Manager",
    },
    {
      label: "a viewer bound to three regions",
      scope: territory("Pedia", ["CA", "GZ", "UE-1"]),
      role: "Regional Manager",
      weeklySales: "Pedia · 3 regions · Regional Manager",
      detailAndStock: "Pedia · 3 regions · Regional Manager",
    },
    {
      label: "a viewer with no access",
      scope: { tier: "none", canViewHeadOffice: false },
      role: "Employee",
      weeklySales: "No access · Employee",
      detailAndStock: "No access · Employee",
    },
  ];
  for (const viewer of noRead) {
    const counted = countingClient(orgClient());
    const names = await loadWeeklyScopeRegionNames(viewer.scope, counted.client as never);
    assert.deepEqual(counted.reads, [], `${viewer.label} costs no organogram read`);
    assert.equal(names.size, 0, `${viewer.label} gets no region names`);
    assert.deepEqual(
      scopeLines(viewer.scope, viewer.role, names),
      { depotDetail: viewer.detailAndStock, weeklySales: viewer.weeklySales, weeklyStock: viewer.detailAndStock },
      `${viewer.label} keeps its scope line`,
    );
  }

  // The lookup itself: a code matches whatever its case or spacing, and a row with no name adds nothing, so the line
  // falls back to words rather than printing a blank.
  const selected = selectWeeklyScopeRegionNames([
    { region_code: "UE-1", region_name: "  " },
    { region_code: " ue-2 ", region_name: " Upper Egypt 2 " },
    { region_code: "UE-2", region_name: "Upper Egypt 2 (duplicate seat)" },
  ]);
  assert.deepEqual([...selected], [["UE-2", "Upper Egypt 2"]], "a nameless row adds nothing and the first name for a code wins");
  assert.equal(weeklyScopeRegionPart(new Set([" ue-2 "]), selected), "Upper Egypt 2");
  assert.equal(weeklyScopeRegionPart(new Set(["UE-1"]), selected), "1 region");
  assert.equal(weeklyScopeRegionPart(null, selected), "all regions");

  // Wiring: each screen hands its builder the organogram names, never a lookup built from the depot rows' labels.
  const weeklySales = readSource("../src/lib/sales/weekly/portal-weekly-dashboard.ts");
  assert.match(
    weeklySales,
    /const regionNames = await loadWeeklyScopeRegionNames\(accessScope\);/,
    "Weekly Sales reads the organogram names for the viewer's scope",
  );
  assert.match(
    weeklySales,
    /const scopeSummary = buildWeeklyScopeSummary\(accessScope, role, regionNames\);/,
    "Weekly Sales builds its scope line from the organogram names",
  );
  const depotDetail = readSource("../src/lib/sales/weekly/depot-detail-service.ts");
  assert.match(
    depotDetail,
    /summary: buildDetailScopeSummary\(scope\.accessScope, ctx\.role, scope\.regionNames\),/,
    "Depot Detail builds its scope line from the organogram names resolvePortalWeeklyScope read",
  );
  const weeklyStock = readSource("../src/lib/sales/weekly/stock-dashboard-service.ts");
  assert.match(weeklyStock, /loadWeeklyScopeRegionNames\(accessScope\),/, "Weekly Stock reads the organogram names");
  assert.match(
    weeklyStock,
    /summary: buildStockScopeSummary\(accessScope, ctx\.role, regionNames\),/,
    "Weekly Stock builds its scope line from the organogram names",
  );
  for (const [screen, source] of [
    ["Weekly Sales", weeklySales],
    ["Depot Detail", depotDetail],
    ["Weekly Stock", weeklyStock],
  ] as const) {
    assert.doesNotMatch(
      source,
      /availableRegions\.map\(\(region\) => \[region\.code/,
      `${screen} builds no region-name lookup from the depot rows' own labels`,
    );
  }
}
