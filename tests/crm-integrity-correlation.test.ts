import assert from "node:assert/strict";

import {
  CRM_INTEGRITY_IMPOSSIBLE_SPEED_KMH,
  correlateVisitsWithCheckins,
  type CrmIntegrityCheckinInput,
  type CrmIntegrityVisitInput,
} from "../src/lib/crm-integrity/correlation.ts";
import { haversineKm } from "../src/lib/sales/normalizer/geo-validate.ts";

function visit(overrides: Partial<CrmIntegrityVisitInput> & { agentCrmId: number; crmVisitId: number; visitDate: string }): CrmIntegrityVisitInput {
  return {
    contactCrmId: null,
    crmSaveDate: null,
    visitDateTime: null,
    ...overrides,
  };
}

function checkin(
  overrides: Partial<CrmIntegrityCheckinInput> & { agentCrmId: number; checkDate: string; crmCheckinId: number },
): CrmIntegrityCheckinInput {
  return {
    address: null,
    contactCrmId: null,
    contactName: null,
    lat: null,
    lon: null,
    ...overrides,
  };
}

export function runCrmIntegrityCorrelationTests() {
  // ── Exact contact-id match wins over pure time-proximity ─────────────────────────
  {
    const v = visit({ agentCrmId: 100, contactCrmId: 555, crmVisitId: 1, visitDate: "2026-07-01", visitDateTime: "2026-07-01T14:00:00Z" });
    const closeButWrongContact = checkin({ agentCrmId: 100, checkDate: "2026-07-01T14:05:00Z", contactCrmId: 999, crmCheckinId: 10 });
    const farButRightContact = checkin({ agentCrmId: 100, checkDate: "2026-07-01T09:00:00Z", contactCrmId: 555, crmCheckinId: 11 });
    const [result] = correlateVisitsWithCheckins([v], [closeButWrongContact, farButRightContact], []);
    assert.equal(result.contactMatchState, "exact_contact_match", "exact contact_crm_id match must win even though it's further away in time");
    assert.equal(result.checkinContactCrmId, 555);
  }

  // ── Fallback to nearest-in-time when no check-in shares the visit's contact ──────
  {
    const v = visit({ agentCrmId: 200, contactCrmId: 777, crmVisitId: 2, visitDate: "2026-07-02", visitDateTime: "2026-07-02T10:00:00Z" });
    const nearer = checkin({ agentCrmId: 200, checkDate: "2026-07-02T10:10:00Z", contactCrmId: 888, crmCheckinId: 20 });
    const farther = checkin({ agentCrmId: 200, checkDate: "2026-07-02T15:00:00Z", contactCrmId: 999, crmCheckinId: 21 });
    const [result] = correlateVisitsWithCheckins([v], [nearer, farther], []);
    assert.equal(result.contactMatchState, "nearest_different_contact");
    assert.equal(result.checkinContactCrmId, 888, "of two non-matching contacts, the nearest-in-time one must be picked");
  }

  // ── No check-in at all ────────────────────────────────────────────────────────────
  {
    const v = visit({ agentCrmId: 300, contactCrmId: 111, crmVisitId: 3, visitDate: "2026-07-03" });
    const [result] = correlateVisitsWithCheckins([v], [], []);
    assert.equal(result.contactMatchState, "no_checkin");
    assert.equal(result.checkinDate, null);
    assert.equal(result.saveLagFlag, null, "can't compute a save-lag gap against nothing");
    assert.equal(result.speedFeasibilityFlag, null);
  }

  // ── Save-lag flag: same-day vs. next-day-or-later, and null when unmatched/unsaved ─
  {
    const sameDayVisit = visit({
      agentCrmId: 400,
      crmSaveDate: "2026-07-04T18:00:00Z",
      crmVisitId: 4,
      visitDate: "2026-07-04",
    });
    const sameDayCheckin = checkin({ agentCrmId: 400, checkDate: "2026-07-04T10:00:00Z", crmCheckinId: 40 });

    const lateVisit = visit({
      agentCrmId: 401,
      crmSaveDate: "2026-07-06T09:00:00Z",
      crmVisitId: 5,
      visitDate: "2026-07-04",
    });
    const lateCheckin = checkin({ agentCrmId: 401, checkDate: "2026-07-04T20:00:00Z", crmCheckinId: 41 });

    const noSaveDateVisit = visit({ agentCrmId: 402, crmVisitId: 6, visitDate: "2026-07-04" });
    const noSaveDateCheckin = checkin({ agentCrmId: 402, checkDate: "2026-07-04T08:00:00Z", crmCheckinId: 42 });

    const [sameDayResult, lateResult, noSaveDateResult] = correlateVisitsWithCheckins(
      [sameDayVisit, lateVisit, noSaveDateVisit],
      [sameDayCheckin, lateCheckin, noSaveDateCheckin],
      [],
    );

    assert.equal(sameDayResult.saveLagFlag, "same_day");
    assert.equal(sameDayResult.saveLagHours, 8, "18:00 minus 10:00 on the same day is an 8-hour gap");

    assert.equal(lateResult.saveLagFlag, "next_day_or_later");
    assert.ok(lateResult.saveLagHours != null && lateResult.saveLagHours > 24, "a save two calendar days later must report a multi-day hour gap");

    assert.equal(noSaveDateResult.saveLagFlag, null, "no crm_save_date on the visit means no lag can be computed");
    assert.equal(noSaveDateResult.saveLagHours, null);
  }

  // ── Haversine-based speed-feasibility: threshold boundary ────────────────────────
  {
    // Two real points ~11km apart (0.1 degree of latitude) -- computed via the real haversineKm,
    // not hand-derived, so the test doesn't depend on guessing the formula's exact output.
    const distanceKm = haversineKm(30.0444, 31.2357, 30.1444, 31.2357);

    const flaggingHours = distanceKm / 190; // implies ~190 km/h -> exceeds the 180 km/h threshold
    const okHours = distanceKm / 170; // implies ~170 km/h -> under the threshold
    const start = new Date("2026-07-05T06:00:00Z").getTime();

    const flaggingFirst = checkin({ agentCrmId: 500, checkDate: new Date(start).toISOString(), crmCheckinId: 50, lat: 30.0444, lon: 31.2357 });
    const flaggingSecond = checkin({
      agentCrmId: 500,
      checkDate: new Date(start + flaggingHours * 3600000).toISOString(),
      crmCheckinId: 51,
      lat: 30.1444,
      lon: 31.2357,
    });
    const flaggingVisit = visit({ agentCrmId: 500, crmVisitId: 7, visitDate: flaggingSecond.checkDate.slice(0, 10), visitDateTime: flaggingSecond.checkDate });

    const okFirst = checkin({ agentCrmId: 501, checkDate: new Date(start).toISOString(), crmCheckinId: 52, lat: 30.0444, lon: 31.2357 });
    const okSecond = checkin({
      agentCrmId: 501,
      checkDate: new Date(start + okHours * 3600000).toISOString(),
      crmCheckinId: 53,
      lat: 30.1444,
      lon: 31.2357,
    });
    const okVisit = visit({ agentCrmId: 501, crmVisitId: 8, visitDate: okSecond.checkDate.slice(0, 10), visitDateTime: okSecond.checkDate });

    const [flaggingResult, okResult] = correlateVisitsWithCheckins(
      [flaggingVisit, okVisit],
      [flaggingFirst, flaggingSecond, okFirst, okSecond],
      [],
    );

    assert.equal(flaggingResult.speedFeasibilityFlag, "impossible_speed");
    assert.ok(flaggingResult.impliedSpeedKmh != null && flaggingResult.impliedSpeedKmh > CRM_INTEGRITY_IMPOSSIBLE_SPEED_KMH);

    assert.equal(okResult.speedFeasibilityFlag, "ok");
    assert.ok(okResult.impliedSpeedKmh != null && okResult.impliedSpeedKmh < CRM_INTEGRITY_IMPOSSIBLE_SPEED_KMH);
  }

  // ── First-check-in-of-window edge case: the lookback day supplies a real predecessor ─
  {
    // ~200km apart (30.0444N vs 31.8444N), only 20 minutes apart across the midnight boundary
    // -> unambiguously impossible regardless of haversine's exact output (~200km / (1/3)h ≈ 600
    // km/h), so the assertion doesn't depend on hand-verifying a borderline value.
    const lookbackCheckin = checkin({ agentCrmId: 600, checkDate: "2026-06-30T23:45:00Z", crmCheckinId: 60, lat: 30.0444, lon: 31.2357 });
    const inWindowCheckin = checkin({ agentCrmId: 600, checkDate: "2026-07-01T00:05:00Z", crmCheckinId: 61, lat: 31.8444, lon: 31.2357 });
    const v = visit({ agentCrmId: 600, crmVisitId: 9, visitDate: "2026-07-01" });

    const results = correlateVisitsWithCheckins([v], [inWindowCheckin], [lookbackCheckin]);

    assert.equal(results.length, 1, "the lookback check-in must never produce its own output row");
    const [result] = results;
    assert.equal(result.contactMatchState, "nearest_different_contact");
    assert.ok(result.distanceFromPreviousCheckinKm != null, "the window's first check-in must still get a distance computed against the lookback day's check-in, not treated as having no history");
    assert.equal(result.speedFeasibilityFlag, "impossible_speed");
    assert.ok(result.impliedSpeedKmh != null && result.impliedSpeedKmh > CRM_INTEGRITY_IMPOSSIBLE_SPEED_KMH);
  }
}
