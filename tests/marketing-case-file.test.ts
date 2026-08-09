import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  buildCaseFileWarnings,
  caseFileRoiFilters,
  describeLifecycleStage,
  getMarketingRequestCaseFile,
  hasCompanyWideMarketingClaim,
  resolveCaseFileAdmission,
  resolveOutcomeBlock,
  resolveReferenceStatus,
} from "../src/lib/marketing-requests/case-file-service.ts";
import {
  caseFileNotApplicable,
  caseFileOk,
  caseFileUnavailable,
  caseFileValueOr,
  type MarketingCaseFileTargetPharmacies,
  type MarketingCaseFileTargetPharmacy,
  type MarketingCaseFileWarning,
  type MarketingCaseFileWarningKey,
} from "../src/lib/marketing-requests/case-file-types.ts";
import type { MarketingDecisionPharmacy } from "../src/lib/marketing-requests/request-loaders.ts";
import type { RoiConfidence } from "../src/lib/marketing-requests/roi-confidence.ts";
import { resolveRoiStatusScope } from "../src/lib/marketing-requests/roi-report-service.ts";
import type { MarketingRoiReportRow } from "../src/lib/marketing-requests/roi-report-types.ts";
import { roiLifecycleStage } from "../src/lib/marketing-requests/roi-live-stages.ts";

// The Case File data layer. Every assertion below calls the REAL exported function — no source-text
// matching, no mocks of the thing under test. The pure decision functions run without a database;
// the two service-level assertions exercise gates that throw before any Supabase call.
//
// What each group protects:
//
//  1. THE BLOCK CONTRACT. "the read failed" and "there is nothing here yet" must never collapse
//     into the same shape. The module's recurring defect is exactly that collapse — the approval
//     screen's double-count check is `.catch(() => [])`, so a check that fell over renders
//     identically to one that passed.
//
//  2. THE STATUS-SCOPE TRAP. resolveRoiStatusScope defaults an empty status list to the five
//     APPROVED statuses, and the ROI index only loads requests carrying a pay date. So a draft,
//     returned or rejected request is silently ABSENT from getMarketingRoiReport — which is
//     precisely the population this feature exists to surface, since those three have no surface
//     at all today. Invisible against the only live Phoenix request (approved, so it passes
//     either way), which is why it needs a test rather than a look.
//
//  3. TOO EARLY vs NO SALES. Measured live: MKT-REQ-20260802-DCF31EC4's window is 2026-08 →
//     2026-12 while validated sales end 2026-07. Zero attributed sales is CORRECT there and means
//     "not due yet" — but the existing screen says "No sales matched in this period range", and
//     its honest warning only fires when salesDataAsOf is missing entirely, so it never fires.
//
//  4. ADMISSION. One union gate. Broad enough to admit every participant (including CC reviewers
//     and rungs that have not opened yet), closed on a missing HR_ID and on a failed lookup.

function ctx(
  role: PhoenixRole,
  overrides: Partial<AccessContext> = {},
): AccessContext {
  return {
    hrId: "A-1",
    loginId: "a-1",
    role,
    scope: "line",
    source: "session",
    ...overrides,
  };
}

const SOME_REQUEST_ID = "00000000-0000-0000-0000-000000000001";

// ── 1. the CaseFileBlock state machine ───────────────────────────────────────

function testBlockStatesAreDistinguishable() {
  const ok = caseFileOk({ total: 0 });
  const unavailable = caseFileUnavailable<{ total: number }>("the read failed");
  const notApplicable = caseFileNotApplicable<{ total: number }>("no pay date yet");

  assert.equal(ok.state, "ok");
  assert.equal(unavailable.state, "unavailable");
  assert.equal(notApplicable.state, "not_applicable");

  // The whole point: a zeroed OK and a failed read are different objects, and neither carries the
  // other's fields. A consumer that only checks truthiness cannot conflate them.
  assert.notEqual(
    unavailable.state,
    notApplicable.state,
    "'the read failed' and 'this does not exist yet' must never share a state — they are opposite facts",
  );
  assert.equal("value" in unavailable, false, "a failed block must carry NO value to accidentally render as zero");
  assert.equal("value" in notApplicable, false, "a not-applicable block must carry NO value to accidentally render as zero");

  assert.equal(caseFileValueOr(ok, { total: -1 }).total, 0, "an ok block folds to its own value");
  assert.equal(
    caseFileValueOr(unavailable, { total: -1 }).total,
    -1,
    "an unavailable block must fold to the caller's fallback, never to a silent zero of its own",
  );
}

function testBlockReasonsAreAlwaysProse() {
  for (const block of [
    caseFileUnavailable<null>("The ROI engine could not be read."),
    caseFileNotApplicable<null>("No pay date is set."),
  ]) {
    assert.ok(block.state !== "ok" && block.reason.length > 10, "every non-ok block must carry a readable reason, never a bare code");
  }
}

// ── 2. the status-scope trap ─────────────────────────────────────────────────

/** The statuses the ROI engine drops unless the caller names them. */
const SILENTLY_DROPPED_STATUSES = ["draft", "returned", "rejected", "pending_approval", "pending_validation", "archived"] as const;

function testCaseFileAlwaysNamesTheRequestStatus() {
  for (const status of SILENTLY_DROPPED_STATUSES) {
    const filters = caseFileRoiFilters({ status }, ctx("Medical Rep"));
    assert.deepEqual(
      filters.status,
      [status],
      `the Case File must name status "${status}" explicitly — an empty status list is what makes this request vanish from the ROI report`,
    );
    // The real defaulting function, called for real. This is what turns an unstated status into
    // the five approved ones.
    assert.deepEqual(
      resolveRoiStatusScope(filters.status),
      [status],
      `resolveRoiStatusScope must return "${status}" untouched — an explicit selection always wins over the approved-only default`,
    );
  }
}

function testUnstatedStatusIsWhatDropsTheRequest() {
  // The defect itself, asserted directly so the fix above is provably necessary rather than
  // decorative: an unstated status resolves to the approved five and a draft is not among them.
  const defaulted = resolveRoiStatusScope([]);
  assert.ok(defaulted.length > 1, "an empty status list must fall back to the approved scope");
  for (const status of ["draft", "returned", "rejected"] as const) {
    assert.equal(
      defaulted.includes(status),
      false,
      `"${status}" is NOT in the default ROI scope — which is exactly why the Case File must state the status itself`,
    );
  }
}

// ── 3. the outcome block ─────────────────────────────────────────────────────

function roiRow(overrides: Partial<MarketingRoiReportRow> = {}): MarketingRoiReportRow {
  return {
    actualCoverageRatio: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    approverRoleKeys: [],
    attributionGapReason: null,
    attributionQuality: "no_sales",
    customerName: "Some Pharmacy",
    dataCoverage: "complete",
    distributorCodes: [],
    estimatedCost: 1_000,
    expectedRoiValue: 10_000,
    forecastCoverageRatio: 1,
    hasSalesData: false,
    line: "Pedia",
    payDate: "2026-03-01",
    productCodes: [],
    region: "Cairo",
    requesterHrId: "a-1",
    requesterName: "Some Rep",
    requestCode: "MKT-REQ-TEST",
    requestId: SOME_REQUEST_ID,
    requestTypeName: "Sponsorship",
    requiredRoiValue: 10_000,
    resultStatus: "no_data",
    roiDurationMonths: 3,
    roiWindow: "2026-03 → 2026-05",
    salesDataComplete: true,
    status: "approved",
    ...overrides,
  };
}

const NO_CONFIDENCE = caseFileUnavailable<RoiConfidence>("not under test here");

function testOutcomeIsNotApplicableWithoutAPayDate() {
  const block = resolveOutcomeBlock({
    confidence: NO_CONFIDENCE,
    payDate: null,
    reportError: null,
    roiDurationMonths: 3,
    row: null,
    salesDataAsOf: "2026-07",
  });
  assert.equal(
    block.state,
    "not_applicable",
    "a request with no pay date has never started its ROI clock — that is not a result of zero",
  );
}

function testOutcomeIsUnavailableWhenTheEngineFails() {
  const block = resolveOutcomeBlock({
    confidence: NO_CONFIDENCE,
    payDate: "2026-03-01",
    reportError: "statement timeout",
    roiDurationMonths: 3,
    row: null,
    salesDataAsOf: null,
  });
  assert.equal(block.state, "unavailable", "a failed ROI read must be reported as unavailable, never as zero sales");
  assert.ok(
    block.state === "unavailable" && block.reason.includes("statement timeout"),
    "the reason must name what actually failed",
  );
}

function testOutcomeIsUnavailableWhenNoSalesDataIsLoadedAtAll() {
  const block = resolveOutcomeBlock({
    confidence: NO_CONFIDENCE,
    payDate: "2026-03-01",
    reportError: null,
    roiDurationMonths: 3,
    row: roiRow(),
    salesDataAsOf: null,
  });
  assert.equal(
    block.state,
    "unavailable",
    "with no validated-sales frontier at all, 'too early' cannot be told apart from 'nothing sold' — guessing between them is the defect",
  );
}

function testTooEarlyToMeasureIsNotApplicableAndNamesTheFrontier() {
  // The live case: window 2026-08 → 2026-12, validated sales end 2026-07. Note the ROI engine DOES
  // return a row here — so a naive implementation would happily render it as an `ok` block showing
  // zero attributed sales, which is what the current screen does.
  const block = resolveOutcomeBlock({
    confidence: NO_CONFIDENCE,
    payDate: "2026-08-02",
    reportError: null,
    roiDurationMonths: 5,
    row: roiRow({ payDate: "2026-08-02", roiWindow: "2026-08 → 2026-12", salesDataComplete: false }),
    salesDataAsOf: "2026-07",
  });

  assert.equal(
    block.state,
    "not_applicable",
    "a window that opens AFTER the validated-sales frontier is too early to measure — it must not render as an ok block showing zero",
  );
  assert.ok(
    block.state === "not_applicable" && block.reason.includes("2026-07"),
    "the sentence must name the frontier month so a reader knows WHEN it becomes measurable",
  );
  assert.ok(
    block.state === "not_applicable" && block.reason.includes("2026-08"),
    "the sentence must name the month the window opens",
  );
}

function testMissingRowInsideAnOpenWindowIsUnavailable() {
  // The status-scope trap's fingerprint: the window has opened, sales data reaches it, and the
  // engine still returned nothing for this request.
  const block = resolveOutcomeBlock({
    confidence: NO_CONFIDENCE,
    payDate: "2026-03-01",
    reportError: null,
    roiDurationMonths: 3,
    row: null,
    salesDataAsOf: "2026-07",
  });
  assert.equal(
    block.state,
    "unavailable",
    "an opened window with no ROI row is an unanswered question, not a zero result",
  );
}

function testMeasuredOutcomeIsOkAndCarriesTheFigures() {
  const block = resolveOutcomeBlock({
    confidence: NO_CONFIDENCE,
    payDate: "2026-03-01",
    reportError: null,
    roiDurationMonths: 3,
    row: roiRow({
      actualCoverageRatio: 1.2,
      actualSalesValue: 12_000,
      hasSalesData: true,
      resultStatus: "on_track",
    }),
    salesDataAsOf: "2026-07",
  });
  assert.equal(block.state, "ok");
  assert.equal(block.state === "ok" && block.value.actualSalesValue, 12_000);
  assert.equal(block.state === "ok" && block.value.windowStart, "2026-03");
  assert.equal(block.state === "ok" && block.value.windowEnd, "2026-05");
  assert.ok(
    block.state === "ok" && block.value.resultSentence.length > 0,
    "a measured outcome must carry a prose verdict, not just numbers",
  );
}

function testAwaitingDataNeverReadsAsAFailedCampaign() {
  const block = resolveOutcomeBlock({
    confidence: NO_CONFIDENCE,
    payDate: "2026-06-01",
    reportError: null,
    roiDurationMonths: 6,
    row: roiRow({
      payDate: "2026-06-01",
      resultStatus: "awaiting_data",
      roiWindow: "2026-06 → 2026-11",
      salesDataComplete: false,
    }),
    salesDataAsOf: "2026-07",
  });
  assert.equal(block.state, "ok", "a partly-loaded window still has a real, if provisional, figure");
  const sentence = block.state === "ok" ? block.value.resultSentence : "";
  assert.ok(
    /too early/i.test(sentence),
    `an awaiting_data verdict must say it is too early to judge, not that nothing sold — got: ${sentence}`,
  );
}

// ── 4. lifecycle stage, server-side ──────────────────────────────────────────

function testLifecycleStageRunsForTheRequestsTheRoiEngineDrops() {
  // These three have no surface anywhere today, and the ROI engine never returns them — so the
  // stage has to be derivable from the request alone.
  assert.equal(roiLifecycleStage({ dataCoverage: "no_validated_data", payDate: null, status: "draft" }, "2026-07"), "awaiting_approval");
  assert.equal(roiLifecycleStage({ dataCoverage: "no_validated_data", payDate: null, status: "returned" }, "2026-07"), "awaiting_approval");
  assert.equal(
    roiLifecycleStage({ dataCoverage: "complete", payDate: "2026-01-01", status: "rejected" }, "2026-07"),
    "rejected",
    "a rejected request that still carries a pay date must never be promoted into committed spend",
  );

  for (const stage of ["rejected", "awaiting_approval", "approved_unpaid", "measuring", "judged"] as const) {
    const sentence = describeLifecycleStage({
      currentStepName: "SFE Validation",
      payDate: "2026-08-02",
      salesDataAsOf: "2026-07",
      stage,
      status: "approved",
      windowEnd: "2026-12",
    });
    assert.ok(sentence.length > 20, `${stage} must have a prose sentence, never a bare status code`);
  }
}

// ── 5. warnings ──────────────────────────────────────────────────────────────

function pharmacy(overrides: Partial<MarketingCaseFileTargetPharmacy> = {}): MarketingCaseFileTargetPharmacy {
  return {
    distributorName: "Ibnsina",
    distributorPharmacyCode: "12345",
    evidencePhotoUrl: null,
    notes: null,
    pharmacyCode: "PH-1",
    pharmacyId: "p-1",
    pharmacyName: "Some Pharmacy",
    referenceStatus: "matched",
    referenceStatusSentence: "Confirmed.",
    suspect: false,
    validationStatus: "sfe_validated",
    ...overrides,
  };
}

function pharmacies(rows: MarketingCaseFileTargetPharmacy[]): MarketingCaseFileTargetPharmacies {
  return {
    rows,
    suspectCount: rows.filter((row) => row.suspect).length,
    unvalidatedCount: rows.filter(
      (row) => !row.validationStatus || !["sfe_validated", "system_validated"].includes(row.validationStatus),
    ).length,
  };
}

function warningFor(warnings: MarketingCaseFileWarning[], key: MarketingCaseFileWarningKey): MarketingCaseFileWarning {
  const found = warnings.find((warning) => warning.key === key);
  assert.ok(found, `the case file must always report on "${key}", even when it has nothing to say`);
  return found;
}

function testFailedOverlapCheckIsUnavailableAndNeverClear() {
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "sfe_validated",
    overlaps: null, // the check did not run
    targetPharmacies: pharmacies([pharmacy()]),
  });
  const doubleSpend = warningFor(warnings, "double_spend");

  assert.equal(
    doubleSpend.state,
    "unavailable",
    "a double-spend check that could not run must be UNAVAILABLE — reporting it as clear is the defect this feature exists to end",
  );
  assert.notEqual(doubleSpend.state, "clear", "an unrun check must never be presented as a passed check");
  assert.ok(/unknown/i.test(doubleSpend.sentence), "the sentence must say the answer is unknown, in words");
  assert.notEqual(doubleSpend.severity, "info", "an unknown double-spend risk is not an informational note");
}

function testCleanOverlapCheckIsClearAndSaysSo() {
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "sfe_validated",
    overlaps: [],
    targetPharmacies: pharmacies([pharmacy()]),
  });
  const doubleSpend = warningFor(warnings, "double_spend");
  assert.equal(doubleSpend.state, "clear", "an empty overlap list from a check that RAN is a genuine pass");
  assert.equal(doubleSpend.severity, "info");
}

function testFlaggedOverlapCarriesItsDetail() {
  const overlaps = [{ description: "MKT-REQ-A already measures 2 of these pharmacies.", requestCode: "MKT-REQ-A", status: "approved" }];
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "sfe_validated",
    overlaps,
    targetPharmacies: pharmacies([pharmacy()]),
  });
  const doubleSpend = warningFor(warnings, "double_spend");
  assert.equal(doubleSpend.state, "flagged");
  assert.deepEqual(doubleSpend.detail, overlaps, "a flagged warning must carry the rows that triggered it");
}

function testUnreadablePharmaciesMakeThreeChecksUnavailableNotClear() {
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "sfe_validated",
    overlaps: [],
    targetPharmacies: null,
  });
  for (const key of ["no_target_pharmacies", "suspect_pharmacy_codes", "unvalidated_pharmacies"] as const) {
    assert.equal(
      warningFor(warnings, key).state,
      "unavailable",
      `"${key}" reads the target pharmacies — if they could not be read the check is unknown, not clear`,
    );
  }
}

function testNoTargetPharmaciesBlocks() {
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "sfe_validated",
    overlaps: [],
    targetPharmacies: pharmacies([]),
  });
  const warning = warningFor(warnings, "no_target_pharmacies");
  assert.equal(warning.state, "flagged");
  assert.equal(
    warning.severity,
    "block",
    "a request with no targets can NEVER attribute a sale, so its ROI is permanently zero — that is a blocking fact, not a note",
  );
}

function testUnvalidatedCustomerAndPharmaciesAreSurfaced() {
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "pending",
    overlaps: [],
    targetPharmacies: pharmacies([pharmacy({ validationStatus: "pending" }), pharmacy({ validationStatus: "sfe_validated" })]),
  });
  assert.equal(
    warningFor(warnings, "unvalidated_customer").state,
    "flagged",
    "155 of 157 customers are 'pending' and it has never been shown anywhere — 'never validated' must be visible, not silent",
  );
  const unvalidated = warningFor(warnings, "unvalidated_pharmacies");
  assert.equal(unvalidated.state, "flagged");
  assert.equal((unvalidated.detail ?? []).length, 1, "only the unvalidated pharmacy belongs in the detail");
}

function testUnreadableCustomerValidationIsUnavailable() {
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: null,
    overlaps: [],
    targetPharmacies: pharmacies([pharmacy()]),
  });
  assert.equal(
    warningFor(warnings, "unvalidated_customer").state,
    "unavailable",
    "an unreadable customer record leaves validation UNKNOWN — it must not read as validated OR as unvalidated",
  );
}

function testConfidentialWithholdingIsAnnounced() {
  const withheld = buildCaseFileWarnings({
    confidentialWithheldCount: 2,
    customerValidationStatus: "sfe_validated",
    overlaps: [],
    targetPharmacies: pharmacies([pharmacy()]),
  });
  assert.equal(
    warningFor(withheld, "confidential_withheld").state,
    "flagged",
    "a viewer whose product list was silently shortened must be told, or they read the campaign as smaller than it is",
  );

  const nothingWithheld = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "sfe_validated",
    overlaps: [],
    targetPharmacies: pharmacies([pharmacy()]),
  });
  assert.equal(warningFor(nothingWithheld, "confidential_withheld").state, "clear");
}

function testEverySixWarningsAlwaysReported() {
  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: 0,
    customerValidationStatus: "sfe_validated",
    overlaps: [],
    targetPharmacies: pharmacies([pharmacy()]),
  });
  assert.equal(warnings.length, 6, "all six checks report every time — a check that goes quiet is indistinguishable from one that passed");
  for (const warning of warnings) {
    assert.ok(warning.sentence.length > 10, `${warning.key} must carry prose, never a bare code`);
  }
}

// ── 6. reference status: lookup_failed is not pending ────────────────────────

function decisionPharmacy(overrides: Partial<MarketingDecisionPharmacy> = {}): MarketingDecisionPharmacy {
  return {
    distributorName: "Ibnsina",
    distributorPharmacyCode: "12345",
    evidencePhotoUrl: null,
    notes: null,
    pharmacyCode: "PH-1",
    pharmacyId: "p-1",
    pharmacyName: "Some Pharmacy",
    referenceLookup: "resolved",
    referenceStatus: "matched",
    ...overrides,
  };
}

function testFailedCodeLookupIsNotReportedAsPending() {
  assert.equal(
    resolveReferenceStatus(decisionPharmacy({ referenceLookup: "lookup_failed", referenceStatus: "pending" })),
    "lookup_failed",
    "production holds ZERO genuinely pending codes — a 'pending' on screen is a failed lookup, and it must be named as one",
  );
  assert.equal(
    resolveReferenceStatus(decisionPharmacy({ referenceStatus: "pending" })),
    "pending",
    "a code row that WAS read and says pending is genuinely pending",
  );
  assert.equal(resolveReferenceStatus(decisionPharmacy({ referenceStatus: "MATCHED" })), "matched", "casing must not create an unknown state");
  assert.equal(
    resolveReferenceStatus(decisionPharmacy({ referenceStatus: "something-new" })),
    "lookup_failed",
    "an unrecognised state is unknown, not confirmed — fail closed on the reader's trust",
  );
}

// ── 7. admission ─────────────────────────────────────────────────────────────

const NO_STEPS: Array<{ assignedHrId: string | null; isCc: boolean }> = [];

function admission(overrides: Partial<Parameters<typeof resolveCaseFileAdmission>[0]> = {}) {
  return resolveCaseFileAdmission({
    access: ctx("Medical Rep"),
    assignedSteps: NO_STEPS,
    hierarchyAllows: false,
    requestProductCodes: ["TE002"],
    requesterHrId: "B-9",
    viewerOwnedProductCodes: null,
    ...overrides,
  });
}

function testRequesterIsAdmitted() {
  const admitted = admission({ access: ctx("Medical Rep", { hrId: "B-9" }) });
  assert.ok(admitted.includes("requester"), "the person who submitted the request must always be able to open it");
}

function testRequesterIsAdmittedAcrossHrIdCasing() {
  const admitted = admission({ access: ctx("Medical Rep", { hrId: "b-9" }), requesterHrId: "B-9" });
  assert.ok(
    admitted.includes("requester"),
    "the session HR_ID is lower-cased while the employee master is upper-cased — a casing mismatch must not lock a requester out of their own request",
  );
}

function testEveryChainRoleIsAdmittedIncludingCcAndUnopenedRungs() {
  // The live chain: National Sales Manager -> SFE Manager -> Marketing Manager -> CEO, with the
  // line's Product Manager attached as a CC reviewer.
  const steps = [
    { assignedHrId: "C-1", isCc: false }, // NSM, already approved
    { assignedHrId: "C-2", isCc: false }, // SFE Manager, current
    { assignedHrId: "C-3", isCc: false }, // Marketing Manager, not opened yet
    { assignedHrId: "C-4", isCc: true }, // Product Manager, advisory only
  ];

  for (const [hrId, expected] of [
    ["C-1", "chain_step"],
    ["C-2", "chain_step"],
    ["C-3", "chain_step"],
    ["C-4", "cc_reviewer"],
  ] as const) {
    const admitted = resolveCaseFileAdmission({
      access: ctx("National Sales Manager", { hrId }),
      assignedSteps: steps,
      hierarchyAllows: false,
      requestProductCodes: ["TE002"],
      requesterHrId: "B-9",
      viewerOwnedProductCodes: null,
    });
    assert.ok(
      admitted.includes(expected),
      `${hrId} is named on this request's chain and must be admitted as "${expected}" — a rung that has not opened yet still has to be able to read ahead`,
    );
  }
}

function testCompanyOversightIsAdmittedWithoutBeingOnTheChain() {
  for (const role of ["CEO", "Super Admin", "Marketing Manager", "SFE Manager", "Finance Manager", "Financial Advisor"] as PhoenixRole[]) {
    assert.equal(hasCompanyWideMarketingClaim(ctx(role)), true, `${role} has company-wide marketing oversight`);
    assert.ok(
      admission({ access: ctx(role, { hrId: "Z-9" }) }).includes("company_oversight"),
      `${role} must reach any request's case file without being named on it`,
    );
  }
}

function testSystemScopeIsAdmitted() {
  const admitted = admission({
    access: ctx("Medical Rep", { hrId: null, loginId: null, scope: "system", source: "system" }),
  });
  assert.deepEqual(admitted, ["system"], "the server-to-server path is role-independent and needs no HR_ID");
}

function testProductOwnerIsAdmittedOnlyForOwnedProducts() {
  const owns = admission({
    access: ctx("Product Manager", { hrId: "P-1" }),
    requestProductCodes: ["TE002", "OS001"],
    viewerOwnedProductCodes: new Set(["TE002"]),
  });
  assert.ok(owns.includes("product_owner"), "a PM whose product is being promoted has a real stake in the spend");

  const doesNotOwn = admission({
    access: ctx("Product Manager", { hrId: "P-1" }),
    requestProductCodes: ["OS001"],
    viewerOwnedProductCodes: new Set(["TE002"]),
  });
  assert.deepEqual(doesNotOwn, [], "a PM with no product on this request has no claim on it");
}

function testUnrelatedMedicalRepIsDenied() {
  const admitted = admission({ access: ctx("Medical Rep", { hrId: "Z-99" }) });
  assert.deepEqual(
    admitted,
    [],
    "a Medical Rep who is not the requester, not on the chain and not in the hierarchy must be denied — an empty array is the ONLY denial signal",
  );
}

function testFailClosedOnMissingHrId() {
  // "No HR_ID" means no linked Phoenix identity at all — the marketing module resolves an actor as
  // hr_id falling back to login_id (resolveEmployeeIdentityId), so both have to be absent.
  for (const role of ["Medical Rep", "District Manager", "Regional Manager", "National Sales Manager", "Product Manager"] as PhoenixRole[]) {
    for (const blank of [null, "", "   "]) {
      const admitted = admission({
        access: ctx(role, { hrId: blank, loginId: blank }),
        // Deliberately generous everywhere else: an assigned chain step, a hierarchy pass and an
        // owned product all point at this request. None of them may rescue a viewer with no identity.
        assignedSteps: [{ assignedHrId: "C-1", isCc: false }],
        hierarchyAllows: true,
        requesterHrId: "B-9",
        viewerOwnedProductCodes: new Set(["TE002"]),
      });
      assert.deepEqual(
        admitted,
        [],
        `${role} with HR_ID and login id ${JSON.stringify(blank)} must be denied — every arm below company oversight keys on an identity, so an actor without one matches nothing`,
      );
    }
  }
}

function testHierarchyArmIsNotClaimedWhenOversightAlreadyApplies() {
  // Cosmetic but load-bearing: canSeeMarketingRequest returns true for every oversight role, so a
  // naive union would report "hierarchy" for a CEO who has no hierarchy relationship at all.
  const admitted = admission({ access: ctx("CEO", { hrId: "AA" }), hierarchyAllows: true });
  assert.ok(admitted.includes("company_oversight"));
  assert.equal(admitted.includes("hierarchy"), false, "the reported reason must be the one that actually applies");
}

function testManagerInTheHierarchyIsAdmitted() {
  const admitted = admission({ access: ctx("District Manager", { hrId: "D-1" }), hierarchyAllows: true });
  assert.ok(admitted.includes("hierarchy"), "a manager the requester reports up to keeps the visibility they already have today");
}

// ── 8. the service gate, before any database call ────────────────────────────

async function testServiceFailsClosedWithoutAnHrId() {
  // These throw BEFORE getSupabaseAdmin() is reached, so they run without a database.
  for (const role of ["Medical Rep", "District Manager", "Product Manager", "National Sales Manager"] as PhoenixRole[]) {
    await assert.rejects(
      () => getMarketingRequestCaseFile(SOME_REQUEST_ID, ctx(role, { hrId: null, loginId: null })),
      /Forbidden/i,
      `${role} with no linked Phoenix identity must be refused before any request data is read — unknown is never allow`,
    );
  }
}

async function testServiceRejectsAnEmptyRequestId() {
  await assert.rejects(
    () => getMarketingRequestCaseFile("   ", ctx("Super Admin", { hrId: "AA", scope: "company" })),
    /required/i,
    "an empty request id is a validation error, not a 403 and not an empty case file",
  );
}

export async function runMarketingCaseFileTests() {
  testBlockStatesAreDistinguishable();
  testBlockReasonsAreAlwaysProse();

  testCaseFileAlwaysNamesTheRequestStatus();
  testUnstatedStatusIsWhatDropsTheRequest();

  testOutcomeIsNotApplicableWithoutAPayDate();
  testOutcomeIsUnavailableWhenTheEngineFails();
  testOutcomeIsUnavailableWhenNoSalesDataIsLoadedAtAll();
  testTooEarlyToMeasureIsNotApplicableAndNamesTheFrontier();
  testMissingRowInsideAnOpenWindowIsUnavailable();
  testMeasuredOutcomeIsOkAndCarriesTheFigures();
  testAwaitingDataNeverReadsAsAFailedCampaign();

  testLifecycleStageRunsForTheRequestsTheRoiEngineDrops();

  testFailedOverlapCheckIsUnavailableAndNeverClear();
  testCleanOverlapCheckIsClearAndSaysSo();
  testFlaggedOverlapCarriesItsDetail();
  testUnreadablePharmaciesMakeThreeChecksUnavailableNotClear();
  testNoTargetPharmaciesBlocks();
  testUnvalidatedCustomerAndPharmaciesAreSurfaced();
  testUnreadableCustomerValidationIsUnavailable();
  testConfidentialWithholdingIsAnnounced();
  testEverySixWarningsAlwaysReported();

  testFailedCodeLookupIsNotReportedAsPending();

  testRequesterIsAdmitted();
  testRequesterIsAdmittedAcrossHrIdCasing();
  testEveryChainRoleIsAdmittedIncludingCcAndUnopenedRungs();
  testCompanyOversightIsAdmittedWithoutBeingOnTheChain();
  testSystemScopeIsAdmitted();
  testProductOwnerIsAdmittedOnlyForOwnedProducts();
  testUnrelatedMedicalRepIsDenied();
  testFailClosedOnMissingHrId();
  testHierarchyArmIsNotClaimedWhenOversightAlreadyApplies();
  testManagerInTheHierarchyIsAdmitted();

  await testServiceFailsClosedWithoutAnHrId();
  await testServiceRejectsAnEmptyRequestId();
}
