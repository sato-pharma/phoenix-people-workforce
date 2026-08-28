import assert from "node:assert/strict";

import {
  resolveVacancyManager,
  type ManagerSeatRow,
} from "../src/lib/recruitment/vacancy-manager-escalation.ts";

/**
 * "Yes, route him to the district manager's manager."
 *
 * The owner, 2026-08-28, on the one open vacancy in production whose own manager post is empty:
 * "Down town · Pedia" reports to the Cairo Pedia District Manager, that post is vacant, and until
 * this the send button stayed disabled — the CV could be read but not sent.
 *
 * Pinned as BEHAVIOUR. Every seat below is a real production seat, spelled as `au_v_org_tree` spells
 * it, because the two things most likely to break this are both about real shape: that the tier above
 * a district manager is not always the National Sales Manager, and that a line's name is not always
 * capitalised the same way twice.
 */

/** The PEDIA and ANTI_INFECTIVE seats this file reasons about, as production held them 2026-08-28. */
const SEATS: ManagerSeatRow[] = [
  { is_vacant: false, occupant_hr_id: "AA", parent_seat_id: null, seat_display_label: "CEO", seat_id: "SEAT-ROOT-CEO", seat_tier: "CEO" },

  // PEDIA. Note the two vacant district manager seats do NOT report to the same tier: Cairo reports
  // to the NSM, Alex-BHR reports to the RSM. That difference is the whole reason this climbs.
  { is_vacant: false, line_name: "Pedia", occupant_hr_id: "A-12", parent_seat_id: "SEAT-ROOT-CEO", seat_display_label: "PEDIA NSM", seat_id: "SEAT-PED-NSM", seat_tier: "NSM" },
  { is_vacant: false, line_name: "Pedia", occupant_hr_id: "PD-0001", parent_seat_id: "SEAT-PED-NSM", seat_display_label: "PEDIA RSM (Alex-BHR, Delta (1), Delta (2))", seat_id: "SEAT-PED-RSM", seat_tier: "RSM" },
  { is_vacant: true, line_name: "Pedia", occupant_hr_id: null, parent_seat_id: "SEAT-PED-NSM", region_name: "Cairo", seat_display_label: "PEDIA Cairo DM (VACANT)", seat_id: "SEAT-PED-DM-CA", seat_tier: "DM" },
  { is_vacant: true, line_name: "Pedia", occupant_hr_id: null, parent_seat_id: "SEAT-PED-RSM", region_name: "Alex-BHR", seat_display_label: "PEDIA Alex-BHR DM (VACANT)", seat_id: "SEAT-PED-DM-AB", seat_tier: "DM" },
  { is_vacant: false, line_name: "Pedia", occupant_hr_id: "B-94", parent_seat_id: "SEAT-PED-NSM", region_name: "Giza", seat_display_label: "PEDIA Giza DM", seat_id: "SEAT-PED-DM-GZ", seat_tier: "DM" },
  { is_vacant: true, line_name: "Pedia", occupant_hr_id: null, parent_seat_id: "SEAT-PED-DM-CA", region_name: "Cairo", seat_display_label: "PEDIA Nasr City rep (VACANT)", seat_id: "SEAT-PED-REP-CA2", seat_tier: "REP" },

  // ANTI_INFECTIVE, for the acting district manager and the line-name spelling.
  { is_vacant: false, line_name: "Anti Infective", occupant_hr_id: "AI-0008", parent_seat_id: "SEAT-ROOT-CEO", seat_display_label: "ANTI_INFECTIVE NSM", seat_id: "SEAT-AIF-NSM", seat_tier: "NSM" },
  { is_vacant: false, line_name: "Anti Infective", occupant_hr_id: "B-1", parent_seat_id: "SEAT-AIF-NSM", region_name: "Upper Egypt 1", seat_display_label: "ANTI_INFECTIVE Upper Egypt 1 acting DM", seat_id: "SEAT-AIF-ADM-UE-1", seat_tier: "ACTING_DM" },
];

/** Vacancy 245 as production holds it: no seat of its own, and a manager post with nobody in it. */
const DOWN_TOWN = { lineName: "Pedia", regionName: "Cairo", seatId: null };

export async function runVacancyManagerEscalationTests(): Promise<void> {
  // ── 1. The vacancy this was built for ──────────────────────────────────────
  // "Down town" has no PEDIA rep seat at all — the five Cairo PEDIA rep seats are Cairo East 1,
  // Cairo East 2, Cairo West, Heliopolis and Nasr City — so there is no seat to take a parent from
  // and the manager is found by line and region instead.
  {
    const standIn = resolveVacancyManager(DOWN_TOWN, SEATS);
    assert.equal(standIn?.hrId, "A-12", "Down town · Pedia must route to the Pedia National Sales Manager");
    assert.equal(
      standIn?.coveredSeatLabel,
      "PEDIA Cairo DM (VACANT)",
      "and must name the empty post it climbed past, so the recruiter can see why it went up",
    );
  }

  // ── 2. It follows the parent link, never a tier ────────────────────────────
  // The seat that would break a hard-coded "go to the NSM": PEDIA Alex-BHR reports to the Regional
  // Sales Manager. Sending an Alexandria CV to the National Sales Manager would put it in front of
  // somebody who does not run that region.
  {
    const alexBhr = resolveVacancyManager({ lineName: "Pedia", regionName: "Alex-BHR", seatId: null }, SEATS);
    assert.equal(alexBhr?.hrId, "PD-0001", "Alex-BHR climbs to the REGIONAL sales manager, who is its parent");
    assert.notEqual(alexBhr?.hrId, "A-12", "and specifically not to the national one, which is a tier further up");
  }

  // ── 3. A vacancy that names its own seat uses that seat's parent ───────────
  // The exact answer where it exists. The territory fallback is only for the vacancies that have no
  // seat, and it must not be reached when there is a real link to follow.
  {
    const nasrCity = resolveVacancyManager({ lineName: "Pedia", regionName: "Cairo", seatId: "SEAT-PED-REP-CA2" }, SEATS);
    assert.equal(nasrCity?.hrId, "A-12", "the rep seat's parent is the vacant Cairo DM, which climbs to the NSM");
    assert.equal(nasrCity?.coveredSeatLabel, "PEDIA Cairo DM (VACANT)", "and the covered post is that DM seat");
  }

  // ── 4. Two empty levels name the FIRST one ─────────────────────────────────
  // After climbing twice the note must still read "standing in for the district manager". Naming the
  // highest empty seat instead would tell a recruiter their CV is covering a post they never chose.
  {
    const emptied = SEATS.map((seat) =>
      seat.seat_id === "SEAT-PED-RSM" ? { ...seat, is_vacant: true, occupant_hr_id: null } : seat,
    );
    const alexBhr = resolveVacancyManager({ lineName: "Pedia", regionName: "Alex-BHR", seatId: null }, emptied);
    assert.equal(alexBhr?.hrId, "A-12", "with the RSM empty too, the climb carries on to the NSM");
    assert.equal(
      alexBhr?.coveredSeatLabel,
      "PEDIA Alex-BHR DM (VACANT)",
      "but the post being covered is still the district manager's, not the regional manager's",
    );
  }

  // ── 5. A line spelled two ways is one line ─────────────────────────────────
  // `au.lines` seeds the Anti Infective line as 'Anti infective' while the application spells it
  // "Anti Infective". A case-sensitive comparison here drops the entire line's seats, and the
  // symptom is a send button that never enables for any Anti Infective vacancy.
  {
    const acting = resolveVacancyManager({ lineName: "Anti infective", regionName: "Upper Egypt 1", seatId: null }, SEATS);
    assert.equal(acting?.hrId, "B-1", "the lower-case spelling must reach the same acting district manager");
    assert.equal(acting?.coveredSeatLabel, null, "who is sitting in the seat, so nothing was climbed past");
  }

  // ── 6. An occupied manager post is not an escalation ───────────────────────
  // A vacancy can name no manager while the organogram knows one. Filling it in is right; calling
  // that person a stand-in is not, and the covering note must stay off the screen.
  {
    const giza = resolveVacancyManager({ lineName: "Pedia", regionName: "Giza", seatId: null }, SEATS);
    assert.equal(giza?.hrId, "B-94", "the Giza district manager is simply the manager");
    assert.equal(giza?.coveredSeatLabel, null, "and is standing in for nobody");
  }

  // ── 7. What it refuses, and why refusing is the right answer ───────────────
  // Every one of these leaves the send disabled, which is exactly where a recruiter is today. A
  // guess would instead put a real candidate in front of somebody who is not hiring.
  {
    assert.equal(
      resolveVacancyManager({ lineName: "Pedia", regionName: "Sinai", seatId: null }, SEATS),
      null,
      "a region with no manager seat resolves to nobody rather than to the nearest name",
    );
    assert.equal(
      resolveVacancyManager({ lineName: null, regionName: "Cairo", seatId: null }, SEATS),
      null,
      "a region alone is not enough — Cairo has a district manager on every line",
    );
    assert.equal(
      resolveVacancyManager({ lineName: "Pedia", regionName: null, seatId: null }, SEATS),
      null,
      "and a line alone is not enough either",
    );

    // Nobody occupied anywhere up the chain.
    const allEmpty = SEATS.map((seat) => ({ ...seat, is_vacant: true, occupant_hr_id: null }));
    assert.equal(
      resolveVacancyManager(DOWN_TOWN, allEmpty),
      null,
      "a chain that is empty to the top has no answer, and inventing one is worse than none",
    );

    // A cycle. Impossible in a correctly built tree, which is why it is worth refusing on: the
    // answer it would otherwise invent is indistinguishable from a real one.
    const cyclic: ManagerSeatRow[] = [
      { is_vacant: true, line_name: "Pedia", occupant_hr_id: null, parent_seat_id: "SEAT-B", region_name: "Cairo", seat_id: "SEAT-A", seat_tier: "DM" },
      { is_vacant: true, occupant_hr_id: null, parent_seat_id: "SEAT-A", seat_id: "SEAT-B", seat_tier: "NSM" },
    ];
    assert.equal(resolveVacancyManager(DOWN_TOWN, cyclic), null, "a cycle terminates and refuses");

    // A parent named that the tree does not contain.
    const orphaned = SEATS.map((seat) =>
      seat.seat_id === "SEAT-PED-DM-CA" ? { ...seat, parent_seat_id: "SEAT-THAT-WAS-RETIRED" } : seat,
    );
    assert.equal(resolveVacancyManager(DOWN_TOWN, orphaned), null, "a dangling parent link refuses");
  }

  // ── 8. A seat the tree no longer contains falls back to the territory ──────
  // A restructure can retire a seat while the vacancy row still names it. Refusing there would
  // disable the send for a reason that has nothing to do with the vacancy.
  {
    const stale = resolveVacancyManager({ lineName: "Pedia", regionName: "Cairo", seatId: "SEAT-PED-REP-GONE" }, SEATS);
    assert.equal(stale?.hrId, "A-12", "an unknown seat id is treated as absent, not as a dead end");
  }

  // ── 9. Two routes that disagree refuse; two that agree do not ──────────────
  // A line and region resolving to two manager seats is not itself a problem — what matters is
  // whether they lead to the same person. Choosing between two different managers by sort order is
  // how a CV lands in front of somebody who is not hiring.
  {
    const twoSeatsOnePerson: ManagerSeatRow[] = [
      ...SEATS,
      { is_vacant: true, line_name: "Pedia", occupant_hr_id: null, parent_seat_id: "SEAT-PED-NSM", region_name: "Cairo", seat_display_label: "PEDIA Cairo DM 2 (VACANT)", seat_id: "SEAT-PED-DM-CA2", seat_tier: "DM" },
    ];
    assert.equal(
      resolveVacancyManager(DOWN_TOWN, twoSeatsOnePerson)?.hrId,
      "A-12",
      "two Cairo district manager seats under one national manager still answer with that manager",
    );

    const twoSeatsTwoPeople: ManagerSeatRow[] = [
      ...SEATS,
      { is_vacant: false, line_name: "Pedia", occupant_hr_id: "B-999", parent_seat_id: "SEAT-PED-NSM", region_name: "Cairo", seat_display_label: "PEDIA Cairo DM 2", seat_id: "SEAT-PED-DM-CA2", seat_tier: "DM" },
    ];
    assert.equal(
      resolveVacancyManager(DOWN_TOWN, twoSeatsTwoPeople),
      null,
      "but two that lead to different people refuse rather than pick one",
    );
  }

  // ── 10. A vacant seat with a stale occupant is still vacant ────────────────
  // The seat says empty and the occupant column has not caught up. Reading the occupant alone would
  // route a live candidate to somebody who has left the company.
  {
    const stale = SEATS.map((seat) =>
      seat.seat_id === "SEAT-PED-DM-CA" ? { ...seat, occupant_hr_id: "B-000" } : seat,
    );
    const standIn = resolveVacancyManager(DOWN_TOWN, stale);
    assert.equal(standIn?.hrId, "A-12", "the vacant flag wins over a leftover occupant id");
    assert.notEqual(standIn?.hrId, "B-000", "and the person who left is never the one a CV is sent to");
  }
}
