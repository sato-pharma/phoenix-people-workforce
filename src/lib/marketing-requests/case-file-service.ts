// ─────────────────────────────────────────────────────────────────────────────
// Marketing request Case File — the composition.
//
// THIS MODULE ADDS NO ATTRIBUTION LOGIC, for the same reason roi-tracker-service.ts says so: the
// marketing module already grew four ROI surfaces on three engines that disagreed with each other,
// and a fifth would have made it worse. Every number here comes from the function that already
// owns it — getMarketingRoiReport for realized ROI, buildMarketingApproverChain for the chain,
// roiConfidenceOf for measurement trust, findRequestOverlaps for double-spend. What this file adds
// is one honest SHAPE for all of it (see case-file-types.ts) and one admission gate.
//
// ── THE STATUS-SCOPE TRAP ────────────────────────────────────────────────────
//
// resolveRoiStatusScope defaults an empty status filter to the five APPROVED statuses, and
// buildRoiIndex only loads requests carrying a pay date. So calling getMarketingRoiReport without
// an explicit status silently returns NOTHING for a draft, returned or rejected request — exactly
// the population this feature exists to surface, because those three have no surface at all today.
// The function's own comment names the remedy: "An explicit status selection always wins." So this
// module ALWAYS passes `status: [request.status]`.
//
// The defect is invisible against the only live Phoenix request (MKT-REQ-20260802-DCF31EC4, which
// is `approved` and passes either way), which is why it survived. It is covered by test, not by
// eyeballing a screen.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import {
  caseFileNotApplicable,
  caseFileOk,
  caseFileUnavailable,
  type CaseFileBlock,
  type MarketingCaseFileAdmission,
  type MarketingCaseFileChain,
  type MarketingCaseFileChainRung,
  type MarketingCaseFileCustomer,
  type MarketingCaseFileHistory,
  type MarketingCaseFileLazySection,
  type MarketingCaseFileMoney,
  type MarketingCaseFileOutcome,
  type MarketingCaseFileProduct,
  type MarketingCaseFileProducts,
  type MarketingCaseFileReferenceStatus,
  type MarketingCaseFileSpentBefore,
  type MarketingCaseFileTargetPharmacies,
  type MarketingCaseFileTargetPharmacy,
  type MarketingCaseFileViewer,
  type MarketingCaseFileWarning,
  type MarketingRequestCaseFile,
  type MarketingRequestEventKind,
} from "@/lib/marketing-requests/case-file-types";
import { cairoDateTime } from "@/lib/marketing-requests/request-report-columns";
import { loadMarketingEvidencePhoto } from "@/lib/marketing-requests/evidence-photo-storage";
import {
  loadMarketingCustomerSpendHistory,
  loadMarketingDecisionPharmacies,
  loadMarketingRequestOverlaps,
  type MarketingDecisionOverlap,
  type MarketingDecisionPharmacy,
} from "@/lib/marketing-requests/request-loaders";
import { INERT_MARKETING_REQUEST_STATUSES } from "@/lib/marketing-requests/request-overlap";
import { roiConfidenceOf, type RoiConfidence } from "@/lib/marketing-requests/roi-confidence";
import { roiLifecycleStage, type RoiLifecycleStage } from "@/lib/marketing-requests/roi-live-stages";
import { getMarketingRoiReport } from "@/lib/marketing-requests/roi-report-service";
import {
  emptyRoiFilterState,
  type MarketingRoiReportRow,
  type RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";
import {
  buildMarketingApproverChain,
  companyMarketingRoles,
  canSeeMarketingHierarchyRecord,
  loadMarketingRequestApprovalSteps,
  loadMarketingRequestById,
  loadMarketingRequestTypeName,
  normalizeHrId,
} from "@/lib/marketing-requests/service";
import { canViewRestrictedProducts, isRestrictedProductCode } from "@/lib/sales/access-scope";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  MarketingRequest,
  MarketingRequestApprovalStep,
  MarketingValidationStatus,
} from "@/lib/marketing-requests/types";

// ── admission ────────────────────────────────────────────────────────────────

/**
 * The company-wide half of the gate, as a pure predicate — no request, no database.
 *
 * Split out so the rule is directly executable in a test rather than asserted against source text.
 * Answers only "may this role open ANY marketing request's case file?".
 */
export function hasCompanyWideMarketingClaim(access: AccessContext): boolean {
  return access.scope === "system" || companyMarketingRoles.has(access.role);
}

/** Roles whose marketing visibility can come from owning the promoted PRODUCTS. */
const productOwnerRoles = new Set<AccessContext["role"]>(["Product Manager", "Group Product Manager"]);

export type CaseFileAdmissionInput = {
  access: AccessContext;
  /** Every approval step's assignee — gating AND CC, at ANY status, including rungs not yet open. */
  assignedSteps: ReadonlyArray<{ assignedHrId: string | null; isCc: boolean }>;
  /** `canSeeMarketingRequest`'s answer (requester / hierarchy / HR scope) for this request. */
  hierarchyAllows: boolean;
  /** Uppercased codes of the products this request promotes. */
  requestProductCodes: readonly string[];
  requesterHrId: string | null;
  /** PM/GPM only: the uppercased product codes this viewer owns. `null` = not a product-owner role. */
  viewerOwnedProductCodes: ReadonlySet<string> | null;
};

/**
 * Which rules admit this viewer. An EMPTY array means denied — there is no "maybe".
 *
 * The union of every rule that already exists in the module, because the Case File replaces
 * ~20 surfaces and must not be narrower than the narrowest of them:
 *
 *   system scope · company-wide marketing oversight · the requester · the requester's management
 *   hierarchy · assigned to ANY approval step at ANY status · a CC/advisory reviewer · a PM/GPM
 *   who owns one of the promoted products.
 *
 * Chain membership deliberately ignores `is_cc` and step status. A CC reviewer is ASKED to advise
 * on the spend, and an approver whose rung has not opened yet should be able to read ahead rather
 * than meet the request for the first time at the moment they must decide. That is the rule PR
 * #1909 landed for sales evidence; this is the same question about the same people.
 *
 * Pure. Fail-closed follows from the shape: every arm below the first two keys on an HR_ID, so an
 * actor without one matches nothing and the array comes back empty.
 */
export function resolveCaseFileAdmission(input: CaseFileAdmissionInput): MarketingCaseFileAdmission[] {
  const admitted: MarketingCaseFileAdmission[] = [];
  const { access } = input;

  if (access.scope === "system") admitted.push("system");
  if (companyMarketingRoles.has(access.role)) admitted.push("company_oversight");

  // The module's own identity resolver (hr_id, falling back to login_id), so this pure function and
  // the service's fail-closed pre-check below can never disagree about who is asking.
  const viewerHrId = resolveEmployeeIdentityId(access);
  if (viewerHrId) {
    if (viewerHrId === normalizeHrId(input.requesterHrId)) admitted.push("requester");

    // `hierarchyAllows` is canSeeMarketingRequest's verdict, which already returns true for every
    // company oversight role. Only claim the hierarchy arm when it is doing real work, so the
    // reported reason is the one that actually applies.
    if (input.hierarchyAllows && !admitted.includes("company_oversight") && !admitted.includes("requester")) {
      admitted.push("hierarchy");
    }

    let onGatingStep = false;
    let onCcStep = false;
    for (const step of input.assignedSteps) {
      if (normalizeHrId(step.assignedHrId) !== viewerHrId) continue;
      if (step.isCc) onCcStep = true;
      else onGatingStep = true;
    }
    if (onGatingStep) admitted.push("chain_step");
    if (onCcStep) admitted.push("cc_reviewer");

    if (
      productOwnerRoles.has(access.role) &&
      input.viewerOwnedProductCodes !== null &&
      input.requestProductCodes.some((code) => input.viewerOwnedProductCodes!.has(code))
    ) {
      admitted.push("product_owner");
    }
  }

  return admitted;
}

// ── small helpers ────────────────────────────────────────────────────────────

function cleanText(value: unknown): string | null {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function employeeByHrId(rows: EmployeeDirectoryRow[]): Map<string, EmployeeDirectoryRow> {
  return new Map(
    rows
      .map((row) => [normalizeHrId(row.hrId), row] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
}

/** The month a YYYY-MM-DD pay date opens the measurement window in. */
function windowStartMonth(payDate: string | null): string | null {
  const month = (payDate ?? "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : null;
}

function windowEndMonth(payDate: string | null, durationMonths: number): string | null {
  const start = windowStartMonth(payDate);
  if (!start) return null;
  const [yearRaw, monthRaw] = start.split("-");
  const index = Number(yearRaw) * 12 + (Number(monthRaw) - 1) + Math.max(1, Math.round(durationMonths)) - 1;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function roiWindowLabel(payDate: string | null, durationMonths: number): string | null {
  const start = windowStartMonth(payDate);
  const end = windowEndMonth(payDate, durationMonths);
  if (!start || !end) return null;
  return start === end ? start : `${start} → ${end}`;
}

// ── header prose ─────────────────────────────────────────────────────────────

/**
 * One sentence naming where the money is and what happens next.
 *
 * Prose, not a status code, because the status vocabulary is not readable: `finance_hold`,
 * `roi_tracking` and `archived` all mean something specific to this module and nothing at all to
 * the person who has to act on them.
 */
export function describeLifecycleStage(input: {
  currentStepName: string | null;
  payDate: string | null;
  salesDataAsOf: string | null;
  stage: RoiLifecycleStage;
  status: string;
  windowEnd: string | null;
}): string {
  switch (input.stage) {
    case "rejected":
      return "Refused. No money was committed, and nothing here counts towards company spend.";
    case "awaiting_approval":
      return input.currentStepName
        ? `Awaiting a decision at ${input.currentStepName}. Nothing is committed until the chain finishes.`
        : input.status === "draft"
          ? "Still a draft. It has not been submitted, so no approver has seen it."
          : input.status === "returned"
            ? "Returned to the requester for edits. It re-enters the chain when they resubmit."
            : "Awaiting a decision. Nothing is committed until the chain finishes.";
    case "approved_unpaid":
      return input.payDate
        ? `Approved, pay date ${input.payDate}. The measurement window has not opened yet.`
        : "Approved, but no pay date is set — the measurement window cannot open without one.";
    case "measuring":
      return input.windowEnd
        ? `Being measured. The window runs to ${input.windowEnd}; validated sales currently reach ${input.salesDataAsOf ?? "no month at all"}, so the figure will still move.`
        : "Being measured. The figure will still move as more sales are validated.";
    case "judged":
      return "Fully measured. Validated sales cover the whole window, so this result is final.";
  }
}

// ── outcome ──────────────────────────────────────────────────────────────────

/**
 * The realized-ROI verdict, as prose that survives an empty result.
 *
 * The distinction this exists to protect, measured live on MKT-REQ-20260802-DCF31EC4: its window
 * is 2026-08 → 2026-12 while validated sales end 2026-07. Zero attributed sales is therefore
 * CORRECT and means "too early to measure" — but the existing screen renders "No sales matched in
 * this period range", and its honest warning only fires when `salesDataAsOf` is missing entirely,
 * so it never fires here. A reader is told the campaign failed. It has not started.
 */
export function describeOutcome(row: MarketingRoiReportRow, salesDataAsOf: string | null): string {
  if (row.resultStatus === "awaiting_data") {
    return `Too early to judge. The window runs to ${row.roiWindow?.split("→").pop()?.trim() ?? "an unknown month"}; validated sales reach ${salesDataAsOf ?? "no month at all"}.`;
  }
  if (!row.hasSalesData) {
    return row.attributionGapReason
      ? `No sales attributed. ${row.attributionGapReason}.`
      : "No sales attributed to this request inside its window.";
  }
  if (row.resultStatus === "on_track") {
    return `EGP ${round2(row.actualSalesValue).toLocaleString("en-US")} attributed against a required EGP ${round2(row.requiredRoiValue).toLocaleString("en-US")} — the target is covered.`;
  }
  return `EGP ${round2(row.actualSalesValue).toLocaleString("en-US")} attributed against a required EGP ${round2(row.requiredRoiValue).toLocaleString("en-US")}${row.salesDataComplete ? " — the target was not reached." : " — still short, and the window is not fully loaded yet."}`;
}

/**
 * Which block the outcome section is, given what is actually known. Pure, so the whole state
 * machine is testable without an ROI engine.
 *
 * Order is load-bearing:
 *  1. No pay date -> the ROI clock never started. `not_applicable`, not a zero.
 *  2. The report itself failed -> `unavailable`. Never a zeroed `ok`.
 *  3. No validated sales data at all -> `unavailable`: with no frontier we cannot even tell
 *     "too early" from "nothing sold", and guessing between those two is the whole defect.
 *  4. The frontier is EARLIER than the window's first month -> `not_applicable`, naming the
 *     frontier month. This is the case the live screen gets wrong.
 *  5. Still no row -> `unavailable`. This is the status-scope trap's fingerprint.
 */
export function resolveOutcomeBlock(input: {
  confidence: CaseFileBlock<RoiConfidence>;
  payDate: string | null;
  reportError: string | null;
  roiDurationMonths: number;
  row: MarketingRoiReportRow | null;
  salesDataAsOf: string | null;
}): CaseFileBlock<MarketingCaseFileOutcome> {
  const windowStart = windowStartMonth(input.payDate);
  const windowEnd = windowEndMonth(input.payDate, input.roiDurationMonths);

  if (!windowStart) {
    return caseFileNotApplicable(
      "No pay date is set, so the measurement window has never opened. There is nothing to measure yet — this is not a result of zero.",
    );
  }
  if (input.reportError) {
    return caseFileUnavailable(`The ROI engine could not be read (${input.reportError}). No figure is being shown rather than a misleading zero.`);
  }
  if (!input.salesDataAsOf) {
    return caseFileUnavailable(
      "No validated Source-of-Sales data is loaded at all, so nothing can be attributed and 'too early' cannot be told apart from 'nothing sold'.",
    );
  }
  if (input.salesDataAsOf < windowStart) {
    return caseFileNotApplicable(
      `Too early to measure — validated sales data currently ends ${input.salesDataAsOf}, and this campaign's window opens ${windowStart}. Zero attributed sales is expected here and does NOT mean the campaign failed.`,
    );
  }
  if (!input.row) {
    return caseFileUnavailable(
      "The ROI engine returned no row for this request even though its window has opened. Its realized result cannot be stated.",
    );
  }

  return caseFileOk({
    actualCoverageRatio: input.row.actualCoverageRatio,
    actualSalesUnits: input.row.actualSalesUnits,
    actualSalesValue: input.row.actualSalesValue,
    attributionGapReason: input.row.attributionGapReason,
    confidence: input.confidence,
    dataCoverage: input.row.dataCoverage,
    requiredRoiValue: input.row.requiredRoiValue,
    resultStatus: input.row.resultStatus,
    resultSentence: describeOutcome(input.row, input.salesDataAsOf),
    roiWindow: input.row.roiWindow,
    salesDataAsOf: input.salesDataAsOf,
    windowEnd,
    windowStart,
  });
}

// ── warnings ─────────────────────────────────────────────────────────────────

const VALIDATED_STATUSES = new Set<MarketingValidationStatus>(["sfe_validated", "system_validated"]);

/** Reference states that cannot be relied on to attribute a sale. */
const SUSPECT_REFERENCE_STATES = new Set<MarketingCaseFileReferenceStatus>([
  "ambiguous",
  "lookup_failed",
  "not_found",
  "pending",
  "rejected",
]);

export type CaseFileWarningInput = {
  confidentialWithheldCount: number;
  customerValidationStatus: MarketingValidationStatus | null;
  /** `null` means the overlap CHECK did not run — never the same as "no overlaps". */
  overlaps: MarketingDecisionOverlap[] | null;
  /** `null` means the target-pharmacy read failed. */
  targetPharmacies: MarketingCaseFileTargetPharmacies | null;
};

/**
 * The six checks, each in one of three states.
 *
 * The reason this exists at all: `loadMarketingRequestOverlaps` is wrapped in `.catch(() => [])`
 * on the approval screen, so a double-spend check that FELL OVER renders identically to one that
 * PASSED. Here a failed check is `unavailable`, and `unavailable` is never dressed up as `clear`.
 */
export function buildCaseFileWarnings(input: CaseFileWarningInput): MarketingCaseFileWarning[] {
  const warnings: MarketingCaseFileWarning[] = [];

  // 1. double spend
  if (input.overlaps === null) {
    warnings.push({
      detail: null,
      key: "double_spend",
      severity: "warn",
      sentence: "The double-spend check could not run. Whether another live campaign would be credited the same sales is UNKNOWN — this is not a clean result.",
      state: "unavailable",
    });
  } else if (input.overlaps.length > 0) {
    warnings.push({
      detail: input.overlaps,
      key: "double_spend",
      severity: "warn",
      sentence: `${input.overlaps.length} other live request${input.overlaps.length === 1 ? "" : "s"} would be credited the same invoice lines as this one. The same sale would count twice.`,
      state: "flagged",
    });
  } else {
    warnings.push({
      detail: null,
      key: "double_spend",
      severity: "info",
      sentence: "No other live request contests this campaign's pharmacies, products and months.",
      state: "clear",
    });
  }

  // 2 & 3 & 5 all read the target pharmacies, so one unavailable answer covers them together.
  if (input.targetPharmacies === null) {
    for (const key of ["no_target_pharmacies", "suspect_pharmacy_codes", "unvalidated_pharmacies"] as const) {
      warnings.push({
        detail: null,
        key,
        severity: "warn",
        sentence: "The target pharmacies could not be read, so this check is UNKNOWN rather than clear.",
        state: "unavailable",
      });
    }
  } else {
    const { rows, suspectCount, unvalidatedCount } = input.targetPharmacies;

    warnings.push(
      rows.length === 0
        ? {
          detail: null,
          key: "no_target_pharmacies",
          severity: "block",
          sentence: "This request has NO target pharmacies. Nothing can ever be attributed to it, so its ROI is permanently zero however the campaign actually performs.",
          state: "flagged",
        }
        : {
          detail: null,
          key: "no_target_pharmacies",
          severity: "info",
          sentence: `${rows.length} target pharmac${rows.length === 1 ? "y is" : "ies are"} recorded.`,
          state: "clear",
        },
    );

    warnings.push(
      suspectCount > 0
        ? {
          detail: rows.filter((row) => row.suspect),
          key: "suspect_pharmacy_codes",
          severity: "warn",
          sentence: `${suspectCount} of ${rows.length} pharmacy code${rows.length === 1 ? "" : "s"} could not be confirmed against the reference database. A code it cannot find has no sales 27.9% of the time, against 1.3% for a matched code.`,
          state: "flagged",
        }
        : {
          detail: null,
          key: "suspect_pharmacy_codes",
          severity: "info",
          sentence: rows.length === 0
            ? "No pharmacy codes to check."
            : `All ${rows.length} pharmacy code${rows.length === 1 ? " is" : "s are"} confirmed against the reference database.`,
          state: "clear",
        },
    );

    warnings.push(
      unvalidatedCount > 0
        ? {
          detail: rows.filter((row) => !row.validationStatus || !VALIDATED_STATUSES.has(row.validationStatus)),
          key: "unvalidated_pharmacies",
          severity: "warn",
          sentence: `${unvalidatedCount} of ${rows.length} target pharmac${unvalidatedCount === 1 ? "y has" : "ies have"} never been validated. Nobody has confirmed the shop exists at the address on file.`,
          state: "flagged",
        }
        : {
          detail: null,
          key: "unvalidated_pharmacies",
          severity: "info",
          sentence: rows.length === 0 ? "No pharmacies to validate." : "Every target pharmacy has been validated.",
          state: "clear",
        },
    );
  }

  // 4. customer validation
  if (input.customerValidationStatus === null) {
    warnings.push({
      detail: null,
      key: "unvalidated_customer",
      severity: "warn",
      sentence: "The customer's validation state could not be read, so whether anyone has ever confirmed this customer is UNKNOWN.",
      state: "unavailable",
    });
  } else if (!VALIDATED_STATUSES.has(input.customerValidationStatus)) {
    warnings.push({
      detail: null,
      key: "unvalidated_customer",
      severity: "warn",
      sentence: `The customer is "${input.customerValidationStatus}" — nobody has validated that this customer exists as recorded. 155 of the 157 customers in the database sit in this state.`,
      state: "flagged",
    });
  } else {
    warnings.push({
      detail: null,
      key: "unvalidated_customer",
      severity: "info",
      sentence: "The customer has been validated.",
      state: "clear",
    });
  }

  // 6. confidential products withheld from THIS viewer
  warnings.push(
    input.confidentialWithheldCount > 0
      ? {
        detail: null,
        key: "confidential_withheld",
        severity: "info",
        sentence: `${input.confidentialWithheldCount} promoted product${input.confidentialWithheldCount === 1 ? " is" : "s are"} confidential and withheld from you, so the product figures below are incomplete.`,
        state: "flagged",
      }
      : {
        detail: null,
        key: "confidential_withheld",
        severity: "info",
        sentence: "No promoted product is withheld from you.",
        state: "clear",
      },
  );

  return warnings;
}

// ── reference status ─────────────────────────────────────────────────────────

const KNOWN_REFERENCE_STATES = new Set([
  "ambiguous",
  "manual_approved",
  "matched",
  "not_found",
  "pending",
  "rejected",
]);

/**
 * Turn the loader's answer into an honest state.
 *
 * `reference_status` coalesces a failed lookup to "pending" — and production holds 273 matched /
 * 16 not_found / ZERO genuine pending, so every "pending" visible today is a lookup that missed.
 * A code we could not read is `lookup_failed`, not `pending`.
 */
export function resolveReferenceStatus(pharmacy: MarketingDecisionPharmacy): MarketingCaseFileReferenceStatus {
  if (pharmacy.referenceLookup === "lookup_failed") return "lookup_failed";
  const raw = pharmacy.referenceStatus.trim().toLowerCase();
  return KNOWN_REFERENCE_STATES.has(raw) ? (raw as MarketingCaseFileReferenceStatus) : "lookup_failed";
}

function describeReferenceStatus(status: MarketingCaseFileReferenceStatus): string {
  switch (status) {
    case "matched":
      return "Confirmed against the distributor reference database.";
    case "manual_approved":
      return "Manually approved by a validator.";
    case "ambiguous":
      return "The reference database holds more than one match for this code — sales may attribute to the wrong pharmacy.";
    case "not_found":
      return "The reference database has no such code. Sales at this pharmacy will not be attributed to this request.";
    case "rejected":
      return "This code was rejected during validation.";
    case "pending":
      return "Never checked against the reference database.";
    case "lookup_failed":
      return "The code record could not be read, so its state is unknown. It is NOT confirmed.";
  }
}

// ── the service ──────────────────────────────────────────────────────────────

/**
 * Everything about ONE marketing request, in one object, for whoever may see it.
 *
 * Reads only. Nothing here writes, and nothing here decides anything — the capability booleans on
 * `viewer.can` are affordances the acting routes re-enforce for themselves.
 */
export async function getMarketingRequestCaseFile(
  requestId: string,
  access: AccessContext,
): Promise<MarketingRequestCaseFile> {
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) throw validationError("Marketing request ID is required.");

  const denied = forbiddenError("Forbidden: you cannot view this marketing request.");

  // Fail closed, before a single row is read. Every arm of the admission union below the
  // company-wide one keys on an HR_ID, so an actor with no linked Phoenix identity can never match
  // any of them — there is nothing left to check, and "unknown" is never "allow".
  const viewerHrId = resolveEmployeeIdentityId(access);
  if (!hasCompanyWideMarketingClaim(access) && !viewerHrId) throw denied;

  const supabase = getSupabaseAdmin();
  const generatedAt = new Date().toISOString();

  // A read failure here throws rather than degrading: not knowing who the requester is, or which
  // steps exist, means not knowing whether this viewer may be here at all. Unknown is never allow.
  const [request, steps, activeEmployeeRows] = await Promise.all([
    loadMarketingRequestById(supabase, cleanRequestId),
    loadMarketingRequestApprovalSteps(supabase, cleanRequestId),
    getEmployeeDirectoryRows(),
  ]);

  const [requestProductCodes, ownedProductCodes] = await Promise.all([
    loadRequestProductCodes(supabase, cleanRequestId),
    resolveViewerOwnedProductCodes(supabase, access, activeEmployeeRows),
  ]);

  const admittedAs = resolveCaseFileAdmission({
    access,
    assignedSteps: steps.map((step) => ({ assignedHrId: step.assignedHrId, isCc: step.isCc })),
    // Exactly `canSeeMarketingRequest`'s rule, no wider — it is the requester / hierarchy / HR-scope
    // arm of the union and must not be quietly loosened on the way in.
    hierarchyAllows: canSeeMarketingHierarchyRecord(
      access,
      { employeeHrId: request.requesterHrId, managerHrId: request.managerHrId },
      activeEmployeeRows,
    ),
    requestProductCodes: requestProductCodes.codes,
    requesterHrId: request.requesterHrId,
    viewerOwnedProductCodes: ownedProductCodes.codes,
  });

  if (admittedAs.length === 0) {
    // A lookup that FAILED denies, exactly like no claim at all — but it says so, rather than
    // letting the viewer read the refusal as "you have no business here".
    if (ownedProductCodes.lookupFailed || requestProductCodes.lookupFailed) {
      throw forbiddenError(
        "Forbidden: you cannot view this marketing request. The product-ownership check could not be completed, so admission was refused rather than assumed.",
      );
    }
    throw denied;
  }

  // ── viewer tiers ───────────────────────────────────────────────────────────
  // Deliberately NO `scope === "system"` bypass on confidential products: the locked rule is
  // role-based, and a scope bypass would reopen it for every system-scoped non-CEO role.
  const canSeeConfidentialProducts = canViewRestrictedProducts(access.role);
  // The customer's captured address, contact mobile and GPS-stamped evidence frames.
  //
  // Every admission arm except one is a stake in this REQUEST — the requester, their management
  // chain, an approver, a CC reviewer, company oversight. `product_owner` is different: it is a
  // claim on the promoted PRODUCTS, not on the customer's doorstep, so a PM admitted only that way
  // reads the campaign without the customer's personal data.
  const canSeeCustomerPii = admittedAs.some((arm) => arm !== "product_owner");

  const employeesByHrId = employeeByHrId(activeEmployeeRows);
  const displayRows = await getEmployeeDirectoryRows({ includeInactive: true }).catch(() => activeEmployeeRows);
  const displayByHrId = employeeByHrId(displayRows);
  const nameOf = (hrId: string | null | undefined): string => {
    const key = normalizeHrId(hrId);
    if (!key) return "";
    return displayByHrId.get(key)?.displayName ?? employeesByHrId.get(key)?.displayName ?? key.toUpperCase();
  };

  const requesterRow = displayByHrId.get(normalizeHrId(request.requesterHrId) ?? "");

  // ── the sections, each free to fail on its own ─────────────────────────────
  const [
    requestTypeName,
    productsBlock,
    pharmaciesResult,
    customerResult,
    spentBeforeBlock,
    historyBlock,
    overlaps,
  ] = await Promise.all([
    loadMarketingRequestTypeName(supabase, request.requestTypeId).catch(() => null),
    loadProductsBlock(supabase, cleanRequestId, canSeeConfidentialProducts),
    loadTargetPharmacies(supabase, cleanRequestId, canSeeCustomerPii),
    loadCustomerBlock(supabase, request, canSeeCustomerPii, nameOf),
    loadSpentBefore(supabase, request),
    // Joins the same batch rather than adding a round trip of its own: every DB call from here
    // crosses to Frankfurt, so what costs is the number of trips, not the size of one.
    loadHistoryBlock(supabase, cleanRequestId, nameOf),
    // The ONE place a caught failure is allowed to become a value — and it becomes `null`, which
    // buildCaseFileWarnings renders as "UNKNOWN", never as "clear".
    loadMarketingRequestOverlaps(supabase, request).then(
      (rows) => rows,
      () => null as MarketingDecisionOverlap[] | null,
    ),
  ]);

  const chainBlock = buildChainBlock(steps, displayRows, viewerHrId);
  const targetPharmacies = pharmaciesResult.state === "ok" ? pharmaciesResult.value : null;

  // ── the ROI report, with the status scope stated EXPLICITLY ────────────────
  const roi = await loadRoiRow(access, request, generatedAt);

  const confidence: CaseFileBlock<RoiConfidence> =
    productsBlock.state === "ok" && pharmaciesResult.state === "ok" && roi.row
      ? caseFileOk(
        roiConfidenceOf({
          dataCoverage: roi.row.dataCoverage,
          payDate: request.payDate,
          pharmacies: pharmaciesResult.value.rows,
          products: productsBlock.value.rows.map((product) => ({ forecastQty: product.forecastQuantity })),
          roiWindow: roi.row.roiWindow,
          suspectPharmacyCount: pharmaciesResult.value.suspectCount,
        }),
      )
      : caseFileUnavailable(
        "The confidence score needs the promoted products, the target pharmacies and a live ROI row; at least one of them could not be read.",
      );

  const outcome = resolveOutcomeBlock({
    confidence,
    payDate: request.payDate,
    reportError: roi.error,
    roiDurationMonths: request.roiDurationMonths,
    row: roi.row,
    salesDataAsOf: roi.salesDataAsOf,
  });

  // ── header ─────────────────────────────────────────────────────────────────
  // Composed from the request itself, NOT from the ROI row — the ROI engine never returns a draft,
  // returned or rejected request, and those are exactly the three the case file exists to cover.
  const windowEnd = windowEndMonth(request.payDate, request.roiDurationMonths);
  const lifecycleStage = roiLifecycleStage(
    {
      dataCoverage: roi.row?.dataCoverage ?? "no_validated_data",
      payDate: request.payDate,
      status: request.status,
    },
    roi.salesDataAsOf,
  );
  const currentStepName = chainBlock.state === "ok" ? chainBlock.value.currentStepName : null;

  const warnings = buildCaseFileWarnings({
    confidentialWithheldCount: productsBlock.state === "ok" ? productsBlock.value.confidentialWithheldCount : 0,
    customerValidationStatus: customerResult.state === "ok" ? customerResult.value.validation.status : null,
    overlaps,
    targetPharmacies,
  });

  return {
    chain: chainBlock,
    customer: customerResult,
    generatedAt,
    header: {
      closedAt: request.closedAt,
      decidedAt: request.approvedAt ?? request.rejectedAt ?? request.returnedAt,
      lifecycleStage,
      lifecycleSentence: describeLifecycleStage({
        currentStepName,
        payDate: request.payDate,
        salesDataAsOf: roi.salesDataAsOf,
        stage: lifecycleStage,
        status: request.status,
        windowEnd,
      }),
      origin: requestProductCodes.origin ?? "phoenix",
      payDate: request.payDate,
      requestCode: request.requestCode,
      requestDate: request.requestDate,
      requestId: request.id,
      requestType: requestTypeName,
      requester: {
        areaName: requesterRow?.areaName ?? null,
        hrId: request.requesterHrId,
        lineName: requesterRow?.lineName ?? null,
        name: nameOf(request.requesterHrId) || request.requesterHrId,
        regionName: requesterRow?.regionName ?? null,
        role: requesterRow ? resolveJobFunctionRole(requesterRow.jobTitle) : null,
      },
      status: request.status,
      submittedAt: request.submittedAt,
    },
    history: historyBlock,
    lazySections: buildLazySections(cleanRequestId, access, admittedAs),
    money: buildMoney(request, spentBeforeBlock),
    outcome,
    products: productsBlock,
    targetPharmacies: pharmaciesResult,
    viewer: buildViewer(access, viewerHrId, admittedAs, steps, request, {
      canSeeConfidentialProducts,
      canSeeCustomerPii,
    }),
    warnings,
  };
}

// ── section loaders ──────────────────────────────────────────────────────────

async function loadRequestProductCodes(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  requestId: string,
): Promise<{ codes: string[]; lookupFailed: boolean; origin: string | null }> {
  const [linkResult, requestResult] = await Promise.all([
    supabase
      .from("marketing_request_products")
      .select("marketing_products(product_code)")
      .eq("request_id", requestId),
    supabase.from("marketing_requests").select("origin").eq("id", requestId).maybeSingle(),
  ]);
  const origin = cleanText((requestResult.data as { origin?: string | null } | null)?.origin);
  if (linkResult.error) return { codes: [], lookupFailed: true, origin };

  const codes = new Set<string>();
  for (const row of (linkResult.data ?? []) as Array<{ marketing_products?: { product_code?: string | null } | null }>) {
    const code = (row.marketing_products?.product_code ?? "").trim().toUpperCase();
    if (code) codes.add(code);
  }
  return { codes: [...codes], lookupFailed: false, origin };
}

/**
 * The product codes a PM/GPM owns, by their own line — the same rule the ROI module already uses.
 *
 * `codes: null` means "this role's visibility never comes from product ownership", which is a
 * different fact from "this owner owns nothing". A failed read reports `lookupFailed` and an EMPTY
 * set, so it can only ever DENY.
 */
async function resolveViewerOwnedProductCodes(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  access: AccessContext,
  employeeRows: EmployeeDirectoryRow[],
): Promise<{ codes: ReadonlySet<string> | null; lookupFailed: boolean }> {
  if (!productOwnerRoles.has(access.role)) return { codes: null, lookupFailed: false };
  const viewer = employeeByHrId(employeeRows).get(normalizeHrId(access.hrId) ?? "");
  const lineId = viewer?.lineId ?? null;
  if (lineId === null || lineId === undefined) return { codes: new Set<string>(), lookupFailed: false };

  const { data, error } = await supabase
    .from("marketing_products")
    .select("product_code")
    .eq("line_id", lineId)
    .or("active.is.null,active.eq.true");
  if (error) return { codes: new Set<string>(), lookupFailed: true };

  const codes = new Set<string>();
  for (const row of (data ?? []) as Array<{ product_code?: string | null }>) {
    const code = (row.product_code ?? "").trim().toUpperCase();
    if (code) codes.add(code);
  }
  return { codes, lookupFailed: false };
}

async function loadProductsBlock(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  requestId: string,
  canSeeConfidential: boolean,
): Promise<CaseFileBlock<MarketingCaseFileProducts>> {
  const { data, error } = await supabase
    .from("marketing_request_products")
    .select("product_id, product_name_snapshot, line_snapshot, factory_price_snapshot, forecast_quantity, value_share, marketing_products(product_code)")
    .eq("request_id", requestId);
  if (error) {
    return caseFileUnavailable("The promoted products could not be read, so this campaign's forecast cannot be shown.");
  }

  const rows: MarketingCaseFileProduct[] = [];
  let confidentialWithheldCount = 0;
  for (const raw of (data ?? []) as Array<{
    factory_price_snapshot?: number | string | null;
    forecast_quantity?: number | string | null;
    line_snapshot?: string | null;
    marketing_products?: { product_code?: string | null } | null;
    product_id: number | string;
    product_name_snapshot?: string | null;
    value_share?: number | string | null;
  }>) {
    if (!canSeeConfidential && isRestrictedProductCode(raw.marketing_products?.product_code)) {
      confidentialWithheldCount += 1;
      continue;
    }
    const factoryPrice = toNumber(raw.factory_price_snapshot);
    const forecastQuantity = toNumber(raw.forecast_quantity);
    rows.push({
      expectedValue: round2(factoryPrice * forecastQuantity),
      factoryPrice,
      forecastQuantity,
      line: cleanText(raw.line_snapshot),
      name: cleanText(raw.product_name_snapshot) ?? "Unnamed product",
      productId: Number(raw.product_id),
      valueShare: toNumber(raw.value_share),
    });
  }

  return caseFileOk({
    confidentialWithheldCount,
    rows,
    totalExpectedValue: round2(rows.reduce((sum, row) => sum + row.expectedValue, 0)),
    totalForecastUnits: round2(rows.reduce((sum, row) => sum + row.forecastQuantity, 0)),
  });
}

async function loadTargetPharmacies(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  requestId: string,
  canSeePii: boolean,
): Promise<CaseFileBlock<MarketingCaseFileTargetPharmacies>> {
  const linkResult = await supabase
    .from("marketing_request_pharmacies")
    .select("pharmacy_id, distributor_code_id, notes")
    .eq("request_id", requestId);
  if (linkResult.error) {
    return caseFileUnavailable("The target pharmacies could not be read, so what this campaign is pointed at is unknown.");
  }

  const links = (linkResult.data ?? []) as Array<{
    distributor_code_id: string | null;
    notes: string | null;
    pharmacy_id: string | null;
  }>;

  let resolved: MarketingDecisionPharmacy[];
  try {
    resolved = await loadMarketingDecisionPharmacies(supabase, links);
  } catch {
    return caseFileUnavailable("The target pharmacies could not be resolved to names and distributor codes.");
  }

  // Each pharmacy's OWN validation state, which no marketing surface has ever shown. 286 of 289
  // pharmacies in production are `pending` — "never validated" has to be visible, not silent.
  const pharmacyIds = [...new Set(links.map((link) => link.pharmacy_id).filter((id): id is string => Boolean(id)))];
  const validationByPharmacyId = new Map<string, MarketingValidationStatus>();
  if (pharmacyIds.length > 0) {
    const validationResult = await supabase
      .from("marketing_pharmacies")
      .select("id, validation_status")
      .in("id", pharmacyIds);
    for (const row of (validationResult.data ?? []) as Array<{ id: string; validation_status?: MarketingValidationStatus | null }>) {
      if (row.validation_status) validationByPharmacyId.set(String(row.id), row.validation_status);
    }
  }

  const rows: MarketingCaseFileTargetPharmacy[] = resolved.map((pharmacy) => {
    const referenceStatus = resolveReferenceStatus(pharmacy);
    return {
      distributorName: pharmacy.distributorName,
      distributorPharmacyCode: pharmacy.distributorPharmacyCode,
      evidencePhotoUrl: canSeePii ? pharmacy.evidencePhotoUrl : null,
      notes: pharmacy.notes,
      pharmacyCode: pharmacy.pharmacyCode,
      pharmacyId: pharmacy.pharmacyId,
      pharmacyName: pharmacy.pharmacyName,
      referenceStatus,
      referenceStatusSentence: describeReferenceStatus(referenceStatus),
      suspect: SUSPECT_REFERENCE_STATES.has(referenceStatus),
      validationStatus: pharmacy.pharmacyId ? validationByPharmacyId.get(pharmacy.pharmacyId) ?? null : null,
    };
  });

  return caseFileOk({
    rows,
    suspectCount: rows.filter((row) => row.suspect).length,
    unvalidatedCount: rows.filter((row) => !row.validationStatus || !VALIDATED_STATUSES.has(row.validationStatus)).length,
  });
}

async function loadCustomerBlock(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  request: MarketingRequest,
  canSeePii: boolean,
  nameOf: (hrId: string | null | undefined) => string,
): Promise<CaseFileBlock<MarketingCaseFileCustomer>> {
  if (!request.customerId) {
    return caseFileNotApplicable("This request carries no customer, so there is no customer record to show.");
  }

  const customerResult = await supabase
    .from("marketing_customers")
    // `speciality` does NOT exist on marketing_customers — naming it here throws "column does not
    // exist". The real column for the free-text qualifier is `other_type_description`.
    .select("display_name, customer_code, customer_type, other_type_description, captured_address, extracted_area_name, extracted_governorate_name, evidence_photo_name, evidence_photo_captured_at, validation_status, validated_at, validated_by_hr_id")
    .eq("id", request.customerId)
    .maybeSingle();
  if (customerResult.error) {
    return caseFileUnavailable("The customer record could not be read.");
  }
  if (!customerResult.data) {
    return caseFileUnavailable("This request points at a customer id that no longer exists in the customer database.");
  }

  const row = customerResult.data as {
    captured_address?: string | null;
    customer_code?: string | null;
    customer_type?: string | null;
    display_name?: string | null;
    evidence_photo_captured_at?: string | null;
    evidence_photo_name?: string | null;
    extracted_area_name?: string | null;
    extracted_governorate_name?: string | null;
    other_type_description?: string | null;
    validated_at?: string | null;
    validated_by_hr_id?: string | null;
    validation_status?: MarketingValidationStatus | null;
  };

  const validationStatus: MarketingValidationStatus = row.validation_status ?? "pending";
  const validatedByName = cleanText(nameOf(row.validated_by_hr_id));

  const contact: CaseFileBlock<{ mobile: string | null; name: string | null }> = !canSeePii
    ? caseFileUnavailable("The customer's contact details are withheld: they are personal data, and your claim on this request is on the promoted products rather than on the customer.")
    : !request.customerContactId
      ? caseFileNotApplicable("No contact person was recorded for this customer.")
      : await supabase
        .from("marketing_customer_contacts")
        .select("contact_name, mobile_number")
        .eq("id", request.customerContactId)
        .maybeSingle()
        .then((result) => {
          if (result.error) return caseFileUnavailable<{ mobile: string | null; name: string | null }>("The customer's contact record could not be read.");
          const contactRow = result.data as { contact_name?: string | null; mobile_number?: string | null } | null;
          if (!contactRow) return caseFileUnavailable<{ mobile: string | null; name: string | null }>("The recorded contact person no longer exists.");
          return caseFileOk({ mobile: cleanText(contactRow.mobile_number), name: cleanText(contactRow.contact_name) });
        });

  const evidencePhoto = !canSeePii
    ? caseFileUnavailable<{ capturedAt: string | null; fileName: string | null; url: string | null }>(
      "The shop-front photo is withheld: it carries a GPS stamp of a real business address, and your claim on this request is on the promoted products.",
    )
    : await loadMarketingEvidencePhoto({ entityId: request.customerId, entityType: "customer", supabase })
      .then((photo) =>
        photo
          ? caseFileOk({
            capturedAt: photo.capturedAt,
            fileName: cleanText(row.evidence_photo_name),
            url: photo.signedUrl,
          })
          : caseFileNotApplicable<{ capturedAt: string | null; fileName: string | null; url: string | null }>(
            cleanText(row.evidence_photo_name)
              ? `A capture named "${cleanText(row.evidence_photo_name)}" was recorded, but the image itself was never retained — a filename is not proof.`
              : "No shop-front photo was retained for this customer.",
          ),
      )
      .catch(() =>
        caseFileUnavailable<{ capturedAt: string | null; fileName: string | null; url: string | null }>(
          "The shop-front photo could not be signed for viewing.",
        ),
      );

  return caseFileOk({
    code: cleanText(row.customer_code),
    contact,
    customerId: request.customerId,
    evidencePhoto,
    location: {
      capturedAddress: canSeePii
        ? caseFileOk(cleanText(row.captured_address))
        : caseFileUnavailable<string | null>("The captured address is withheld: it is the customer's physical address, and your claim on this request is on the promoted products."),
      extractedAreaName: cleanText(row.extracted_area_name),
      extractedGovernorateName: cleanText(row.extracted_governorate_name),
    },
    name: cleanText(row.display_name),
    speciality: cleanText(row.other_type_description),
    type: cleanText(row.customer_type),
    validation: {
      sentence: VALIDATED_STATUSES.has(validationStatus)
        ? `Validated${validatedByName ? ` by ${validatedByName}` : ""}${row.validated_at ? ` on ${row.validated_at.slice(0, 10)}` : ""}.`
        : validationStatus === "rejected"
          ? "This customer was REJECTED during validation."
          : "Never validated — nobody has confirmed this customer exists as recorded.",
      status: validationStatus,
      validatedAt: row.validated_at ?? null,
      validatedByName,
    },
  });
}

async function loadSpentBefore(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  request: MarketingRequest,
): Promise<CaseFileBlock<MarketingCaseFileSpentBefore>> {
  if (!request.customerId) {
    return caseFileNotApplicable("This request carries no customer, so there is no prior spend to total.");
  }
  try {
    const rows = await loadMarketingCustomerSpendHistory(supabase, {
      customerId: request.customerId,
      excludeRequestId: request.id,
      // Drafts and rejected requests are NOT spend. The approver screen's equivalent applies no
      // filter at all and therefore counts abandoned and refused money as money out of the door.
      excludeStatuses: INERT_MARKETING_REQUEST_STATUSES,
    });
    const measured = rows.map((row) => row.actualSalesValue).filter((value): value is number => value !== null);
    return caseFileOk({
      isFirstRequest: rows.length === 0,
      // Null, never 0, when NO earlier request has a calculated return: "we spent and got nothing"
      // and "nobody has measured it yet" are opposite facts.
      priorRealisedSales: measured.length > 0 ? round2(measured.reduce((sum, value) => sum + value, 0)) : null,
      requests: rows.map((row) => ({
        actualSalesValue: row.actualSalesValue,
        estimatedCost: row.estimatedCost,
        payDate: row.payDate,
        requestCode: row.requestCode,
        status: row.status,
      })),
      total: round2(rows.reduce((sum, row) => sum + row.estimatedCost, 0)),
    });
  } catch {
    return caseFileUnavailable(
      "The customer's earlier requests could not be read, so what has already been spent here is unknown — it is NOT a clean slate.",
    );
  }
}

/**
 * Prose for each event kind. A raw `step_commented` must never reach a screen.
 *
 * Exported so this is tested for what it SAYS rather than for how it is written — in particular
 * that an unrecorded actor never renders as "the system", which is the one substitution that turns
 * a gap in the record into a false statement about who acted.
 */
export function marketingHistoryHeadline(
  row: Pick<MarketingRequestEventRow, "from_status" | "kind" | "step_name" | "to_status">,
  actorName: string | null,
): string {
  const who = actorName ?? "Someone (not recorded)";
  const step = row.step_name ? ` at ${row.step_name}` : "";
  switch (row.kind) {
    case "request_created":
      return `${who} raised the request`;
    case "request_submitted":
      return `${who} submitted it for approval`;
    case "request_status_changed":
      // The status words are the DB's own vocabulary; underscores are not for reading.
      return `Status changed${row.from_status ? ` from ${row.from_status.replace(/_/g, " ")}` : ""}${
        row.to_status ? ` to ${row.to_status.replace(/_/g, " ")}` : ""
      }`;
    case "request_value_changed":
      return `${who} changed the requested figures`;
    case "request_deleted":
      return `${who} deleted the request`;
    case "step_opened":
      return `Opened${step}`;
    case "step_decided":
      // A rung a REFUSAL closed out arrives here too: the reject marks every waiting rung
      // 'skipped', which is a status change, so the capture trigger records it as `step_decided`
      // with `decision_by_hr_id` still null — and the trigger then falls back to `assigned_hr_id`
      // for the actor. Naming that person would say they skipped their own step. Nobody decided it;
      // the refusal ended the chain above it. Caught on staging by reading the events a reject
      // actually writes, not by reading the trigger.
      if (row.to_status === "skipped") return `Closed out without a decision${step}`;
      return `${who} ${row.to_status ? row.to_status.replace(/_/g, " ") : "decided"}${step}`;
    case "step_commented":
      return `${who} commented${step}`;
  }
}

export type MarketingRequestEventRow = {
  actor_hr_id: string | null;
  from_status: string | null;
  kind: MarketingRequestEventKind;
  note: string | null;
  occurred_at: string;
  payload: Record<string, unknown> | null;
  step_name: string | null;
  step_sequence: number | null;
  to_status: string | null;
};

/**
 * The event log — the only record of a comment that was later overwritten.
 *
 * `postMarketingAdvisoryComment` writes the comment into ONE text column on the CC step, so a
 * reviewer's second comment replaces their first and the row can only ever show the latest. The
 * `marketing_request_steps_capture_event` trigger records each write as its own `step_commented`
 * row, so the history survives — but nothing read it until this function, which made a preserved
 * comment indistinguishable from a destroyed one for anyone actually using the app.
 *
 * A failed read is `unavailable`, never an empty list: "there is no history" and "the history could
 * not be read" are the two answers this whole contract exists to keep apart.
 */
async function loadHistoryBlock(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  requestId: string,
  nameOf: (hrId: string | null | undefined) => string,
): Promise<CaseFileBlock<MarketingCaseFileHistory>> {
  const result = await supabase
    .from("marketing_request_events")
    .select("kind,actor_hr_id,occurred_at,from_status,to_status,step_sequence,step_name,note,payload")
    .eq("request_id", requestId)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });

  if (result.error) {
    return caseFileUnavailable(
      `The history could not be read (${result.error.message}). Nothing is being shown rather than an empty timeline, which would read as "nothing ever happened".`,
    );
  }

  const rows = (result.data ?? []) as MarketingRequestEventRow[];
  const entries = rows.map((row) => {
    const name = nameOf(row.actor_hr_id);
    // nameOf falls back to the upper-cased HR_ID for an id it cannot resolve; an empty string is
    // what it returns for no id at all, and THAT is the "not recorded" case.
    const actorName = name === "" ? null : name;
    return {
      actorHrId: row.actor_hr_id,
      actorName,
      atLabel: cairoDateTime(row.occurred_at) ?? row.occurred_at,
      headline: marketingHistoryHeadline(row, actorName),
      isBackfilled: row.payload?.backfilled === true || row.payload?.backfilled === "true",
      kind: row.kind,
      note: row.note,
      occurredAt: row.occurred_at,
      stepName: row.step_name,
    };
  });

  const commentCount = entries.filter((entry) => entry.kind === "step_commented").length;

  return caseFileOk({
    commentCount,
    // Never present a short list as a complete one. The table starts on 2026-08-13; a comment a
    // reviewer overwrote before that was only ever held in one column and is genuinely gone.
    coverageSentence:
      entries.length === 0
        ? "No history has been recorded for this request. Events have only been captured since 13 Aug 2026 — anything earlier was not kept."
        : `${entries.length} recorded event${entries.length === 1 ? "" : "s"}. Events have been captured since 13 Aug 2026; entries marked as reconstructed were derived from the request's own rows rather than recorded as they happened.`,
    entries,
  });
}

/**
 * The chain, with the CC rows KEPT.
 *
 * `buildMarketingApproverChain` is the richest builder in the module — it credits `decisionByHrId`
 * over `assignedHrId`, so a reassigned step never misattributes a predecessor's approval to
 * whoever holds it now. It drops CC rows, correctly, because an advisory comment is not one more
 * approval on an inbox row. On a case file the opposite is true: "the Product Manager was asked
 * and said nothing" is a fact about the decision, so the CC rows are appended and tagged.
 */
function buildChainBlock(
  steps: MarketingRequestApprovalStep[],
  employeeRows: EmployeeDirectoryRow[],
  viewerHrId: string | null,
): CaseFileBlock<MarketingCaseFileChain> {
  if (steps.length === 0) {
    return caseFileNotApplicable("This request has no approval chain — it has never been submitted.");
  }

  const myStep = viewerHrId
    ? steps.find((step) => normalizeHrId(step.assignedHrId) === viewerHrId) ?? null
    : null;
  const byHrId = employeeByHrId(employeeRows);
  const nameOf = (hrId: string | null | undefined) => {
    const key = normalizeHrId(hrId);
    if (!key) return "";
    return byHrId.get(key)?.displayName ?? key.toUpperCase();
  };

  const gatingByStepName = new Map(
    buildMarketingApproverChain(steps, employeeRows, myStep?.id ?? null).map((rung) => [rung.sequence, rung] as const),
  );

  const rungs: MarketingCaseFileChainRung[] = [...steps]
    .sort((left, right) => left.sequence - right.sequence || Number(left.isCc) - Number(right.isCc))
    .map((step) => {
      const gating = step.isCc ? null : gatingByStepName.get(step.sequence) ?? null;
      return {
        // The gating rung's own attribution rule wins where it applies; a CC row has no decision
        // chain to misattribute, so its assignee IS its approver.
        approverName: gating?.approverName ?? nameOf(step.decisionByHrId ?? step.assignedHrId),
        assignedHrId: step.assignedHrId,
        assignedName: nameOf(step.assignedHrId),
        assignedRole: step.assignedRole,
        decisionAt: step.decisionAt,
        decisionByHrId: step.decisionByHrId,
        decisionNote: cleanText(step.decisionNote),
        isCc: step.isCc,
        isCurrent: step.status === "current",
        isMine: Boolean(viewerHrId) && normalizeHrId(step.assignedHrId) === viewerHrId,
        sequence: step.sequence,
        status: step.status,
        stepName: step.stepName,
      };
    });

  const gatingRungs = rungs.filter((rung) => !rung.isCc);
  const current = gatingRungs.find((rung) => rung.isCurrent) ?? null;
  const returned = gatingRungs.find((rung) => rung.status === "returned") ?? null;

  return caseFileOk({
    approvedGatingCount: gatingRungs.filter((rung) => rung.status === "approved").length,
    currentStepName: (current ?? returned ?? gatingRungs[gatingRungs.length - 1])?.stepName ?? null,
    returnReason: returned?.decisionNote ?? null,
    rungs,
    totalGatingSteps: gatingRungs.length,
  });
}

/**
 * The filter the Case File hands the ROI engine — the single most important line in this module.
 *
 * `status: [request.status]` is stated EXPLICITLY and must never be dropped. `resolveRoiStatusScope`
 * defaults an empty status list to the five APPROVED statuses, so an unfiltered call silently
 * returns nothing at all for a draft, returned or rejected request. Its own comment names the
 * remedy: "An explicit status selection always wins."
 *
 * Exported and pure so that rule is executable in a test, against the real `resolveRoiStatusScope`,
 * for exactly the statuses the engine otherwise drops.
 */
export function caseFileRoiFilters(
  request: { status: MarketingRequest["status"] },
  access: AccessContext,
): RoiFilterState {
  return {
    ...emptyRoiFilterState(),
    // Only ever honoured for CEO / Super Admin inside the report itself; stated here so the
    // request the Case File makes is legible rather than implied.
    includeRestricted: canViewRestrictedProducts(access.role),
    status: [request.status],
  };
}

/**
 * The realized-ROI row for THIS request.
 *
 * Never throws: an ROI engine failure becomes `error`, which the outcome block renders as
 * `unavailable`. It must never become a zeroed `ok`.
 */
async function loadRoiRow(
  access: AccessContext,
  request: MarketingRequest,
  generatedAtIso: string,
): Promise<{ error: string | null; row: MarketingRoiReportRow | null; salesDataAsOf: string | null }> {
  try {
    const report = await getMarketingRoiReport(access, caseFileRoiFilters(request, access), generatedAtIso);
    return {
      error: null,
      row: report.rows.find((row) => row.requestId === request.id) ?? null,
      salesDataAsOf: report.kpi.salesDataAsOf ?? null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "unknown error",
      row: null,
      salesDataAsOf: null,
    };
  }
}

function buildMoney(
  request: MarketingRequest,
  spentBefore: CaseFileBlock<MarketingCaseFileSpentBefore>,
): MarketingCaseFileMoney {
  return {
    estimatedCost: round2(request.estimatedCost),
    expectedRoiValue: round2(request.expectedRoiValue),
    forecastCoverageRatio: request.requiredRoiValue > 0
      ? round2(request.expectedRoiValue / request.requiredRoiValue)
      : request.expectedRoiValue > 0
        ? 1
        : 0,
    requiredRoiValue: round2(request.requiredRoiValue),
    roiDurationMonths: request.roiDurationMonths,
    roiWindow: roiWindowLabel(request.payDate, request.roiDurationMonths),
    spentBefore,
  };
}

function buildViewer(
  access: AccessContext,
  viewerHrId: string | null,
  admittedAs: MarketingCaseFileAdmission[],
  steps: MarketingRequestApprovalStep[],
  request: MarketingRequest,
  tiers: { canSeeConfidentialProducts: boolean; canSeeCustomerPii: boolean },
): MarketingCaseFileViewer {
  // Mirrors postMarketingAdvisoryComment's eligibility rule: a CC reviewer may comment while the
  // gating step their row is attached to is the CURRENT one. Affordance only — that route
  // re-checks it before writing anything.
  const currentGating = steps.find((step) => step.status === "current" && !step.isCc) ?? null;
  const canComment = Boolean(
    viewerHrId &&
      currentGating &&
      steps.some(
        (step) => step.isCc && step.stepCode === currentGating.stepCode && normalizeHrId(step.assignedHrId) === viewerHrId,
      ),
  );

  return {
    admittedAs,
    can: {
      comment: canComment,
      // Only the holder of the CURRENT gating step decides, and only while the request is actually
      // pending. decideMarketingRequestWorkflow enforces both again.
      decide: Boolean(
        viewerHrId &&
          currentGating &&
          request.status === "pending_approval" &&
          normalizeHrId(currentGating.assignedHrId) === viewerHrId,
      ),
      resubmit: Boolean(
        viewerHrId && request.status === "returned" && normalizeHrId(request.requesterHrId) === viewerHrId,
      ),
    },
    canSeeConfidentialProducts: tiers.canSeeConfidentialProducts,
    canSeeCustomerPii: tiers.canSeeCustomerPii,
    hrId: viewerHrId ? viewerHrId.toUpperCase() : null,
    role: access.role,
  };
}

/**
 * The panels the Case File deliberately does not inline.
 *
 * Each costs its own multi-query pass; paying for all of them on every open would make the one
 * page slower than the twenty it replaces.
 */
function buildLazySections(
  requestId: string,
  access: AccessContext,
  admittedAs: MarketingCaseFileAdmission[],
): MarketingCaseFileLazySection[] {
  const isParticipant = admittedAs.some(
    (arm) => arm === "chain_step" || arm === "cc_reviewer" || arm === "system" || arm === "company_oversight",
  );
  return [
    {
      available: isParticipant,
      href: `/api/marketing-requests/${requestId}/sales-evidence`,
      key: "sales_evidence",
      label: "Customer sales history",
      reason: "A full customer history scan across every validated import batch — too heavy to run on every open.",
    },
    {
      available: true,
      href: `/api/marketing-requests/${requestId}/roi-explain`,
      key: "roi_explain",
      label: "How this ROI was calculated",
      reason: "Re-runs the attribution explain pass line by line; only useful when a reader disputes the number.",
    },
    {
      available: true,
      href: `/api/marketing-requests/${requestId}/view-sales`,
      key: "view_sales",
      label: "Matched sales rows",
      reason: "The individual invoice lines behind the attributed figure — potentially thousands of rows.",
    },
    {
      available: access.role === "Super Admin" || access.scope === "system" || isParticipant,
      href: `/api/marketing-requests/${requestId}/track-direct-sales`,
      key: "direct_tracking",
      label: "Direct-sales tracking",
      reason: "Only meaningful for campaigns flagged to track direct orders.",
    },
  ];
}
