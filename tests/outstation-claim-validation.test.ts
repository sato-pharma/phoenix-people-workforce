import assert from "node:assert/strict";

import {
  BRICK_WEAK_MATCH_KM,
  CLAIM_PROXIMITY_KM,
  cairoClockMinutes,
  checkBrickScope,
  checkDoubleVisitPartner,
  checkLocationVsCheckin,
  checkSubmissionTiming,
  evaluateOutstationClaim,
  vendorClockMinutes,
  type FraudCheckInput,
} from "../src/lib/outstation/expense-fraud-checks.ts";

// Claim validation for outstation expenses (owner request 2026-08-08). Four advisory checks that
// ask whether independent CRM evidence corroborates a claim.
//
// The rule this file exists to defend, above all the others: MISSING DATA IS NEVER A FINDING.
// Measured against live production — of 29 GPS-carrying requests since 2026-07-01, ZERO had a
// check-in by the submitter (managers do not check in, their reps do) and only 14 had one from a
// double-visit partner. Roughly half of every claim has nothing to compare against. If absence
// rendered as suspicion this feature would accuse half the company on its first day, and the
// precedent for that mistake is 14,629.01 EGP of wrong deductions against seven real medical reps
// when NULL agent_hr_id was read as "no CRM activity" (src/lib/crm/sync.ts).
//
// Every "no rows" assertion below is therefore load-bearing, not defensive padding.

/** A claim where everything lines up. Individual tests override one field at a time. */
function baseInput(overrides: Partial<FraudCheckInput> = {}): FraudCheckInput {
  return {
    capturedBrick: { areaCode: "KFS1", brickName: "Sidi Talha", distanceKm: 0.5 },
    capturedLatitude: 31.1140501,
    capturedLongitude: 30.9380045,
    firstCheckin: {
      address: "Qism Kafr El-Shaikh",
      at: "2026-08-05T12:39:00",
      lat: 31.1,
      lon: 30.95,
      via: "Ragaa.Mosad",
    },
    firstVisitSavedAt: "2026-08-05T13:02:00",
    partners: [{ hrId: "B-107", name: "Ragaa.Mosad", source: "visit_partner" }],
    repAreaCodes: ["KFS1"],
    // 17:29 Cairo on the trip day.
    submittedAt: "2026-08-05T14:29:44.000Z",
    tripDay: "2026-08-05",
    ...overrides,
  };
}

export function runOutstationClaimValidationTests() {
  // ── Missing data is never a finding ──────────────────────────────────────────

  assert.equal(
    checkLocationVsCheckin(
      baseInput({ firstCheckin: { address: null, at: null, lat: null, lon: null, via: null } }),
    ).verdict,
    "unverifiable",
    "a check-in with NULL coordinates must be unverifiable, never review — an absent fix is not a distant one",
  );

  assert.equal(
    checkLocationVsCheckin(baseInput({ firstCheckin: null })).verdict,
    "unverifiable",
    "no check-in at all on the day must be unverifiable — this is the majority case in production, not an anomaly",
  );

  assert.equal(
    checkLocationVsCheckin(baseInput({ capturedLatitude: 0, capturedLongitude: 0 })).verdict,
    "unverifiable",
    "0,0 is the Gulf of Guinea — a failed browser geolocation, and must never be measured as a real distance",
  );

  assert.equal(
    checkDoubleVisitPartner(baseInput({ partners: [] })).verdict,
    "unverifiable",
    "no double visit recorded must be unverifiable — a manager who cannot be paired simply has no corroboration, which is not suspicion",
  );

  assert.equal(
    checkBrickScope(baseInput({ repAreaCodes: [] })).verdict,
    "unverifiable",
    "an unresolved rep territory must be unverifiable — an empty scope means UNKNOWN, never 'outside every area'",
  );

  assert.equal(
    checkBrickScope(baseInput({ capturedBrick: null })).verdict,
    "unverifiable",
    "a point that matched no brick cannot be judged against a territory",
  );

  // ── Distance boundary ────────────────────────────────────────────────────────

  {
    // Same longitude, latitude offset chosen so the two points sit either side of 5 km.
    const near = checkLocationVsCheckin(
      baseInput({
        capturedLatitude: 31.1,
        capturedLongitude: 30.95,
        firstCheckin: { address: null, at: null, lat: 31.14, lon: 30.95, via: null },
      }),
    );
    assert.equal(near.verdict, "clean", "≈4.4 km apart is inside the 5 km allowance and must pass");

    const far = checkLocationVsCheckin(
      baseInput({
        capturedLatitude: 31.1,
        capturedLongitude: 30.95,
        firstCheckin: { address: null, at: null, lat: 31.25, lon: 30.95, via: null },
      }),
    );
    assert.equal(far.verdict, "review", "≈16.7 km apart is well beyond the allowance and must be flagged");
    assert.ok(
      far.detail.includes("km"),
      "a distance finding must state the actual distance — a reviewer cannot act on 'too far'",
    );
  }

  assert.equal(CLAIM_PROXIMITY_KM, 5, "the proximity threshold is the owner's 5 km, shared with the departure-photo check");

  // ── Brick scope ──────────────────────────────────────────────────────────────

  assert.equal(
    checkBrickScope(baseInput({ repAreaCodes: ["GZ6", "UE9"] })).verdict,
    "review",
    "a captured area outside every area the rep covers is a real finding",
  );

  assert.equal(
    checkBrickScope(baseInput({ repAreaCodes: ["kfs1"] })).verdict,
    "clean",
    "area codes must compare case-insensitively — a casing difference between sources is not a territory breach",
  );

  {
    // Weak match beats mismatch: a far centroid means the CENTRE is wrong, not the employee.
    const weakAndMismatched = checkBrickScope(
      baseInput({
        capturedBrick: { areaCode: "OTHER", brickName: "Far brick", distanceKm: 24 },
        repAreaCodes: ["KFS1"],
      }),
    );
    assert.equal(
      weakAndMismatched.verdict,
      "unverifiable",
      "a brick matched 24 km away is a mis-geocoded centroid, and must be unverifiable even though its area code also mismatches — the weak match outranks the mismatch",
    );
  }

  assert.equal(BRICK_WEAK_MATCH_KM, 10, "the weak-match band mirrors brick-geo's own Review/Weak boundary");

  // ── Timing ───────────────────────────────────────────────────────────────────

  assert.equal(
    checkSubmissionTiming(baseInput()).verdict,
    "clean",
    "filed at 17:29 after a 12:39 first check-in on the same day is ordinary",
  );

  {
    // 06:10 Cairo = 04:10Z, before the 12:39 first check-in.
    const early = checkSubmissionTiming(baseInput({ submittedAt: "2026-08-05T04:10:00.000Z" }));
    assert.equal(
      early.verdict,
      "review",
      "filing the claim BEFORE the day's first recorded activity is the genuinely suspicious case",
    );
    assert.ok(
      early.detail.includes("BEFORE"),
      "the finding must say plainly that it was filed before the work, not merely report two times",
    );
  }

  assert.equal(
    checkSubmissionTiming(baseInput({ submittedAt: "2026-08-04T14:00:00.000Z" })).verdict,
    "review",
    "filing on a day before the trip happened at all must be flagged",
  );

  assert.equal(
    checkSubmissionTiming(baseInput({ submittedAt: "2026-08-06T06:00:00.000Z" })).verdict,
    "clean",
    "filing the morning AFTER the trip is ordinary behaviour and must not be flagged — a check that fires on normal behaviour trains people to ignore it",
  );

  assert.equal(
    checkSubmissionTiming(
      baseInput({
        firstCheckin: { address: null, at: "2026-08-05T00:00:00", lat: 31.1, lon: 30.95, via: null },
        firstVisitSavedAt: "2026-08-05T00:00:00",
      }),
    ).verdict,
    "unverifiable",
    "midnight is iReports360's date-only placeholder (visit_date_time is 00:00 on ~100% of rows) and must never be read as 'captured at midnight'",
  );

  assert.equal(
    checkSubmissionTiming(
      baseInput({
        firstCheckin: { address: null, at: "2026-08-05T12:39:00", lat: 31.1, lon: 30.95, via: null },
        firstVisitSavedAt: "2026-08-05T00:00:00",
      }),
    ).verdict,
    "clean",
    "a midnight visit timestamp must fall back to the real check-in clock rather than poisoning the comparison",
  );

  assert.equal(
    checkSubmissionTiming(baseInput({ submittedAt: null })).verdict,
    "unverifiable",
    "no submission time recorded means nothing can be placed against the day",
  );

  // ── Clock parsing ────────────────────────────────────────────────────────────

  assert.equal(
    vendorClockMinutes("2026-08-05T12:39:00"),
    12 * 60 + 39,
    "a vendor timestamp must be read straight off the string — new Date() would re-interpret Cairo wall-clock as UTC and shift it by hours",
  );
  assert.equal(
    vendorClockMinutes("2026-08-05T00:00:00"),
    null,
    "the midnight placeholder must parse as 'no time', not as minute zero",
  );
  assert.equal(vendorClockMinutes(null), null, "an absent vendor timestamp has no clock");

  {
    // DST: Egypt is UTC+2 in winter and UTC+3 in summer. The same UTC instant must therefore
    // yield DIFFERENT Cairo wall-clock minutes in January and July — a fixed offset would not.
    const january = cairoClockMinutes("2026-01-15T10:00:00.000Z");
    const july = cairoClockMinutes("2026-07-15T10:00:00.000Z");
    assert.equal(january, 12 * 60, "10:00Z in January is 12:00 Cairo (UTC+2)");
    assert.equal(july, 13 * 60, "10:00Z in July is 13:00 Cairo (UTC+3) — DST is observed again since 2023");
    assert.notEqual(
      january,
      july,
      "a hardcoded UTC offset would return the same minutes year-round and mis-read every submission near midnight for half the year",
    );
  }

  // ── Headline precedence ──────────────────────────────────────────────────────

  {
    const allClean = evaluateOutstationClaim(baseInput());
    assert.equal(allClean.headline, "clean", "four passing checks give a clean headline");
    assert.equal(allClean.checks.length, 4, "every check must be reported, including the ones that passed");
  }

  {
    const oneReview = evaluateOutstationClaim(baseInput({ repAreaCodes: ["GZ6"] }));
    assert.equal(
      oneReview.headline,
      "review",
      "a single review outranks three clean checks — surfacing the one thing worth a look is the point of the panel",
    );
  }

  {
    const oneUnverifiable = evaluateOutstationClaim(baseInput({ partners: [] }));
    assert.equal(
      oneUnverifiable.headline,
      "unverifiable",
      "unverifiable must outrank clean — a partly-blind result must never present itself as a clean bill of health",
    );
  }

  {
    const nothing = evaluateOutstationClaim(
      baseInput({
        capturedBrick: null,
        firstCheckin: null,
        firstVisitSavedAt: null,
        partners: [],
        repAreaCodes: [],
        submittedAt: null,
      }),
    );
    assert.equal(nothing.headline, "unverifiable", "a claim with no corroborating data anywhere is unverifiable");
    assert.ok(
      nothing.checks.every((check) => check.verdict === "unverifiable"),
      "with no data at all, NOT ONE check may report a finding — this is the half-of-production case",
    );
  }

  // ── Multiple partners ────────────────────────────────────────────────────────

  {
    // Real case: Dina Bdair 2026-08-05 was tagged by two reps, only one of whom had check-ins.
    const twoPartners = checkDoubleVisitPartner(
      baseInput({
        partners: [
          { hrId: "B-107", name: "Ragaa.Mosad", source: "visit_partner" },
          { hrId: "AI-0006", name: "Mohamed.Yasser", source: "visit_partner" },
        ],
      }),
    );
    assert.equal(twoPartners.verdict, "clean", "being with two reps in a day is normal, not a finding");
    assert.ok(
      twoPartners.detail.includes("Ragaa.Mosad") && twoPartners.detail.includes("Mohamed.Yasser"),
      "both reps must be named — a reviewer needs to know who the day is being corroborated against",
    );
  }
}
