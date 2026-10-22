import assert from "node:assert/strict";

import {
  AM_CALL_RATE_TARGET,
  DAILY_CAMPAIGN_LIMIT,
  PHARMACY_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  classifyCallProof,
  computeCallRate,
  countCallRateWorkingDays,
  isCallRateWorkingDay,
  isPharmacyVisit,
  normalizeSession,
  weekdayOfIsoDate,
  type VisitForCallRate,
} from "../src/lib/crm/call-rate.ts";
import { indexCheckinsByAgentContactDay, type CheckinForMatch } from "../src/lib/crm/checkin-match.ts";

const AGENT = 100;
const DOCTOR = 555;

function visit(overrides: Partial<VisitForCallRate> = {}): VisitForCallRate {
  return {
    agent_crm_id: AGENT,
    agent_hr_id: "hr-1",
    agent_name: "Test Rep",
    ampm: "PM",
    comment: null,
    contact_crm_id: DOCTOR,
    crm_save_date: "2026-08-01T11:00:00",
    speciality: null,
    visit_date: "2026-08-01",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  };
}

function campaignVisit(overrides: Partial<VisitForCallRate> = {}): VisitForCallRate {
  // A real campaign row as the vendor sends it: no contact, no grade, no region.
  return visit({
    contact_crm_id: 0,
    visit_type: -8,
    visit_type_description: "Campaign (Prospection)",
    ...overrides,
  });
}

function pharmacyVisit(overrides: Partial<VisitForCallRate> = {}): VisitForCallRate {
  // A regular visit to a registered pharmacy contact — the common case (owner, 2026-09-05).
  return visit({ speciality: "Pharmacy", ...overrides });
}

function checkin(overrides: Partial<CheckinForMatch> = {}): CheckinForMatch {
  return { agent_crm_id: AGENT, contact_crm_id: DOCTOR, check_date: "2026-08-01T10:55:00", ...overrides };
}

export function runCrmCallRateTests() {
  // ── The working-day rule: Sat–Wed count, Thursday and Friday do not ──────────────
  {
    // 2026-08-01 is a Saturday. Walk one full week and assert each day individually,
    // because getting Thursday wrong is the single most likely error in this module.
    const expected: Array<[string, string, boolean]> = [
      ["2026-08-01", "Saturday", true],
      ["2026-08-02", "Sunday", true],
      ["2026-08-03", "Monday", true],
      ["2026-08-04", "Tuesday", true],
      ["2026-08-05", "Wednesday", true],
      ["2026-08-06", "Thursday", false],
      ["2026-08-07", "Friday", false],
    ];
    for (const [day, label, counts] of expected) {
      assert.equal(isCallRateWorkingDay(day), counts, `${day} (${label}) must ${counts ? "" : "not "}count`);
    }
    assert.equal(weekdayOfIsoDate("2026-08-01"), 6, "2026-08-01 must resolve to Saturday (6)");
    assert.equal(weekdayOfIsoDate("2026-08-06"), 4, "2026-08-06 must resolve to Thursday (4)");
    assert.equal(weekdayOfIsoDate("not-a-date"), null, "a malformed date must return null, not NaN");
  }

  // ── The owner's own worked example: 20 visits on Sun+Mon is 20/5, never 20/2 ─────
  {
    // Sat 2026-08-01 .. Fri 2026-08-07 is exactly one week => 5 working days.
    const workingDays = countCallRateWorkingDays("2026-08-01", "2026-08-07");
    assert.equal(workingDays, 5, "one calendar week must contain exactly 5 call-rate working days");

    const visits: VisitForCallRate[] = [];
    for (let i = 0; i < 12; i += 1) visits.push(visit({ visit_date: "2026-08-02", contact_crm_id: 1000 + i }));
    for (let i = 0; i < 8; i += 1) visits.push(visit({ visit_date: "2026-08-03", contact_crm_id: 2000 + i }));
    const checkins = visits.map((v) =>
      checkin({ contact_crm_id: v.contact_crm_id, check_date: `${v.visit_date}T10:55:00` }),
    );

    const report = computeCallRate(visits, checkins, { dateFrom: "2026-08-01", dateTo: "2026-08-07" });
    const rep = report.reps[0];
    assert.equal(rep.pm.verified, 20, "all 20 calls are verified PM calls");
    assert.equal(rep.pm.verifiedRate, 4, "20 verified calls over 5 working days must be 4.0, not 10.0");
    assert.notEqual(rep.pm.verifiedRate, 10, "dividing by days-worked (2) instead of working-days (5) is the bug");
  }

  // ── Targets are 2 AM and 10 PM, and attainment is measured against them ──────────
  {
    assert.equal(AM_CALL_RATE_TARGET, 2, "owner's standard: two AM accounts per working day");
    assert.equal(PM_CALL_RATE_TARGET, 10, "owner's standard: ten PM clinics per working day");

    const visits: VisitForCallRate[] = [];
    // A perfect single working day: 2 AM + 10 PM, every one of them checked in.
    for (let i = 0; i < 2; i += 1) visits.push(visit({ ampm: "AM", contact_crm_id: 3000 + i }));
    for (let i = 0; i < 10; i += 1) visits.push(visit({ ampm: "PM", contact_crm_id: 4000 + i }));
    const checkins = visits.map((v) => checkin({ contact_crm_id: v.contact_crm_id }));

    const report = computeCallRate(visits, checkins, { dateFrom: "2026-08-01", dateTo: "2026-08-01" });
    const rep = report.reps[0];
    assert.equal(report.workingDays, 1, "a single Saturday is one working day");
    assert.equal(rep.am.verifiedRate, 2, "AM rate must be 2.0");
    assert.equal(rep.pm.verifiedRate, 10, "PM rate must be 10.0");
    assert.equal(rep.am.attainmentPct, 100, "2 against a target of 2 is 100%");
    assert.equal(rep.pm.attainmentPct, 100, "10 against a target of 10 is 100%");
  }

  // ── THE POINT OF THE MODULE: campaign calls must not lift the verified rate ──────
  {
    // One real verified visit, then eleven campaign calls — the shape that made a
    // fabricating rep look like he hit the daily standard.
    const visits: VisitForCallRate[] = [visit({ ampm: "PM", contact_crm_id: DOCTOR })];
    for (let i = 0; i < 11; i += 1) visits.push(campaignVisit({ ampm: "PM" }));

    const report = computeCallRate(visits, [checkin()], { dateFrom: "2026-08-01", dateTo: "2026-08-01" });
    const rep = report.reps[0];

    assert.equal(rep.pm.verified, 1, "only the one real visit is verified");
    assert.equal(rep.pm.campaign, 11, "the eleven campaign calls are counted, separately");
    assert.equal(rep.pm.verifiedRate, 1, "the HEADLINE rate must stay at 1.0");
    assert.equal(rep.pm.totalRate, 12, "the un-split total is what the old single number would have shown");
    assert.equal(rep.pm.attainmentPct, 10, "1 against a target of 10 is 10%, not 120%");
  }

  // ── A regular visit with no check-in is unverified, NOT campaign and NOT verified ─
  {
    const visits = [visit({ contact_crm_id: 777 })];
    const report = computeCallRate(visits, [], { dateFrom: "2026-08-01", dateTo: "2026-08-01" });
    const rep = report.reps[0];
    assert.equal(rep.pm.verified, 0, "no check-in means not verified");
    assert.equal(rep.pm.unverified, 1, "a real contact with no check-in is unverified");
    assert.equal(rep.pm.campaign, 0, "it is not a campaign call — it has a real contact");
    assert.equal(rep.pm.total, 1, "it still counts in the total");
  }

  // ── The daily campaign limit is 3, so 4 is the first flagged day ─────────────────
  {
    assert.equal(DAILY_CAMPAIGN_LIMIT, 3, "owner set the limit at three campaign calls per day");

    const threeOnSaturday = Array.from({ length: 3 }, () => campaignVisit({ visit_date: "2026-08-01" }));
    const fourOnSunday = Array.from({ length: 4 }, () => campaignVisit({ visit_date: "2026-08-02" }));
    const report = computeCallRate([...threeOnSaturday, ...fourOnSunday], [], {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-07",
    });
    const rep = report.reps[0];
    assert.equal(rep.campaignOverLimitDays.length, 1, "exactly one day exceeds the limit");
    assert.equal(rep.campaignOverLimitDays[0].day, "2026-08-02", "the four-call day is the flagged one");
    assert.equal(rep.campaignOverLimitDays[0].campaignCalls, 4);
    assert.equal(rep.campaignOverLimitDays[0].verifiedCalls, 0, "and it carried no verified visit at all");
    assert.equal(rep.campaignOnlyDays, 2, "both days were campaign-only");
    assert.equal(rep.campaignShare, 1, "every one of this rep's calls took the campaign route");
  }

  // ── Non-field work (leave, meetings, admin) is excluded from every count ─────────
  {
    const visits = [
      visit({ visit_type: -4, visit_type_description: "Annual Vacation", contact_crm_id: 0 }),
      visit({ visit_type: -19, visit_type_description: "Unknown", contact_crm_id: 0 }),
      visit({ visit_type: -9, visit_type_description: "Training", contact_crm_id: 0 }),
      visit({ contact_crm_id: DOCTOR }),
    ];
    const report = computeCallRate(visits, [checkin()], { dateFrom: "2026-08-01", dateTo: "2026-08-01" });
    const rep = report.reps[0];
    assert.equal(rep.pm.total, 1, "only the one regular visit is field work");
  }

  // ── An undocumented -30 row is real field work, and unverified without a check-in ─
  {
    const index = indexCheckinsByAgentContactDay([]);
    const proof = classifyCallProof(
      visit({ visit_type: -30, visit_type_description: "Unknown", comment: "د احمد" }),
      index,
    );
    assert.equal(proof, "unverified", "-30 is a real field visit; with no check-in it is unverified, not skipped");
  }

  // ── AM/PM normalisation: the vendor's live API sends mixed case ──────────────────
  {
    assert.equal(normalizeSession("AM"), "am");
    assert.equal(normalizeSession("Pm"), "pm", "the live API returns 'Pm' and 'pm' on the same rep-day");
    assert.equal(normalizeSession("pm"), "pm");
    assert.equal(normalizeSession(" am "), "am");
    assert.equal(normalizeSession(""), "unspecified");
    assert.equal(normalizeSession(null), "unspecified");

    const report = computeCallRate([visit({ ampm: "Pm" }), visit({ ampm: null, contact_crm_id: 888 })], [checkin()], {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
    });
    const rep = report.reps[0];
    assert.equal(rep.pm.verified, 1, "mixed-case 'Pm' must be counted as PM");
    assert.equal(rep.unspecified, 1, "a row with no AM/PM flag is counted separately, in neither slice");
    assert.equal(rep.am.total, 0, "and it must not be silently dropped into AM");
  }

  // ── A period with no working days yields null rates, never a divide-by-zero ──────
  {
    // 2026-08-06 is Thursday, 2026-08-07 is Friday — neither counts.
    assert.equal(countCallRateWorkingDays("2026-08-06", "2026-08-07"), 0);
    const report = computeCallRate([visit({ visit_date: "2026-08-06" })], [], {
      dateFrom: "2026-08-06",
      dateTo: "2026-08-07",
    });
    const rep = report.reps[0];
    assert.equal(rep.pm.verifiedRate, null, "no working days must give null, not Infinity or NaN");
    assert.equal(rep.pm.attainmentPct, null);
    // A Thursday visit is now GATED OUT of the numerator too (owner, 2026-09-05) — see the next
    // block. So the total is 0 here, not 1: nothing this rep did in this window is countable.
    assert.equal(rep.pm.total, 0, "a Thursday-only window counts nothing, numerator included");
  }

  // ── THE 2026-09-05 FIX: Thursday is gated out of the NUMERATOR too, not just the ──
  // ── denominator — a Thursday visit inside an otherwise-normal week must vanish ───
  {
    // Sat 2026-08-01 .. Fri 2026-08-07: one real week, 5 working days (Thu/Fri excluded).
    const visits = [
      visit({ visit_date: "2026-08-01", ampm: "AM", contact_crm_id: 5001 }), // Saturday — counts
      visit({ visit_date: "2026-08-06", ampm: "AM", contact_crm_id: 5002 }), // Thursday — must NOT
    ];
    const checkins = visits.map((v) => checkin({ contact_crm_id: v.contact_crm_id, check_date: `${v.visit_date}T10:55:00` }));
    const report = computeCallRate(visits, checkins, { dateFrom: "2026-08-01", dateTo: "2026-08-07" });
    const rep = report.reps[0];
    assert.equal(report.workingDays, 5, "Thu and Fri stay out of the denominator, as before");
    assert.equal(rep.am.verified, 1, "only the Saturday visit counts — the Thursday one must be gated out entirely");
    assert.equal(rep.am.verifiedRate, 0.2, "1 verified call over 5 working days, not 2 over 5");
  }

  // ── A reversed or malformed range is 0 days rather than an exception ─────────────
  {
    assert.equal(countCallRateWorkingDays("2026-08-31", "2026-08-01"), 0, "reversed range must be 0");
    assert.equal(countCallRateWorkingDays("garbage", "2026-08-01"), 0, "malformed range must be 0");
  }

  // ── August 2026 has 23 call-rate working days ────────────────────────────────────
  {
    // 2026-08-01 is a Saturday, so the month holds 5 Sat, 5 Sun, 5 Mon, 4 Tue, 4 Wed
    // (= 23 counted) plus 4 Thursdays and 4 Fridays (= 8 excluded), totalling 31.
    assert.equal(countCallRateWorkingDays("2026-08-01", "2026-08-31"), 23, "August 2026 has 23 call-rate working days");
    assert.equal(
      countCallRateWorkingDays("2026-08-01", "2026-08-31") +
        // the excluded half, counted independently so a wrong weekday set cannot pass both
        [6, 13, 20, 27, 7, 14, 21, 28].length,
      31,
      "counted + excluded must account for every day of the month",
    );
  }

  // ── Two reps are kept apart, and the worst campaign share sorts first ────────────
  {
    const clean = visit({ agent_crm_id: 200, agent_hr_id: "hr-2", agent_name: "Clean Rep", contact_crm_id: 999 });
    const report = computeCallRate(
      [visit(), campaignVisit(), campaignVisit(), campaignVisit(), clean],
      [checkin(), checkin({ agent_crm_id: 200, contact_crm_id: 999 })],
      { dateFrom: "2026-08-01", dateTo: "2026-08-01" },
    );
    assert.equal(report.reps.length, 2, "two distinct agents must produce two rows");
    assert.equal(report.reps[0].agentName, "Test Rep", "the heavier campaign user sorts first");
    assert.equal(report.reps[0].campaignShare, 0.75, "3 of 4 calls were campaign");
    assert.equal(report.reps[1].campaignShare, 0, "the clean rep has no campaign calls");
    assert.equal(report.reps[1].agentHrId, "hr-2", "each rep keeps its own hr id");
  }

  // ── PHARMACIES ARE NOT AM/PM (owner, 2026-09-05) ─────────────────────────────────
  {
    assert.equal(PHARMACY_CALL_RATE_TARGET, null, "no owner-set pharmacy target exists — never invent one");

    // A pharmacy visit tagged AM must be pulled OUT of the am slice entirely, whatever the flag says.
    const visits = [
      pharmacyVisit({ ampm: "AM", contact_crm_id: 6001 }),
      visit({ ampm: "AM", contact_crm_id: 6002 }), // a real doctor, still AM
    ];
    const checkins = visits.map((v) => checkin({ contact_crm_id: v.contact_crm_id }));
    const report = computeCallRate(visits, checkins, { dateFrom: "2026-08-01", dateTo: "2026-08-01" });
    const rep = report.reps[0];
    assert.equal(rep.am.verified, 1, "only the real doctor counts toward AM");
    assert.equal(rep.pharmacy.verified, 1, "the pharmacy visit lands in its own slice");
    assert.equal(rep.pharmacy.target, null, "the pharmacy slice carries no target");
    assert.equal(rep.pharmacy.attainmentPct, null, "with no target there can be no attainment percentage");
  }

  // ── A pharmacy visit with no AM/PM flag still counts as pharmacy, not "unspecified" ─
  {
    const report = computeCallRate([pharmacyVisit({ ampm: null })], [checkin()], {
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
    });
    const rep = report.reps[0];
    assert.equal(rep.pharmacy.verified, 1, "an untagged pharmacy row is still a pharmacy call");
    assert.equal(rep.unspecified, 0, "it must not also land in the untagged bucket");
  }

  // ── An unlabelled -30 field visit with a pharmacy-flavored comment is pharmacy too ─
  {
    const row = visit({ visit_type: -30, visit_type_description: "Unknown", comment: "صيدلية النور", speciality: null });
    assert.equal(isPharmacyVisit(row), true, "the free-text pharmacy marker routes a -30 row to pharmacy");
    assert.equal(
      isPharmacyVisit(visit({ visit_type: -30, visit_type_description: "Unknown", comment: "د احمد" })),
      false,
      "a -30 row with no pharmacy signal in either field stays out of the pharmacy slice",
    );
  }

  // ── A rep with zero pharmacy calls still gets a fully finalized, non-null slice ───
  {
    const report = computeCallRate([visit()], [checkin()], { dateFrom: "2026-08-01", dateTo: "2026-08-01" });
    const rep = report.reps[0];
    assert.equal(rep.pharmacy.verified, 0);
    assert.equal(rep.pharmacy.verifiedRate, 0, "zero pharmacy calls over real working days is 0.00, not null");
  }

  // ── A Phoenix pharmacy call is a pharmacy by its LIST, with no speciality at all (re-audit 2026-10-22) ─
  {
    // The pharmacy a rep added in Phoenix carries no speciality; the unified view hands its list over as
    // ampm = 'Pharmacy'. 257 such October calls were filed under "unspecified" — counted in no lane.
    const phoenixPharmacy = visit({ ampm: "Pharmacy", speciality: null, source: "phoenix", crm_visit_id: -9001 });
    assert.equal(isPharmacyVisit(phoenixPharmacy), true, "ampm = 'Pharmacy' is a pharmacy whatever the speciality says");
    assert.equal(isPharmacyVisit(visit({ ampm: "PM", speciality: null })), false, "a PM doctor visit stays a doctor visit");

    const report = computeCallRate([phoenixPharmacy], [], { dateFrom: "2026-08-01", dateTo: "2026-08-01" });
    const rep = report.reps[0];
    assert.equal(rep.pharmacy.verified, 1, "the Phoenix pharmacy call lands in the pharmacy lane, proved by itself");
    assert.equal(rep.unspecified, 0, "and never in 'unspecified'");
    assert.equal(rep.pm.verified + rep.pm.unverified, 0, "nor among the PM doctors");
  }
}
