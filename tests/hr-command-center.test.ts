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
import { deductionsCategories } from "../src/lib/deductions/types.ts";
import { candidateStatuses } from "../src/lib/recruitment/candidate-status.ts";
import {
  buildHrCommandGroups,
  DEDUCTION_CATEGORY_LABELS,
  CANDIDATE_FUNNEL_BARS,
  CANDIDATE_FUNNEL_FINISHED,
  buildRecruitingCharts,
  buildRecruitingTiles,
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
 * Dashboard destinations that are NOT rail rows — tile hrefs and chart hrefs alike, each named
 * with the verdict that makes it safe.
 *
 * "Is it a row?" was this file's proxy for "can the seat open it?", and until 2026-09-05 the two
 * were the same question. That day the owner ruled that no rail row may open a page of modules —
 * "I don't want any subtitle to be the one that when I press, it redirects me to a page with big
 * modules" — so every hub row was replaced by its cards. The hub PAGES were not touched: they
 * still serve, and both seats still pass their gates. The proxy broke; the property did not.
 *
 * So the two hubs the dashboard still points at are listed here rather than the check being
 * loosened to "any /hr href". Each entry carries the gate verdict, obtained by CALLING the gate for
 * the seat rather than by reading it, and the number of cards the hub renders for her — because a
 * link to a hub that lists nothing is worse than no link, and that is the failure this cannot see.
 * The assertion below requires this map to match the exempted set EXACTLY, so an entry that stops
 * being used fails loudly instead of sitting here as a standing licence.
 *
 * A tile is better off pointing at the page that holds its own figure, and two of the three payroll
 * ones now could — /hr/admin/deductions became hers on 2026-09-03. That is a change to her
 * dashboard rather than to this sidebar work, so the destinations are left as they are and the
 * stale reason recorded beside them in src/lib/hr/command-center.ts has been corrected instead.
 */
const DASHBOARD_DESTINATIONS_THAT_ARE_NOT_ROWS: Record<string, string> = {
  "/hr/admin/payroll-management":
    "any-of payroll:read || payslips:read || deductions:read — HR Operations, the only seat with " +
    "payroll_inputs, holds all three; measured 2026-09-05, the hub renders 3 cards for her " +
    "(Payroll Report, Payslips Center, Deductions), so it is a real module page and not an " +
    "empty one",
  "/hr/attendance":
    "no permission gate at all — the page redirects only when resolveNavigationMode(access) is " +
    '"employee-portal", and it resolves to "admin" for BOTH seats (called, not assumed). Measured ' +
    "2026-09-05, the hub renders 7 cards for HR Operations and 4 for HR Advisory. It stays the " +
    "destination because the queue those three tiles count — /attendance/exceptions — is gated on " +
    "canAccessSystemAdministratorWorkspace and is not hers to open, so there is no page holding " +
    "the figure to send her to; the chart beside them says \"Open Attendance\" for the same reason",
};

/**
 * Every source present and empty. The point is to exercise each builder's full path — a builder
 * that returns early on a missing source would otherwise emit none of its hrefs and the loop below
 * would pass by reading nothing. `clearance` and `retention` were missing from this object until
 * 2026-09-01, which is exactly that failure in miniature: the comment said "every source" while
 * six tiles — three clearance figures on HR Operations' board and three retention ones on HR
 * Advisory's — were never built and so never had their hrefs checked. Measured: the loop below
 * read 31 tiles before those two keys were added and 37 after.
 *
 * `clearance` is gone again, and for a different reason: the module was removed later the same
 * day, so the key no longer exists on HrCommandSources at all. Its absence here is now enforced by
 * the compiler rather than by this comment. Adding a source to SOURCES_BY_FUNCTION still means
 * adding it here too, or its tiles ship unchecked — that half is unchanged, and it is the half
 * nothing enforces.
 *
 * `deductions` needs the cast because its buckets are keyed by a category union this test has no
 * reason to enumerate; `Object.values({})` is `[]` either way.
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
        candidatePool: { backup: 0, hired: 0, new: 0, rejected: 0, sent_to_manager: 0, shortlisted: 0 },
        hiredWindow: { fromIso: "2026-09-01", toIso: "2026-09-30" },
        hires: 0,
        hiresInWindow: 0,
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
    hrOpsReports: {
      reports: [],
      summary: { inReview: 0, rowsToAnswer: 0, rowsToDecide: 0, submitted: 0 },
    },
  };
}

/**
 * Functions that contribute no tiles on purpose. Written down rather than inferred, so dropping a
 * group by accident fails instead of quietly shrinking somebody's dashboard.
 */
// `hr_communication` added 2026-09-11 with the function itself. Reason: it is a CAPABILITY, not a
// data source - it grants composing and sending HR mail by hand, plus the templates behind it. A
// send path has no backlog to report and no population to plot, so there is no honest figure for a
// tile to carry. The alternative, a tile counting mail sent, would be exactly the ambitious-but-
// empty dashboard this page was built to avoid: a number nobody acts on, linking to a screen that
// is already one click away on her rail.
// `cv_lookup` added 2026-09-30 with the function itself. Reason: it is the one entry here whose
// blankness is a PRIVACY decision rather than "there is nothing to count". The owner granted this
// seat a search box over the CV database precisely so that she does NOT have the pool — "i dont want
// her to have access to all cvs" — and every figure a tile could carry (CVs on file, new this week,
// awaiting screening) is a fact about the pool. It would print the size and shape of the withheld
// thing on her landing page before she had searched for anybody. SOURCES_BY_FUNCTION.cv_lookup is
// empty for the same reason, so there is nothing loaded to build a tile from even by accident.
// `hiring_paperwork` and `workforce_context` added 2026-10-08 with the Talent Acquisition seat.
// hiring_paperwork is two GRANTS lifted out of recruiting (employee documents and account
// activation) so that seat could hold recruiting without the contracts and salary letters; it moved
// no data source, so the tiles recruiting already drew stay with recruiting and this function has
// nothing of its own to count. workforce_context is read-only REFERENCE for that seat — organogram,
// calendars, Early Birds, probation outcomes — every one of them a sidebar row whose figures belong
// to the function that owns the work; a tile here would only repeat another group’s number.
// `recognition` (same seat, same day): Spotlight and Milestones are sheets she prints, not a queue.
const FUNCTIONS_WITH_NO_TILES = new Set([
  "hr_governance",
  "hr_communication",
  "cv_lookup",
  "hiring_paperwork",
  "workforce_context",
  "recognition",
  // HR Reminders is the team's own notes page, not a queue this dashboard counts.
  "team_reminders",
  // NOT the HR Operations Specialist seat's two functions any more: since 2026-10-20 attendance_review
  // counts her Daily & Weekly Reports queue and people_master mirrors people_records' tiles with
  // every link on a page her seat opens.
]);


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
  const resourcingSources = sourcesFor("HR Resourcing");
  const operationsSources = sourcesFor("HR Operations");
  assert.ok(
    !resourcingSources.includes("deductions"),
    `the Talent Acquisition seat's dashboard loads the deductions month (sources: ${resourcingSources.join(", ")}) — ` +
      "she holds no deductions grant, and reading it on her behalf crosses a job-description boundary",
  );
  for (const source of ["recruitment", "offers", "supportRequests"] as const) {
    assert.ok(
      !operationsSources.includes(source),
      `HR Operations' dashboard loads "${source}", which only the Talent Acquisition seat's functions ask for`,
    );
  }
  // A control: without it, a sourcesFor that returned [] would satisfy both assertions above.
  assert.ok(
    resourcingSources.length >= 4 && operationsSources.length >= 4,
    `sourcesFor returned almost nothing (Talent Acquisition ${resourcingSources.length}, Operations ` +
      `${operationsSources.length}) — the checks above passed by loading nothing, not by scope`,
  );

  // ── Every tile leads somewhere the seat can actually go ───────────────────────────────────────
  const failures: string[] = [];
  const exemptionsUsed = new Set<string>();
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

        // The PAGE a tile opens. A query only filters the page its row opens — the recruitment
        // tiles land on that seat's own workspace pre-filtered ("?status=new", 2026-10-20) — so it
        // never makes a destination the seat cannot reach.
        const page = tile.href.split(/[?#]/)[0]!;
        if (!offered.has(page)) {
          if (page in DASHBOARD_DESTINATIONS_THAT_ARE_NOT_ROWS) {
            exemptionsUsed.add(page);
          } else {
            failures.push(
              `${seat}: tile "${tile.label}" (${group.functionKey}) links to ${tile.href}, which is ` +
                "not a row this seat is offered and is not a recorded module page — either it holds " +
                "no grant that opens that page, or the destination is a hub whose verdict belongs in " +
                "DASHBOARD_DESTINATIONS_THAT_ARE_NOT_ROWS",
            );
          }
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
  // The negative control, which has to be a row the offered set REALLY rejects — an `offered`
  // containing everything would pass the loop above blind.
  //
  // It used to be /hr/admin/deductions, removed in #2554 because the page admitted {Super Admin,
  // CEO} by name. That subject expired on 2026-09-03: the owner said "yes give HR access to the
  // deductions screen", the page now names HR Operations, and the row is back — so the old
  // assertion would have been a control that passes because its claim is stale, which is worse
  // than no control at all.
  //
  // /hr/offers replaces it, and it is a stronger control because it discriminates in BOTH
  // directions on the SAME href: offers:read is a recruiting grant, so the recruiting seat is offered
  // the row and HR Operations is not. That seat is the Talent Acquisition seat since "move recruiting off the HR Business Partner" (owner, 2026-10-08). A one-sided check cannot tell "correctly rejected" from
  // "rejects everything"; this one can.
  assert.ok(
    !offeredHrefs("HR Operations").has("/hr/offers"),
    "/hr/offers is offered to HR Operations — she holds no offers grant, so if this set now " +
      "admits it, the offered-set check has stopped discriminating and every tile assertion " +
      "above is blind",
  );
  assert.ok(
    offeredHrefs("HR Resourcing").has("/hr/offers"),
    "/hr/offers is NOT offered to the Talent Acquisition seat — offers is hers, so this set is now rejecting " +
      "everything and the control above passes for the wrong reason",
  );

  // The row that replaced it as a subject, pinned as a fact rather than left implied. Both
  // directions again: the seat that was granted the screen on 2026-09-03 is offered it, and the
  // seat that was deliberately not granted it is not. That was the HR Business Partner until her
  // seat was retired on 2026-10-08; the Talent Acquisition seat holds no deductions grant either —
  // the owner did not tick payroll for her.
  assert.ok(
    offeredHrefs("HR Operations").has("/hr/admin/deductions"),
    "/hr/admin/deductions is no longer offered to HR Operations — the owner granted her that " +
      "screen on 2026-09-03 and the deductions-comment mail links to it, so losing the row " +
      "restores the offered-but-closed shape this file exists to catch",
  );
  assert.ok(
    !offeredHrefs("HR Resourcing").has("/hr/admin/deductions"),
    "/hr/admin/deductions is offered to the Talent Acquisition seat — she holds no deductions grant; " +
      "a row here would be a dead link and a claim she can read payroll",
  );

  // ── Every chart plots what it says it plots ───────────────────────────────────────────────────
  // A chart fails differently from a tile. A tile with a wrong key renders `undefined` and is
  // obvious; a chart whose series key is absent from its rows renders a clean, empty, entirely
  // plausible plot — recharts does not complain about a dataKey that matches nothing. So the
  // series/row agreement is asserted here rather than left to be noticed on the page.
  let chartsChecked = 0;
  let seriesChecked = 0;
  const chartsPerSeat = new Map<HrBundleName, number>();

  for (const seat of seats) {
    const offered = offeredHrefs(seat);
    const chartKeys = new Set<string>();

    for (const group of buildHrCommandGroups(seat, emptySources())) {
      for (const chart of group.charts) {
        chartsChecked += 1;
        chartsPerSeat.set(seat, (chartsPerSeat.get(seat) ?? 0) + 1);

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
        // Same rule as the tiles, and the same exemption map — a chart's "Open X" affordance is
        // the module's front door, so this is where the two hub destinations legitimately land.
        if (chart.href in DASHBOARD_DESTINATIONS_THAT_ARE_NOT_ROWS) {
          exemptionsUsed.add(chart.href);
        } else {
          assert.ok(
            offered.has(chart.href),
            `${seat}: chart "${chart.title}" links to ${chart.href}, which is not a row this seat ` +
              "is offered and is not a recorded module page — either it holds no grant that opens " +
              "that page, or the destination is a hub whose verdict belongs in " +
              "DASHBOARD_DESTINATIONS_THAT_ARE_NOT_ROWS",
          );
        }

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
    chartsChecked >= 8,
    `only ${chartsChecked} charts were built across both seats — the catalogue returned almost ` +
      "nothing and every assertion above passed by reading an empty page",
  );
  // 15 until the owner retired the HR Business Partner seat on 2026-10-08: its probation and directory charts went with it, and
  // the two live seats measured 14 series the same evening.
  assert.ok(
    seriesChecked >= 12,
    `only ${seriesChecked} series were checked — the row/series agreement assertion, which is the ` +
      "only thing standing between a typo and a silently empty plot, read almost nothing",
  );

  // The exemption map may not outlive its subject. An entry nobody points at is a standing licence
  // for a destination that no longer exists, and the next tile or chart aimed there would be waved
  // through by it; an href exempted for a seat that has since been given the row is the same thing
  // read the other way. Both are caught by requiring the map to be exactly what the two loops above
  // consumed between them — which is why this sits after the charts rather than after the tiles.
  assert.deepEqual(
    Object.keys(DASHBOARD_DESTINATIONS_THAT_ARE_NOT_ROWS).sort(),
    [...exemptionsUsed].sort(),
    "DASHBOARD_DESTINATIONS_THAT_ARE_NOT_ROWS no longer matches the destinations the dashboard actually " +
      "uses — add the new one with its gate verdict, or drop the entry that is now a rail row",
  );

  // The control that a company-wide total cannot give. Until 2026-09-01 the two seats read 5 and
  // 1: four of the eight functions returned no chart, and the four HR Advisory holds contributed
  // between them exactly one. The totals above were GREEN throughout — six charts across both
  // seats is six charts — so the owner's complaint ("there are no any chart") was true of one
  // account while the only assertion guarding it passed. A per-seat floor is the assertion that
  // can tell those two states apart, which is why it is here rather than a larger global number.
  //
  // HR Advisory's floor was lowered to two when recruiting left her seat, and the seat itself was
  // retired the same evening (2026-10-08) — so every live seat is back on one floor.
  for (const seat of seats) {
    const built = chartsPerSeat.get(seat) ?? 0;
    const floor = 3;
    assert.ok(
      built >= floor,
      `${seat} is shown ${built} chart(s). Every seat gets a shape for its own work, not just ` +
        "the seat whose functions happened to be built first — see CHARTS_BY_FUNCTION for the " +
        "two functions that legitimately return none, and why neither is a gap",
    );
  }

  // ── The recruiting funnel can see every candidate pile there is ──────────────────────────────
  // The funnel counts the CANDIDATE POOL (owner, 2026-10-14: "extremely wrong data" — it used to plot
  // the 30 live applications while the pool held 898 live candidates). `CANDIDATE_FUNNEL_BARS` is typed
  // against `CandidateStatus`, and that type is NOT the guard: this repo builds with
  // `ignoreBuildErrors`, so a status added to `candidateStatuses` and put on no bar compiles, builds and
  // DEPLOYS with its candidates invisible on the chart and the columns still adding up to a plausible
  // number. So the vocabulary is asserted at runtime.
  const barStatuses = CANDIDATE_FUNNEL_BARS.map((bar) => bar.status as string);
  const barsSeenTwice = barStatuses.filter((status, index) => barStatuses.indexOf(status) !== index);
  assert.deepEqual(
    barsSeenTwice,
    [],
    `recruiting funnel: ${barsSeenTwice.join(", ")} is on more than one bar, so those candidates are counted twice and the bars sum above the Active Candidates tile`,
  );
  const finished = CANDIDATE_FUNNEL_FINISHED as readonly string[];
  const unplaced = candidateStatuses.filter((status) => !barStatuses.includes(status) && !finished.includes(status));
  assert.deepEqual(
    unplaced,
    [],
    `recruiting funnel: ${unplaced.join(", ")} is neither a bar nor a finished pile, so a live candidate there is INVISIBLE on the chart — no error, just a smaller number`,
  );
  assert.deepEqual(
    barStatuses.filter((status) => finished.includes(status)),
    [],
    "recruiting funnel: a finished pile (rejected, hired) is on a bar, so the chart would count history as workload",
  );
  for (const bar of CANDIDATE_FUNNEL_BARS) {
    assert.ok(bar.label.length > 0, `recruiting funnel: the bar for ${bar.status} has no label`);
  }

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

  // ── The Hired tile counts the EMPLOYEE MASTER, and is ABSENT rather than wrong without it ─────
  //
  // Owner, 2026-10-14 ("extremely wrong data"): the tile used to count applications that reached the
  // hired stage. That half of the ATS is nearly unused, so it read 0 for October while 20 people had
  // been hired. The window is a past October so the answer cannot move with today's date.
  {
    const base = emptySources();
    const october = { fromIso: "2020-10-01", toIso: "2020-10-31" };
    const people = [
      { employmentStatus: "active", hireDate: "2020-10-01" },
      { employmentStatus: "active", hireDate: "2020-10-31" },
      { employmentStatus: "declined_offer", hireDate: "2020-10-05" },
      { employmentStatus: "active", hireDate: "2020-09-30" },
    ];
    const withPeople = {
      ...base,
      directory: { ...base.directory, employees: people },
      recruitment: {
        ...base.recruitment,
        summary: { ...base.recruitment?.summary, hiredWindow: october, hires: 0, hiresInWindow: 0 },
      },
    } as unknown as HrCommandSources;
    const hiredTile = buildHrCommandGroups("HR Resourcing", withPeople)
      .flatMap((group) => group.tiles)
      .find((tile) => tile.key === "hired");
    assert.ok(hiredTile, "the recruiting group must still draw a Hired tile");
    assert.equal(
      hiredTile.value,
      2,
      "RED the tile must read two — the pipeline says 0, the Master has two October hires; the declined offer and the September hire are not October's",
    );
    assert.equal(hiredTile.sub, "hired in October", "the caption names the window; nobody is still to start in a past month");

    const withoutDirectory = { ...withPeople, directory: undefined } as unknown as HrCommandSources;
    const absent = buildHrCommandGroups("HR Resourcing", withoutDirectory)
      .flatMap((group) => group.tiles)
      .find((tile) => tile.key === "hired");
    assert.equal(
      absent,
      undefined,
      "RED an unreadable directory drops the tile — it is never drawn as 0 hired, and never replaced by the pipeline's figure",
    );
  }

  // ── The candidate tiles and the funnel count the CANDIDATE POOL, and agree with each other ──────
  //
  // Owner, 2026-10-14 ("extremely wrong data"): "Active Candidates" read the 30 live applications while
  // the pool held 898 live candidates. The fixture gives the applications a number that would be wrong
  // everywhere (3) so reading them again fails loudly.
  {
    const base = emptySources();
    const pooled = {
      ...base,
      directory: {
        ...base.directory,
        employees: [
          { employmentStatus: "active", hireDate: "2999-01-01" },
          { employmentStatus: "declined_offer", hireDate: "2999-01-02" },
          { employmentStatus: "active", hireDate: "2020-01-01" },
        ],
      },
      recruitment: {
        ...base.recruitment,
        summary: {
          ...base.recruitment?.summary,
          activeApplications: 3,
          candidatePool: { backup: 2, hired: 40, new: 700, rejected: 500, sent_to_manager: 30, shortlisted: 100 },
          stageCounts: { hr_interview: 3 },
        },
      },
    } as unknown as HrCommandSources;

    const tiles = buildRecruitingTiles(pooled) ?? [];
    const tileValue = (key: string) => tiles.find((tile) => tile.key === key)?.value;
    assert.equal(tileValue("active-candidates"), 832, "RED Active Candidates is new + shortlisted + backup + with a manager (700 + 100 + 2 + 30), never the 3 live applications");
    assert.equal(tileValue("awaiting-review"), 700, "Awaiting Review is the undecided pile of the pool");
    assert.equal(tileValue("with-managers"), 30, "With Hiring Managers is the sent-to-manager pile of the pool");

    const funnel = buildRecruitingCharts(pooled).find((chart) => chart.key === "recruiting-pipeline");
    assert.ok(funnel, "the recruiting funnel must still be drawn");
    const counts = funnel.rows.map((row) => Number((row as Record<string, unknown>).candidates));
    assert.deepEqual(
      funnel.rows.map((row) => (row as Record<string, unknown>).label),
      ["Awaiting review", "Shortlisted", "Backup", "With a manager", "Hired, not started"],
      "the title the owner likes stays, over one bar per pile and the hand-off bar",
    );
    assert.deepEqual(
      counts,
      [700, 100, 2, 30, 1],
      "RED bars read the pool; the one person hired for a future day counts, the declined offer and the long-ago hire do not",
    );
    assert.equal(
      counts.slice(0, 4).reduce((total, count) => total + count, 0),
      tileValue("active-candidates"),
      "the first four bars add up to the Active Candidates tile beside the chart",
    );

    const noDirectory = buildRecruitingCharts({ ...pooled, directory: undefined } as unknown as HrCommandSources).find(
      (chart) => chart.key === "recruiting-pipeline",
    );
    assert.equal(noDirectory?.rows.length, 4, "RED without the directory the hand-off bar is ABSENT, never drawn as 0 not started");
  }
}
