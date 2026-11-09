import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { joinKpiRows, kpiBoardRoster, type KpiDirectoryEntry } from "../src/lib/crm/kpis-board.ts";
import type { RepCallRate } from "../src/lib/crm/call-rate.ts";
import { buildKpiManagerRows } from "../src/lib/crm/kpis-manager-rows.ts";

// OWNER, 2026-11-09 — "y are not pulling data of these reports from phoenix crm". Hany Saad's Coverage read
// "Showing 9 of 9 medical reps in your reach" while his Phoenix CRM seats held 13: the board was built only
// from the reps whose visit or plan rows came back, so three November hires with no row yet — and with them
// Sahar El Gallad's whole district — were absent from the rep rows AND the manager rows. Every rep in reach
// is now on the board, with nothing to measure until he works. Names below are invented.

const SCOPE = { kind: "agents", basis: "team", agentHrIds: ["PD-0001", "PD-0028", "PD-0012", "B-100", "PD-0032", "PD-0034"], label: "test" } as const;

const entry = (hrId: string, displayName: string, managerHrId: string | null, managerName: string | null, jobTitle: string, hireDate: string): KpiDirectoryEntry => ({
  hrId,
  displayName,
  lineName: "Pedia",
  regionName: null,
  areaName: null,
  managerName,
  managerHrId,
  jobTitle,
  hireDate,
});

const DIRECTORY: KpiDirectoryEntry[] = [
  entry("PD-0001", "Regional Lead", null, null, "Regional Sales Manager", "2019-01-01"),
  entry("PD-0012", "District One", "PD-0001", "Regional Lead", "District Sales Manager", "2020-01-01"),
  entry("PD-0028", "District Two", "PD-0001", "Regional Lead", "District Sales Manager", "2020-01-01"),
  entry("B-100", "Working Rep", "PD-0012", "District One", "Medical Representative", "2025-01-01"),
  entry("PD-0032", "New Rep A", "PD-0028", "District Two", "Medical Representative", "2026-11-01"),
  entry("PD-0034", "New Rep B", "PD-0028", "District Two", "Medical Representative", "2026-11-01"),
];

/** One rep with real work, as the call-rate report hands him over: by CRM id, hr id on the row. */
function workingRep(): RepCallRate {
  const lane = { verified: 10, total: 10, verifiedRate: 2, totalRate: 2, campaign: 0 };
  return {
    agentCrmId: 1397,
    agentHrId: "B-100",
    agentName: "Working Rep",
    workingDays: 5,
    am: { ...lane },
    pm: { ...lane, verified: 40, total: 40, verifiedRate: 8, totalRate: 8 },
    pharmacy: { verified: 0, total: 0, verifiedRate: 0, totalRate: 0 },
    unspecified: 0,
    campaignShare: 0,
    campaignOnlyDays: 0,
    awaitingValidation: 0,
  } as unknown as RepCallRate;
}

export function runKpisFullRosterTests() {
  const roster = kpiBoardRoster(
    [
      { hrId: "B-100", crmId: "1397", employmentStatus: "active", jobTitle: "Medical Representative", hireDate: "2025-01-01" },
      { hrId: "PD-0032", crmId: null, employmentStatus: "active", jobTitle: "Medical Representative", hireDate: "2026-11-01" },
      { hrId: "PD-0034", crmId: null, employmentStatus: "active", jobTitle: "Medical Representative", hireDate: "2026-11-01" },
      // Never on the roster: a manager, a leaver, a rep outside the scope, a rep hired after the window.
      { hrId: "PD-0028", crmId: null, employmentStatus: "active", jobTitle: "District Sales Manager", hireDate: "2020-01-01" },
      { hrId: "B-58", crmId: null, employmentStatus: "resigned", jobTitle: "Medical Representative", hireDate: "2024-01-01" },
      { hrId: "AI-0099", crmId: null, employmentStatus: "active", jobTitle: "Medical Representative", hireDate: "2024-01-01" },
      { hrId: "PD-0038", crmId: null, employmentStatus: "active", jobTitle: "Medical Representative", hireDate: "2026-12-08" },
    ],
    SCOPE,
    "2026-11-30",
  );
  assert.deepEqual(
    roster.map((rep) => rep.hrId),
    ["B-100", "PD-0032", "PD-0034"],
    "the roster is the active medical reps in scope, hired by the window's end",
  );
  assert.equal(roster[0].crmId, 1397, "a rep's CRM id travels with him");

  // ── 1. A rep with no row yet is on the board, with nothing to measure ───────────────────────────
  const rows = joinKpiRows({ callRates: [workingRep()], docLists: [], scope: SCOPE, workingDays: 5, directory: DIRECTORY, roster });
  assert.deepEqual(
    rows.map((row) => row.repName).sort(),
    ["New Rep A", "New Rep B", "Working Rep"],
    "the two November hires are on the board beside the rep who worked",
  );
  const newRep = rows.find((row) => row.repName === "New Rep A");
  assert.ok(newRep);
  assert.equal(newRep.totalCalls, 0, "no calls is printed as none, never invented");
  assert.equal(newRep.hasMeasurablePlan, false, "no plan is no plan, never 0% of one");
  assert.equal(newRep.hasCallRate, false);

  // ── 2. A rep already present is never added twice — by hr id or by CRM id ───────────────────────
  assert.equal(rows.filter((row) => row.repName === "Working Rep").length, 1, "the working rep is one row");
  const blankHrId = { ...workingRep(), agentHrId: null } as unknown as RepCallRate;
  const byCrm = joinKpiRows({ callRates: [blankHrId], docLists: [], scope: { kind: "company", basis: "company", label: "t" }, workingDays: 5, directory: DIRECTORY, roster });
  assert.equal(byCrm.filter((row) => row.agentCrmId === 1397 || row.agentHrId === "b-100" || row.repName === "Working Rep").length, 1, "an old-CRM row with a blank hr id still matches by CRM id");

  // ── 3. The roster never widens the scope ───────────────────────────────────────────────────────
  const narrow = joinKpiRows({
    callRates: [],
    docLists: [],
    scope: { kind: "agents", basis: "team", agentHrIds: ["PD-0032"], label: "t" },
    workingDays: 5,
    directory: DIRECTORY,
    roster: [{ hrId: "PD-0032", crmId: null }, { hrId: "PD-0034", crmId: null }],
  });
  assert.deepEqual(narrow.map((row) => row.repName), ["New Rep A"], "a roster rep outside the scope stays off");

  // ── 4. The district with only new hires has its manager row ────────────────────────────────────
  const managers = buildKpiManagerRows({ reps: rows, directory: DIRECTORY });
  const districtTwo = managers.find((row) => row.name === "District Two");
  assert.ok(districtTwo, "the district whose reps have not worked yet still has its manager row");
  assert.equal(districtTwo.repsBeneath, 2);

  // ── 5. The board passes the roster ─────────────────────────────────────────────────────────────
  const source = readFileSync(new URL("../src/lib/crm/kpis-board.ts", import.meta.url), "utf8");
  assert.ok(source.includes("roster: kpiBoardRoster(employees, scope, range.windowEnd)"), "getKpisBoard hands the join its roster");
}
