import assert from "node:assert/strict";

import { computeCallRate, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import { type CheckinForMatch } from "../src/lib/crm/checkin-match.ts";
import {
  buildRepVisits,
  campaignReadingOf,
  contactLabel,
  isFieldWork,
  isProspectRow,
  offDutyReason,
  partitionRepVisitRows,
  resolveVisitTerritory,
  summarizeRepVisits,
  territoryLabel,
  type CrmRegionTerritoryIndex,
  type RepVisitRow,
  type VisitForRepDrilldown,
} from "../src/lib/crm/rep-visits.ts";

const AGENT = 100;
const DOCTOR = 555;
const REGION = 118;

function visit(overrides: Partial<VisitForRepDrilldown> = {}): VisitForRepDrilldown {
  return {
    agent_crm_id: AGENT,
    agent_hr_id: "hr-1",
    agent_name: "Adel.Srour ( Down-town / C )",
    ampm: "PM",
    comment: null,
    contact_crm_id: DOCTOR,
    contact_name: "Dr Sherif Kamal",
    crm_contact_grade: "A",
    crm_region_id: REGION,
    crm_region_name: "Mahalla",
    crm_save_date: "2026-08-01T11:00:00",
    crm_visit_id: 9001,
    customer_name: "El Nasr Clinic",
    double_hr_id: null,
    double_name: null,
    double2_hr_id: null,
    double2_name: null,
    speciality: "Pediatrics",
    visit_date: "2026-08-01",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  };
}

function checkin(overrides: Partial<CheckinForMatch> = {}): CheckinForMatch {
  return { agent_crm_id: AGENT, contact_crm_id: DOCTOR, check_date: "2026-08-01T10:55:00", ...overrides };
}

const MAPPED: CrmRegionTerritoryIndex = new Map([
  [
    REGION,
    {
      areaCode: "D15",
      areaName: "Gharbia 2 (Mahalla)",
      brickId: "B77-3",
      brickName: "المحلة الكبرى",
      regionCode: "DL1",
      regionName: "Delta (1)",
    },
  ],
]);

const UNMAPPED: CrmRegionTerritoryIndex = new Map();

export function runCrmRepVisitsTests() {
  // ── Territory: three states, and the difference between the last two is the point ──
  {
    const mapped = resolveVisitTerritory(REGION, MAPPED);
    assert.equal(mapped.status, "mapped");
    assert.equal(mapped.status === "mapped" ? mapped.areaName : null, "Gharbia 2 (Mahalla)");
    assert.equal(mapped.status === "mapped" ? mapped.regionName : null, "Delta (1)");

    // A real coded region nobody has tied to a brick yet. NOT the same as no region at all: the
    // screen names the place either way, and conflating the two would tell the reader the CRM
    // recorded nothing when it recorded somewhere that has simply never been mapped.
    assert.equal(resolveVisitTerritory(REGION, UNMAPPED).status, "unmapped");
    assert.equal(resolveVisitTerritory(null, MAPPED).status, "none");
    assert.notEqual(
      resolveVisitTerritory(REGION, UNMAPPED).status,
      resolveVisitTerritory(null, MAPPED).status,
      "an unmapped region and a missing region must never collapse into one state — one is a TODO with a name, the other is an absence",
    );
  }

  // ── The territory label is never blank, in any of the three states ──────────────
  {
    const built = buildRepVisits([visit()], [], { territoryIndex: MAPPED });
    assert.equal(territoryLabel(built.rows[0]!), "المحلة الكبرى · Gharbia 2 (Mahalla) · Delta (1)");

    const unmapped = buildRepVisits([visit()], [], { territoryIndex: UNMAPPED });
    assert.equal(
      territoryLabel(unmapped.rows[0]!),
      "Mahalla",
      "an unmapped visit still names its place — the reader must always see WHERE, even when the map cannot place it",
    );

    const noRegion = buildRepVisits([visit({ crm_region_id: null, crm_region_name: null })], [], {
      territoryIndex: MAPPED,
    });
    assert.equal(
      territoryLabel(noRegion.rows[0]!),
      "No location yet",
      "a visit nothing can place reads Phoenix CRM's own words, the Reps List's — never \"No region recorded\" (owner, 2026-10-31)",
    );
    for (const row of [built.rows[0]!, unmapped.rows[0]!, noRegion.rows[0]!]) {
      assert.ok(territoryLabel(row).trim().length > 0, "the territory cell must never render empty");
    }
  }

  // ── The doctor's Phoenix CRM brick comes first (owner, 2026-10-31) ────────────────────────────────
  // "donot show no crm region from the address get the brick area and region": a Phoenix visit carries
  // no CRM region, so it read "no region"; the doctor's brick from the Reps List's own placement is
  // asked first, for every visit, and a contact with no brick falls back to the CRM region as before.
  {
    const phoenixBrick = new Map([
      [
        DOCTOR,
        {
          status: "mapped" as const,
          brickId: "BH-01",
          brickName: "Damanhour",
          areaCode: "A21",
          areaName: "Behira 1",
          regionCode: null,
          regionName: "Alex-BHR",
        },
      ],
    ]);
    const phoenixVisit = buildRepVisits([visit({ crm_region_id: null, crm_region_name: null })], [], {
      contactTerritory: phoenixBrick,
      territoryIndex: UNMAPPED,
    });
    assert.equal(territoryLabel(phoenixVisit.rows[0]!), "Damanhour · Behira 1 · Alex-BHR", "a Phoenix visit with no CRM region reads its doctor's brick");

    const regionVisit = buildRepVisits([visit()], [], { contactTerritory: phoenixBrick, territoryIndex: MAPPED });
    assert.equal(
      territoryLabel(regionVisit.rows[0]!),
      "Damanhour · Behira 1 · Alex-BHR",
      "the Phoenix brick outranks the CRM region's, exactly as on the Reps List",
    );

    const otherDoctor = buildRepVisits([visit({ contact_crm_id: 777 })], [], { contactTerritory: phoenixBrick, territoryIndex: MAPPED });
    assert.equal(territoryLabel(otherDoctor.rows[0]!), "المحلة الكبرى · Gharbia 2 (Mahalla) · Delta (1)", "a doctor Phoenix has not placed keeps his CRM region");
  }

  // ── Proof: the SAME three buckets the rate uses, per row ────────────────────────
  {
    const visits = [
      visit({ contact_crm_id: DOCTOR, crm_visit_id: 1 }), // proved by the check-in below
      visit({ contact_crm_id: 777, crm_visit_id: 2 }), // real contact, no check-in
      visit({ contact_crm_id: 0, crm_visit_id: 3, visit_type: -8, visit_type_description: "Campaign (Prospection)" }),
      visit({ crm_visit_id: 4, visit_type: -4, visit_type_description: "Vacation" }), // not field work
    ];
    const built = buildRepVisits(visits, [checkin()], { territoryIndex: UNMAPPED });
    const byId = new Map(built.rows.map((row) => [row.visitCrmId, row]));
    assert.equal(byId.get(1)?.standing, "verified");
    assert.equal(byId.get(2)?.standing, "unverified");
    assert.equal(byId.get(3)?.standing, "campaign");
    assert.equal(
      byId.get(4)?.standing,
      "excluded",
      "leave is not field work — it stays on the screen, because the rep's month contains it, but out of the KPI",
    );

    // ZERO IS NOT AN ID. The vendor sends a campaign call's absent contact as 0, and left alone it
    // renders as the fake record "Contact 0" — measured on 85 of one rep's 153 August rows.
    assert.equal(
      byId.get(3)?.contactCrmId,
      null,
      "a campaign call has no contact, and the vendor's 0 must be normalised to null rather than shown as a doctor",
    );
    assert.equal(byId.get(1)?.contactCrmId, DOCTOR, "a real contact id is untouched");
  }

  // ── A campaign call is a REAL doctor who is not on the rep's list ───────────────
  {
    // The owner's correction, 2026-08-28: "the campaign will have zero contact because it is a
    // doctor that is not in the medical rep's contact list." So the row is not empty — the CRM
    // simply has no record to point at, and the rep's own comment is the only name there is. All
    // 1,779 August campaign rows in production carry a comment and NOTHING else.
    const campaign = buildRepVisits(
      [
        visit({
          comment: "د. عبدالكريم صبح Pedia العصافرة\r\nكتب اللاكتو ادفانسد",
          contact_crm_id: 0,
          contact_name: null,
          crm_visit_id: 51,
          // EMPTY, exactly as production sends it. All 1,779 August campaign rows carry a comment
          // and nothing else — no contact name, no customer, no speciality, no region. The fixture
          // has to say so, or the parsed fallback is never the thing under test.
          customer_name: null,
          speciality: null,
          visit_type: -8,
          visit_type_description: "Campaign (Prospection)",
        }),
      ],
      [],
      { territoryIndex: UNMAPPED },
    );
    const row = campaign.rows[0]!;
    // OWNER, 2026-08-28: *"in the campaign you must be able to separate the doctor name, the
    // specialty, and the clinic."* Until then this cell held the WHOLE comment — name, speciality,
    // district and the promise, in the Doctor column — and this test pinned it that way. It now
    // pins the split instead: the three parts land in the three columns a regular visit already
    // has, so a campaign row sorts, searches and exports like any other.
    assert.equal(contactLabel(row), "عبدالكريم صبح", "the Doctor cell is the doctor — not the sentence he was found in");
    assert.equal(row.speciality, "Pedia", "his speciality goes in the Speciality column, exactly as the rep wrote it");
    // No clinic was NAMED here — "العصافرة" is the district he practises in, not a hospital or a
    // pharmacy — so the clinic column stays empty rather than being filled with a guess.
    assert.equal(row.customerName, null, "a district is not a clinic, and inventing one would be a fact made up");
    // But NOTHING the rep typed disappears. The district and the promise are both still on the row.
    const reading = campaignReadingOf(row)!;
    assert.ok(reading.unread.includes("العصافرة"), "the district survives as unread — it is also what the assist is asked to read");
    assert.ok(row.comment?.includes("كتب اللاكتو ادفانسد"), "the rep's own sentence survives whole on the row");
    for (const person of reading.people) {
      assert.ok(row.comment!.includes(person.name), "and nobody is ever invented — every name is the rep's own characters");
    }
    assert.ok(isProspectRow(row), "a doctor named only by free text is a PROSPECT and must be marked as one");
    assert.ok(
      !contactLabel(row).includes("Contact 0"),
      "'Contact 0' is a fake record and must never reach the screen — it did, on 85 of one rep's 153 August rows",
    );

    // A real contact is never called a prospect, however much comment it carries.
    const real = buildRepVisits([visit({ comment: "left a sample", crm_visit_id: 52 })], [], {
      territoryIndex: UNMAPPED,
    });
    assert.equal(contactLabel(real.rows[0]!), "Dr Sherif Kamal");
    assert.ok(!isProspectRow(real.rows[0]!), "a registered contact is not a prospect");

    // A day off is not a prospecting call. Leave rows carry no contact and often a comment of their
    // own — "Sales day", "Interviews" — and 21 of August's campaign-typed rows were exactly that.
    const leave = buildRepVisits(
      [
        visit({
          comment: "Sales day",
          contact_crm_id: 0,
          contact_name: null,
          crm_visit_id: 53,
          visit_type: -4,
          visit_type_description: "Vacation",
        }),
      ],
      [],
      { territoryIndex: UNMAPPED },
    );
    assert.ok(
      !isProspectRow(leave.rows[0]!),
      "a leave row with a comment must never be marked a prospect — that would invent a doctor visit out of a day off",
    );
  }

  // ── VACATIONS ARE NOT VISITS. Owner's rule, 2026-08-28 ─────────────────────────
  {
    // A public holiday arrives down the same feed as a call: a date, an AM/PM flag, and the reason
    // in the comment. Before this split it rendered in the Doctor column, so the 27th of August read
    // as a visit to a doctor named "اجازة بمناسبة المولد النبوي الشريف".
    const holiday = visit({
      ampm: "AM",
      comment: "اجازة بمناسبة المولد النبوي الشريف",
      contact_crm_id: 0,
      contact_name: null,
      crm_visit_id: 71,
      customer_name: null,
      visit_type: -4,
      visit_type_description: "Vacations & Leaves",
    });
    const built = buildRepVisits([visit({ crm_visit_id: 70 }), holiday], [], { territoryIndex: UNMAPPED });
    const { fieldRows, offDutyRows } = partitionRepVisitRows(built.rows);

    assert.equal(fieldRows.length, 1, "the call is the only field row");
    assert.equal(offDutyRows.length, 1, "the holiday is separated out");
    assert.equal(offDutyRows[0]!.visitCrmId, 71);
    assert.ok(fieldRows.every(isFieldWork), "every field row is field work");
    assert.ok(offDutyRows.every((row) => !isFieldWork(row)), "no off-duty row is field work");
    assert.equal(
      fieldRows.length + offDutyRows.length,
      built.rows.length,
      "the split loses nothing — a rep's month is still every row he logged",
    );

    // THE HEADLINE: the leave reason must not be able to appear as a person.
    assert.equal(
      contactLabel(offDutyRows[0]!),
      "Vacations & Leaves",
      "a leave row is labelled by what the day WAS — never by its comment, which is the leave reason",
    );
    assert.equal(
      offDutyReason(offDutyRows[0]!),
      "اجازة بمناسبة المولد النبوي الشريف",
      "the reason is still shown — under its own label, in its own list",
    );

    // And it is out of every count a call feeds: the day off is not a doctor and not a place.
    assert.equal(built.summary.fieldCalls, 1);
    assert.equal(built.summary.excluded, 1);
    assert.equal(built.summary.am, 0, "the holiday's AM flag must not inflate the AM count");
    assert.equal(built.summary.distinctContacts, 1, "one doctor, not two");
  }

  // ── THE RECONCILIATION. These rows ARE the board's rate, not a second opinion ───
  {
    // A month's worth of mixed rows, including the ones most likely to make two
    // implementations disagree: an unflagged AM/PM row, a campaign row, and leave.
    const visits: VisitForRepDrilldown[] = [
      visit({ ampm: "AM", contact_crm_id: DOCTOR, crm_visit_id: 11 }),
      visit({ ampm: "AM", contact_crm_id: 601, crm_visit_id: 12 }),
      visit({ ampm: "PM", contact_crm_id: 602, crm_visit_id: 13 }),
      visit({ ampm: "PM", contact_crm_id: 603, crm_visit_id: 14 }),
      visit({ ampm: null, contact_crm_id: 604, crm_visit_id: 15 }),
      visit({ ampm: "PM", contact_crm_id: 0, crm_visit_id: 16, visit_type: -8, visit_type_description: "Campaign (Prospection)" }),
      visit({ ampm: "PM", crm_visit_id: 17, visit_type: -4, visit_type_description: "Vacation" }),
    ];
    const checkins = [checkin()];

    const drilldown = buildRepVisits(visits, checkins, { territoryIndex: UNMAPPED });
    const rate = computeCallRate(visits as unknown as VisitForCallRate[], checkins, {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
    });
    const rep = rate.reps[0]!;

    const reportedByRate = rep.am.total + rep.pm.total + rep.pharmacy.total + rep.unspecified;
    assert.equal(
      drilldown.summary.fieldCalls,
      reportedByRate,
      "the drill-down's call count must EQUAL the board's reported calls — a drill-down that adds up to a different number than the row that opened it is worse than none",
    );
    assert.equal(
      drilldown.summary.verified,
      rep.am.verified + rep.pm.verified + rep.pharmacy.verified,
      "proved calls must reconcile too",
    );
    assert.equal(drilldown.summary.campaign, rep.am.campaign + rep.pm.campaign + rep.pharmacy.campaign);
    assert.equal(drilldown.summary.am, rep.am.total, "AM rows must match the AM slice exactly");
    assert.equal(drilldown.summary.pm, rep.pm.total, "PM rows must match the PM slice exactly");
    assert.equal(drilldown.summary.pharmacy, rep.pharmacy.total, "pharmacy rows must match the pharmacy slice exactly");
    assert.equal(
      drilldown.summary.unspecified,
      rep.unspecified,
      "a row the CRM left without an AM/PM flag is counted in neither slice, in both places",
    );
    // And the row the KPI ignores is still ON the screen — present, and counted apart.
    assert.equal(drilldown.summary.excluded, 1);
    assert.equal(drilldown.summary.rows, visits.length, "every visit is rendered, field work or not");
  }

  // ── PHARMACIES ARE SEPARATE FROM AM/PM HERE TOO (owner, 2026-09-05) ─────────────
  {
    const visits: VisitForRepDrilldown[] = [
      visit({ ampm: "AM", speciality: "Pharmacy", contact_crm_id: 701, crm_visit_id: 61 }),
      visit({ ampm: "AM", contact_crm_id: 702, crm_visit_id: 62 }), // a real doctor, still AM
    ];
    const checkins = [checkin({ contact_crm_id: 701 }), checkin({ contact_crm_id: 702 })];
    const drilldown = buildRepVisits(visits, checkins, { territoryIndex: UNMAPPED });
    const rate = computeCallRate(visits as unknown as VisitForCallRate[], checkins, {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
    });
    const rep = rate.reps[0]!;
    assert.equal(drilldown.summary.pharmacy, 1, "the pharmacy row is pulled out of AM, on screen exactly as on the board");
    assert.equal(drilldown.summary.am, 1, "only the real doctor remains in AM");
    assert.equal(drilldown.summary.pharmacy, rep.pharmacy.total, "and it reconciles with the board's pharmacy slice");
  }

  // ── THE 2026-09-05 GATE: a Thursday row is shown but excluded from every count ───
  {
    // 2026-08-06 is a Thursday.
    const visits: VisitForRepDrilldown[] = [
      visit({ ampm: "PM", contact_crm_id: DOCTOR, crm_visit_id: 63, visit_date: "2026-08-06" }),
    ];
    const drilldown = buildRepVisits(visits, [checkin()], { territoryIndex: UNMAPPED });
    assert.equal(drilldown.rows.length, 1, "the Thursday call is still RENDERED — it is real field work");
    assert.equal(drilldown.summary.fieldCalls, 0, "but it must not inflate fieldCalls — the board no longer counts it");
    assert.equal(drilldown.summary.pm, 0, "nor any session");
    assert.equal(drilldown.summary.verified, 0, "nor the proof totals");
  }

  // ── Sessions are counted over FIELD WORK only ───────────────────────────────────
  {
    // A leave row carries an AM/PM flag like any other. Counting it in the session totals would
    // inflate them past the rate's, which is exactly the drift the reconciliation above forbids.
    const built = buildRepVisits(
      [visit({ ampm: "PM", crm_visit_id: 21, visit_type: -4, visit_type_description: "Vacation" })],
      [],
      { territoryIndex: UNMAPPED },
    );
    assert.equal(built.summary.pm, 0, "a leave row flagged PM must not count as a PM call");
    assert.equal(built.summary.excluded, 1);
    assert.equal(built.summary.fieldCalls, 0);
  }

  // ── The partner is NAMED from the directory, never left as a login handle ───────
  {
    const built = buildRepVisits(
      [visit({ double_hr_id: "HR-9", double_name: "Nabil.Fahmy ( Delta / A )" })],
      [],
      { partnerNameByHrId: new Map([["hr-9", "Nabil Fahmy"]]), territoryIndex: UNMAPPED },
    );
    assert.equal(
      built.rows[0]?.partnerName,
      "Nabil Fahmy",
      "the directory names the person and the CRM names the territory — keyed lower-cased, because hr ids reach this module in mixed case",
    );

    // No directory row: the CRM handle is better than nothing, and far better than throwing.
    const fallback = buildRepVisits([visit({ double_hr_id: "HR-9", double_name: "Nabil.Fahmy ( Delta / A )" })], [], {
      territoryIndex: UNMAPPED,
    });
    assert.equal(fallback.rows[0]?.partnerName, "Nabil.Fahmy ( Delta / A )");
  }

  // ── Distinct counts, and the unmapped tally the page reports ───────────────────
  {
    const built = buildRepVisits(
      [
        visit({ contact_crm_id: DOCTOR, crm_visit_id: 31 }),
        visit({ contact_crm_id: DOCTOR, crm_visit_id: 32 }), // same doctor twice
        visit({ contact_crm_id: 606, crm_region_id: 900, crm_region_name: "Sohag", crm_visit_id: 33 }),
        visit({ contact_crm_id: 607, crm_region_id: null, crm_region_name: null, crm_visit_id: 34 }),
      ],
      [],
      { territoryIndex: MAPPED },
    );
    assert.equal(built.summary.distinctContacts, 3, "a doctor seen twice is one doctor");
    assert.equal(built.summary.distinctRegions, 2);
    assert.equal(built.summary.unmappedTerritory, 1, "only region 900 is unmapped — region 118 resolves");
    assert.equal(built.summary.noTerritory, 1, "the row with no region at all is counted apart from the unmapped one");
  }

  // ── Order: newest day first, AM before PM inside a day ─────────────────────────
  {
    const built = buildRepVisits(
      [
        visit({ ampm: "PM", crm_visit_id: 41, visit_date: "2026-08-01" }),
        visit({ ampm: "AM", crm_visit_id: 42, visit_date: "2026-08-01" }),
        visit({ ampm: "PM", crm_visit_id: 43, visit_date: "2026-08-05" }),
      ],
      [],
      { territoryIndex: UNMAPPED },
    );
    assert.deepEqual(
      built.rows.map((row) => row.visitCrmId),
      [43, 42, 41],
      "a manager opening this asks what the rep has been doing — the answer starts at the most recent day, and AM leads the day",
    );
  }

  // ── An empty month summarizes to zeros rather than throwing ────────────────────
  {
    const empty = summarizeRepVisits([] as RepVisitRow[]);
    assert.equal(empty.rows, 0);
    assert.equal(empty.fieldCalls, 0);
    assert.equal(empty.distinctContacts, 0);
  }
}
