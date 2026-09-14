import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { CoverageFilterTree } from "@/lib/crm/coverage-filters";
import {
  lastHolderBySeat,
  resolveVacantAreaStatus,
  vacancyCascadeTree,
  type SeatOccupancyRow,
} from "@/lib/crm/reps-list-vacant-areas";

/**
 * Reps List — tab three, Vacant Areas (owner, 2026-09-14: "a third tab that is showing the doctors
 * list in vacant areas exactly as the other tab").
 *
 * WHY THIS IS PINNED. A vacant area's doctors are the open list of the rep who LAST held its seat.
 * Get "last" wrong and the screen names an earlier rep; show a RESEATED rep's list and a working
 * rep's doctors appear under an area he no longer covers; drop a vacancy with no list and the gap
 * reads as no gap. Each of those renders cleanly, so only a test catches it.
 */

const row = (overrides: Partial<SeatOccupancyRow>): SeatOccupancyRow => ({
  effective_from: null,
  effective_to: null,
  node_type: "person",
  occupant_canonical_hr_id: null,
  occupant_hr_id: null,
  seat_id: "SEAT-PED-REP-UE7",
  ...overrides,
});

export function runRepsListVacantAreasTests() {
  // ---------------------------------------------------------------------------------------------
  // 1. The LATEST rep, from any of the three records (owner, 2026-09-14: "you must get the latest
  //    rep on every vacant area") — never the first, never a placeholder, never a declined offer
  // ---------------------------------------------------------------------------------------------
  {
    const ue7 = { areaCode: "UE7", lineCode: "pedia", seatId: "SEAT-PED-REP-UE7" };
    const ue8 = { areaCode: "UE8", lineCode: "pedia", seatId: "SEAT-PED-REP-UE8" };
    const none = { coverage: [], people: new Map(), replacements: [] };

    const last = lastHolderBySeat({
      ...none,
      occupancy: [
        row({ effective_from: "2026-01-24", effective_to: "2026-08-31", occupant_hr_id: "B-25", occupant_canonical_hr_id: "b-25" }),
        row({ effective_from: "2025-01-04", effective_to: "2026-01-23", occupant_hr_id: "B-7", occupant_canonical_hr_id: "b-7" }),
        // The placeholder that makes the seat vacant names nobody and must not win on its later date.
        row({ effective_from: "2026-08-31", node_type: "vacant_placeholder" }),
        row({ effective_from: "2026-08-31", node_type: "vacant_placeholder", seat_id: "SEAT-PED-REP-UE8" }),
      ],
      vacancies: [ue7, ue8],
    });
    assert.equal(last.get("SEAT-PED-REP-UE7")?.hrId, "B-25", "the latest occupancy wins, whatever the row order");
    assert.equal(last.get("SEAT-PED-REP-UE7")?.heldUntil, "2026-08-31", "and carries the day they left");
    assert.equal(last.has("SEAT-PED-REP-UE8"), false, "a seat no record names has no last rep");

    const tie = lastHolderBySeat({
      ...none,
      occupancy: [
        row({ effective_from: "2026-08-04", effective_to: "2026-08-31", occupant_hr_id: "PD-1" }),
        row({ effective_from: "2026-08-04", effective_to: null, occupant_hr_id: "PD-2" }),
      ],
      vacancies: [ue7],
    });
    assert.equal(tie.get("SEAT-PED-REP-UE7")?.hrId, "PD-2", "an open span beats a dated one");

    // Gharbia 2 (Anti Infective), production 2026-09-14: the seat history's latest "occupant" declined
    // the offer and worked no day; the vacancy opened to replace her names her too.
    const d15 = { areaCode: "D15", lineCode: "anti_infective", seatId: "SEAT-AIF-REP-D15" };
    const declined = lastHolderBySeat({
      coverage: [],
      occupancy: [
        row({ effective_from: "2026-04-14", effective_to: "2026-08-09", occupant_hr_id: "B-179", seat_id: d15.seatId }),
        row({ effective_from: "2026-09-01", effective_to: "2026-09-01", occupant_hr_id: "AI-0019", seat_id: d15.seatId }),
      ],
      people: new Map([
        ["ai-0019", { employmentStatus: "declined_offer", lastWorkingDate: "2026-09-01" }],
        ["b-179", { employmentStatus: "resigned", lastWorkingDate: "2026-08-09" }],
      ]),
      replacements: [{ created_at: "2026-09-11T13:44:27Z", replacement_for_hr_id: "AI-0019", seat_id: d15.seatId }],
      vacancies: [d15],
    });
    assert.equal(
      declined.get(d15.seatId)?.hrId,
      "B-179",
      "somebody who declined the offer never worked the area — the rep before them is the last rep",
    );

    // Heliopolis (Anti Infective): the rep left 2026-05-25, before the seat history begins on
    // 2026-07-13, so only the HR vacancy opened to replace her names her.
    const ca1 = { areaCode: "CA1", lineCode: "anti_infective", seatId: "SEAT-AIF-REP-CA1" };
    const fromVacancy = lastHolderBySeat({
      coverage: [],
      occupancy: [row({ effective_from: "2026-07-13", node_type: "vacant_placeholder", seat_id: ca1.seatId })],
      people: new Map([["b-174", { employmentStatus: "resigned", lastWorkingDate: "2026-05-25" }]]),
      replacements: [{ created_at: "2026-07-18T00:47:51Z", replacement_for_hr_id: "B-174", seat_id: ca1.seatId }],
      vacancies: [ca1],
    });
    assert.equal(
      fromVacancy.get(ca1.seatId)?.hrId,
      "B-174",
      "a rep who left before the seat history began is found through the vacancy opened to replace them",
    );
    assert.equal(fromVacancy.get(ca1.seatId)?.heldUntil, "2026-05-25", "dated by their last working day, not the vacancy");

    // Beni Suef (Pedia): no seat of its own until 2026-09-01; from 2026-08-03 the Fayoum seat covered it.
    const ue9 = { areaCode: "UE9", lineCode: "pedia", seatId: "SEAT-PED-REP-UE9" };
    const coverage = [
      { area_code: "UE9", effective_from: "2026-08-03", effective_to: "2026-09-01", line_code: "pedia", rep_seat_id: "SEAT-PED-REP-GZ6" },
      { area_code: "UE9", effective_from: "2026-09-01", effective_to: null, line_code: "pedia", rep_seat_id: "SEAT-PED-REP-UE9" },
      // Another line's seat in the same area is somebody else's territory.
      { area_code: "UE9", effective_from: "2026-07-13", effective_to: null, line_code: "anti_infective", rep_seat_id: "SEAT-AIF-REP-GZ6" },
    ];
    const earlier = lastHolderBySeat({
      coverage,
      occupancy: [
        row({ effective_from: "2025-07-21", effective_to: "2026-08-09", occupant_hr_id: "B-52", seat_id: "SEAT-PED-REP-GZ6" }),
        // Left Fayoum before that seat ever covered Beni Suef.
        row({ effective_from: "2024-01-01", effective_to: "2025-07-20", occupant_hr_id: "B-8", seat_id: "SEAT-PED-REP-GZ6" }),
        row({ effective_from: "2026-01-01", effective_to: "2026-09-10", occupant_hr_id: "AI-7", seat_id: "SEAT-AIF-REP-GZ6" }),
      ],
      people: new Map(),
      replacements: [],
      vacancies: [ue9],
    });
    assert.equal(
      earlier.get(ue9.seatId)?.hrId,
      "B-52",
      "an area covered from another seat before it had its own takes that seat's rep — and only one who held it inside the window, on the same line",
    );
    assert.equal(earlier.get(ue9.seatId)?.source, "earlier_seat");
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The four states, reseated checked BEFORE the list
  // ---------------------------------------------------------------------------------------------
  {
    const last = { heldUntil: "2026-08-31", hrId: "B-25", key: "b-25", source: "seat" as const };
    const counts = { amCount: 8, pharmacyCount: 50, pmCount: 99 };
    assert.equal(resolveVacantAreaStatus(undefined, new Set(), counts), "never_held");
    assert.equal(
      resolveVacantAreaStatus(last, new Set(["b-25"]), counts),
      "holder_reseated",
      "a holder seated elsewhere keeps his list for the territory he works TODAY — it must not appear under the vacant area",
    );
    assert.equal(resolveVacantAreaStatus(last, new Set(), undefined), "list_closed");
    assert.equal(resolveVacantAreaStatus(last, new Set(), { amCount: 0, pharmacyCount: 0, pmCount: 0 }), "list_closed");
    assert.equal(resolveVacantAreaStatus(last, new Set(), counts), "list");
    assert.equal(
      resolveVacantAreaStatus(last, new Set(), { amCount: 0, pharmacyCount: 3, pmCount: 0 }),
      "list",
      "a pharmacy-only list is still a list",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 3. The cascade offers only where a vacancy is
  // ---------------------------------------------------------------------------------------------
  {
    const tree: CoverageFilterTree = {
      areas: [
        { code: "CA1", name: "Heliopolis" },
        { code: "UE7", name: "Qena 1" },
      ],
      cells: [{ areaCode: "CA1", lineCode: "cns", regionCode: "CA", seatId: "SEAT-CNS-REP-CA1" }],
      droppedRows: 0,
      lines: [
        { code: "cns", name: "CNS" },
        { code: "pedia", name: "Pedia" },
      ],
      regions: [
        { code: "CA", name: "Cairo" },
        { code: "UE-2", name: "Upper Egypt 2" },
      ],
      reps: [{ hrId: "B-1", repKey: "hr:b-1", repName: "A Rep", seatId: "SEAT-CNS-REP-CA1" }],
      vacancies: [
        {
          areaCode: "UE7",
          areaName: "Qena 1",
          lineCode: "pedia",
          lineName: "Pedia",
          regionCode: "UE-2",
          regionName: "Upper Egypt 2",
          seatId: "SEAT-PED-REP-UE7",
        },
      ],
    };
    const vacant = vacancyCascadeTree(tree);
    assert.deepEqual(vacant.cells.map((cell) => cell.seatId), ["SEAT-PED-REP-UE7"], "the cells ARE the vacancies");
    assert.deepEqual(vacant.lines.map((line) => line.code), ["pedia"], "a line with no vacancy is never offered");
    assert.deepEqual(vacant.regions.map((region) => region.code), ["UE-2"], "nor a region with none");
    assert.deepEqual(vacant.reps, [], "a vacant area has no rep to pick");
  }

  // ---------------------------------------------------------------------------------------------
  // 4. Both doors render the tab, under the Reps List scope, restricted first
  // ---------------------------------------------------------------------------------------------
  {
    for (const page of ["app/(admin)/admin/reps-list/page.tsx", "app/employee-portals/reps-list/page.tsx"]) {
      const source = readFileSync(page, "utf8");
      assert.ok(source.includes("await getVacantAreasBoard({"), `${page} must CALL the vacant-areas board`);
      assert.ok(source.includes("<RepsListVacantAreasView"), `${page} must render it`);
      const branch = source.slice(source.indexOf('if (tab === "vacant")'), source.indexOf('if (tab === "plans")'));
      assert.ok(
        branch.includes("getDoctorListScope(access)") && !branch.includes("getPlanVerificationScope"),
        `${page} must read vacant areas under the Reps List scope — they are the same lists the contact tab reads`,
      );
    }

    const lib = readFileSync("src/lib/crm/reps-list-vacant-areas.ts", "utf8");
    assert.ok(
      lib.includes("restrictCoverageFilterTree(companyTree, allowedHrIdsFor(input.scope))"),
      "the vacancy tree is restricted to the viewer BEFORE any option is derived — a picker is never wider than its viewer",
    );
    assert.ok(
      lib.includes('.from("position_vacancies")') && lib.includes('.from("au_v_line_area_map_all")') && lib.includes("await loadLastHolders(inView)"),
      "the board reads all three records of who last worked a seat — the seat history alone names nobody for a rep who left before 2026-07-13",
    );
    assert.ok(
      /if \(input\.scope\.kind === "none"\)/.test(lib),
      "a seat with no reach returns an explained empty board, never an unscoped one",
    );

    const view = readFileSync("src/components/crm/reps-list-vacant-areas.tsx", "utf8");
    assert.ok(
      view.includes("activityUnavailableNote={`Nobody works ${selected.areaName} now"),
      "a vacant area's missing activity is explained as the departed-rep rule — never as a failed read, which it is not",
    );

    const tabs = readFileSync("src/components/crm/reps-list-tabs.tsx", "utf8");
    assert.ok(tabs.includes('tabs.push({ key: "vacant", label: "Vacant areas" });'), "the strip offers the third tab");
  }
}
