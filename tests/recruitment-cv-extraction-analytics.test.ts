import assert from "node:assert/strict";

import {
  summarizeCvExtractionAccuracy,
  type ExtractionReviewRow,
} from "../src/lib/recruitment/cv-extraction-analytics.ts";

function row(overrides: Partial<ExtractionReviewRow>): ExtractionReviewRow {
  return {
    appliedFields: {},
    extractedFields: {},
    positionKey: "medical_rep",
    ...overrides,
  };
}

export function runRecruitmentCvExtractionAnalyticsTests() {
  // --- empty input ---------------------------------------------------------------------------
  assert.deepEqual(summarizeCvExtractionAccuracy([]), {
    byPosition: [],
    overallCorrectionRate: 0,
    overallTotalReviewed: 0,
  });

  // --- a field never corrected -> 0% correction rate ------------------------------------------
  const neverCorrected = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { fullName: "Jane Doe" },
      extractedFields: { fullName: { confidence: "high", value: "Jane Doe" } },
    }),
    row({
      appliedFields: { fullName: "John Smith" },
      extractedFields: { fullName: { confidence: "high", value: "John Smith" } },
    }),
  ]);
  assert.equal(neverCorrected.overallTotalReviewed, 2);
  assert.equal(neverCorrected.overallCorrectionRate, 0);
  assert.equal(neverCorrected.byPosition[0].fields[0].correctionRate, 0);
  assert.equal(neverCorrected.byPosition[0].fields[0].correctedCount, 0);
  assert.equal(neverCorrected.byPosition[0].fields[0].proposedCount, 2);
  assert.equal(neverCorrected.byPosition[0].fields[0].notProposedCount, 0);

  // --- a field always corrected -> 100% correction rate ---------------------------------------
  const alwaysCorrected = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { governorate: "Cairo" },
      extractedFields: { governorate: { confidence: "low", value: "Giza" } },
    }),
  ]);
  assert.equal(alwaysCorrected.byPosition[0].fields[0].correctionRate, 1);
  assert.equal(alwaysCorrected.overallCorrectionRate, 1);

  // --- mixed: field sorted worst-first ---------------------------------------------------------
  const mixed = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { email: "a@b.com", phone: "0100" },
      extractedFields: {
        email: { confidence: "high", value: "a@b.com" }, // never corrected
        phone: { confidence: "low", value: "0999" }, // corrected
      },
    }),
    row({
      appliedFields: { email: "c@d.com", phone: "0200" },
      extractedFields: {
        email: { confidence: "high", value: "c@d.com" },
        phone: { confidence: "low", value: "wrong" },
      },
    }),
  ]);
  const fields = mixed.byPosition[0].fields;
  assert.equal(fields[0].fieldKey, "phone", "worst (100% corrected) field sorts first");
  assert.equal(fields[0].correctionRate, 1);
  assert.equal(fields[1].fieldKey, "email");
  assert.equal(fields[1].correctionRate, 0);
  // 2 corrections out of 4 total field-checks (2 rows x 2 fields) = 50%
  assert.equal(mixed.overallCorrectionRate, 0.5);

  // --- whitespace-only differences don't count as a correction --------------------------------
  const whitespaceOnly = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { fullName: "Jane Doe" },
      extractedFields: { fullName: { confidence: "high", value: "  Jane Doe  " } },
    }),
  ]);
  assert.equal(whitespaceOnly.byPosition[0].fields[0].correctionRate, 0, "trimmed values must compare equal");

  // --- null/undefined/empty-string normalize to the same "empty" value ------------------------
  const emptyEquivalence = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { medicalRepEmployer: null },
      extractedFields: { medicalRepEmployer: { confidence: "low", value: "" } },
    }),
  ]);
  assert.equal(
    emptyEquivalence.byPosition[0].fields[0].correctionRate,
    0,
    "an empty-string AI proposal vs a null saved value should not count as a correction",
  );
  assert.equal(
    emptyEquivalence.byPosition[0].fields[0].proposedCount,
    0,
    "an empty-string proposal is not a proposal, so it must not sit in the rate's denominator",
  );

  // --- a field missing from appliedFields entirely (undefined) counts as corrected if the AI
  //     proposed a real value ------------------------------------------------------------------
  const missingApplied = summarizeCvExtractionAccuracy([
    row({
      appliedFields: {},
      extractedFields: { faculty: { confidence: "high", value: "Pharmacy" } },
    }),
  ]);
  assert.equal(missingApplied.byPosition[0].fields[0].correctionRate, 1);

  // --- THE OVER-COUNT: a field the AI proposed nothing for is not a correction -----------------
  // The review board saves every schema field and seeds the empty ones from the candidate record
  // (seedReviewFieldsFromCandidate), so a value lands in applied_fields for fields the AI honestly
  // reported finding nothing in. Diffing those scored the AI as wrong for not guessing.
  const unproposed = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { governorate: "Cairo", phone: "01000000000" },
      extractedFields: {
        governorate: { confidence: "low", value: null }, // AI found nothing; TA's saved value seeded
        phone: { confidence: "high", value: "01000000000" }, // AI proposed, kept as-is
      },
    }),
  ]);
  const unproposedGovernorate = unproposed.byPosition[0].fields.find((f) => f.fieldKey === "governorate");
  assert.ok(unproposedGovernorate, "governorate must still be reported, not dropped");
  assert.equal(
    unproposedGovernorate.correctedCount,
    0,
    "a field the AI proposed nothing for must never count as a human correction",
  );
  assert.equal(unproposedGovernorate.proposedCount, 0, "an unproposed field must not enter the denominator");
  assert.equal(unproposedGovernorate.notProposedCount, 1, "it must be reported as not-found, not silently dropped");
  assert.equal(
    unproposed.overallCorrectionRate,
    0,
    "overall rate must count only the one real proposal, which was kept — not 1 of 2 'corrected'",
  );

  // --- a boolean false IS a proposal, and correcting it still counts --------------------------
  const booleanFinding = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { hasMedicalRepExperience: true },
      extractedFields: { hasMedicalRepExperience: { confidence: "low", value: false } },
    }),
  ]);
  assert.equal(
    booleanFinding.byPosition[0].fields[0].proposedCount,
    1,
    "false means 'no medical rep experience' — a real finding, not an empty field",
  );
  assert.equal(booleanFinding.byPosition[0].fields[0].correctionRate, 1, "overturning a false must count as a correction");

  // --- a field the AI never once proposed reports 0%, not 100% --------------------------------
  const neverProposed = summarizeCvExtractionAccuracy([
    row({
      appliedFields: { university: "Cairo University" },
      extractedFields: { university: { confidence: "low", value: null } },
    }),
    row({
      appliedFields: { university: "Ain Shams" },
      extractedFields: { university: { confidence: "low", value: null } },
    }),
  ]);
  assert.equal(neverProposed.byPosition[0].fields[0].correctionRate, 0);
  assert.equal(neverProposed.byPosition[0].fields[0].notProposedCount, 2);
  assert.equal(neverProposed.overallCorrectionRate, 0, "no proposals at all means no correction rate, not a perfect miss");

  // --- per-position breakdown splits correctly, sorted by totalReviewed descending -------------
  const perPosition = summarizeCvExtractionAccuracy([
    row({ positionKey: "medical_rep", appliedFields: { fullName: "A" }, extractedFields: { fullName: { confidence: "high", value: "A" } } }),
    row({ positionKey: "medical_rep", appliedFields: { fullName: "B" }, extractedFields: { fullName: { confidence: "high", value: "B" } } }),
    row({
      positionKey: "district_manager",
      appliedFields: { fullName: "C" },
      extractedFields: { fullName: { confidence: "high", value: "Wrong" } },
    }),
  ]);
  assert.equal(perPosition.byPosition.length, 2);
  assert.equal(perPosition.byPosition[0].positionKey, "medical_rep", "more-reviewed position sorts first");
  assert.equal(perPosition.byPosition[0].totalReviewed, 2);
  assert.equal(perPosition.byPosition[1].positionKey, "district_manager");
  assert.equal(perPosition.byPosition[1].totalReviewed, 1);
  assert.equal(perPosition.byPosition[1].fields[0].correctionRate, 1);
  // Overall spans both positions: 1 correction out of 3 total field-checks.
  assert.equal(Math.round(perPosition.overallCorrectionRate * 100) / 100, Math.round((1 / 3) * 100) / 100);
}
