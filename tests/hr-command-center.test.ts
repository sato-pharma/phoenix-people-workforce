/**
 * The HR command centre — that a seat's landing dashboard only ever shows it figures it can act on.
 *
 * THE CLAIM, AND WHY IT CHAINS. Every tile links somewhere. This file asserts that every tile's
 * href is a row the seat is ALREADY OFFERED in its own sidebar; tests/hr-seat-route-coherence.ts
 * asserts that every offered row's page actually opens for that seat. Together those two say the
 * thing that matters and neither says alone: every figure on this dashboard leads to a page that
 * renders. Breaking either half breaks the chain, so neither may be deleted as redundant.
 *
 * WHY IT EXISTS. The defect it guards is one this repository has now produced twice. The HR
 * sidebar offered a Deductions row on `deductions:read` — a grant HR Operations really holds —
 * pointing at a page that admits {Super Admin, CEO} by name; the link rendered and the page
 * redirected (fixed in #2554). Building this dashboard reproduced the same shape immediately: the
 * contract-renewal tiles were first written under `hr_governance`, which BOTH seats hold, while
 * `contracts` is granted only by `people_records`, which is Operations-only — so HR Advisory's
 * dashboard carried four figures linking to a page she cannot open. A second draft pointed the
 * "No Manager Set" tile at /hr/organogram, which no function in the Operations bundle grants at
 * all. Neither was caught by a permission test, because in both cases the tile's own basis was
 * sound and the LINK was what failed. That is what the loop below reads.
 *
 * IT IS NOT A LIST. The tiles are produced by calling the real builders in
 * src/lib/hr/command-center.ts with empty but well-formed sources, so the hrefs asserted are the
 * hrefs the page emits. A test that re-listed them would agree with itself forever while the page
 * pointed somewhere else.
 */

import assert from "node:assert/strict";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { HR_ROLE_BUNDLES, type HrBundleName } from "../src/lib/auth/hr-functions.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { deductionsCategories } from "../src/lib/deductions/types.ts";
import {
  buildHrCommandGroups,
  DEDUCTION_CATEGORY_LABELS,
  hrBundleForRole,
  sourcesFor,
  type HrCommandSources,
} from "../src/lib/hr/command-center.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

/**
 * Indent for a multi-line assertion message, built from a char code rather than an escape — this
 * repository is edited through shells that halve backslashes in a heredoc (AGENTS.md §2.1), and a
 * swallowed escape turns the separator into a real line break inside the template literal, which
 * is a syntax error that takes the whole suite down before one test runs. It has happened twice.
 */
const SEP = String.fromCharCode(10) + "  ";

const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];

function lookupForSeat(seat: HrBundleName): PermissionLookup {
  const rolePermissions = permissionMatrix[seat as unknown as PhoenixRole];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] =
        rolePermissions?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/** Every `/hr` row the sidebar renders for this seat. */
function offeredHrefs(seat: HrBundleName): Set<string> {
  const rows = getSections(
    getNavigationSections("hr"),
    "hr",
    lookupForSeat(seat),
    seat as unknown as PhoenixRole,
  ).flatMap((section) => section.items);
  return new Set(rows.map((row) => row.href));
}

/**
 * Every source present and empty. The point is to exercise each builder's full path — a builder
 * that returns early on a missing source would otherwise emit none of its hrefs and the loop below
 * would pass by reading nothing. `deductions` needs the cast because its buckets are keyed by a
 * category union this test has no reason to enumerate; `Object.values({})` is `[]` either way.
 */
function emptySources(): HrCommandSources {
  return {
    attendanceExceptions: [],
    contracts: {
      rows: [],
      summary: {
        activeRequests: 0,
        hrReview: 0,
        managerReview: 0,
        notRenewed: 0,
        renewed: 0,
        totalRequests: 0,
      },
    },
    deductions: {
      pending: {},
      pendingTotal: 0,
      willPublish: {},
      willPublishTotal: 0,
    } as HrCommandSources["deductions"],
    directory: {
      employees: [],
      lookups: {
        areas: [],
        departments: [],
        lines: [],
        managers: [],
        medicalRepVacancies: [],
        positions: [],
        statuses: [],
        teams: [],
        workforceVacancies: [],
      },
      summary: {
        activeEmployees: 0,
        employeesWithoutManagers: 0,
        totalEmployees: 0,
        uniqueAreas: 0,
        uniqueLines: 0,
      },
    },
    offers: [],
    probation: [],
    recruitment: {
      applications: [],
      requisitions: [],
      summary: {
        activeApplications: 0,
        hires: 0,
        openRequisitions: 0,
        stageCounts: {},
        totalApplications: 0,
        totalRequisitions: 0,
      },
    },
    resignations: {
      employees: [],
      payrollCandidates: [],
      records: [],
      summary: {
        active: 0,
        approved: 0,
        completed: 0,
        payrollCandidates: 0,
        pending: 0,
        total: 0,
      },
    },
    supportRequests: [],
  };
}

/**
 * Functions that contribute no tiles on purpose. Written down rather than inferred, so dropping a
 * group by accident fails instead of quietly shrinking somebody's dashboard.
 */
const FUNCTIONS_WITH_NO_TILES = new Set(["hr_governance"]);

export async function runHrCommandCenterTests() {
  // ── The gate the page gates on ────────────────────────────────────────────────────────────────
  // app/(admin)/admin/hr-command-center/page.tsx redirects on `!hrBundleForRole(access.role)`, so
  // this function IS the page's access control. Super Admin is the one worth naming: it can do
  // everything else in this system, and it still has no bundle, so it has no version of this page.
  for (const seat of seats) {
    assert.equal(hrBundleForRole(seat), seat, `"${seat}" must resolve to its own bundle`);
  }
  for (const role of ["Super Admin", "CEO", "Employee", "Medical Rep", "HR Specialist", ""]) {
    assert.equal(
      hrBundleForRole(role),
      null,
      `"${role}" resolves to an HR bundle — the command centre would render for a role it is not ` +
        "composed for, and the page's only gate is this function",
    );
  }

  // ── Never fetch what the bundle does not justify ──────────────────────────────────────────────
  // Latency is the smaller half. HR Advisory holds no deductions grant at all, so a dashboard that
  // read the deductions month under her session would be doing work her job description forbids —
  // the boundary is in HR_ROLE_BOUNDARIES and this is the one code path that could quietly cross it.
  const advisorySources = sourcesFor("HR Advisory");
  const operationsSources = sourcesFor("HR Operations");
  assert.ok(
    !advisorySources.includes("deductions"),
    `HR Advisory's dashboard loads the deductions month (sources: ${advisorySources.join(", ")}) — ` +
      "she holds no deductions grant, and reading it on her behalf crosses a job-description boundary",
  );
  for (const source of ["recruitment", "offers", "supportRequests"] as const) {
    assert.ok(
      !operationsSources.includes(source),
      `HR Operations' dashboard loads "${source}", which only an HR Advisory function asks for`,
    );
  }
  // A control: without it, a sourcesFor that returned [] would satisfy both assertions above.
  assert.ok(
    advisorySources.length >= 4 && operationsSources.length >= 4,
    `sourcesFor returned almost nothing (Advisory ${advisorySources.length}, Operations ` +
      `${operationsSources.length}) — the checks above passed by loading nothing, not by scope`,
  );

  // ── Every tile leads somewhere the seat can actually go ───────────────────────────────────────
  const failures: string[] = [];
  let tilesChecked = 0;

  for (const seat of seats) {
    const offered = offeredHrefs(seat);
    const groups = buildHrCommandGroups(seat, emptySources());
    const rendered = new Set(groups.map((group) => group.functionKey));

    for (const functionKey of HR_ROLE_BUNDLES[seat]) {
      const expected = !FUNCTIONS_WITH_NO_TILES.has(functionKey);
      if (expected && !rendered.has(functionKey)) {
        failures.push(
          `${seat}: function "${functionKey}" is in the bundle but contributed no tiles — either ` +
            "its builder regressed, or it belongs in FUNCTIONS_WITH_NO_TILES with a reason",
        );
      }
      if (!expected && rendered.has(functionKey)) {
        failures.push(
          `${seat}: function "${functionKey}" is listed as contributing no tiles but rendered a ` +
            "group — remove it from FUNCTIONS_WITH_NO_TILES",
        );
      }
    }

    for (const group of groups) {
      // A group may only come from a function the seat actually holds. The dashboard is composed
      // from the permission bundle; a group outside it would be a figure with no grant behind it.
      assert.ok(
        (HR_ROLE_BUNDLES[seat] as readonly string[]).includes(group.functionKey),
        `${seat} renders a "${group.functionKey}" group, which is not in its bundle`,
      );

      const keys = new Set<string>();
      for (const tile of group.tiles) {
        tilesChecked += 1;
        assert.ok(
          !keys.has(tile.key),
          `${seat}/${group.functionKey}: duplicate tile key "${tile.key}" — React will drop one`,
        );
        keys.add(tile.key);

        assert.ok(
          tile.href.startsWith("/hr/"),
          `${seat}/${group.functionKey}: tile "${tile.key}" links to ${tile.href}, outside the /hr ` +
            "namespace — AppShell would bounce it back and the seat would pay a redirect per click",
        );

        if (!offered.has(tile.href)) {
          failures.push(
            `${seat}: tile "${tile.label}" (${group.functionKey}) links to ${tile.href}, which is ` +
              "not a row this seat is offered — it holds no grant that opens that page",
          );
        }
      }
    }
  }

  assert.deepEqual(failures, [], `HR command centre tiles that lead nowhere:${SEP}${failures.join(SEP)}`);

  // Controls. The loop above is only meaningful if it read a real number of tiles against a set
  // that can actually reject something — an `offered` containing everything would pass it blind.
  assert.ok(
    tilesChecked >= 20,
    `only ${tilesChecked} tiles were checked across both seats — the builders returned almost ` +
      "nothing and the assertion above passed by reading an empty dashboard",
  );
  assert.ok(
    !offeredHrefs("HR Operations").has("/hr/admin/deductions"),
    "/hr/admin/deductions is offered to HR Operations again — that row was removed in #2554 " +
      "because the page admits {Super Admin, CEO} by name. If it is back, this whole file's " +
      "offered-set check has stopped discriminating and every tile assertion above is blind",
  );

  // ── Every chart plots what it says it plots ───────────────────────────────────────────────────
  // A chart fails differently from a tile. A tile with a wrong key renders `undefined` and is
  // obvious; a chart whose series key is absent from its rows renders a clean, empty, entirely
  // plausible plot — recharts does not complain about a dataKey that matches nothing. So the
  // series/row agreement is asserted here rather than left to be noticed on the page.
  let chartsChecked = 0;
  let seriesChecked = 0;

  for (const seat of seats) {
    const offered = offeredHrefs(seat);
    const chartKeys = new Set<string>();

    for (const group of buildHrCommandGroups(seat, emptySources())) {
      for (const chart of group.charts) {
        chartsChecked += 1;

        assert.ok(
          !chartKeys.has(chart.key),
          `${seat}: duplicate chart key "${chart.key}" — React will drop one of them`,
        );
        chartKeys.add(chart.key);

        for (const field of ["caption", "emptyLabel", "hrefLabel", "title"] as const) {
          assert.ok(
            chart[field].length > 0,
            `${seat}/${chart.key}: empty ${field} — an unlabelled chart is a rectangle`,
          );
        }

        assert.ok(
          chart.href.startsWith("/hr/"),
          `${seat}/${chart.key}: links to ${chart.href}, outside the /hr namespace — AppShell ` +
            "would bounce it and the seat would pay a redirect per click",
        );
        assert.ok(
          offered.has(chart.href),
          `${seat}: chart "${chart.title}" links to ${chart.href}, which is not a row this seat ` +
            "is offered — it holds no grant that opens that page",
        );

        assert.ok(
          chart.series.length > 0,
          `${seat}/${chart.key}: no series — nothing would be drawn`,
        );

        for (const series of chart.series) {
          seriesChecked += 1;
          assert.match(
            series.color,
            /^#[0-9A-Fa-f]{6}$/,
            `${seat}/${chart.key}: series "${series.key}" colour ${series.color} is not a hex ` +
              "literal — it is handed to recharts as an SVG fill, and a Tailwind class renders black",
          );
          for (const row of chart.rows) {
            assert.equal(
              typeof row[series.key],
              "number",
              `${seat}/${chart.key}: row "${String(row.label)}" carries no numeric "${series.key}" ` +
                "— recharts plots a missing dataKey as an empty chart with no error at all",
            );
          }
        }

        for (const row of chart.rows) {
          assert.equal(
            typeof row.label,
            "string",
            `${seat}/${chart.key}: a row has no string label, so the x axis would be blank`,
          );
        }
      }
    }
  }

  // Controls. Both halves matter: the loop above passes vacuously on a page with no charts at all,
  // which is precisely the state the owner rejected on 2026-09-01 ("there are no any chart").
  assert.ok(
    chartsChecked >= 6,
    `only ${chartsChecked} charts were built across both seats — the catalogue returned almost ` +
      "nothing and every assertion above passed by reading an empty page",
  );
  assert.ok(
    seriesChecked >= 12,
    `only ${seriesChecked} series were checked — the row/series agreement assertion, which is the ` +
      "only thing standing between a typo and a silently empty plot, read almost nothing",
  );

  // ── The deduction axis can label every category ───────────────────────────────────────────────
  // `DEDUCTION_CATEGORY_LABELS` is typed as an exhaustive Record, and that type is NOT the guard:
  // this repo builds with `ignoreBuildErrors`, so a category added to `deductionsCategories`
  // without a label here would compile, build and deploy, and land on her page as an axis column
  // labelled `undefined`. AGENTS.md §2.1: back an exhaustive Record with a runtime assertion.
  for (const category of deductionsCategories) {
    const label = DEDUCTION_CATEGORY_LABELS[category];
    assert.ok(
      typeof label === "string" && label.length > 0,
      `deduction category "${category}" has no axis label in DEDUCTION_CATEGORY_LABELS — the ` +
        "deductions chart would print `undefined` under that column",
    );
  }
  assert.ok(
    deductionsCategories.length >= 5,
    `deductionsCategories holds only ${deductionsCategories.length} entries — the loop above is ` +
      "not checking a real vocabulary",
  );
}
