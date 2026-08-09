import assert from "node:assert/strict";

import { activeRosterOnly } from "../src/lib/employee-portal/home-snapshot.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

// Resigned people must not appear on the daily CRM compliance board.
//
// Real case, 2026-08-09: B-97 Nada Elsharkawy resigned on 2026-06-28 and B-179 Ashraf Radwan on
// 2026-08-09, and both were still listed under their District Manager (B-12) — permanently red,
// because a leaver can never submit a visit. The rosters come from the SALES services, which keep
// a leaver who booked sales in the period; that is right for sales and wrong for a "who started
// work today" board.

function row(over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    displayName: over.hrId,
    employmentStatus: "active",
    organogramVisible: true,
    jobTitle: "Medical Representative",
    ...over,
  } as EmployeeDirectoryRow;
}

export function runActiveRosterOnlyTests() {
  const directory = [
    row({ hrId: "B-12", displayName: "Dina Fadel", jobTitle: "District Sales Manager" }),
    row({ hrId: "B-50", displayName: "Active Rep" }),
    row({ hrId: "B-97", displayName: "Nada Elsharkawy", employmentStatus: "resigned", organogramVisible: false }),
    row({ hrId: "B-179", displayName: "Ashraf Radwan", employmentStatus: "resigned", organogramVisible: false }),
  ];

  const roster = [
    { hrId: "B-50", name: "Active Rep" },
    { hrId: "B-97", name: "Nada Elsharkawy" },
    { hrId: "B-179", name: "Ashraf Radwan" },
  ];

  // ── The rule ────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    activeRosterOnly(roster, directory).map((r) => r.hrId),
    ["B-50"],
    "a resigned rep must not appear on the daily board at all — red is not the right answer for a leaver",
  );

  // HR ids are matched hyphen-insensitively, the same way the display-name lookup beside it does.
  assert.deepEqual(
    activeRosterOnly([{ hrId: "b50" }, { hrId: "B-97" }], directory).map((r) => r.hrId),
    ["b50"],
    "matching must survive casing and hyphens, or an active rep silently vanishes",
  );

  // ── The guard that stops the fix becoming a worse bug ───────────────────────────
  {
    // Every call site fetches the directory with `.catch(() => [])`. Filtering against an empty
    // active-set would erase the roster, and this board renders an empty roster as "nobody
    // submitted today" — a confident lie told to a manager during a database blip.
    assert.deepEqual(
      activeRosterOnly(roster, []).map((r) => r.hrId),
      ["B-50", "B-97", "B-179"],
      "an unreadable directory must degrade to UNFILTERED, never to an empty board",
    );
  }

  // Does not mutate its input.
  const original = [...roster];
  activeRosterOnly(roster, directory);
  assert.deepEqual(roster, original);
}
