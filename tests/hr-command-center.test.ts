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
import { readFileSync } from "node:fs";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { HR_ROLE_BUNDLES, type HrBundleName } from "../src/lib/auth/hr-functions.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import {
  buildHrCommandGroups,
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
 * would pass by reading nothing. `clearance` and `retention` were missing from this object until
 * 2026-09-01, which is exactly that failure in miniature: the comment said "every source" while
 * six tiles — three clearance figures on HR Operations' board and three retention ones on HR
 * Advisory's — were never built and so never had their hrefs checked. Measured: the loop below
 * read 31 tiles before those two keys were added and 37 after. (A seventh, "No Clearance Opened",
 * is conditional on a non-empty `awaiting` and so is still unreached by an empty fixture.) Adding
 * a source to SOURCES_BY_FUNCTION means adding it here too, or its tiles ship unchecked. `deductions` needs the cast because its buckets are keyed by a
 * category union this test has no reason to enumerate; `Object.values({})` is `[]` either way.
 */
function emptySources(): HrCommandSources {
  return {
    attendanceExceptions: [],
    clearance: {
      awaiting: [],
      checklists: [],
      schemaReady: true,
      stations: [],
      stats: {
        amountOutstanding: 0,
        blockedStations: 0,
        cancelled: 0,
        open: 0,
        overdue: 0,
        ready: 0,
        released: 0,
      },
    },
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
    retention: {
      conversations: [],
      rollup: [],
      schemaReady: true,
      stats: {
        exitCount: 0,
        exitCoveragePercent: null,
        highRisk: 0,
        openFollowUps: 0,
        overdueFollowUps: 0,
        regrettableExits: 0,
        resignationsInWindow: 0,
        stayCount: 0,
        wouldRejoin: 0,
      },
      themes: [],
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

  // ── No tile prints a code where a name belongs ────────────────────────
  {
    // "Payroll Month" rendered `Number(monthKey.slice(5))`, so HR Operations' board carried a tile
    // reading **9** in the same 30px black type as a queue depth — nine what? It is September,
    // written as a code, on the one page in this product that is somebody's home screen. The
    // owner's standing rule is human-readable names, never raw codes or ids.
    //
    // BOTH halves are asserted, because either alone passes while the screen stays wrong: the
    // DATA must carry the name, and the COMPONENT must draw it. A `valueLabel` added to the tile
    // and never consumed renders exactly the 9 it was added to remove.
    const months = new Set([
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ]);

    const payroll = buildHrCommandGroups("HR Operations", emptySources())
      .flatMap((group) => group.tiles)
      .find((tile) => tile.key === "payroll-month");
    if (!payroll) throw new Error("HR Operations lost her Payroll Month tile entirely");

    assert.ok(
      payroll.valueLabel !== undefined && months.has(payroll.valueLabel),
      `the Payroll Month tile draws "${String(payroll.valueLabel)}" — it must carry the month's ` +
        "NAME, not its number, which is what `value` already holds",
    );
    assert.equal(
      Number.isFinite(payroll.value),
      true,
      "`value` stays the month number, so anything reading tiles numerically still works",
    );

    const component = readFileSync("src/components/hr/hr-command-center.tsx", "utf8");
    assert.match(
      component,
      /\{tile\.valueLabel \?\? tile\.value\.toLocaleString\("en-US"\)\}/,
      "MetricTile must PREFER valueLabel over the raw figure — a label the data carries and the " +
        "component ignores renders the exact code this pin exists to remove",
    );
  }
}
