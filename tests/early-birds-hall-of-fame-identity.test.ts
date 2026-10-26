/**
 * The Early Birds Hall of Fame: area, name and win count (owner audit, 2026-10-26).
 *
 * Production had 90 of 125 winner rows with no area (the slot printed "—"), and one rep stored under
 * two or three spellings. Driven against the in-memory Supabase fake, never the real tables — this
 * suite runs with PRODUCTION credentials.
 */
import assert from "node:assert/strict";

import type { EmployeeNameLookupClient } from "@/lib/employees/names-by-hr-id";
import { completeWinnerIdentities as completeWith, type WinnerAreaLoader } from "@/lib/early-birds/winner-identity";
import { countWinsByHrIdKey, listMostStars } from "@/lib/early-birds/win-counts";
import { formatDistrictCountChip, formatShownScopeLabel } from "@/components/early-birds/early-birds-format";

import { fakeSupabaseClient } from "./fixtures/fake-supabase-table";

type Winner = { employeeHrId: string; employeeName: string; areaName: string | null };

const employees = [
  { hr_id: "B-177", full_name: "Mostafa Saied Basiouny Hamd", nickname: null, area_id: "a-alex" },
  { hr_id: "B-158", full_name: "Hassan Mohamed Raffat Mohamed Elsherbiny", nickname: null, area_id: "a-giza" },
  // A rep who has since left is still in `employees`; the area follows the row, not the status.
  { hr_id: "B-90", full_name: "SAHAR EL GALLAD", nickname: null, area_id: "a-giza" },
  { hr_id: "B-91", full_name: "Rep Without Area", nickname: null, area_id: null },
];
const areas = [
  { id: "a-alex", name: "Alex Center" },
  { id: "a-giza", name: "Giza" },
];

function db(options: { failOn?: Record<string, string> } = {}) {
  return fakeSupabaseClient({ employees }, options) as unknown as EmployeeNameLookupClient;
}

// The area names come from the shared reference list; the suite hands it a fixed one (and a broken one).
const areaLoader: WinnerAreaLoader = async () => areas;
const brokenAreaLoader: WinnerAreaLoader = async () => {
  throw new Error("connection reset");
};

function completeWinnerIdentities<T extends Winner>(
  winners: readonly T[],
  client: EmployeeNameLookupClient,
  loader: WinnerAreaLoader = areaLoader,
) {
  return completeWith(winners, client, loader);
}

export async function runEarlyBirdsHallOfFameIdentityTests() {
  // ── An EMPTY stored area falls back to the employee's live area ──────────────────────────────
  {
    const [empty, blank, kept, none] = await completeWinnerIdentities<Winner>(
      [
        { employeeHrId: "B-177", employeeName: "Mostafa Saied", areaName: null },
        { employeeHrId: "B-158", employeeName: "Hassan Elsherbiny", areaName: "   " },
        // A frozen record stays frozen: a stored area is never overwritten by today's.
        { employeeHrId: "B-177", employeeName: "Mostafa Saied", areaName: "Cairo East" },
        { employeeHrId: "B-91", employeeName: "Rep Without Area", areaName: null },
      ],
      db(),
    );
    assert.equal(empty.areaName, "Alex Center", "a null area reads the employee's live area");
    assert.equal(blank.areaName, "Giza", "a whitespace-only area counts as empty");
    assert.equal(kept.areaName, "Cairo East", "a stored area wins over the live one");
    assert.equal(none.areaName, null, "no area anywhere stays null (the page prints a dash), never a guess");
  }

  // ── The hr id is matched whatever its spelling, and a departed rep still resolves ────────────
  {
    const [lower] = await completeWinnerIdentities<Winner>(
      [{ employeeHrId: "b-177", employeeName: "Mostafa Saied", areaName: null }],
      db(),
    );
    assert.equal(lower.areaName, "Alex Center", "a lower-cased stored hr id still finds the employee");
  }

  // ── One rep, two spellings → the employee's current name on every row ────────────────────────
  {
    const rows = await completeWinnerIdentities<Winner>(
      [
        { employeeHrId: "B-177", employeeName: "Mostafa Saied", areaName: null },
        { employeeHrId: "B-177", employeeName: "Mostafa Saied Basiouny Hamd", areaName: null },
      ],
      db(),
    );
    assert.deepEqual(
      rows.map((row) => row.employeeName),
      ["Mostafa Saied Basiouny Hamd", "Mostafa Saied Basiouny Hamd"],
    );
  }

  // ── An all-capitals name is re-cased by the repo's own helper, on the live name and the stored one ──
  {
    const [live, stored] = await completeWinnerIdentities<Winner>(
      [
        { employeeHrId: "B-90", employeeName: "SAHAR EL GALLAD", areaName: "Giza" },
        { employeeHrId: "NOT-IN-TABLE", employeeName: "AHMED ALI", areaName: null },
      ],
      db(),
    );
    assert.equal(live.employeeName, "Sahar El Gallad");
    assert.equal(stored.employeeName, "Ahmed Ali", "no employee row: the stored name is tidied, not invented");
  }

  // ── A failed read costs the fallback and nothing else; the page never throws ──────────────────
  {
    const noAreas = await completeWinnerIdentities<Winner>(
      [{ employeeHrId: "B-177", employeeName: "Mostafa Saied", areaName: null }],
      db(),
      brokenAreaLoader,
    );
    assert.equal(noAreas[0].areaName, null);
    assert.equal(noAreas[0].employeeName, "Mostafa Saied Basiouny Hamd", "names still resolve when only areas fail");

    const noEmployees = await completeWinnerIdentities<Winner>(
      [{ employeeHrId: "B-177", employeeName: "Mostafa Saied", areaName: "Alex Center" }],
      db({ failOn: { employees: "connection reset" } }),
    );
    assert.deepEqual(noEmployees[0], { employeeHrId: "B-177", employeeName: "Mostafa Saied", areaName: "Alex Center" });
  }

  // ── THE WIN COUNT IS KEYED ON THE HR ID, NEVER THE NAME ───────────────────────────────────────
  {
    const winners = [
      { employeeHrId: "B-177", employeeName: "Mostafa Saied" },
      { employeeHrId: "B-177", employeeName: "Mostafa Saied" },
      { employeeHrId: "b-177", employeeName: "Mostafa Saied Basiouny Hamd" },
      // Same printed name, a different person: must NOT be added to the count above.
      { employeeHrId: "B-300", employeeName: "Mostafa Saied" },
    ];
    const counts = countWinsByHrIdKey(winners);
    assert.equal(counts.get("b177"), 3, "three spellings of the name, one hr id, three wins");
    assert.equal(counts.get("b300"), 1, "a namesake is a different rep");

    const stars = listMostStars(winners);
    assert.equal(stars.length, 1, "one entry per rep, not per spelling");
    assert.equal(stars[0].wins, 3);
    assert.equal(stars[0].key, "b177");
  }

  // ── The scope words name the district on screen, and say "your line" only for the whole line ──
  {
    assert.equal(
      formatShownScopeLabel({ scopeLabel: "your line", districtCount: 6, districtName: "Mohamed Eleiwa" }),
      "Mohamed Eleiwa's district",
    );
    assert.equal(
      formatShownScopeLabel({ scopeLabel: "your line", districtCount: 6, districtName: "Vacant — Alex Center" }),
      "the vacant Alex Center district",
    );
    assert.equal(
      formatShownScopeLabel({ scopeLabel: "your line", districtCount: 6, districtName: "Vacant district" }),
      "the vacant district",
    );
    assert.equal(
      formatShownScopeLabel({ scopeLabel: "your team", districtCount: 1, districtName: "Mohamed Eleiwa" }),
      "your team",
      "one district IS the whole scope",
    );
    assert.equal(formatDistrictCountChip("your line", 6), "One of 6 districts in your line");
  }
}
