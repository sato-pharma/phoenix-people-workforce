import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { buildOrgIndex, managerChain, seatOccupants, seatPeople, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { factsForWindow, type RankRawData } from "../src/lib/rep-ranks/rank-facts.ts";

/**
 * A handover seat has TWO occupants, and the org index keeps both (2026-10-26).
 *
 * `au_v_org_tree` returns one row per occupant. `buildOrgIndex` used to `byId.set(seatId, …)` and so kept
 * only the LAST row: on SEAT-PED-REP-GZ4 (Pedia · Haram - Faisal) Hana Abdelaziz (serving notice, last day
 * 2026-10-31, 148 countable visits 10–25 Oct) vanished behind Aya Mamdouh (hired 2026-10-24). Aya showed
 * "no field work" on the Ranks board and Hana had no row for October.
 *
 * `territories` stays ONE entry per seat (plans, parents, managers read the seat); `territoryHolders` is
 * one per seat × person, and is what anything that counts or scores PEOPLE reads.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const ROOT_SEAT: OrgSeat = {
  seatId: "SEAT-ROOT-CEO",
  parentSeatId: null,
  tier: "CEO",
  path: ["SEAT-ROOT-CEO"],
  occupantHrId: "C-1",
  lineCode: null,
  lineName: null,
  areaName: null,
  regionName: null,
  seatLabel: "CEO",
};
const DM: OrgSeat = {
  ...ROOT_SEAT,
  seatId: "SEAT-PED-DM-GZ",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-PED-DM-GZ"],
  occupantHrId: "B-60",
  lineCode: "pedia",
  lineName: "Pedia",
  seatLabel: "Pedia Giza district",
};
const HANA: OrgSeat = {
  ...DM,
  seatId: "SEAT-PED-REP-GZ4",
  parentSeatId: "SEAT-PED-DM-GZ",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-PED-DM-GZ", "SEAT-PED-REP-GZ4"],
  occupantHrId: "B-110",
  areaName: "Haram - Faisal",
  seatLabel: "Haram - Faisal",
};
const AYA: OrgSeat = { ...HANA, occupantHrId: "PD-0029" };
/** A seat with one occupant, beside the shared one. */
const SOLO: OrgSeat = { ...HANA, seatId: "SEAT-PED-REP-GZ5", path: ["SEAT-ROOT-CEO", "SEAT-PED-DM-GZ", "SEAT-PED-REP-GZ5"], occupantHrId: "PD-0030" };

const HANA_KEY = "b110";
const AYA_KEY = "pd0029";

function rankData(sharedSeatIds: readonly string[] | undefined): RankRawData {
  const visit = (repKey: string, day: string, customerId: string) => ({
    repKey,
    seatId: HANA.seatId,
    customerId,
    listType: "PM" as const,
    day,
    located: true,
    atPlace: true,
  });
  const rep = (hrIdKey: string, repName: string) => ({
    hrIdKey,
    repName,
    lineName: "Pedia",
    areaName: "Haram - Faisal",
    regionName: null,
    seatIds: [HANA.seatId],
    ...(sharedSeatIds ? { sharedSeatIds } : {}),
    startDay: "2026-10-03",
  });
  return {
    roster: [rep(HANA_KEY, "Hana Abdelaziz"), rep(AYA_KEY, "Aya Mamdouh")],
    // Hana made all three October calls; Aya, hired on the 24th, has made none.
    visits: [visit(HANA_KEY, "2026-10-04", "d1"), visit(HANA_KEY, "2026-10-05", "d2"), visit(HANA_KEY, "2026-10-06", "d3")],
    saves: [],
    placeCases: [],
    customers: ["d1", "d2", "d3", "d4"].map((id) => ({ id, seatId: HANA.seatId, listType: "PM" as const, grade: "A", active: true, statusChangedDay: null })),
    planDays: [],
    starts: new Map(),
    leave: new Set<string>(),
    holidays: new Set<string>(),
    gradeTargets: { AM: { A: 1, B: null, C: null }, PM: { A: 3, B: 2, C: 1 } },
    callRateTargets: { am: 2, pm: 10 },
  };
}

export function runPhoenixCrmSeatHandoverOccupantsTests(): void {
  // ── 1. The org index keeps both occupants of a seat ─────────────────────────────────────────────
  {
    const org = buildOrgIndex([ROOT_SEAT, DM, HANA, AYA, SOLO]);
    const seat = org.seats.get(HANA.seatId);
    assert.deepEqual(seat?.occupants, ["B-110", "PD-0029"], "the seat carries every person who sits on it");
    assert.deepEqual(seatOccupants(seat as OrgSeat), ["B-110", "PD-0029"]);
    assert.equal(org.territories.filter((territory) => territory.seatId === HANA.seatId).length, 1, "territories stay one entry per SEAT");
    assert.equal(org.territories.length, 2, "two seats, not three people");
    assert.deepEqual(
      org.territoryHolders.map((holder) => `${holder.seatId}|${holder.occupantHrId}`),
      ["SEAT-PED-REP-GZ4|B-110", "SEAT-PED-REP-GZ4|PD-0029", "SEAT-PED-REP-GZ5|PD-0030"],
      "territoryHolders is one per seat × person, in a stable order",
    );
    assert.deepEqual(org.seatsByOccupant.get("B-110")?.map((held) => held.seatId), [HANA.seatId], "the resigned rep still holds her seat");
    assert.deepEqual(org.seatsByOccupant.get("PD-0029")?.map((held) => held.seatId), [HANA.seatId], "and so does the new hire, once");
    assert.deepEqual(seatPeople(seat as OrgSeat).map((person) => person.occupantHrId), ["B-110", "PD-0029"], "seatPeople splits a shared seat into its people");
    assert.deepEqual(seatPeople(org.seats.get(SOLO.seatId) as OrgSeat).length, 1, "a seat with one occupant is left alone");

    // The same person twice on a seat (a repeated row) is still one person.
    const repeated = buildOrgIndex([ROOT_SEAT, DM, HANA, HANA]);
    assert.deepEqual(repeated.seats.get(HANA.seatId)?.occupants, ["B-110"]);
    assert.equal(repeated.territoryHolders.length, 1);

    // A vacant seat has no occupants and no holder.
    const vacant = buildOrgIndex([ROOT_SEAT, DM, { ...HANA, occupantHrId: null }]);
    assert.deepEqual(seatOccupants(vacant.seats.get(HANA.seatId) as OrgSeat), []);
    assert.equal(vacant.territoryHolders.length, 0);
  }

  // ── 2. A manager who sits on the shared seat is not his own reviewer, whichever row came last ────
  {
    const org = buildOrgIndex([ROOT_SEAT, DM, { ...HANA, occupantHrId: "B-60" }, AYA]);
    assert.deepEqual(
      managerChain(org, HANA.seatId).map((member) => member.hrId),
      [],
      "the district manager on the shared seat is skipped as a reviewer of it, even when he is not the last row",
    );
    // The contrast: the same district manager, NOT on the seat, is the reviewer.
    const apart = buildOrgIndex([ROOT_SEAT, DM, HANA, AYA]);
    assert.deepEqual(
      managerChain(apart, HANA.seatId).map((member) => member.hrId),
      ["B-60"],
      "a district manager who is not on the seat is still listed as its reviewer",
    );
  }

  // ── 3. Phoenix Ranks gives each occupant their OWN visits ───────────────────────────────────────
  {
    const shared = factsForWindow(rankData([HANA.seatId]), { from: "2026-10-03", to: "2026-10-09" });
    const hana = shared.find((facts) => facts.hrIdKey === HANA_KEY);
    const aya = shared.find((facts) => facts.hrIdKey === AYA_KEY);
    assert.equal(hana?.pmVisits, 3, "Hana keeps her own three calls");
    assert.equal(aya?.pmVisits, 0, "Aya is credited none of Hana's");
    assert.equal(hana?.coverage?.covered, 3, "Hana's coverage is her own three doctors");
    assert.equal(aya?.coverage?.covered, 0, "Aya covers nobody on Hana's calls");

    // A seat nobody else sits on reads the seat's visits exactly as before.
    const unshared = factsForWindow(rankData(undefined), { from: "2026-10-03", to: "2026-10-09" });
    assert.equal(unshared.find((facts) => facts.hrIdKey === AYA_KEY)?.coverage?.covered, 3, "without a shared mark the seat's visits are still the seat's");
  }

  // ── 4. Wired through, not just decided ───────────────────────────────────────────────────────────
  {
    const compute = source("src/lib/rep-ranks/server/compute.ts");
    assert.ok(compute.includes("org.territoryHolders"), "the Ranks roster walks every occupant of a seat");
    assert.equal(compute.includes("org.territories"), false, "and no longer walks one row per seat");
    assert.ok(compute.includes("sharedSeatIds:"), "each roster rep is told which seats are shared");
    const recordings = source("src/lib/phoenix-crm/server/visit-recordings.ts");
    assert.ok(recordings.includes("viewer.org.territoryHolders"), "visit recordings are credited to every occupant");
    assert.equal(recordings.includes("viewer.org.territories"), false);
    const readiness = source("src/lib/crm/phoenix-team-readiness-server.ts");
    assert.ok(readiness.includes("seatPeople(territory)"), "team readiness counts people, not seats");
    const starts = source("src/lib/crm/phoenix-team-starts.ts");
    assert.ok(starts.includes("seatOccupants(territory).length"), "a team's rep count is its people");
    const facts = source("src/lib/rep-ranks/rank-facts.ts");
    assert.ok(facts.includes("visit.repKey === rep.hrIdKey"), "coverage and frequency read only the rep's own visits on a shared seat");
  }
}
