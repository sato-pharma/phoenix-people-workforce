
import {
  normalizeHrId,
  normalizeHrIdForAccess,
  resolveEmployeeIdentityId,
  resolveNavigationMode,
  systemAccessContext,
  type AccessContext,
  type NavigationMode,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { isReadOnlyViewer } from "@/lib/auth/read-only-viewer";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import {
  OUTSTATION_CLAIM_CHANGED_CODE,
  OUTSTATION_CLAIM_REVISION_MISSING_MESSAGE,
  OutstationClaimChangedError,
  assertOutstationClaimUnchanged,
  isOutstationClaimChangedError,
  outstationClaimRevision,
} from "@/lib/outstation/claim-revision";
import { composeDecisionNote } from "@/lib/outstation/decision-note";
import {
  OUTSTATION_CLAIM_DECIDED_MESSAGE,
  OUTSTATION_UNDECIDED_STATUSES,
  isOutstationClaimUndecided,
} from "@/lib/outstation/undecided-claim";
import { carTripFuelIsUnpriceable, UNPRICEABLE_CAR_TRIP_MESSAGE } from "@/lib/outstation/fuel-policy";
import { getRepTripVisitWorkload } from "@/lib/crm/visit-workload";
import { mergeWorkloadEvidence } from "@/lib/outstation/workload-evidence";
import { getDoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/types";
import { validateLiveArrivalEvidence } from "@/lib/outstation/car-evidence";
import {
  formatOutstationDescriptionInline,
  humanizeOutstationCode,
  parseOutstationDescription,
  tidyOutstationAddress,
} from "@/lib/outstation/description-format";
import {
  isOutstationEvidenceWaivedRole,
  isOutstationTicketWaivedRole,
} from "@/lib/outstation/evidence-waiver";
import {
  OUTSTATION_NO_HOLD_ADMIN_APPROVAL_REASON,
  OUTSTATION_NO_HOLD_APPROVAL_REASON,
  isOutstationNoHoldRole,
} from "@/lib/outstation/nsm-no-hold";
import {
  createOutstationCarEvidenceSignedUrl,
  createOutstationEvidenceSignedUrls,
  uploadOutstationDepartureEvidenceImage,
  deleteOutstationCarEvidenceImage,
  deleteOutstationMeetingInvoice,
  deleteOutstationTicketAttachments,
  uploadOutstationCarEvidenceImage,
  uploadOutstationJourneyStopImage,
  uploadOutstationMeetingInvoice,
  uploadOutstationTicketAttachments,
  type OutstationTicketAttachmentUploadInput,
} from "@/lib/outstation/car-evidence-storage";
import { classifyOutstationExpenseEligibility } from "@/lib/outstation/classification";
import {
  JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE,
  MAX_JOURNEY_STOPS,
  journeyOverlapHoldReason,
  journeyStopDays,
  pickJourneyLegOrigin,
  priceChainedJourney,
  readJourneyPricing,
  readJourneyStops,
  rebaseClaimOnNewFuel,
  withJourneyReason,
  type ChainedJourneyPricing,
  type OutstationJourneyStop,
} from "@/lib/outstation/chained-journey";
import { resolveGovernorate } from "@/lib/geo/egypt-locations";
import {
  outstationCampaignRuleOutcome,
  outstationDvEvidenceWindowClosed,
  outstationGpsAccuracyHoldReason,
  outstationTicketEvidenceRejection,
  type OutstationCampaignRuleOutcome,
} from "@/lib/outstation/decision";
import { overnightStayEvidenceHoldReason } from "@/lib/outstation/overnight-evidence";
import {
  approvalReasonAfterMissingTicketAttached,
  canAttachMissingOutstationTicket,
  eligibilityAfterMissingTicketAttached,
  MISSING_TICKET_ALREADY_ATTACHED_MESSAGE,
  MISSING_TICKET_WRONG_TRANSPORT_MESSAGE,
  missingTicketAttachedSentence,
  OUTSTATION_ELIGIBLE_LOCATION_REASON,
  OUTSTATION_OFFLINE_TICKET_HOLD_REASON,
  OUTSTATION_TICKET_EVIDENCE_REQUIRED_REASON,
} from "@/lib/outstation/missing-ticket";
import {
  isNonTravelExpenseType,
  NON_TRAVEL_APPROVAL_REASON,
  NON_TRAVEL_ELIGIBILITY_REASON,
  NON_TRAVEL_LOCATION_SOURCE,
  NON_TRAVEL_NO_INVOICE_HOLD_REASON,
  nonTravelAmountRefusal,
  nonTravelDestinationLabel,
  nonTravelTripLabel,
  priceNonTravelExpense,
} from "@/lib/outstation/non-travel-expense";
import { readAccuracyInput } from "@/lib/geo/coordinate-input";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { formatPhoenixDateTime, formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  attachOutstationCapturedLocations,
  resolveOutstationCapturedLocation,
} from "@/lib/outstation/captured-location";
import { captureOutstationTripWorkload } from "@/lib/outstation/workload-capture";
import { storedWorkloadMatchStatus } from "@/lib/outstation/workload-evidence";
import {
  capturedWorkloadColumns,
  isWorkloadRestampCandidate,
  restampWindowStart,
  shouldRestampWorkload,
  WORKLOAD_RESTAMP_MAX_ROWS,
} from "@/lib/outstation/workload-stamp";
import {
  allowanceRowDates,
  deriveClaimedAllowanceDays,
  type AllowanceClaimingRequest,
} from "@/lib/outstation/allowance-day-guard";
import {
  duplicateTripMessage,
  findDuplicateTrip,
  type DuplicateTripCandidate,
  type DuplicateTripExisting,
} from "@/lib/outstation/duplicate-trip-guard";
import {
  applyCairoNoAllowance,
  cairoTripEarnsNoAllowance,
} from "@/lib/outstation/cairo-allowance-rule";
import { usablePosition } from "@/lib/outstation/captured-coordinates";
import { outstationClaimedTotal } from "@/lib/outstation/claimed-total";
import {
  cairoDateOnly,
  isWithinDepartureWindow,
  reviewDepartureEvidence,
  type DepartureEvidenceReview,
} from "@/lib/outstation/departure-evidence";
import {
  readDepartureLocationRefusals,
  withDepartureLocationRefusal,
  type DepartureLocationRefusalReason,
} from "@/lib/outstation/departure-location-refusals";
import { departurePhotoLocationRefusal } from "@/lib/outstation/departure-photo-location";
import {
  isOutstationExpenseInPayroll,
  isOutstationRequestHeldForRepair,
  nextEvidenceGateStatus,
  outstationDeparturePhotoReminderDue,
  resolveOutstationGateState,
  validateManualWorkloadInput,
  type OutstationGateBlocker,
} from "@/lib/outstation/expense-gate";
import { forbiddenError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import {
  resolveOutstationRecipientAddresses,
  resolveOutstationSubmitRouting,
} from "@/lib/outstation/submit-recipients";
import { createSystemNotification, createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { resolveNotificationRoleEnabled, resolveRoleRecipientHrIds } from "@/lib/notifications/role-recipients";
import { logError, logInfo } from "@/lib/observability/log";
import {
  canViewEmployeeExpenseScope,
  EXPENSE_DECISION_SELECT,
  isPayrollExpensesSchemaMissing,
  resyncPayrollExpenseStepForRemovedTrips,
  savePayrollExpenseApprovals,
} from "@/lib/outstation/expenses";
import {
  mapOutstationRequestToPayrollExpenseRecord,
  outstationPayrollTripId,
  outstationPharmacyWorkload,
  outstationReportOverride,
} from "@/lib/outstation/payroll-expense-mapping";
import {
  liveOutstationEmployeeName,
  loadLiveOutstationEmployeeNames,
  outstationRecordName,
  withLiveOutstationEmployeeNames,
} from "@/lib/outstation/employee-name";
import { isAdjustedAmount } from "@/lib/outstation/approval-state";
import { planOutstationRequestDecision } from "@/lib/outstation/expense-approval-decisions";
import { assertOutstationExpenseWorkflowTransition } from "@/lib/outstation/workflow";
import { workflowExpenseReportFileName } from "@/lib/outstation/workflow-expense-report-guard";
import {
  validateMedicalRepSimpleExpenseInput,
  type MedicalRepSimpleExpenseInput,
} from "@/lib/outstation/medical-rep-expenses";
import { assertMedicalRepExpenseRole } from "@/lib/outstation/medical-rep-expense-viewer";
import {
  googleDirectionsRoute,
  googleGeocodeAddress,
  googleReverseGeocode,
} from "@/lib/google-maps/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  EmployeeResidenceLocation,
  ManagerExpenseAdminInput,
  OutstationAllowanceBreakdown,
  OutstationApprovalRecommendation,
  OutstationCarEvidenceMetadata,
  OutstationDepartureEvidenceMetadata,
  OutstationDepartureEvidenceVersion,
  OutstationEvidenceGateStatus,
  OutstationWorkloadGateStatus,
  OutstationCalculationInput,
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationTicketAttachmentMetadata,
  OutstationEligibilityStatus,
  OutstationExpenseType,
  OutstationExpenseRequest,
  OutstationHeatmapData,
  OutstationHeatmapMarker,
  OutstationPolicyRule,
  OutstationRouteAlternative,
  OutstationTerritoryValidationStatus,
  OutstationTransportationType,
} from "@/lib/outstation/types";

type ValidationContext = {
  access: AccessContext;
  /** Null when the device reported no accuracy — never read as 0 m. */
  capturedAccuracyMeters: number | null;
  capturedAt?: string | null;
  capturedLatitude: number;
  capturedLongitude: number;
  hasTicketAttachments?: boolean;
  offlineCaptured?: boolean;
};

type ValidatedLocationBundle = {
  /** Canonical governorate of the captured (destination) point, or null when unresolved. */
  destinationGovernorate: string | null;
  employee: EmployeeDirectoryRow | null;
  identity: {
    employeeArea: string | null;
    employeeHrId: string;
    employeeLine: string | null;
    employeeName: string;
    employeeRole: string;
  };
  policy: OutstationPolicyRule;
  residence: EmployeeResidenceLocation | null;
  /** Canonical governorate of the employee's residence, or null when unresolved. */
  residenceGovernorate: string | null;
  result: OutstationCaptureResult;
};

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanText(value: unknown) {
  const normalized = text(value);
  return normalized.length > 0 ? normalized : null;
}

function appendCarEvidenceNote(
  notes: string | null,
  metadata: OutstationCarEvidenceMetadata | null | undefined,
  // Every transportation type carries an arrival photo now, so the audit line must not
  // label a train's evidence "Car". The stored shape is unchanged — only the label moves.
  transportationType: OutstationTransportationType,
) {
  if (!metadata) return notes;

  const evidenceLine = [
    transportationType === "car" ? "Car live evidence:" : "Arrival photo evidence:",
    `source=${metadata.source}`,
    `hr_id=${metadata.employeeHrId}`,
    `captured_at=${metadata.capturedAt}`,
    `location=${metadata.capturedLocationLabel ?? ""}`,
    `gps=${metadata.capturedLatitude},${metadata.capturedLongitude}`,
    `draft_id=${metadata.requestDraftId ?? ""}`,
    `request_id=${metadata.requestId ?? ""}`,
  ].join(" ");

  return [notes, evidenceLine].filter(Boolean).join("\n");
}

/**
 * Puts the duplicate-day guard's reason in the SAME notes an employee already reads, not only
 * in the structured breakdown JSON. He should never have to open the raw record to find out
 * whether a missing allowance line was deliberate — that uncertainty is exactly what made him
 * stop and flag this in the first place.
 */
function appendAllowanceGuardNote(
  notes: string | null,
  allowanceBreakdown: OutstationAllowanceBreakdown | null | undefined,
) {
  const skipped = (allowanceBreakdown?.rows ?? []).filter((row) => row.skipped && row.skipReason);
  if (skipped.length === 0) return notes;

  // One sentence per DISTINCT reason, with the number of days it covered. The breakdown has a row
  // per trip day, so a five-day Cairo trip used to write "No allowance: a trip to Cairo from a
  // regional base does not earn an outstation per-diem allowance." five times in a row — measured
  // on OUTSTATION-148, 2026-09-28. A reason that names its own date stays distinct by construction.
  const counts = new Map<string, number>();
  for (const row of skipped) {
    const reason = String(row.skipReason).trim();
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const sentences = [...counts].map(([reason, days]) =>
    days > 1 ? `${reason.replace(/\.$/, "")} (${days} days).` : reason,
  );
  const line = `Allowance guard: ${sentences.join(" ")}`;
  return [notes, line].filter(Boolean).join("\n");
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A database number, or null when the column held nothing.
 *
 * 🔴 `Number(null)` is **0**, and `Number.isFinite(0)` is **true** — so the obvious one-liner
 * (`Number.isFinite(Number(v)) ? Number(v) : null`) turns a NULL column into a real zero and
 * every downstream `x == null` guard stops firing. `Number("")` and `Number("  ")` are 0 too.
 * Only `undefined` and unparseable text fall through to null on their own.
 *
 * That cost nine real expense claims across two people. `employee_locations.residence_latitude`
 * was NULL, this returned 0, the submit-time guard in `validateCapturedLocation`
 * ("Your registered residence location is missing or invalid. Please contact HR…") therefore
 * never fired, and (0, 0) was frozen onto every row they filed: AI-0013 filed 8 claims worth
 * 5,277 EGP between 2026-09-08 and 2026-09-27, and A-7 one worth 1,035 EGP on 2026-07-06 — two
 * months apart, so this was never a one-off. Google answers those with
 * `"Location coordinates must not be (0, 0)"` days later, so instead of being told at submit
 * that HR needed to fix the address, they filed claims that could not be measured and a human
 * was handed raw API JSON as the reason. Both hold real coordinates now. Measured 2026-09-28.
 *
 * A genuine numeric 0 in the column still returns 0 — only "there was nothing there" becomes null.
 * Latent beyond coordinates: `report_meeting_amount`/`report_other_amount` map through here and
 * `outstationReportOverride` treats 0 as a real override that beats the raw amount (see
 * payroll-expense-mapping.ts), so a NULL override would have paid 0 instead of the raw figure.
 * Not live — production has no NULL in either column today — but it is the same defect.
 */
function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoString(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function roundCoordinate(value: number) {
  return Math.round(value * 100000) / 100000;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

// Outstation expenses are reviewed/approved by HR, not Finance. Map any legacy
// "finance_review" rows persisted before that rename onto the current value so
// the UI shows "HR review" consistently without a data migration.
function normalizeApprovalRecommendation(value: string): OutstationApprovalRecommendation {
  if (value === "finance_review") return "hr_review";
  return value as OutstationApprovalRecommendation;
}

function minutesFromSeconds(value: number | null | undefined) {
  return value != null ? Number((value / 60).toFixed(1)) : null;
}

function normalizeArea(value: string | null | undefined) {
  return text(value).toLowerCase();
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "object") return value as T;
  const raw = text(value);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fallbackWorkloadEvidence(params: {
  sourceLabel: string;
  tripEndDate: string;
  tripStartDate: string;
}): DoubleVisitExpenseWorkloadEvidence {
  const start = params.tripStartDate.slice(0, 10);
  const end = params.tripEndDate.slice(0, 10);
  return {
    amWorkload: 0,
    dateBreakdown: [{ am: 0, date: start, evidenceRows: 0, pharmacies: 0, pm: 0, total: 0 }],
    importId: null,
    matchedDates: [],
    matchStatus: "stale_import",
    missingDates: start && end ? [start, end].filter((value, index, list) => value && list.indexOf(value) === index) : [],
    pharmacyWorkload: 0,
    pmWorkload: 0,
    campaignVisits: 0,
    regularVisits: 0,
    source: "manual",
    sourceLabel: params.sourceLabel,
  };
}

async function resolveOutstationWorkloadPayload(params: {
  employeeHrId: string | null;
  tripEndDate: string;
  tripStartDate: string;
}) {
  // TWO sources on purpose — they answer different questions and must not be conflated.
  //
  // Workload / "did this rep actually work these days" comes from the CRM visits read, which
  // counts every field visit where the rep is the primary agent OR the double-visit partner.
  // The double-visit mirror cannot see a rep's SOLO field days, so it reported worked days as
  // "no activity" and the decision engine judged real trips against a workload of zero.
  //
  // The campaign-visit cap deliberately KEEPS the double-visit source. That rule (rule 3 in
  // decision.ts, reached through campaignRuleOutcome here) rejects on "campaign DOUBLE-visits" and on
  // "no double-visit activity". Feeding it the CRM read would break it both ways: solo campaign
  // visits would inflate campaignVisits into spurious auto-rejections, and solo visits would
  // satisfy the totalDvVisits > 0 test, silently fail-opening a live rejection rule.
  const [doubleVisitEvidence, repWorkload] = await Promise.all([
    getDoubleVisitExpenseWorkloadEvidence(params).catch((error) =>
      fallbackWorkloadEvidence({
        sourceLabel: error instanceof Error
          ? `Double Visit evidence unavailable: ${error.message}`
          : "Double Visit evidence unavailable.",
        tripEndDate: params.tripEndDate,
        tripStartDate: params.tripStartDate,
      }),
    ),
    // Never let the corrected read take a write path down: on failure we keep the previous
    // (under-counting) behaviour rather than blocking an expense submission.
    getRepTripVisitWorkload({
      hrId: params.employeeHrId,
      tripEndDate: params.tripEndDate,
      tripStartDate: params.tripStartDate,
    }).catch(() => null),
  ]);

  const evidence = mergeWorkloadEvidence(doubleVisitEvidence, repWorkload);

  return {
    am_workload: evidence.amWorkload,
    // The third figure (AM · PM · Pharmacies). Every evidence builder sets it; NULL on a row means
    // it was stamped before the split, with its pharmacy visits still inside AM/PM.
    pharmacy_workload: evidence.pharmacyWorkload ?? 0,
    pm_workload: evidence.pmWorkload,
    workload_evidence_snapshot: evidence,
    workload_match_status: storedWorkloadMatchStatus(evidence.matchStatus),
    workload_matched_at: new Date().toISOString(),
    workload_source: evidence.source,
    workload_source_import_id: evidence.importId,
  };
}

function isMissingSupabaseRelation(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    message.includes("Could not find the table") ||
    message.includes("schema cache")
  );
}

function isMissingTolerancePolicyColumn(
  error: { code?: string; message?: string } | null,
) {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    error.code === "42703" ||
    (message.includes("column") &&
      message.includes("does not exist") &&
      message.includes("tolerance_minimum_distance_km"))
  );
}

function daysBetween(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }

  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(0, Math.round((endUtc - startUtc) / 86400000));
}

/**
 * The raw per-day allowance for ONE trip span. Pure: no employee id, no database, no idea any
 * OTHER request exists.
 *
 * DO NOT call this directly outside calculateGuardedAllowanceBreakdown below. Until
 * 2026-08-08 this WAS the only allowance function, called independently from all four write
 * paths (employee wizard, admin preview, admin create, admin edit) — each one priced its own
 * trip span with zero awareness of a sibling request touching the same calendar day. An
 * employee who submitted a trip, then separately logged a same-day meeting invoice, was about
 * to be paid a full second day's allowance purely because two different requests happened to
 * name the same date. He caught it himself before submitting; the owner hit the identical
 * bypass on the very next manual expense he tried to create. Kept private and unexported for
 * exactly that reason: this file is the only place allowance is ever computed, and every path
 * through it must go through the guarded version.
 */
function calculateRawAllowanceBreakdown(
  tripStartDate: string,
  tripEndDate: string,
  policy: OutstationPolicyRule,
) {
  const overnightDays = daysBetween(tripStartDate, tripEndDate);
  const sameDayTrip = overnightDays === 0;
  const rows: OutstationAllowanceBreakdown["rows"] = [];

  if (sameDayTrip) {
    rows.push({
      amount: policy.sameDayAllowance,
      label: "Same day allowance",
      type: "same_day",
    });
  } else {
    for (let index = 0; index < overnightDays; index += 1) {
      rows.push({
        amount: policy.overnightAllowance,
        label: `Overnight allowance day ${index + 1}`,
        type: "overnight",
      });
    }
    rows.push({
      amount: policy.returnDayAllowance,
      label: "Return day allowance",
      type: "return_day",
    });
  }

  const allowanceAmount = roundMoney(rows.reduce((sum, row) => sum + row.amount, 0));
  return {
    allowanceAmount,
    breakdown: {
      overnightDays,
      returnDayApplied: !sameDayTrip,
      rows,
      sameDayTrip,
    } satisfies OutstationAllowanceBreakdown,
    overnightDays,
    sameDayTrip,
  };
}

/**
 * The allowance for a Meeting expense — always zero. Owner rule, 2026-09-04: a Meeting entry
 * is priced on the meeting cost alone, never a distance/day-driven allowance, so the three
 * ManagerExpense* functions below skip calculateGuardedAllowanceBreakdown entirely for it
 * rather than compute a real breakdown and then discard it.
 */
function zeroAllowanceBreakdown(): ReturnType<typeof calculateRawAllowanceBreakdown> {
  return {
    allowanceAmount: 0,
    breakdown: {
      overnightDays: 0,
      returnDayApplied: false,
      rows: [],
      sameDayTrip: true,
    },
    overnightDays: 0,
    sameDayTrip: true,
  };
}

/**
 * Every calendar day, for one employee, already covered by a live request's allowance —
 * mapped to the id of the request that claims it.
 *
 * Read fresh on every calculation rather than cached: this is the guard that stops the same
 * day being paid twice, so it has to see whatever the database holds RIGHT NOW.
 */
async function resolveClaimedAllowanceDays(input: {
  employeeHrId: string;
  excludeRequestId?: number;
}): Promise<Map<string, number>> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("id, status, trip_start_date, trip_end_date")
    .ilike("employee_hr_id", input.employeeHrId)
    .gt("allowance_amount", 0);

  if (error || !data) return new Map();

  const requests: AllowanceClaimingRequest[] = (
    data as Array<{ id: number; status: string; trip_end_date: string; trip_start_date: string }>
  ).map((row) => ({
    id: row.id,
    status: row.status,
    tripEndDate: row.trip_end_date,
    tripStartDate: row.trip_start_date,
  }));

  return deriveClaimedAllowanceDays(requests, input.excludeRequestId);
}

/**
 * Refuses a second claim for a trip the employee already claimed — same day, same destination
 * (duplicate-trip-guard.ts). Read fresh, like the allowance guard: it must see what the database
 * holds at the moment of submitting. A failed read refuses nothing — the payroll duplicate hold
 * is still the later net.
 */
async function assertNoDuplicateTrip(input: DuplicateTripCandidate, excludeRequestId?: number) {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("id, status, employee_hr_id, expense_type, trip_start_date, to_area, to_city, captured_latitude, captured_longitude")
    .ilike("employee_hr_id", input.employeeHrId)
    .gte("trip_start_date", `${input.tripStartDate.slice(0, 10)}T00:00:00Z`)
    .lte("trip_start_date", `${input.tripStartDate.slice(0, 10)}T23:59:59Z`);
  if (error || !data) return;

  const existing: DuplicateTripExisting[] = (
    data as Array<{
      captured_latitude: number | null;
      captured_longitude: number | null;
      employee_hr_id: string;
      expense_type: string | null;
      id: number;
      status: string;
      to_area: string | null;
      to_city: string | null;
      trip_start_date: string;
    }>
  ).map((row) => ({
    capturedLatitude: row.captured_latitude,
    capturedLongitude: row.captured_longitude,
    employeeHrId: row.employee_hr_id,
    expenseType: row.expense_type,
    id: row.id,
    status: row.status,
    toArea: row.to_area,
    toCity: row.to_city,
    tripStartDate: row.trip_start_date,
  }));

  const earlier = findDuplicateTrip(input, existing, excludeRequestId);
  if (earlier) throw new Error(duplicateTripMessage(earlier));
}

/**
 * The one function every write path must call for allowance. Prices the trip span, then
 * zeroes any day another live request already claims for this employee — never refuses the
 * request over it, because the rest of the claim (ticket, meeting cost, other) is real
 * regardless of whether its date overlaps someone else's trip, and blocking the whole
 * submission over one duplicate line would strand it.
 *
 * Every zeroed row carries WHY, in skipReason — this is not a silent correction. The employee
 * who reported this asked for exactly that: never make him wonder whether a missing allowance
 * line is a bug.
 */
async function calculateGuardedAllowanceBreakdown(input: {
  destinationGovernorate?: string | null;
  employeeHrId: string;
  excludeRequestId?: number;
  policy: OutstationPolicyRule;
  residenceGovernorate?: string | null;
  tripEndDate: string;
  tripStartDate: string;
}) {
  const raw = calculateRawAllowanceBreakdown(input.tripStartDate, input.tripEndDate, input.policy);

  const claimedDays = await resolveClaimedAllowanceDays({
    employeeHrId: input.employeeHrId,
    excludeRequestId: input.excludeRequestId,
  });

  // Duplicate-day guard: zero any calendar day another live request already claims for this
  // employee, so one day is never paid twice.
  let guarded = raw;
  if (claimedDays.size > 0) {
    const rowDates = allowanceRowDates(input.tripStartDate, raw.breakdown.rows.length);
    let removedAmount = 0;
    const guardedRows = raw.breakdown.rows.map((row, index) => {
      const day = rowDates[index];
      const claimingRequestId = claimedDays.get(day);
      if (claimingRequestId == null) return row;

      removedAmount += row.amount;
      return {
        ...row,
        amount: 0,
        skipReason: `Allowance for ${day} was already granted on request #${claimingRequestId} — not paid twice.`,
        skipped: true,
      };
    });

    if (removedAmount > 0) {
      guarded = {
        allowanceAmount: roundMoney(raw.allowanceAmount - removedAmount),
        breakdown: { ...raw.breakdown, rows: guardedRows } satisfies OutstationAllowanceBreakdown,
        overnightDays: raw.overnightDays,
        sameDayTrip: raw.sameDayTrip,
      };
    }
  }

  // Cairo rule (owner, 2026-08-15): a regional employee's trip to the Cairo governorate earns no
  // per-diem allowance. Transport / tickets / meeting still pay — only the allowance rows are
  // zeroed, each tagged with why (visible-not-silent, the same discipline as the guard above).
  // A caller that leaves either governorate undefined (or unresolved) keeps today's behaviour.
  if (cairoTripEarnsNoAllowance(input.residenceGovernorate, input.destinationGovernorate)) {
    const cairo = applyCairoNoAllowance(guarded.breakdown);
    if (cairo.removedAmount > 0) {
      return {
        allowanceAmount: cairo.allowanceAmount,
        breakdown: cairo.breakdown,
        overnightDays: guarded.overnightDays,
        sameDayTrip: guarded.sameDayTrip,
      };
    }
  }

  return guarded;
}

function positiveMoney(value: unknown) {
  return roundMoney(Math.max(0, numberValue(value)));
}

function optionalPositiveMoney(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return positiveMoney(value);
}

function reportTripTypeLabel(input: {
  override?: string | null;
  overnightDays: number;
  sameDayTrip: boolean;
}) {
  const override = cleanText(input.override);
  if (override) return override;
  return input.sameDayTrip
    ? "Return same day"
    : `Overnight / ${input.overnightDays + 1} days`;
}

function reportExpectedTotal(input: {
  allowanceAmount: number;
  eligibilityStatus: OutstationEligibilityStatus;
  meetingAmount: number;
  otherAmount: number;
  travelCost: number;
}) {
  if (input.eligibilityStatus === "not_eligible") return 0;
  return roundMoney(
    input.travelCost +
      input.meetingAmount +
      input.allowanceAmount +
      input.otherAmount,
  );
}

function recommendationForResult(params: {
  eligibilityStatus: OutstationEligibilityStatus;
  hasTicketAttachments: boolean;
  policy: OutstationPolicyRule;
  // Canonical job-function role. Present so the ticket-evidence recommendation can honour the
  // same waiver the submit gate does — otherwise a waived role would submit successfully and
  // then land on the approvals screen recommended for "hr_review: ticket evidence required",
  // which is the rule the owner just removed, restated as a nudge to a human.
  role: string;
  territoryValidationStatus: OutstationTerritoryValidationStatus;
  transportationType: OutstationTransportationType;
}) {
  if (params.eligibilityStatus === "not_eligible") {
    return {
      approvalReason:
        "Request is below policy distance or otherwise fails the minimum eligibility rules.",
      approvalRecommendation: "reject" as OutstationApprovalRecommendation,
    };
  }

  if (
    (params.transportationType === "train" || params.transportationType === "bus") &&
    params.policy.requiresTicketAttachment &&
    !isOutstationTicketWaivedRole(params.role) &&
    !params.hasTicketAttachments
  ) {
    return {
      approvalReason:
        "Train or bus requests require ticket evidence before HR can approve the claim.",
      approvalRecommendation: "hr_review" as OutstationApprovalRecommendation,
    };
  }

  // 🔴 `matched` IS THE EXCEPTION, NOT THE PASS. This comparison used to be the other way round and
  // it was tautological. Owner's decision, 2026-09-28.
  //
  // `validateTerritory` returns `matched` when the captured destination's area EQUALS the
  // employee's assigned area. An outstation trip is by definition a trip OUTSIDE that area — that
  // is what the word means and what the allowance pays for — so `outside_expected_territory` is the
  // signature of a LEGITIMATE claim, while `matched` means somebody claimed an outstation allowance
  // for a trip inside their own territory, which is the case actually worth a look.
  //
  // Measured on production before this flipped: across all 153 outstation requests ever recorded,
  // the status was `outside_expected_territory` (80.4%) or `not_available` (19.6%) and NEVER
  // `matched` — so this branch fired on every single one and the `auto_approve` below had never
  // once been reached. A flag that is on for 100% of rows is not a flag.
  if (params.eligibilityStatus === "needs_review" || params.territoryValidationStatus === "matched") {
    return {
      approvalReason:
        params.territoryValidationStatus === "matched"
          ? "The captured destination is inside the employee's own assigned area, so on the face of it this is not an outstation trip and a manager should look."
          : "Location or timing checks require manager review before the request can move forward.",
      approvalRecommendation: "manager_review" as OutstationApprovalRecommendation,
    };
  }

  return {
    approvalReason:
      "Distance, location, and policy checks are clean enough for automatic approval recommendation.",
    approvalRecommendation: "auto_approve" as OutstationApprovalRecommendation,
  };
}

// Campaign-visit cap (#11): a TRAVELING expense for a District/Training Manager needs
// at least one double-visit and at most 2 campaign visits (the rest regular). Meeting /
// other expense types and all other roles are unaffected.
//
// The RULE itself lives in decision.ts and is called, not copied — a second implementation of a
// live rejection rule is how the two drift apart. This function only feeds it the two things it
// cannot work out for itself: the counts off the double-visit evidence, and whether the CRM has
// had a fair chance to record that evidence yet (outstationDvEvidenceWindowClosed).
//
// Same-day submissions are the case this exists for. Reps enter their visits through and after
// the working day, so a trip claimed on its own morning ALWAYS reads zero double-visits — that is
// a missing measurement, not proof of no field work, and it is now a HOLD for review rather than
// an automatic rejection.
function campaignRuleOutcome(input: {
  role: string;
  expenseType: OutstationExpenseType;
  evidence: DoubleVisitExpenseWorkloadEvidence;
  tripEndDate: string;
}): OutstationCampaignRuleOutcome {
  const campaignVisits = input.evidence.campaignVisits ?? 0;
  return outstationCampaignRuleOutcome({
    campaignVisits,
    dvEvidenceWindowClosed: outstationDvEvidenceWindowClosed({
      cairoTodayIso: cairoTodayIso(),
      tripEndDate: input.tripEndDate,
    }),
    expenseType: input.expenseType,
    role: input.role,
    totalDvVisits: campaignVisits + (input.evidence.regularVisits ?? 0),
  });
}

// Lives in employee-name.ts, beside the READ-side resolver that undoes the same snapshot from
// the other end. Re-exported here because every caller — and the test that pins the write
// paths — reaches it through the service.
export { outstationRecordName };

/**
 * The READ side of the same rule.
 *
 * `employee_name` on a request row is a snapshot taken at submit time, so a later correction to
 * the employee record never reaches rows already written — that is why the 2026-09-21 repair had
 * to be applied to 432 live rows by hand instead of fixing one record each. Every list a human
 * reads a name from therefore resolves it live, with ONE cached directory read for the whole list.
 *
 * The stored column itself is left exactly as written: it stays the audit trail of what was true
 * on the day, and nothing here writes to it. An HR id the directory does not know — an imported
 * row, a person never in the master — keeps its stored name rather than blanking.
 */
async function withLiveRequestNames<T extends { employeeHrId: string; employeeName: string }>(
  requests: T[],
): Promise<T[]> {
  return withLiveOutstationEmployeeNames(
    requests,
    (request) => ({ hrId: request.employeeHrId, storedName: request.employeeName }),
    (request, employeeName) => ({ ...request, employeeName }),
  );
}

async function getEmployeeIdentity(access: AccessContext) {
  const identityHrId = resolveEmployeeIdentityId(access);
  if (!identityHrId) {
    throw new Error("Your employee profile is not linked yet. Please contact HR.");
  }

  const directory = await getEmployeeDirectory();
  const employee =
    directory.employees.find(
      (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(identityHrId),
    ) ?? null;

  if (!employee?.hrId) {
    throw new Error("Your employee profile is not available in the employee directory. Please contact HR before submitting an outstation request.");
  }

  return {
    employee,
    employeeArea: employee?.areaName ?? null,
    employeeHrId: employee.hrId,
    employeeLine: employee?.lineName ?? null,
    employeeName: employee?.displayName ?? employee.hrId,
    // The name PERSISTED onto the request row — deliberately NOT `employeeName`.
    //
    // `displayName` is nickname-first by design (employee-directory.ts says so in its own type:
    // "use this for live UI/report rendering; use fullName for legal/payroll documents,
    // persisted workflow audit snapshots, and identity-matching logic"). An outstation request
    // is exactly that third thing — a persisted workflow row that feeds the approvals queue,
    // the expense-claims mirror and payroll — so it takes the employee RECORD's full name.
    //
    // Writing `displayName` here is what put login handles and short forms on 432 rows of live
    // claims (29 people, repaired 2026-09-21). 18 of the 25 wrong names were simply whatever the
    // nickname column held at the time; the other 7 were short forms frozen from a nickname that
    // has since been edited, which no reader could ever have corrected.
    employeeRecordName: outstationRecordName(employee),
    employeeRole: resolveJobFunctionRole(employee?.jobTitle ?? access.role),
  };
}

export async function getOutstationEmployeeContext(access: AccessContext) {
  const identity = await getEmployeeIdentity(access);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId, { persist: !isReadOnlyViewer(access) });

  return {
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
    residence,
  };
}

function residenceSummary(parts: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
}) {
  return [
    parts.residenceAddress,
    parts.residenceCity,
    parts.residenceArea,
  ]
    .map((value) => text(value))
    .filter(Boolean)
    .join(" - ");
}

function fallbackResidenceFromEmployee(employee: EmployeeDirectoryRow): EmployeeResidenceLocation | null {
  const hasResidenceText = Boolean(
    text(employee.residenceAddress) ||
      text(employee.residenceCity) ||
      text(employee.residenceArea),
  );
  const hasCoordinates =
    employee.residenceLatitude != null && employee.residenceLongitude != null;

  if (!hasResidenceText && !hasCoordinates) {
    return null;
  }

  return {
    employeeHrId: employee.hrId,
    geocodeStatus: employee.residenceGeocodeStatus,
    residenceAddress: text(employee.residenceAddress) || null,
    residenceArea: text(employee.residenceArea) || null,
    residenceCity: text(employee.residenceCity) || null,
    residenceLatitude: employee.residenceLatitude,
    residenceLongitude: employee.residenceLongitude,
  };
}

// MEMOIZED PER REQUEST (React cache(), 2026-10-01, "slow to transfer between page and page"): the
// My Outstation Expenses page resolves its context and its request list side by side, and both went
// through here — so every render read employee_locations twice and, for a residence with no
// coordinates yet, geocoded it and wrote the same UPDATE twice. `access` is the page's request-cached
// object, passed by reference to both, so the second call now shares the first one's answer (its
// refusal included). Nobody mutates the result. cache() never spans two requests, and outside a
// render — the submit API route — it is a plain call, so the submit path is unchanged.
const getMedicalRepExpenseIdentity = cache(async (access: AccessContext) => {
  const identity = await getEmployeeIdentity(access);
  // The page reads this refusal through the same module — see medical-rep-expense-viewer.ts.
  assertMedicalRepExpenseRole(identity.employeeRole);
  const residence =
    (await getResidenceLocationForEmployee(identity.employeeHrId, { persist: !isReadOnlyViewer(access) })) ??
    fallbackResidenceFromEmployee(identity.employee);
  const fromLocation = residence ? residenceSummary(residence) : "";

  return {
    ...identity,
    fromLocation,
    residence,
  };
});

export async function getMedicalRepExpenseContext(access: AccessContext) {
  const identity = await getMedicalRepExpenseIdentity(access);

  return {
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
    fromLocation: identity.fromLocation,
    residence: identity.residence,
  };
}

/**
 * `persist: false` geocodes for the answer but writes nothing: a test login (src/lib/auth/test-persona.ts)
 * opening the real person's expense pages must never fill in HER residence coordinates.
 */
export async function getResidenceLocationForEmployee(employeeHrId: string, options: { persist?: boolean } = {}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_locations")
    .select("*")
    .ilike("employee_hr_id", employeeHrId)
    .maybeSingle();

  if (error) {
    if (isMissingSupabaseRelation(error)) {
      return null;
    }
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  const residence: EmployeeResidenceLocation = {
    employeeHrId: text(data.employee_hr_id),
    geocodeStatus: text(data.geocode_status) || null,
    residenceAddress: text(data.residence_address) || null,
    residenceArea: text(data.residence_area) || null,
    residenceCity: text(data.residence_city) || null,
    residenceLatitude: nullableNumber(data.residence_latitude),
    residenceLongitude: nullableNumber(data.residence_longitude),
  };

  if (
    (residence.residenceLatitude == null || residence.residenceLongitude == null) &&
    residence.residenceAddress
  ) {
    const geocoded = await googleGeocodeAddress(
      [
        residence.residenceAddress,
        residence.residenceArea,
        residence.residenceCity,
        "Egypt",
      ]
        .filter(Boolean)
        .join(", "),
    ).catch(() => null);

    if (geocoded && options.persist === false) {
      residence.residenceLatitude = geocoded.lat;
      residence.residenceLongitude = geocoded.lng;
    } else if (geocoded) {
      await supabase
        .from("employee_locations")
        .update({
          geocode_status: "success",
          residence_latitude: geocoded.lat,
          residence_longitude: geocoded.lng,
          updated_at: new Date().toISOString(),
        })
        .ilike("employee_hr_id", employeeHrId);
      residence.residenceLatitude = geocoded.lat;
      residence.residenceLongitude = geocoded.lng;
      residence.geocodeStatus = "success";
    }
  }

  return residence;
}

export async function getOutstationPolicies() {
  const supabase = getSupabaseAdmin();
  const queryColumns =
    "active,created_at,fuel_rate_per_km,gps_accuracy_threshold_meters,id,max_offline_sync_delay_hours,minimum_distance_km,overnight_allowance,requires_ticket_attachment,return_day_allowance,role_name,same_day_allowance,updated_at";

  const executePolicyQuery = async (includeTolerance: boolean) =>
    includeTolerance
      ? supabase
          .from("outstation_policy_rules")
          .select("*")
          .order("role_name", { ascending: true })
      : supabase
          .from("outstation_policy_rules")
          .select(queryColumns)
          .order("role_name", { ascending: true });

  let includeTolerance = true;
  let { data, error } = await executePolicyQuery(true);

  if (error && isMissingTolerancePolicyColumn(error)) {
    ({ data, error } = await executePolicyQuery(false));
    includeTolerance = false;
  }

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map<OutstationPolicyRule>((row) => ({
    active: Boolean(row.active),
    createdAt: isoString(row.created_at),
    fuelRatePerKm: numberValue(row.fuel_rate_per_km),
    gpsAccuracyThresholdMeters: numberValue(row.gps_accuracy_threshold_meters || 100),
    id: Number(row.id),
    maxOfflineSyncDelayHours: numberValue(row.max_offline_sync_delay_hours || 8),
    minimumDistanceKm: numberValue(row.minimum_distance_km),
    toleranceMinimumDistanceKm: includeTolerance
      ? nullableNumber(row.tolerance_minimum_distance_km)
      : null,
    overnightAllowance: numberValue(row.overnight_allowance),
    requiresTicketAttachment: Boolean(row.requires_ticket_attachment),
    returnDayAllowance: numberValue(row.return_day_allowance),
    roleName: text(row.role_name),
    sameDayAllowance: numberValue(row.same_day_allowance),
    updatedAt: isoString(row.updated_at),
  }));
}

async function getActivePolicyForRole(roleName: string) {
  const policies = await getOutstationPolicies();
  const exact = policies.find(
    (policy) => policy.active && policy.roleName.toLowerCase() === roleName.toLowerCase(),
  );
  if (exact) return exact;

  const fallback = policies.find(
    (policy) =>
      policy.active &&
      (policy.roleName.toLowerCase() === "employee" ||
        policy.roleName.toLowerCase() === "medical rep"),
  );

  if (!fallback) {
    throw new Error(`No active outstation policy was found for role ${roleName}.`);
  }

  return fallback;
}

async function getCachedRoute(params: {
  capturedLatitude: number;
  capturedLongitude: number;
  employeeHrId: string;
  residenceLatitude: number;
  residenceLongitude: number;
}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("distance_km,duration_minutes,route_polyline")
    .ilike("employee_hr_id", params.employeeHrId)
    .eq("residence_latitude", roundCoordinate(params.residenceLatitude))
    .eq("residence_longitude", roundCoordinate(params.residenceLongitude))
    .eq("captured_latitude", roundCoordinate(params.capturedLatitude))
    .eq("captured_longitude", roundCoordinate(params.capturedLongitude))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    distanceKm: nullableNumber(data.distance_km),
    durationMinutes: nullableNumber(data.duration_minutes),
    routePolyline: text(data.route_polyline) || null,
  };
}

async function validateTerritory(input: {
  capturedArea: string | null;
  capturedCity: string | null;
  employeeArea: string | null;
}) {
  const normalizedCapturedArea = normalizeArea(input.capturedArea);
  const employeeAreaKey = normalizeArea(input.employeeArea);

  // 🔴 READ THESE TWO THE RIGHT WAY ROUND. `matched` is the ODD one for an outstation claim: the
  // destination is inside the employee's own area, so there was no out-of-station travel to pay
  // for. `outside_expected_territory` is what a genuine outstation trip looks like. The wording
  // used to say the opposite and it drove the whole recommendation backwards — see
  // `resolveApprovalRecommendation` above.
  if (employeeAreaKey && normalizedCapturedArea && employeeAreaKey === normalizedCapturedArea) {
    return {
      reason:
        "Captured destination is inside the employee's own assigned area — an outstation claim would not normally be expected here.",
      status: "matched" as OutstationTerritoryValidationStatus,
    };
  }

  if (employeeAreaKey && normalizedCapturedArea && employeeAreaKey !== normalizedCapturedArea) {
    return {
      reason: "Captured destination is outside the employee's assigned area, as an outstation trip should be.",
      status: "outside_expected_territory" as OutstationTerritoryValidationStatus,
    };
  }

  return {
    reason: "Employee area or captured destination area is not available for territory validation.",
    status: "not_available" as OutstationTerritoryValidationStatus,
  };
}

/**
 * Resolve a canonical Egyptian governorate from the first of several candidate
 * strings that yields a confident match. Used so a residence/destination whose
 * governorate lives in a secondary field (area / address) still resolves.
 */
function resolveFirstGovernorate(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const governorate = resolveGovernorate(value ?? "");
    if (governorate) return governorate;
  }
  return null;
}

async function validateCapturedLocation(
  params: ValidationContext,
): Promise<ValidatedLocationBundle> {
  const identity = await getEmployeeIdentity(params.access);
  const policy = await getActivePolicyForRole(identity.employeeRole);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId);
  const submittedAt = new Date().toISOString();

  if (
    !residence ||
    residence.residenceLatitude == null ||
    residence.residenceLongitude == null
  ) {
    throw new Error(
      "Your registered residence location is missing or invalid. Please contact HR before submitting an outstation request.",
    );
  }

  let eligibilityStatus: OutstationEligibilityStatus = "eligible";
  let eligibilityReason = OUTSTATION_ELIGIBLE_LOCATION_REASON;
  const capturedAt = isoString(params.capturedAt) || submittedAt;

  let polyline: string | null = null;
  let durationMinutes: number | null = null;
  let distanceKm: number | null = null;
  let routeAlternatives: OutstationRouteAlternative[] = [];
  let selectedRouteIndex: number | null = null;
  let selectedRouteReason: "fastest_duration" | null = null;
  let routeError: string | null = null;

  try {
    const directions = await googleDirectionsRoute(
      {
        lat: residence.residenceLatitude,
        lng: residence.residenceLongitude,
      },
      {
        lat: params.capturedLatitude,
        lng: params.capturedLongitude,
      },
    );
    if (directions.distanceMeters != null) {
      distanceKm = Number((directions.distanceMeters / 1000).toFixed(2));
    }
    durationMinutes =
      minutesFromSeconds(directions.durationInTrafficSeconds) ??
      minutesFromSeconds(directions.durationSeconds);
    polyline = directions.polyline;
    selectedRouteIndex = directions.selectedRouteIndex;
    selectedRouteReason = directions.selectedRouteIndex != null ? "fastest_duration" : null;
    routeAlternatives = directions.alternatives.map((route) => ({
      distanceKm:
        route.distanceMeters != null ? Number((route.distanceMeters / 1000).toFixed(2)) : null,
      durationInTrafficMinutes: minutesFromSeconds(route.durationInTrafficSeconds),
      durationMinutes: minutesFromSeconds(route.durationSeconds),
      encodedPolyline: route.encodedPolyline,
      index: route.index,
      isSelected: route.isSelected,
      summary: route.summary,
    }));
  } catch (error) {
    routeError =
      error instanceof Error
        ? error.message
        : "Google Routes API failed to calculate the driving route.";
  }

  if (distanceKm == null || durationMinutes == null || polyline == null) {
    const route = await getCachedRoute({
      capturedLatitude: params.capturedLatitude,
      capturedLongitude: params.capturedLongitude,
      employeeHrId: identity.employeeHrId,
      residenceLatitude: residence.residenceLatitude,
      residenceLongitude: residence.residenceLongitude,
    });

    polyline = polyline ?? route?.routePolyline ?? null;
    durationMinutes = durationMinutes ?? route?.durationMinutes ?? null;
    distanceKm = distanceKm ?? route?.distanceKm ?? null;

    if (distanceKm != null || durationMinutes != null || polyline != null) {
      routeError = null;
    }
  }

  const distanceEligibility = classifyOutstationExpenseEligibility({
    actualDistanceKm: distanceKm,
    policy: {
      officialMinimumDistanceKm: policy.minimumDistanceKm,
      toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
    },
  });
  const distanceReason =
    distanceEligibility.classification === "missing_distance" && routeError
      ? `Distance could not be validated against Google Maps. ${routeError}`
      : distanceEligibility.reason;

  if (distanceEligibility.classification === "not_eligible") {
    eligibilityStatus = "not_eligible";
    eligibilityReason = distanceReason;
  } else if (distanceEligibility.classification !== "eligible") {
    // tolerance / missing / invalid / manual-exception — accept but flag for review.
    eligibilityStatus = "needs_review";
    eligibilityReason = distanceReason;
  }

  const reverse = await googleReverseGeocode({
    lat: params.capturedLatitude,
    lng: params.capturedLongitude,
  }).catch(() => null);

  const territory = await validateTerritory({
    capturedArea: reverse?.area ?? null,
    capturedCity: reverse?.city ?? null,
    employeeArea: identity.employeeArea,
  });

  // Residence-vs-destination governorate rule: a trip must be OUTSIDE the
  // employee's residence governorate. Canonicalize both via resolveGovernorate so a
  // plain compare is valid. Each side is resolved from MULTIPLE fields (first hit
  // wins) so a town-only value in one field does not defeat the check when another
  // field carries the governorate.
  const residenceGovernorate = resolveFirstGovernorate(
    residence.residenceCity,
    residence.residenceArea,
    residence.residenceAddress,
  );
  const destinationGovernorate = resolveFirstGovernorate(
    reverse?.governorate,
    reverse?.formattedAddress,
    reverse?.city,
    reverse?.area,
  );
  if (
    eligibilityStatus !== "not_eligible" &&
    residenceGovernorate &&
    destinationGovernorate &&
    residenceGovernorate === destinationGovernorate
  ) {
    eligibilityStatus = "not_eligible";
    eligibilityReason = `Destination is within the same governorate as your residence (${residenceGovernorate}) and is not eligible for an outstation expense.`;
  }
  // Owner rule: when a governorate can NOT be confirmed (either side unresolved),
  // do not silently auto-pay — hold the request for Super Admin review instead.
  const governorateReviewRequired =
    eligibilityStatus !== "not_eligible" && (!residenceGovernorate || !destinationGovernorate);

  const result: OutstationCaptureResult = {
    // Read once more at the service boundary, so a caller that hands over NaN still stores null.
    capturedAccuracyMeters: readAccuracyInput(params.capturedAccuracyMeters),
    capturedAt,
    capturedLatitude: params.capturedLatitude,
    capturedLocationSource: "browser_gps",
    capturedLongitude: params.capturedLongitude,
    distanceFromResidenceKm: distanceKm,
    durationMinutes,
    eligibilityReason,
    eligibilityStatus,
    governorateReviewRequired,
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
    minimumRequiredDistanceKm: policy.minimumDistanceKm,
    residenceLatitude: residence.residenceLatitude,
    residenceLongitude: residence.residenceLongitude,
    routeAlternatives,
    routePolyline: polyline,
    routeProvider: "google_maps",
    routeError,
    selectedRouteIndex,
    selectedRouteReason,
    submittedAt,
    territoryValidationReason: territory.reason,
    territoryValidationStatus: territory.status,
    toArea: reverse?.area ?? null,
    toCity: reverse?.city ?? null,
    toLabel: reverse?.formattedAddress ?? null,
  };

  return {
    destinationGovernorate,
    employee: identity.employee,
    identity,
    policy,
    residence,
    residenceGovernorate,
    result,
  };
}

export async function captureOutstationLocation(
  access: AccessContext,
  input: {
    capturedAccuracyMeters: number | null;
    capturedAt?: string;
    capturedLatitude: number;
    capturedLongitude: number;
    offlineCaptured?: boolean;
  },
) {
  const validated = await validateCapturedLocation({ access, ...input });
  return validated.result;
}

/**
 * A Meeting or Other expense, priced on its two typed amounts alone — see non-travel-expense.ts.
 *
 * No position is read and no route is asked for: `input.captured*` and `input.transportationType`
 * are ignored on purpose, so a client that still posts a stale destination, kilometre reading or
 * ticket amount cannot put a distance, fuel, ticket or allowance line on the claim. The employee's
 * residence does not have to exist either, which the trip flow refuses to run without.
 *
 * The `captured_latitude` / `captured_longitude` columns are NOT NULL, so they carry the registered
 * residence when there is one (0 only when there is none) under the `no_travel_expense` source —
 * the same device the medical-rep manual path uses. Nothing computes from them.
 */
async function calculateNonTravelExpense(
  access: AccessContext,
  input: OutstationCalculationInput,
): Promise<OutstationCalculationResult> {
  const expenseType = input.expenseType;
  if (!isNonTravelExpenseType(expenseType)) {
    throw new Error("A non-travel calculation needs a Meeting or Other expense type.");
  }

  const amountRefusal = nonTravelAmountRefusal({
    meetingAmount: input.meetingAmount,
    otherAmount: input.otherAmount,
  });
  if (amountRefusal) throw new Error(amountRefusal);

  const tripStartDate = isoString(input.tripStartDate);
  const tripEndDate = isoString(input.tripEndDate);
  if (!input.tripStartDate || !input.tripEndDate) {
    throw new Error("Trip start and end dates are required.");
  }
  if (!tripStartDate || !tripEndDate) {
    throw new Error("Trip dates are invalid.");
  }

  const identity = await getEmployeeIdentity(access);
  const policy = await getActivePolicyForRole(identity.employeeRole);
  const priced = priceNonTravelExpense({
    meetingAmount: input.meetingAmount,
    otherAmount: input.otherAmount,
  });
  const allowance = zeroAllowanceBreakdown();
  const now = new Date().toISOString();
  const inputClaimedTotalAmount = numberValue(input.claimedTotalAmount);

  return {
    allowanceAmount: allowance.allowanceAmount,
    allowanceBreakdown: allowance.breakdown,
    approvalReason: NON_TRAVEL_APPROVAL_REASON,
    approvalRecommendation: "manager_review",
    attachmentCount: Math.max(0, Math.trunc(numberValue(input.attachmentCount))),
    calculationStatus: "calculated",
    capturedAccuracyMeters: null,
    capturedAt: now,
    capturedLatitude: identity.employee.residenceLatitude ?? 0,
    capturedLocationSource: NON_TRAVEL_LOCATION_SOURCE,
    capturedLongitude: identity.employee.residenceLongitude ?? 0,
    carEvidenceImagePath: null,
    claimedTotalAmount: inputClaimedTotalAmount > 0 ? inputClaimedTotalAmount : priced.totalAmount,
    distanceFromResidenceKm: null,
    durationMinutes: null,
    eligibilityReason: NON_TRAVEL_ELIGIBILITY_REASON,
    eligibilityStatus: "eligible",
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
    expectedTotalAmount: priced.totalAmount,
    expenseType,
    fuelAmount: priced.fuelAmount,
    governorateReviewRequired: false,
    kilometerReading: null,
    medicalTripHrId: cleanText(input.medicalTripHrId) ?? null,
    medicalTripName: cleanText(input.medicalTripName) ?? null,
    minimumRequiredDistanceKm: policy.minimumDistanceKm,
    notes: cleanText(input.notes) ?? null,
    offlineCaptured: false,
    overnightDays: allowance.overnightDays,
    reportAmWorkload: positiveMoney(input.amWorkload),
    reportMeetingAmount: priced.meetingAmount,
    reportOtherAmount: priced.otherAmount,
    reportPmWorkload: positiveMoney(input.pmWorkload),
    reportTravelCost: priced.travelCost,
    reportTripType: nonTravelTripLabel(expenseType),
    residenceLatitude: identity.employee.residenceLatitude,
    residenceLongitude: identity.employee.residenceLongitude,
    routeAlternatives: [],
    routeError: null,
    routePolyline: null,
    routeProvider: "google_maps",
    sameDayTrip: allowance.sameDayTrip,
    selectedRouteIndex: null,
    selectedRouteReason: null,
    submittedAt: now,
    territoryValidationReason: "Meeting or Other expense; territory check not applicable.",
    territoryValidationStatus: "not_available",
    ticketAmount: priced.ticketAmount,
    toArea: null,
    toCity: null,
    toLabel: nonTravelDestinationLabel(expenseType),
    // The column is NOT NULL with a car/train/bus/other check; "other" is the mode-less value.
    transportationType: "other",
    tripEndDate,
    tripStartDate,
  };
}

export async function calculateOutstationExpense(
  access: AccessContext,
  input: OutstationCalculationInput,
) {
  if (isNonTravelExpenseType(input.expenseType)) {
    return calculateNonTravelExpense(access, input);
  }

  const validated = await validateCapturedLocation({
    access,
    capturedAccuracyMeters: input.capturedAccuracyMeters,
    capturedAt: input.capturedAt,
    capturedLatitude: input.capturedLatitude,
    capturedLongitude: input.capturedLongitude,
    hasTicketAttachments: input.hasTicketAttachments,
    offlineCaptured: input.offlineCaptured,
  });
  const { destinationGovernorate, identity, policy, residenceGovernorate, result } = validated;

  if (!input.tripStartDate || !input.tripEndDate) {
    throw new Error("Trip start and end dates are required.");
  }

  const tripStartDate = isoString(input.tripStartDate);
  const tripEndDate = isoString(input.tripEndDate);
  if (!tripStartDate || !tripEndDate) {
    throw new Error("Trip dates are invalid.");
  }

  const allowance = await calculateGuardedAllowanceBreakdown({
    destinationGovernorate,
    employeeHrId: identity.employeeHrId,
    policy,
    residenceGovernorate,
    tripEndDate,
    tripStartDate,
  });
  let fuelAmount = 0;
  let ticketAmount = 0;
  if (input.transportationType === "car") {
    const distanceKm = result.distanceFromResidenceKm ?? 0;
    fuelAmount = roundMoney(distanceKm * 2 * policy.fuelRatePerKm);
  } else if (input.transportationType === "train" || input.transportationType === "bus") {
    ticketAmount = roundMoney(
      numberValue(input.goTicketAmount) + numberValue(input.returnTicketAmount),
    );
    // Waived roles skip this too. Leaving it in would downgrade an otherwise clean train claim
    // to `needs_review` on the calculate step — the employee would watch the estimate turn amber
    // and read that his trip needs an attachment, seconds after being told the attachment is
    // optional.
    if (
      policy.requiresTicketAttachment &&
      !isOutstationTicketWaivedRole(identity.employeeRole) &&
      !input.hasTicketAttachments
    ) {
      if (result.eligibilityStatus === "eligible") {
        result.eligibilityStatus = "needs_review";
        // The exact sentence missing-ticket.ts undoes once the employee attaches the ticket.
        result.eligibilityReason = OUTSTATION_TICKET_EVIDENCE_REQUIRED_REASON;
      }
    }
  }

  const computedTravelCost = roundMoney(fuelAmount + ticketAmount);
  const reportTravelCost = optionalPositiveMoney(input.travelCostAmount) ?? computedTravelCost;
  const reportMeetingAmount = positiveMoney(input.meetingAmount);
  const reportOtherAmount = positiveMoney(input.otherAmount);
  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus: result.eligibilityStatus,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      travelCost: reportTravelCost,
    });
  const inputClaimedTotalAmount = numberValue(input.claimedTotalAmount);
  const claimedTotalAmount =
    inputClaimedTotalAmount > 0 ? inputClaimedTotalAmount : expectedTotalAmount;
  const calculationStatus =
    result.eligibilityStatus === "not_eligible" ? "blocked" : "calculated";
  const recommendation = recommendationForResult({
    eligibilityStatus: result.eligibilityStatus,
    hasTicketAttachments: Boolean(input.hasTicketAttachments),
    policy,
    role: identity.employeeRole,
    territoryValidationStatus: result.territoryValidationStatus,
    transportationType: input.transportationType,
  });

  const calculation: OutstationCalculationResult = {
    ...result,
    allowanceAmount: allowance.allowanceAmount,
    allowanceBreakdown: allowance.breakdown,
    attachmentCount: Math.max(0, Math.trunc(numberValue(input.attachmentCount))),
    approvalReason: recommendation.approvalReason,
    approvalRecommendation: recommendation.approvalRecommendation,
    calculationStatus,
    claimedTotalAmount,
    expenseType: input.expenseType,
    expectedTotalAmount,
    fuelAmount,
    kilometerReading:
      input.kilometerReading == null ? null : numberValue(input.kilometerReading),
    medicalTripHrId: cleanText(input.medicalTripHrId) ?? null,
    medicalTripName: cleanText(input.medicalTripName) ?? null,
    notes: cleanText(input.notes) ?? null,
    offlineCaptured: Boolean(input.offlineCaptured),
    overnightDays: allowance.overnightDays,
    reportAmWorkload: positiveMoney(input.amWorkload),
    reportMeetingAmount,
    reportOtherAmount,
    reportPmWorkload: positiveMoney(input.pmWorkload),
    reportTravelCost,
    reportTripType: reportTripTypeLabel({
      override: input.tripType,
      overnightDays: allowance.overnightDays,
      sameDayTrip: allowance.sameDayTrip,
    }),
    sameDayTrip: allowance.sameDayTrip,
    ticketAmount,
    carEvidenceImagePath: null,
    carEvidenceMetadata: input.carEvidenceMetadata,
    transportationType: input.transportationType,
    tripEndDate,
    tripStartDate,
  };

  return calculation;
}

// ── Approval notifications ────────────────────────────────────────────────────
// Submission auto-approves in the same request (no pending-approval step for a
// human to act on), so this is a confirmation to the employee himself (Cc: his
// direct manager, Bcc: Super Admin oversight) rather than an action queue. Every
// send is best-effort: a notification failure must never roll back or fail the
// underlying submit. See submit-recipients.ts for who lands in To/Cc/Bcc and why.
const OUTSTATION_EMPLOYEE_PORTAL_URL = "/employee-portals/expenses";
const OUTSTATION_ADMIN_QUEUE_URL = "/admin/outstation/expense-command?tab=queue";
const OUTSTATION_REVIEW_PORTAL_ROLES = [
  "District Manager",
  "Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
] as const;

function formatEgp(value: number) {
  return `${Number(value || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`;
}

async function authRoleForHrId(hrId: string | null | undefined): Promise<PhoenixRole | null> {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;
  // normalizeHrId is the LOWERCASE comparison key, while app_auth_users stores "B-119". A plain
  // .eq on the key matched nothing for every employee, so the role came back null and every
  // submit link fell back to the ADMIN queue — a District Manager's "request submitted" link
  // pointed at a page his role cannot use (production, 2026-09-12). Same fix as the weekly-plans
  // copy of this function: look up by the stored form.
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("role")
    .eq("hr_id", hrIdForStorage(hrId))
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const role = (data as { role?: string | null }).role;
  return role ? (role as PhoenixRole) : null;
}

/**
 * The submit notification must deep-link to the shell the ADDRESSED recipient actually lives in
 * (his manager, skip-level, or the Super Admin fallback — see submit-recipients.ts), not the
 * shell of whoever happens to open it later. Portal-mode managers (District/Regional/National
 * Sales Manager, Product/Group Product/Marketing/Training Manager, generic Manager) land on the
 * read-only employee-portal review page; Super Admin — the only admin-shell role that can occupy
 * this recipient slot, since the CEO is excluded outright by submit-recipients.ts — lands on the
 * existing admin queue, unchanged. Defaults to the admin queue when the role can't be resolved.
 */
async function outstationSubmitActionUrl(hrId: string | null | undefined, requestId: number): Promise<string> {
  let mode: NavigationMode = "admin";
  try {
    const role = await authRoleForHrId(hrId);
    if (role) {
      mode = resolveNavigationMode({ hrId: normalizeHrId(hrId), role, scope: "self", source: "session" });
    }
  } catch {
    // best-effort — fall back to the admin queue
  }
  if (mode === "employee-portal") {
    return `/employee-portals/outstation-review/${requestId}`;
  }
  return `${OUTSTATION_ADMIN_QUEUE_URL}&requestId=${encodeURIComponent(String(requestId))}`;
}

// Fires once per fresh submission: the employee wizard, offline sync, the
// Medical Rep simple-ticket flow, and admin-created manual entries all route
// through approveOutstationRequestForPayroll immediately after insert (that
// immediate auto-approve is what actually makes the request "submitted" in
// practice). Not fired on later edits to an already-approved request.
async function notifyOutstationSubmitted(
  request: OutstationExpenseRequest,
  options: { heldForReview?: boolean; reviewReason?: string | null } = {},
) {
  try {
    // To = the employee himself, Cc = his direct manager, Bcc = active Super Admins. The CEO is
    // never on this email in any slot other than his own To when he is the one submitting (owner,
    // 2026-08-08): when the direct manager is the CEO (every NSM, and 18 others), the skip-level
    // manager takes the Cc slot instead. Nothing is sent when the employee cannot be identified.
    const routing = await resolveOutstationSubmitRouting(request.employeeHrId);
    if (!routing.toHrId) {
      logError("Outstation submit email skipped — the submitting employee could not be identified", {
        labels: { event: "outstation_submit_email_recipient_unresolved", requestId: String(request.id) },
      });
      return;
    }
    const [ccAddresses, bccAddresses] = await Promise.all([
      resolveOutstationRecipientAddresses(routing.ccHrIds),
      resolveOutstationRecipientAddresses(routing.bccHrIds),
    ]);
    const heldForReview = Boolean(options.heldForReview);

    const claimedAmount = formatEgp(request.claimedTotalAmount || request.expectedTotalAmount);
    // The destination is often a geocoder address ("CMWC+993, … Damietta Governorate 8024807,
    // Egypt"): the mail names the place, without the plus code, postal code or country.
    const destination =
      tidyOutstationAddress(request.toLabel) || text(request.toCity) || text(request.toArea) || "—";
    const transportLabel = humanizeOutstationCode(request.transportationType) || "—";
    // The employee's own words, without the machine audit line appended to the same notes.
    const employeeNote = parseOutstationDescription(request.notes).note;
    // Resolved for the SPECIFIC recipient this send is addressed to (routing.toHrId) — not a
    // generic default. roleHrefs below is the separate, durable fallback so the stored in-app row
    // still resolves correctly whenever/however it is later read (viewer role changes, etc.).
    const actionUrl = await outstationSubmitActionUrl(routing.toHrId, request.id);
    const portalOutstationReviewUrl = `/employee-portals/outstation-review/${request.id}`;
    const roleHrefs = Object.fromEntries(
      OUTSTATION_REVIEW_PORTAL_ROLES.map((role) => [role, portalOutstationReviewUrl]),
    );
    const tripLength = request.sameDayTrip ? "Same-day" : `${request.overnightDays} night(s)`;

    const managerName = text(routing.managerName) || "—";
    // Brick / area / region for the captured GPS point, so the mail carries a place
    // name instead of a coordinate pair. Best-effort — never blocks the send.
    const capturedLocation = await resolveOutstationCapturedLocation({
      latitude: request.capturedLatitude,
      longitude: request.capturedLongitude,
    });
    const capturedAccuracyText =
      request.capturedAccuracyMeters === null
        ? "accuracy not reported"
        : `±${request.capturedAccuracyMeters}m`;

    const metrics = [
      ...(heldForReview
        ? [
            {
              label: "Action needed",
              // Generic on purpose since 2026-08-08: EVERY submission now waits, so this line can
              // no longer name the one hold reason (an unconfirmable governorate) that used to be
              // the only way a claim reached this state. The specific reason, when there is one,
              // is appended rather than assumed. Worded as "a Super Admin" rather than "you" — the
              // metrics table is shared by every recipient (employee To, manager Cc, Super Admin
              // Bcc), and only a Super Admin actually acts on a held claim (see "Approval Flow"
              // below); addressing "you" would tell the employee he can approve his own claim.
              value: [
                "Awaiting Super Admin review — this claim is NOT added to payroll until a Super Admin approves or rejects it.",
                text(options.reviewReason),
              ]
                .filter(Boolean)
                .join(" "),
            },
          ]
        : []),
      { label: "Employee", value: `${request.employeeName} (${request.employeeHrId})` },
      { label: "Role", value: request.employeeRole },
      // Separate "Line"/"Area" labels (replacing the old combined "Line / Area" one) are what
      // the OUTSTATION email template's {{line}}/{{area}} tokens look up via metricValue() —
      // the combined label alone left those tokens rendering blank.
      { label: "Line", value: text(request.employeeLine) || "—" },
      { label: "Area", value: text(request.employeeArea) || "—" },
      { label: "Manager", value: managerName },
      { label: "Transportation", value: transportLabel },
      { label: "Expense type", value: request.expenseType },
      // "Amount" and "Trip start"/"Trip end" (not a combined "Trip dates") are the exact
      // labels the OUTSTATION email template's amount/startDate/endDate tokens look up via
      // metricValue() — using different labels here left those tokens rendering blank.
      // Formatted (not raw ISO) since the template renders these directly into "{{startDate}}
      // to {{endDate}}" text.
      { label: "Amount", value: claimedAmount },
      // Owner format (2026-08-04): "Tuesday, 17 October 2026", Africa/Cairo, everywhere in
      // this mail. formatDateValue's short "17 Oct 2026" stays in the dense admin tables.
      { label: "Trip start", value: formatPhoenixLongDate(request.tripStartDate) },
      { label: "Trip end", value: formatPhoenixLongDate(request.tripEndDate) },
      // "Duration" (in addition to "Trip length") is what the OUTSTATION template's
      // {{duration}} token looks up.
      { label: "Trip length", value: tripLength },
      { label: "Duration", value: tripLength },
      { label: "Destination", value: destination },
      {
        label: "Distance from residence",
        value: request.distanceFromResidenceKm != null ? `${request.distanceFromResidenceKm.toFixed(1)} km` : "—",
      },
      { label: "Fuel amount", value: formatEgp(request.fuelAmount) },
      { label: "Ticket amount", value: formatEgp(request.ticketAmount) },
      { label: "Allowance amount", value: formatEgp(request.allowanceAmount) },
      { label: "Meeting amount", value: formatEgp(request.meetingAmount) },
      { label: "Other amount", value: formatEgp(request.otherAmount) },
      { label: "Expected total", value: formatEgp(request.expectedTotalAmount) },
      { label: "Claimed total", value: claimedAmount },
      {
        label: "Eligibility",
        value: `${humanizeOutstationCode(request.eligibilityStatus) || "—"} — ${text(request.eligibilityReason) || "—"}`,
      },
      {
        label: "Approval recommendation",
        value: `${humanizeOutstationCode(request.approvalRecommendation) || "—"} — ${text(request.approvalReason) || "—"}`,
      },
      // This request auto-decides on submit (no human pre-approval gate); the OUTSTATION
      // template's {{approvalFlow}} token describes that process, not a per-request value.
      {
        label: "Approval Flow",
        value: "Automatic — no manager approval step; Super Admin can review and override afterward in the Expense Command Center.",
      },
      { label: "Status", value: "Submitted" },
      {
        label: "Territory validation",
        value: `${humanizeOutstationCode(request.territoryValidationStatus) || "—"} — ${text(request.territoryValidationReason) || "—"}`,
      },
      // Captured location, as a place rather than a coordinate pair. Labels are deliberately
      // prefixed "Captured …": the plain "Area" label above is the EMPLOYEE's area and is what
      // the OUTSTATION template's {{area}} token resolves through metricValue(), so a second
      // metric labelled "Area" would silently hijack that token.
      { label: "Captured location", value: capturedLocation.label },
      { label: "Captured brick", value: capturedLocation.brickLabel },
      { label: "Captured area / region", value: `${capturedLocation.areaLabel} · ${capturedLocation.regionLabel}` },
      {
        // Nearest-centroid match quality — shown so a far-from-any-brick capture can never
        // read as an exact one. See captured-location.ts.
        label: "Location match",
        value: capturedLocation.confidence
          ? `${capturedLocation.confidence} · captured ${formatPhoenixDateTime(request.capturedAt)} (${capturedAccuracyText}, ${request.offlineCaptured ? "offline sync" : "online"})`
          : `Not matched · captured ${formatPhoenixDateTime(request.capturedAt)} (${capturedAccuracyText}, ${request.offlineCaptured ? "offline sync" : "online"})`,
      },
      // Read, never printed raw: the stored notes carry "Car live evidence: source=… hr_id=… gps=…
      // draft_id=…" after the employee's own words (see description-format.ts).
      { label: "Notes", value: formatOutstationDescriptionInline(request.notes) || "—" },
    ];

    // Short human summary only — the structured fields above (rendered separately as the
    // template's metrics table) already carry every detail, so repeating them here as a
    // second wall of text made the email read as duplicated content.
    // Addressed to the employee himself (his manager rides Cc, Super Admin rides Bcc — see
    // submit-recipients.ts) — third person on purpose since the same lines are also what a
    // Cc'd manager or Bcc'd Super Admin reads.
    const messageLines = [
      ...(heldForReview
        ? [
            // Generic since 2026-09-13, matching the "Action needed" metric above: every submission
            // from a hold role waits now, so naming the one reason that used to cause a hold (an
            // unconfirmable governorate) told a District Manager his Alexandria trip had failed a
            // check it never failed. The real reason, when the checks raised one, is appended.
            [
              "HELD FOR REVIEW: this request is NOT added to payroll yet. A Super Admin will approve or reject it.",
              text(options.reviewReason),
            ]
              .filter(Boolean)
              .join(" "),
          ]
        : []),
      `${request.employeeName} submitted an outstation expense request for ${claimedAmount} on ${formatPhoenixDateTime(request.createdAt)}.`,
      `Trip: ${formatPhoenixLongDate(request.tripStartDate)} to ${formatPhoenixLongDate(request.tripEndDate)} · Destination: ${destination} · Transportation: ${transportLabel}`,
      `Captured location: ${capturedLocation.label}`,
      `Eligibility: ${humanizeOutstationCode(request.eligibilityStatus) || "—"} · Recommendation: ${humanizeOutstationCode(request.approvalRecommendation) || "—"}`,
      ...(employeeNote ? [`Note: ${employeeNote.split("\n").join(" ")}`] : []),
    ];

    await createSystemNotification({
      actionUrl,
      category: "general",
      channels: ["in_app", "email", "telegram", "push"],
      email: { bcc: bccAddresses, cc: ccAddresses, metrics },
      eventType: "request_submitted",
      message: messageLines.join("\n"),
      metadata: {
        actionUrl,
        claimedAmount,
        employeeHrId: request.employeeHrId,
        employeeName: request.employeeName,
        idempotencyKey: `outstation:${request.id}:request_submitted`,
        requestId: String(request.id),
        // Lets notificationHrefForViewerRole (src/lib/notifications/hrefs.ts) resolve the correct
        // destination for whoever actually opens the in-app row, independent of the actionUrl
        // already resolved above for THIS send's specific recipient — including the employee
        // himself now that routing.toHrId (and therefore recipientHrId below) is his own id.
        roleHrefs,
        status: "Submitted",
        // Recorded so a "who was copied?" question is answerable from the audit row alone,
        // without re-deriving a reporting line that may have changed since.
        submitEnvelope: {
          bccHrIds: routing.bccHrIds,
          ccHrIds: routing.ccHrIds,
          routing: "employee_to_manager_cc_superadmin_bcc",
          toHrId: routing.toHrId,
        },
      },
      module: "outstation",
      priority: heldForReview ? "high" : "normal",
      recipientHrId: routing.toHrId,
      recordId: String(request.id),
      subjectHrId: request.employeeHrId,
      // "Open Phoenix", not "Open my expenses" — the same generic label the decision
      // notification below uses, since the primary recipient here can be either the
      // submitter (To) or his manager (Cc rides the same button, no per-recipient text).
      telegram: { buttons: [{ label: "Open Phoenix", url: actionUrl }] },
      title: heldForReview
        ? `${request.employeeName}'s outstation expense request needs review — ${claimedAmount}`
        : `${request.employeeName} submitted an outstation expense request — ${claimedAmount}`,
    });
  } catch (error) {
    logError("Outstation submitted notification dispatch failed (non-blocking)", { labels: { event: "outstation_submitted_notification_dispatch_failed" }, error });
  }
}

// Rejection notification to the submitting employee — HR Manager rejects violations; approvals
// are silent. NEVER emailed (owner rule 2026-09-19: "I don't want him to receive an email that his
// expense is rejected"): in-app, Telegram and push only. The `email` block below is inert — kept
// only so the plain template stays pinned — and outstation-rejection-channel-guard.ts strips email
// even when the Telegram-failure fallback asks for it.
async function notifyOutstationDecision(input: {
  comment?: string | null;
  decision: "reject";
  request: OutstationExpenseRequest;
}) {
  try {
    const r = input.request;
    const amount = formatEgp(r.claimedTotalAmount || r.expectedTotalAmount);
    const reason = text(input.comment);
    await Promise.allSettled([
      createSystemNotification({
        actionUrl: OUTSTATION_EMPLOYEE_PORTAL_URL,
        category: "general",
        channels: ["in_app", "telegram", "push"],
        email: {
          metrics: [
            { label: "Employee", value: r.employeeName },
            { label: "Amount", value: amount },
            { label: "Destination", value: text(r.toLabel) },
            // Were raw ISO ("2026-10-17"), which is what the owner's 2026-08-04 format
            // complaint was pointing at. Same Cairo long-date shape as the submit mail.
            { label: "Trip start", value: formatPhoenixLongDate(r.tripStartDate) },
            { label: "Trip end", value: formatPhoenixLongDate(r.tripEndDate) },
          ],
          // Pinned: module "outstation" otherwise frames EVERY event in the submit template, whose
          // fixed body reads "submitted automatically and requires your review".
          templateKey: "general",
        },
        eventType: "request_rejected",
        message: `Your expense request for ${amount} (${formatPhoenixLongDate(r.tripStartDate)} to ${formatPhoenixLongDate(r.tripEndDate)}) was rejected. Reason: ${reason}`,
        metadata: {
          actionUrl: OUTSTATION_EMPLOYEE_PORTAL_URL,
          amount,
          decision: input.decision,
          employeeHrId: r.employeeHrId,
          employeeName: r.employeeName,
          idempotencyKey: `outstation:${r.id}:request_rejected:${r.employeeHrId.toUpperCase()}`,
          rejectionReason: reason,
          requestId: String(r.id),
          requestUrl: OUTSTATION_EMPLOYEE_PORTAL_URL,
          status: "Rejected",
        },
        module: "outstation",
        priority: "normal",
        recipientHrId: r.employeeHrId,
        recordId: String(r.id),
        subjectHrId: r.employeeHrId,
        telegram: { buttons: [{ label: "Open Phoenix", url: OUTSTATION_EMPLOYEE_PORTAL_URL }] },
        title: "Your expense request was rejected",
      }),
    ]);
  } catch (error) {
    logError("Outstation decision notification dispatch failed (non-blocking)", { labels: { event: "outstation_decision_notification_dispatch_failed" }, error });
  }
}

export async function submitOutstationRequest(
  access: AccessContext,
  input: OutstationCalculationInput,
  options: { ticketAttachments?: OutstationTicketAttachmentUploadInput[] } = {},
) {
  const calculation = await calculateOutstationExpense(access, input);
  // Meeting and Other are not trips (non-travel-expense.ts): no arrival photo, no GPS fix, no
  // overnight evidence, no ticket rule. Their evidence is an uploaded invoice or picture, held
  // for review when missing — never refused.
  const nonTravel = isNonTravelExpenseType(calculation.expenseType);
  const evidenceValidation = nonTravel
    ? { isValid: true as const, message: "" }
    : validateLiveArrivalEvidence({
        carEvidenceMetadata: input.carEvidenceMetadata,
        employeeRole: calculation.employeeRole,
        transportationType: input.transportationType,
      });
  // Whether this submitter owes a photo at all. Read from the CALCULATION's role, which is the
  // same value written to `employee_role` below and therefore the same value every later read of
  // this request resolves the waiver from.
  const evidencePhotoWaived = isOutstationEvidenceWaivedRole(calculation.employeeRole);
  // Owner rule (2026-08-28): a National Sales Manager is never held, for any reason. Read from
  // the same CALCULATION role written to `employee_role` below, so every later read of this
  // request resolves the rule from the value the claim was submitted under.
  const noHoldRole = isOutstationNoHoldRole(calculation.employeeRole);

  if (!evidenceValidation.isValid) {
    throw new Error(evidenceValidation.message);
  }

  // One trip is claimed once (owner, 2026-10-26, after OUTSTATION-292/293). Checked before any
  // photo or ticket is uploaded, so a refused copy leaves nothing behind in storage.
  if (!nonTravel) {
    await assertNoDuplicateTrip({
      capturedLatitude: calculation.capturedLatitude,
      capturedLongitude: calculation.capturedLongitude,
      employeeHrId: calculation.employeeHrId,
      expenseType: calculation.expenseType,
      toArea: calculation.toArea,
      toCity: calculation.toCity,
      tripStartDate: calculation.tripStartDate,
    });
  }

  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending",
    status: "draft",
  });

  const identity = await getEmployeeIdentity(access);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId, { persist: !isReadOnlyViewer(access) });
  const supabase = getSupabaseAdmin();
  // Stored for EVERY transportation type, not car only. validateLiveArrivalEvidence() above
  // already refuses a train or bus request that carries no arrival photo, so gating the
  // persistence on `car` meant the only photo that could ever satisfy the gate was silently
  // dropped for the very types the gate had just been widened to cover.
  const storedCarEvidenceMetadata = !nonTravel && input.carEvidenceMetadata
    ? {
        ...input.carEvidenceMetadata,
        employeeHrId: calculation.employeeHrId,
        requestId: input.carEvidenceMetadata.requestId ?? null,
      }
    : null;
  let carEvidenceImagePath: string | null = null;

  // A blocked draft is recoverable; an approved 0.00 EGP fuel line is not. Condition and message
  // live in fuel-policy.ts so they can be asserted -- see the notes there on why a measured 0
  // must still submit and why train/bus must not be blocked.
  if (
    !nonTravel &&
    carTripFuelIsUnpriceable(calculation.transportationType, calculation.distanceFromResidenceKm)
  ) {
    throw new Error(UNPRICEABLE_CAR_TRIP_MESSAGE);
  }

  // The arrival image is uploaded for every transportation type. The refusal names the
  // employee's actual transport so a train passenger is never told to photograph a car.
  //
  // A waived role (evidence-waiver.ts) may submit with no photo — but if one IS supplied it is
  // stored and checked exactly as anyone else's. The pair is deliberately all-or-nothing: an
  // image with no metadata still fails, because a photo with no HR ID, timestamp or GPS on it is
  // not lighter evidence, it is evidence an approver cannot read.
  if (!nonTravel && !input.carEvidenceImageDataUrl && !evidencePhotoWaived) {
    throw new Error(
      calculation.transportationType === "car"
        ? "Car transport requires the live camera evidence image before submitting the request."
        : `A ${calculation.transportationType} trip requires the live arrival photo before submitting the request.`,
    );
  }
  if (!nonTravel && !storedCarEvidenceMetadata && !evidencePhotoWaived) {
    throw new Error("The live arrival photo metadata is missing.");
  }
  if (!nonTravel && input.carEvidenceImageDataUrl && !storedCarEvidenceMetadata) {
    throw new Error("The live arrival photo metadata is missing.");
  }

  if (!nonTravel && input.carEvidenceImageDataUrl && storedCarEvidenceMetadata) {
    carEvidenceImagePath = await uploadOutstationCarEvidenceImage({
      imageDataUrl: input.carEvidenceImageDataUrl,
      metadata: storedCarEvidenceMetadata,
    });
  }

  const workloadPayload = await resolveOutstationWorkloadPayload({
    employeeHrId: calculation.employeeHrId,
    tripEndDate: calculation.tripEndDate,
    tripStartDate: calculation.tripStartDate,
  });
  const campaignRule = campaignRuleOutcome({
    role: calculation.employeeRole,
    expenseType: calculation.expenseType,
    evidence: workloadPayload.workload_evidence_snapshot,
    tripEndDate: calculation.tripEndDate,
  });
  const campaignRejectionReason = campaignRule?.kind === "reject" ? campaignRule.reason : null;
  // A claim whose double-visit evidence has not been written to the CRM yet is HELD, not rejected.
  // It joins reviewHoldReasons below, so it persists as `submitted` and lands in the pending
  // approvals queue with the reason on it, instead of being decided against the employee on a
  // record that does not exist yet.
  const campaignHoldReason = campaignRule?.kind === "hold" ? campaignRule.reason : null;
  // Ticket attachments: train/bus requests MUST carry ticket evidence, and the uploaded
  // files are persisted to the request (previously the manager flow discarded them
  // entirely — only a boolean count was sent). Car uses the live photo instead.
  // Evidence is counted from files the SERVER received, never a client-supplied boolean.
  const ticketAttachmentInputs = options.ticketAttachments ?? [];
  const submitPolicy = await getActivePolicyForRole(calculation.employeeRole);
  const ticketEvidenceRejection = outstationTicketEvidenceRejection({
    hasTicketAttachments: ticketAttachmentInputs.length > 0,
    requiresTicketAttachment: nonTravel ? false : submitPolicy.requiresTicketAttachment,
    role: calculation.employeeRole,
    transportationType: calculation.transportationType,
  });
  // Online: block the submission outright so the employee attaches the ticket now.
  // Offline: the resilience path genuinely cannot carry files, so the claim is still
  // accepted into the system but HELD for Super Admin review below — it is never
  // auto-paid without evidence, which is what this exemption used to allow.
  if (ticketEvidenceRejection && !calculation.offlineCaptured) {
    throw new Error(
      "A ticket attachment is required for train and bus expense requests. Upload the ticket before submitting.",
    );
  }

  // Admin-editable policy limits. Both were previously stored and rendered in the
  // policy editor but enforced nowhere, so a kilometre-inaccurate GPS fix or an
  // offline capture synced days later auto-paid exactly like a clean one. Neither
  // rejects — a fuzzy or stale capture is a review signal, not proof of abuse. An accuracy the
  // device never reported is null here, never 0 m, and holds too (owner, 2026-09-18).
  const gpsAccuracyHoldReason = nonTravel
    ? null
    : outstationGpsAccuracyHoldReason({
        capturedAccuracyMeters: calculation.capturedAccuracyMeters,
        gpsAccuracyLimitMeters: numberValue(submitPolicy.gpsAccuracyThresholdMeters),
      });

  const offlineSyncLimitHours = numberValue(submitPolicy.maxOfflineSyncDelayHours);
  const capturedAtMs = calculation.capturedAt ? Date.parse(calculation.capturedAt) : Number.NaN;
  const offlineSyncDelayHours =
    calculation.offlineCaptured && Number.isFinite(capturedAtMs)
      ? (Date.now() - capturedAtMs) / 3_600_000
      : null;
  const offlineSyncHoldReason =
    offlineSyncDelayHours !== null &&
    offlineSyncLimitHours > 0 &&
    offlineSyncDelayHours > offlineSyncLimitHours
      ? `This offline capture synced ${Math.round(offlineSyncDelayHours)} hours after it was taken, beyond the ${offlineSyncLimitHours}-hour policy window, so it is held for Super Admin review before it moves to payroll.`
      : null;

  // Only an overnight stay joins two days (owner, 2026-09-18) — see overnight-evidence.ts.
  const overnightEvidenceHoldReason = nonTravel
    ? null
    : overnightStayEvidenceHoldReason({
        arrivalCapturedAt: storedCarEvidenceMetadata?.capturedAt ?? null,
        tripEndDate: calculation.tripEndDate,
        tripStartDate: calculation.tripStartDate,
      });
  const noInvoiceHoldReason =
    nonTravel && ticketAttachmentInputs.length === 0 ? NON_TRAVEL_NO_INVOICE_HOLD_REASON : null;
  // A car trip filed for a day another of his journeys already reached through an added stop: the
  // same drive could be paid twice (owner, 2026-10-18 — "make sure that no one abuses it"). The
  // journey side flags it as another_trip_same_day; this is the other half. Held, never refused.
  // A failed read HOLDS the claim and says why; it never refuses the submission (the 2026-08-09
  // flag-never-reject rule — risk review, 2026-10-18).
  let journeyOverlapReason: string | null = null;
  if (!nonTravel && calculation.transportationType === "car") {
    try {
      journeyOverlapReason = journeyOverlapHoldReason({
        journeys: await journeysWithStopsForEmployee(calculation.employeeHrId),
        tripEndDate: calculation.tripEndDate,
        tripStartDate: calculation.tripStartDate,
      });
    } catch (error) {
      logError("Outstation journey-overlap check could not read the employee's other trips", {
        error,
        labels: { event: "outstation_journey_overlap_read_failed" },
      });
      journeyOverlapReason =
        "The employee's other trips could not be read to check whether this drive is already paid through another journey's stop, so it is held for Super Admin review before it moves to payroll.";
    }
  }

  /**
   * The system FLAGS, it never REJECTS. (Owner rule, 2026-08-09.)
   *
   * Every automated check still runs and every failure is still recorded in full — what changed is
   * who acts on it. A failed check now HOLDS the claim for Super Admin review carrying its reason,
   * instead of deciding against the employee on its own. `rejected_by_system` is no longer
   * reachable from this path; only a human rejects, as `rejected_by_admin`.
   *
   * The rule was set after the double-visit check auto-rejected four genuine same-day claims. The
   * lesson generalised: every one of these checks reads a signal that can be MISSING rather than
   * false — an unwritten CRM record, an unmeasured distance, an unresolved governorate, a ticket
   * an offline capture could not carry. The system cannot tell "this is wrong" from "I could not
   * see it yet", so it must not be the one to refuse a person's money.
   *
   * Held claims are PERSISTED (never thrown), so the employee sees the claim in his list with the
   * reason on it, and the approvals queue shows the Super Admin exactly what to look at.
   */
  const eligibilityFlagReason =
    calculation.eligibilityStatus === "not_eligible" ? calculation.eligibilityReason : null;
  const governorateReviewReason =
    "Your residence or destination governorate could not be confirmed automatically, so this request is held for Super Admin review before it moves to payroll.";
  // The hold the employee clears himself by attaching the ticket from Expense Submissions
  // (missing-ticket.ts), which replaces this sentence on the claim.
  const offlineTicketHoldReason = OUTSTATION_OFFLINE_TICKET_HOLD_REASON;
  // Ordered worst-first: the flag most likely to decide the outcome is the one the approver
  // should read first, and this list is joined into the reason the queue renders.
  const detectedHoldReasons = [
    eligibilityFlagReason,
    overnightEvidenceHoldReason,
    campaignRejectionReason,
    campaignHoldReason,
    calculation.governorateReviewRequired ? governorateReviewReason : null,
    ticketEvidenceRejection ? offlineTicketHoldReason : null,
    gpsAccuracyHoldReason,
    offlineSyncHoldReason,
    noInvoiceHoldReason,
    journeyOverlapReason,
  ].filter((reason): reason is string => Boolean(reason));
  /**
   * Owner rule (2026-08-28): a National Sales Manager is never held, for any reason.
   *
   * Every check above still RAN, and every flag it raised is still written onto the request in
   * `decisionReason` below, so a reviewer reads exactly what the system saw. What is removed for
   * this one role is the HOLD itself — the same shape as the owner's 2026-08-09 "the system
   * flags, it never rejects" rule, taken one step further. See nsm-no-hold.ts.
   */
  const reviewHoldReasons = noHoldRole ? [] : detectedHoldReasons;
  const decisionStatus = reviewHoldReasons.length > 0 ? "submitted" : "accepted_by_system";
  /**
   * Where the request sits in the WORKFLOW — deliberately separate from what the automated
   * calculation concluded, which stays in `calculation_status`.
   *
   * Owner decision 2026-08-08: a clean submission now WAITS for a human. It used to persist as
   * `accepted_by_system` and be pushed to payroll in the same second it was submitted, which put
   * 21 of 29 live claims into payroll staging before anyone could look at them — and left the
   * approvals queue holding only the handful the automated checks had refused to clear.
   *
   * Everything is therefore `submitted`, so it lands in the pending queue. `calculation_status`
   * still records `accepted_by_system` vs `submitted`, so "passed every automated check" stays
   * distinguishable from "flagged by one" — the distinction is preserved, it just no longer
   * decides where the money goes.
   *
   * Since the owner's 2026-08-09 flag-never-reject rule no submission produces
   * `rejected_by_system` any more, so nothing here branches on a refusal.
   *
   * The one branch that DOES exist is the owner's 2026-08-28 rule — "once submitted, once
   * accepted" for a National Sales Manager. His claim is accepted the moment it is submitted and
   * released into payroll below. Nobody else auto-accepts; the 2026-08-08 decision stands for
   * every other role.
   */
  const workflowStatus = noHoldRole ? "accepted_by_system" : "submitted";
  // A no-hold claim carries the rule FIRST and then any flag the checks raised, so the screen
  // says why it was accepted without hiding what was noticed.
  const decisionReason = noHoldRole
    ? [OUTSTATION_NO_HOLD_APPROVAL_REASON, ...detectedHoldReasons].join(" ")
    : reviewHoldReasons.length > 0
      ? reviewHoldReasons.join(" ")
      : calculation.approvalReason;

  let uploadedTicketAttachments: OutstationTicketAttachmentMetadata[] = [];
  if (ticketAttachmentInputs.length > 0) {
    const ticketRequestDraftId = `outstation-${randomUUID()}`;
    uploadedTicketAttachments = await uploadOutstationTicketAttachments(
      ticketAttachmentInputs.map((attachment) => ({
        ...attachment,
        employeeHrId: calculation.employeeHrId,
        requestDraftId: ticketRequestDraftId,
      })),
    );
  }

  const insertPayload = {
    allowance_amount: calculation.allowanceAmount,
    allowance_breakdown_json: JSON.stringify(calculation.allowanceBreakdown),
    attachment_count: uploadedTicketAttachments.length,
    approval_reason: decisionReason,
    // A held claim can never be an `auto_approve` recommendation: the approvals screen would show
    // "recommended: auto approve" beside a reason saying the request is held, and the two readings
    // contradict each other on the one screen where the money decision is made.
    approval_recommendation:
      reviewHoldReasons.length > 0 ? "manager_review" : calculation.approvalRecommendation,
    area: calculation.employeeArea,
    calculation_status: decisionStatus,
    captured_accuracy_meters: calculation.capturedAccuracyMeters,
    captured_at: calculation.capturedAt,
    captured_latitude: calculation.capturedLatitude,
    captured_location_source: calculation.capturedLocationSource,
    captured_longitude: calculation.capturedLongitude,
    car_evidence_image_path: carEvidenceImagePath,
    car_evidence_metadata: storedCarEvidenceMetadata,
    // Set explicitly, NOT left to the column default. The default is 'pending_arrival_photo',
    // but a submitted request already HAS its arrival photo, so inheriting the default records a
    // state the row's own evidence contradicts. The column default exists to make a row that
    // skips this path fail CLOSED; it is not the value a real submission should carry.
    // A Meeting or Other claim has no arrival photo to wait for, so the shared resolver marks it
    // `grandfathered`: exempt from the photo gate, but distinct from a two-photo `complete` row.
    evidence_gate_status: nextEvidenceGateStatus({
      grandfathered: nonTravel,
      hasArrivalPhoto: Boolean(carEvidenceImagePath),
      hasDeparturePhoto: false,
    }),
    // The RESOLVED figure, never the raw posted one. This is also the OFFLINE entry point —
    // syncOfflineOutstationRequest delegates here — and the offline draft replay posts a
    // hardcoded `claimedTotalAmount: 0`, because a phone with no signal was never able to price
    // the trip: the route distance, the policy rates, the duplicate-day guard and the Cairo
    // no-allowance rule all live on this side. Storing that 0 verbatim is how request 72, the
    // only offline submission ever made, landed with claimed 0 against an expected 448.14 and
    // showed "EGP 0 / You claimed" on the employee's own portal card beside 323.14 of real fuel.
    //
    // `calculation.claimedTotalAmount` already carries the `posted > 0 ? posted : expected`
    // fallback, taken from the recalculation this function just performed. Applying it here is
    // what makes an offline submission price itself instead of claiming nothing.
    claimed_total_amount: calculation.claimedTotalAmount,
    distance_from_residence_km: calculation.distanceFromResidenceKm,
    distance_km: calculation.distanceFromResidenceKm,
    duration_minutes: calculation.durationMinutes,
    expense_type: calculation.expenseType,
    eligibility_reason: calculation.eligibilityReason,
    eligibility_status: calculation.eligibilityStatus,
    employee_hr_id: calculation.employeeHrId,
    // The employee RECORD name, not `calculation.employeeName` — that one is the nickname-first
    // display name the capture screen showed the employee, which is right on screen and wrong in
    // a persisted row. See outstationRecordName().
    employee_name: identity.employeeRecordName,
    employee_role: calculation.employeeRole,
    expected_total_amount: calculation.expectedTotalAmount,
    fuel_amount: calculation.fuelAmount,
    kilometer_reading: calculation.kilometerReading,
    line: calculation.employeeLine,
    medical_trip_hr_id: calculation.medicalTripHrId,
    medical_trip_name: calculation.medicalTripName,
    minimum_required_distance_km: calculation.minimumRequiredDistanceKm,
    notes: appendCarEvidenceNote(
      appendAllowanceGuardNote(calculation.notes, calculation.allowanceBreakdown),
      storedCarEvidenceMetadata,
      calculation.transportationType,
    ),
    offline_captured: calculation.offlineCaptured,
    overnight_days: calculation.overnightDays,
    report_am_workload: calculation.reportAmWorkload,
    report_meeting_amount: calculation.reportMeetingAmount,
    report_other_amount: calculation.reportOtherAmount,
    report_pm_workload: calculation.reportPmWorkload,
    report_travel_cost: calculation.reportTravelCost,
    report_trip_type: calculation.reportTripType,
    residence_address: residence?.residenceAddress ?? null,
    residence_area: residence?.residenceArea ?? null,
    residence_city: residence?.residenceCity ?? null,
    residence_latitude: residence?.residenceLatitude ?? null,
    residence_longitude: residence?.residenceLongitude ?? null,
    route_polyline: calculation.routePolyline,
    same_day_trip: calculation.sameDayTrip,
    status: workflowStatus,
    submitted_at: calculation.submittedAt,
    territory_validation_status: calculation.territoryValidationStatus,
    territory_validation_reason: calculation.territoryValidationReason,
    ...workloadPayload,
    meeting_amount: nonTravel ? calculation.reportMeetingAmount : (input.meetingAmount ?? 0),
    other_amount: nonTravel ? calculation.reportOtherAmount : (input.otherAmount ?? 0),
    go_ticket_amount: nonTravel ? 0 : (input.goTicketAmount ?? 0),
    return_ticket_amount: nonTravel ? 0 : (input.returnTicketAmount ?? 0),
    ticket_amount: calculation.ticketAmount,
    ticket_attachment_metadata: uploadedTicketAttachments,
    ticket_attachment_paths: uploadedTicketAttachments.map((attachment) => attachment.path),
    to_area: calculation.toArea,
    to_city: calculation.toCity,
    to_label: calculation.toLabel,
    transportation_type: calculation.transportationType,
    trip_end_date: calculation.tripEndDate,
    trip_start_date: calculation.tripStartDate,
  };

  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) {
    await deleteOutstationCarEvidenceImage(carEvidenceImagePath);
    await deleteOutstationTicketAttachments(
      uploadedTicketAttachments.map((attachment) => attachment.path),
    );
    throw new Error(error.message);
  }

  const requestId = String(data.id);
  const metadataWithRequestId = storedCarEvidenceMetadata
    ? {
        ...storedCarEvidenceMetadata,
        requestId,
      }
    : null;
  let persistedCarEvidenceMetadata = storedCarEvidenceMetadata;

  if (metadataWithRequestId) {
    const { error: metadataUpdateError } = await supabase
      .from("outstation_expense_requests")
      .update({
        car_evidence_metadata: metadataWithRequestId,
        notes: appendCarEvidenceNote(
          appendAllowanceGuardNote(calculation.notes, calculation.allowanceBreakdown),
          metadataWithRequestId,
          calculation.transportationType,
        ),
      })
      .eq("id", data.id);

    if (!metadataUpdateError) {
      persistedCarEvidenceMetadata = metadataWithRequestId;
    }
  }

  const submitted = mapOutstationRequestRow({
    ...data,
    car_evidence_image_path: carEvidenceImagePath,
    car_evidence_metadata: persistedCarEvidenceMetadata,
    notes: persistedCarEvidenceMetadata
      ? appendCarEvidenceNote(
          calculation.notes,
          persistedCarEvidenceMetadata,
          calculation.transportationType,
        )
      : data.notes,
  });
  // Every submission now WAITS — whether it passed every automated check or was flagged by one
  // (owner decisions 2026-08-08 and 2026-08-09). Nothing is pushed to payroll from here, and
  // nothing is refused from here either; only an explicit human decision in the queue does either,
  // which is what makes the evidence gate, the workload gate and the CRM claim checks worth
  // reading. The submit-time rejection email is gone with the submit-time rejection: the only
  // rejection notice an employee can now receive is one a Super Admin actually chose to send.
  //
  // The two notices (this one and the departure-photo reminder, further down) go out AFTER the reply
  // (afterResponse), in that order, in ONE deferred task: on production this submit took 14.8 s at the
  // median, and the claim was already saved while they were awaited. Both swallow their own failures,
  // so the answer never depended on them.

  /**
   * Owner rule (2026-08-28), the second half of it: "once submitted, once accepted".
   *
   * The row was written `accepted_by_system` above, but an accepted claim that nobody releases
   * is held under a different name — the push into payroll is what actually pays the man.
   *
   * Runs as the SYSTEM, not as the submitter, for two reasons. The payroll write asserts a
   * manual-approval permission a National Sales Manager does not hold, so his own context would
   * be refused; and it was the rule that accepted this claim, not him, so the audit row should
   * not read as though he approved his own money.
   *
   * Never throws — it reports failure in its return value — so a payroll hiccup cannot fail a
   * submission the employee has already completed. A failure is logged rather than swallowed,
   * because the one outcome this rule exists to prevent is a claim sitting unpaid unnoticed.
   */
  if (noHoldRole) {
    const release = await releaseOutstationRequestToPayrollIfReady(submitted.id, systemAccessContext);
    if (!release.released) {
      logError("Outstation no-hold request accepted on submission but not released into payroll", {
        labels: {
          event: "outstation_no_hold_release_failed",
          reason: release.reason,
          requestId: String(submitted.id),
        },
      });
    }
  }

  // Tell him NOW, not tomorrow morning.
  //
  // The daily job fires at 06:36 Cairo, and for a same-day trip the request does not yet exist at
  // that hour — it is created in the afternoon or evening, after the travelling is done (median
  // 16:00 Cairo across the live data, some as late as 21:40). So the "last day" reminder could
  // never fire for a one-day trip: by the next morning the trip is in the past, and the FIRST and
  // ONLY notice an employee ever received was an "overdue" one telling him to photograph a
  // destination he had already left. That is not a theory — when this was found, production held
  // 8 reminders and every single one was "overdue"; not one "due today" had ever been sent, and
  // six employees were owed EGP 2,279.67 behind a photo nobody had asked them for in time.
  //
  // Raising it here does not guarantee he can still act — if he is already home, he cannot — but
  // it moves the only warning from "the morning after" to "the moment he submits", which is the
  // last point at which acting is still possible at all.
  //
  // Deliberately AFTER notifyOutstationSubmitted and deliberately swallowed: a reminder that
  // fails must never fail the submission the employee just made. The shared idempotency key means
  // the daily job will not repeat whatever this raises.
  await afterResponse("outstation_notice:submitted", async () => {
    await notifyOutstationSubmitted(submitted, {
      heldForReview: !noHoldRole,
      reviewReason: reviewHoldReasons.length > 0 ? reviewHoldReasons.join(" ") : null,
    });
    try {
      await sendOutstationDeparturePhotoReminder(submitted, cairoTodayIso());
    } catch (reminderError) {
      logError("Outstation departure-photo reminder on submit failed", {
        error: reminderError,
        labels: {
          event: "outstation_departure_reminder_on_submit_failed",
          requestId,
        },
      });
    }
  });

  return submitted;
}

/**
 * The offline route. The ticket files are passed through when the phone sent them (owner,
 * 2026-10-22 — "the offline ticket gap"): a phone that REPORTS no signal while its request still
 * reaches the server used to have the ticket stripped on the way, so a train claim with its ticket
 * in hand landed held as "could not carry its ticket". A replay from the phone's own storage still
 * carries none — files are not kept there — and the employee then attaches it from Expense
 * Submissions (attachMissingTicketsToOwnOutstationRequest).
 */
export async function syncOfflineOutstationRequest(
  access: AccessContext,
  input: OutstationCalculationInput,
  options: { ticketAttachments?: OutstationTicketAttachmentUploadInput[] } = {},
) {
  return submitOutstationRequest(
    access,
    {
      ...input,
      offlineCaptured: true,
    },
    options,
  );
}

export async function updateOutstationPolicies(
  rules: Array<Partial<OutstationPolicyRule> & { roleName: string }>,
) {
  const supabase = getSupabaseAdmin();
  const payload = rules.map((rule) => ({
    active: rule.active ?? true,
    fuel_rate_per_km: numberValue(rule.fuelRatePerKm),
    gps_accuracy_threshold_meters: numberValue(rule.gpsAccuracyThresholdMeters || 100),
    max_offline_sync_delay_hours: numberValue(rule.maxOfflineSyncDelayHours || 8),
    minimum_distance_km: numberValue(rule.minimumDistanceKm),
    overnight_allowance: numberValue(rule.overnightAllowance),
    requires_ticket_attachment: Boolean(rule.requiresTicketAttachment),
    return_day_allowance: numberValue(rule.returnDayAllowance),
    role_name: rule.roleName,
    same_day_allowance: numberValue(rule.sameDayAllowance),
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("outstation_policy_rules")
    .upsert(payload, { onConflict: "role_name" });

  if (error) {
    throw new Error(error.message);
  }

  return getOutstationPolicies();
}

function mapOutstationRequestRow(row: Record<string, unknown>): OutstationExpenseRequest {
  const expenseTypeRaw = text(row.expense_type).toLowerCase();
  const transportationTypeRaw = text(row.transportation_type).toLowerCase();
  const expenseType: OutstationExpenseType =
    expenseTypeRaw === "meeting" || expenseTypeRaw === "other"
      ? expenseTypeRaw
      : "traveling";
  const transportationType: OutstationTransportationType =
    transportationTypeRaw === "bus" ||
    transportationTypeRaw === "other" ||
    transportationTypeRaw === "train"
      ? transportationTypeRaw
      : transportationTypeRaw === "train_bus"
        ? "train"
        : "car";

  return {
    allowanceAmount: numberValue(row.allowance_amount),
    allowanceBreakdown: safeJsonParse(row.allowance_breakdown_json, null),
    attachmentCount: numberValue(row.attachment_count),
    approvalReason: text(row.approval_reason),
    approvalRecommendation: normalizeApprovalRecommendation(text(row.approval_recommendation)),
    // Never numberValue: a stored null (no accuracy reported) would read back as 0, which is the
    // manual-entry marker expense-command.ts looks for.
    capturedAccuracyMeters: readAccuracyInput(row.captured_accuracy_meters),
    capturedAt: isoString(row.captured_at),
    capturedLatitude: numberValue(row.captured_latitude),
    capturedLongitude: numberValue(row.captured_longitude),
    departureCapturedAt: isoString(row.departure_captured_at) || null,
    departureEvidenceImagePath: text(row.departure_evidence_image_path) || null,
    departureEvidenceMetadata: safeJsonParse<OutstationDepartureEvidenceMetadata | null>(
      row.departure_evidence_metadata,
      null,
    ),
    // A row read before the 2026-09-18 migration has no such column: no refused tries, never an error.
    departureLocationRefusals: readDepartureLocationRefusals(row.departure_location_refusals),
    journeyPricing: readJourneyPricing(row.journey_pricing),
    journeyStops: readJourneyStops(row.journey_stops),
    // Fall back to the pre-gate states, not to the strict ones: a row read before the 2026-08-04
    // migration has applied genuinely IS exempt, and defaulting it to "pending" would make the
    // gate withhold payroll from every historical request the moment this code deploys ahead of
    // the migration. The migration then stamps the real value.
    evidenceGateStatus:
      (text(row.evidence_gate_status) as OutstationEvidenceGateStatus) || "grandfathered",
    workloadCaptureAttempts: Math.max(0, Math.trunc(numberValue(row.workload_capture_attempts))),
    workloadLastAttemptAt: isoString(row.workload_last_attempt_at) || null,
    workloadLastAttemptError: text(row.workload_last_attempt_error) || null,
    workloadGateStatus:
      (text(row.workload_gate_status) as OutstationWorkloadGateStatus) || "grandfathered",
    carEvidenceImagePath: text(row.car_evidence_image_path) || null,
    carEvidenceImageUrl: null,
    carEvidenceMetadata: safeJsonParse<OutstationCarEvidenceMetadata | null>(
      row.car_evidence_metadata,
      null,
    ),
    // Resolved, not raw. Rows written before 2026-08-31 can carry a hard `0` here: an offline
    // draft replay posts `claimedTotalAmount: 0` (the phone cannot price a trip) and the insert
    // used to store it verbatim. A stored 0 is the ABSENCE of a claim, not a claim of nothing,
    // and rendering it bare put "EGP 0 / You claimed" on a portal card beside a trip with 323.14
    // of real fuel behind it. Resolving here, at the single mapper every read path goes through,
    // is what stops each surface having to remember the fallback for itself.
    claimedTotalAmount: outstationClaimedTotal({
      claimedTotalAmount: numberValue(row.claimed_total_amount),
      expectedTotalAmount: numberValue(row.expected_total_amount),
    }),
    createdAt: isoString(row.created_at),
    distanceFromResidenceKm:
      row.distance_km != null
        ? numberValue(row.distance_km)
        : row.distance_from_residence_km != null
          ? numberValue(row.distance_from_residence_km)
          : null,
    durationMinutes: nullableNumber(row.duration_minutes),
    expenseType,
    eligibilityReason: text(row.eligibility_reason),
    eligibilityStatus: text(row.eligibility_status) as OutstationEligibilityStatus,
    employeeArea: text(row.area) || null,
    employeeHrId: text(row.employee_hr_id),
    employeeLine: text(row.line) || null,
    employeeName: text(row.employee_name),
    employeeRole: text(row.employee_role),
    expectedTotalAmount: numberValue(row.expected_total_amount),
    fuelAmount: numberValue(row.fuel_amount),
    goTicketAmount: numberValue(row.go_ticket_amount),
    id: Number(row.id),
    kilometerReading: nullableNumber(row.kilometer_reading),
    medicalTripHrId: text(row.medical_trip_hr_id) || null,
    medicalTripName: text(row.medical_trip_name) || null,
    meetingInvoiceMetadata: safeJsonParse<OutstationTicketAttachmentMetadata | null>(
      row.meeting_invoice_metadata,
      null,
    ),
    meetingInvoicePath: text(row.meeting_invoice_path) || null,
    minimumRequiredDistanceKm: numberValue(row.minimum_required_distance_km),
    notes: text(row.notes) || null,
    offlineCaptured: Boolean(row.offline_captured),
    overnightDays: numberValue(row.overnight_days),
    reportAmWorkload: numberValue(row.report_am_workload),
    reportMeetingAmount: nullableNumber(row.report_meeting_amount),
    reportOtherAmount: nullableNumber(row.report_other_amount),
    reportPmWorkload: numberValue(row.report_pm_workload),
    reportTravelCost:
      row.report_travel_cost == null ? null : numberValue(row.report_travel_cost),
    reportTripType: text(row.report_trip_type) || null,
    residenceAddress: text(row.residence_address) || null,
    residenceArea: text(row.residence_area) || null,
    residenceCity: text(row.residence_city) || null,
    residenceLatitude: nullableNumber(row.residence_latitude),
    residenceLongitude: nullableNumber(row.residence_longitude),
    routePolyline: text(row.route_polyline) || null,
    routeError: null,
    sameDayTrip: Boolean(row.same_day_trip),
    status: text(row.status),
    submittedAt: isoString(row.submitted_at) || null,
    territoryValidationReason: text(row.territory_validation_reason),
    territoryValidationStatus:
      text(row.territory_validation_status) as OutstationTerritoryValidationStatus,
    returnTicketAmount: numberValue(row.return_ticket_amount),
    ticketAttachmentMetadata: safeJsonParse<OutstationTicketAttachmentMetadata[]>(
      row.ticket_attachment_metadata,
      [],
    ),
    ticketAttachmentPaths: safeJsonParse<string[]>(row.ticket_attachment_paths, []),
    amWorkload: numberValue(row.am_workload),
    meetingAmount: numberValue(row.meeting_amount),
    otherAmount: numberValue(row.other_amount),
    pharmacyWorkload: outstationPharmacyWorkload(row.pharmacy_workload),
    pmWorkload: numberValue(row.pm_workload),
    workloadEvidenceSnapshot: safeJsonParse<DoubleVisitExpenseWorkloadEvidence | Record<string, unknown>>(
      row.workload_evidence_snapshot,
      {},
    ),
    workloadMatchedAt: isoString(row.workload_matched_at) || null,
    workloadMatchStatus: text(row.workload_match_status) || "manual",
    workloadOverrideReason: text(row.workload_override_reason) || null,
    workloadSource: text(row.workload_source) || "manual",
    workloadSourceImportId: text(row.workload_source_import_id) || null,
    ticketAmount: numberValue(row.ticket_amount),
    toArea: text(row.to_area) || null,
    toCity: text(row.to_city) || null,
    toCountry: text(row.to_country) || null,
    toLabel: text(row.to_label) || null,
    transportationType,
    tripEndDate: isoString(row.trip_end_date),
    tripStartDate: isoString(row.trip_start_date),
    // The claim's version token — what a reviewer sends back with Approve or Reject so the
    // decision is refused if the claim moved after he loaded it (claim-revision.ts).
    updatedAt: outstationClaimRevision(row.updated_at),
  };
}

/**
 * Signs every evidence kind a request can carry: the arrival photo, the departure photo AND the
 * ticket attachments.
 *
 * Tickets were previously left unsigned here, so the admin request detail received only
 * their metadata (name/type/size) and rendered each one as an inert row — it looked
 * clickable but had no href, which is the "the ticket attachment doesn't open" report of
 * 2026-08-04. The Expense Approvals page never hit this because it fetches its own signed
 * URLs from /api/admin/outstation/[id]/attachments.
 *
 * The departure photo was left unsigned the same way until 2026-09-18, so no approver screen
 * could show it: the one approver (the Super Admin) saw the arrival photo alone.
 */
async function attachCarEvidenceSignedUrls(
  requests: OutstationExpenseRequest[],
): Promise<OutstationExpenseRequest[]> {
  return Promise.all(
    requests.map(async (request) => {
      const [carEvidenceImageUrl, departureEvidenceImageUrl, ticketAttachmentUrls, meetingInvoiceUrl] =
        await Promise.all([
          createOutstationCarEvidenceSignedUrl(request.carEvidenceImagePath),
          createOutstationCarEvidenceSignedUrl(request.departureEvidenceImagePath),
          createOutstationEvidenceSignedUrls(request.ticketAttachmentPaths ?? []),
          createOutstationCarEvidenceSignedUrl(request.meetingInvoicePath),
        ]);

      return {
        ...request,
        carEvidenceImageUrl,
        departureEvidenceImageUrl,
        meetingInvoiceUrl,
        ticketAttachmentUrls,
      };
    }),
  );
}

export type PendingOutstationReviewRequest = {
  id: number;
  tripStartDate: string;
  tripEndDate: string;
  destination: string;
  amount: number;
  transportationType: string;
  reason: string;
  submittedAt: string;
};

/**
 * The caller's OWN outstation requests that are held for Super Admin review
 * (status "submitted"). These never enter the payroll ledger, so they are
 * invisible on the ledger-backed expense dashboard — this surfaces them to the
 * submitter so a governorate-held request is not silently lost.
 */
export async function getOwnPendingOutstationReviewRequests(
  access: AccessContext,
): Promise<PendingOutstationReviewRequest[]> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .eq("status", "submitted")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((row) => normalizeHrIdForAccess(row.employeeHrId) === callerHrId)
    .map((row) => ({
      id: row.id,
      tripStartDate: row.tripStartDate,
      tripEndDate: row.tripEndDate,
      destination: text(row.toLabel) || text(row.toCity) || text(row.toArea) || "—",
      amount: row.claimedTotalAmount || row.expectedTotalAmount || 0,
      transportationType: row.transportationType,
      reason:
        text(row.approvalReason) ||
        text(row.eligibilityReason) ||
        "Held for Super Admin review.",
      submittedAt: row.submittedAt || row.createdAt,
    }));
}

/**
 * Extra-ticket count for each of the caller's OWN train/bus requests, keyed by
 * request id. Powers the "Extra Tickets" tracking column on the employee
 * portal's Expense Dashboard table — the ledger row data (ExpenseRow) has no
 * ticket count of its own, so the dashboard looks it up here.
 */
export async function getOwnOutstationTicketCounts(
  access: AccessContext,
): Promise<Record<number, number>> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return {};
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .in("transportation_type", ["train", "bus"]);
  if (error || !data) return {};
  const counts: Record<number, number> = {};
  for (const row of (data as Array<Record<string, unknown>>).map(mapOutstationRequestRow)) {
    if (normalizeHrIdForAccess(row.employeeHrId) !== callerHrId) continue;
    counts[row.id] = row.ticketAttachmentPaths.length;
  }
  return counts;
}

/**
 * Employee self-service: add ONE OR MORE extra tickets (each an attachment +
 * cost) plus a shared reason to their own already-submitted train/bus request —
 * e.g. an unplanned multi-leg trip needing several ticket legs. The summed extra
 * cost is ADDED to the ticket/travel total (allowance is never touched).
 *
 * Only while nobody has decided the claim (owner, 2026-10-19: "after HR decision not able to add
 * anything"). It used to go on after HR accepted the claim and re-push the new, higher total to the
 * linked payroll row — a figure HR never saw, because an ordinary Approve stores no typed amount and
 * payroll then pays the claim in full. Now an accepted, rejected or otherwise decided claim refuses
 * the ticket outright, so there is nothing to re-sync; HR adds a ticket through the trip edit and
 * sees the new figure. Also blocked once the expense has been paid, for car trips, and for other
 * people's requests.
 */
export async function addExtraTicketsToOwnOutstationRequest(
  requestId: number,
  access: AccessContext,
  input: {
    destination: string;
    tickets: Array<{ ticket: OutstationTicketAttachmentUploadInput; amount: number }>;
    reason: string;
  },
): Promise<OutstationExpenseRequest> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) {
    throw new Error("Your session is not linked to an employee. Please sign in again.");
  }

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  if (normalizeHrIdForAccess(existing.employeeHrId) !== callerHrId) {
    throw new Error("Forbidden: you can only add tickets to your own expense request.");
  }
  if (existing.transportationType !== "train" && existing.transportationType !== "bus") {
    throw new Error("Extra tickets can only be added to train or bus expense requests.");
  }
  if (existing.status.startsWith("rejected")) {
    throw new Error("This request was rejected and cannot accept extra tickets.");
  }
  // Checked before anything is uploaded or written. An allow-list: only a claim still waiting for a
  // decision takes a ticket, so accepted_by_admin, accepted_by_system, the legacy approved and any
  // status nobody listed are all refused.
  if (!isOutstationClaimUndecided(existing.status)) {
    throw new Error(OUTSTATION_CLAIM_DECIDED_MESSAGE);
  }

  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (isOutstationExpenseInPayroll(linkedPayroll)) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }

  const tickets = input.tickets ?? [];
  if (tickets.length === 0) {
    throw new Error("Upload at least one ticket to add.");
  }
  const amounts = tickets.map((entry) => roundMoney(Math.max(0, Number(entry.amount))));
  if (amounts.some((amount) => !(amount > 0))) {
    throw new Error("Enter a valid cost greater than zero for every ticket.");
  }
  const extraTotal = roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
  const destination = cleanText(input.destination);
  if (!destination) {
    throw new Error("A destination for the extra ticket(s) is required.");
  }
  const reason = cleanText(input.reason);
  if (!reason) {
    throw new Error("A reason for the extra tickets is required.");
  }

  const requestDraftId = `outstation-extra-${randomUUID()}`;
  const uploaded = await uploadOutstationTicketAttachments(
    tickets.map((entry) => ({
      ...entry.ticket,
      employeeHrId: existing.employeeHrId,
      requestDraftId,
    })),
  );

  try {
    const newTicketAmount = roundMoney(existing.ticketAmount + extraTotal);
    const existingTravelCost =
      existing.reportTravelCost ?? roundMoney(existing.fuelAmount + existing.ticketAmount);
    const newTravelCost = roundMoney(existingTravelCost + extraTotal);
    const newExpectedTotal = reportExpectedTotal({
      allowanceAmount: existing.allowanceAmount,
      eligibilityStatus: existing.eligibilityStatus,
      meetingAmount: outstationReportOverride(existing.reportMeetingAmount, existing.meetingAmount),
      otherAmount: outstationReportOverride(existing.reportOtherAmount, existing.otherAmount),
      travelCost: newTravelCost,
    });
    const newClaimedTotal =
      existing.claimedTotalAmount > 0
        ? roundMoney(existing.claimedTotalAmount + extraTotal)
        : newExpectedTotal;

    const mergedPaths = [...existing.ticketAttachmentPaths, ...uploaded.map((a) => a.path)];
    const mergedMetadata = [...existing.ticketAttachmentMetadata, ...uploaded];
    const noteLine = `${uploaded.length} extra ticket(s) added to ${destination} (${formatEgp(extraTotal)}): ${reason}`;
    const newNotes = existing.notes ? `${existing.notes}\n${noteLine}` : noteLine;
    const now = new Date().toISOString();

    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .update({
        attachment_count: mergedMetadata.length,
        claimed_total_amount: newClaimedTotal,
        expected_total_amount: newExpectedTotal,
        notes: newNotes,
        report_travel_cost: newTravelCost,
        ticket_amount: newTicketAmount,
        ticket_attachment_metadata: mergedMetadata,
        ticket_attachment_paths: mergedPaths,
        updated_at: now,
      })
      .eq("id", requestId)
      .eq("status", existing.status)
      // The write is a gate too: HR deciding the claim between the read above and this update
      // leaves no row to change, instead of a ticket landing on a claim that was just approved.
      .in("status", [...OUTSTATION_UNDECIDED_STATUSES])
      .select("*")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("This request just changed status. Refresh and try again.");

    const updated = mapOutstationRequestRow(data as Record<string, unknown>);

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
      entityId: String(updated.id),
      entityType: "outstation_request",
      newValues: {
        destination,
        extraTicketCount: uploaded.length,
        extraTicketTotal: extraTotal,
        newExpectedTotal: updated.expectedTotalAmount,
        reason,
        source: "employee_extra_ticket",
        status: updated.status,
      },
      summary: `Employee added ${uploaded.length} extra ticket(s) to ${destination} (${formatEgp(extraTotal)}) on outstation request ${updated.id}.`,
    });

    return updated;
  } catch (error) {
    await deleteOutstationTicketAttachments(uploaded.map((a) => a.path));
    throw error;
  }
}

/**
 * Employee self-service: attach the ticket a train or bus claim ARRIVED WITHOUT (owner,
 * 2026-10-22 — "fix the offline ticket gap"). A claim saved with no signal is replayed later from
 * the phone's own storage, which cannot carry files, so it lands with no ticket and is held. Until
 * now he had no way to supply it: "Add tickets" adds MONEY (a new leg at a new cost), never proof
 * for the ticket he already claimed.
 *
 * EVIDENCE ONLY (missing-ticket.ts): no amount moves, so neither `updated_at` (the approval
 * revision, claim-revision.ts) nor any figure is touched. Only the ticket gap is closed: the
 * calculation's ticket downgrade is undone, the offline hold sentence is replaced by one saying he
 * attached it — and nothing else the claim was held for is cleared.
 *
 * His own, undecided train or bus claim with no ticket yet; the write is pinned to both, so HR
 * deciding it, or a second tap racing this one, leaves no row to change.
 */
export async function attachMissingTicketsToOwnOutstationRequest(
  requestId: number,
  access: AccessContext,
  input: { tickets: OutstationTicketAttachmentUploadInput[] },
): Promise<OutstationExpenseRequest> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) {
    throw new Error("Your session is not linked to an employee. Please sign in again.");
  }

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  if (normalizeHrIdForAccess(existing.employeeHrId) !== callerHrId) {
    throw new Error("Forbidden: you can only attach a ticket to your own expense request.");
  }
  if (existing.transportationType !== "train" && existing.transportationType !== "bus") {
    throw new Error(MISSING_TICKET_WRONG_TRANSPORT_MESSAGE);
  }
  if (!isOutstationClaimUndecided(existing.status)) {
    throw new Error(OUTSTATION_CLAIM_DECIDED_MESSAGE);
  }
  const existingCount = existing.ticketAttachmentPaths.length;
  if (
    !canAttachMissingOutstationTicket({
      status: existing.status,
      ticketAttachmentCount: existingCount,
      transportationType: existing.transportationType,
    })
  ) {
    throw new Error(MISSING_TICKET_ALREADY_ATTACHED_MESSAGE);
  }

  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (isOutstationExpenseInPayroll(linkedPayroll)) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }

  const tickets = input.tickets ?? [];
  if (tickets.length === 0) throw new Error("Upload the ticket to attach.");

  const uploaded = await uploadOutstationTicketAttachments(
    tickets.map((ticket) => ({
      ...ticket,
      employeeHrId: existing.employeeHrId,
      requestDraftId: `outstation-missing-ticket-${randomUUID()}`,
    })),
  );

  try {
    const now = new Date().toISOString();
    const eligibility = eligibilityAfterMissingTicketAttached({
      eligibilityReason: existing.eligibilityReason,
      eligibilityStatus: existing.eligibilityStatus,
    });
    const approvalReason = approvalReasonAfterMissingTicketAttached(
      existing.approvalReason,
      missingTicketAttachedSentence(formatPhoenixDateTime(now), uploaded.length),
    );

    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .update({
        approval_reason: approvalReason,
        attachment_count: uploaded.length,
        eligibility_reason: eligibility.eligibilityReason,
        eligibility_status: eligibility.eligibilityStatus,
        ticket_attachment_metadata: uploaded,
        ticket_attachment_paths: uploaded.map((attachment) => attachment.path),
      })
      .eq("id", requestId)
      .in("status", [...OUTSTATION_UNDECIDED_STATUSES])
      // Still no ticket: a second tap, or another tab, that already attached one leaves no row.
      .eq("attachment_count", existing.attachmentCount)
      .select("*")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("This request just changed. Refresh and try again.");

    const updated = mapOutstationRequestRow(data as Record<string, unknown>);

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
      entityId: String(updated.id),
      entityType: "outstation_request",
      newValues: {
        attachmentCount: uploaded.length,
        eligibilityStatus: updated.eligibilityStatus,
        source: "employee_missing_ticket",
        status: updated.status,
      },
      oldValues: {
        attachmentCount: existing.attachmentCount,
        eligibilityStatus: existing.eligibilityStatus,
      },
      summary: `Employee attached the missing ticket (${uploaded.length} file(s)) to outstation request ${updated.id}.`,
    });

    return updated;
  } catch (error) {
    await deleteOutstationTicketAttachments(uploaded.map((attachment) => attachment.path));
    throw error;
  }
}

export async function listOutstationRequests(options?: { includeCarEvidenceSignedUrls?: boolean }) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const mapped = await withLiveRequestNames(
    ((data ?? []) as Array<Record<string, unknown>>).map(mapOutstationRequestRow),
  );
  // Brick / area / region per row, so the admin detail can show a place name instead of the
  // raw coordinate pair. One cached centroid load for the whole page — see captured-location.ts.
  const requests = await attachOutstationCapturedLocations(mapped);
  return options?.includeCarEvidenceSignedUrls
    ? attachCarEvidenceSignedUrls(requests)
    : requests;
}

export async function getOutstationRequestById(
  requestId: number,
  options?: { includeCarEvidenceSignedUrl?: boolean },
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) return null;

  const [mapped] = await withLiveRequestNames([
    mapOutstationRequestRow(data as Record<string, unknown>),
  ]);
  const request = {
    ...mapped,
    capturedLocation: await resolveOutstationCapturedLocation({
      latitude: mapped.capturedLatitude,
      longitude: mapped.capturedLongitude,
    }),
  };
  if (!options?.includeCarEvidenceSignedUrl) return request;

  // Both photos, always together: an approver shown the arrival photo alone cannot see whether
  // the employee was still there when he left (see attachCarEvidenceSignedUrls).
  const [carEvidenceImageUrl, departureEvidenceImageUrl] = await Promise.all([
    createOutstationCarEvidenceSignedUrl(request.carEvidenceImagePath),
    createOutstationCarEvidenceSignedUrl(request.departureEvidenceImagePath),
  ]);
  return {
    ...request,
    carEvidenceImageUrl,
    departureEvidenceImageUrl,
  };
}

export async function listMedicalRepExpenseRequests(access: AccessContext) {
  const identity = await getMedicalRepExpenseIdentity(access);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .ilike("employee_hr_id", identity.employeeHrId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return withLiveRequestNames(
    ((data ?? []) as Array<Record<string, unknown>>).map(mapOutstationRequestRow),
  );
}

export async function submitMedicalRepSimpleExpenseRequest(
  access: AccessContext,
  input: MedicalRepSimpleExpenseInput,
) {
  const identity = await getMedicalRepExpenseIdentity(access);
  const normalized = validateMedicalRepSimpleExpenseInput(input);

  if (!identity.fromLocation) {
    throw new Error("Residence location is not configured for your employee profile. Please contact HR.");
  }

  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending",
    status: "draft",
  });

  const now = new Date().toISOString();
  const requestDraftId = `medical-rep-${randomUUID()}`;
  let uploadedAttachments: OutstationTicketAttachmentMetadata[] = [];

  try {
    uploadedAttachments = await uploadOutstationTicketAttachments(
      normalized.attachments.map((attachment) => ({
        ...attachment,
        employeeHrId: identity.employeeHrId,
        requestDraftId,
      })),
    );

    const overnightDays = daysBetween(normalized.tripStartDate, normalized.tripEndDate);
    const sameDayTrip = overnightDays === 0;
    const residence = identity.residence;
    const capturedLatitude = residence?.residenceLatitude ?? 0;
    const capturedLongitude = residence?.residenceLongitude ?? 0;
    const attachmentPaths = uploadedAttachments.map((attachment) => attachment.path);
    const workloadPayload = await resolveOutstationWorkloadPayload({
      employeeHrId: identity.employeeHrId,
      tripEndDate: normalized.tripEndDate,
      tripStartDate: normalized.tripStartDate,
    });
    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .insert({
        allowance_amount: 0,
        allowance_breakdown_json: JSON.stringify({
          overnightDays,
          returnDayApplied: false,
          rows: [],
          sameDayTrip,
        }),
        approval_reason:
          "Medical rep manual traveling expense submitted without manager outstation distance rules.",
        approval_recommendation: "hr_review",
        area: identity.employeeArea,
        attachment_count: uploadedAttachments.length,
        calculation_status: "submitted",
        captured_accuracy_meters: 0,
        captured_at: now,
        captured_latitude: capturedLatitude,
        captured_location_source: "medical_rep_manual",
        captured_longitude: capturedLongitude,
        claimed_total_amount: normalized.ticketAmount,
        distance_from_residence_km: null,
        distance_km: null,
        duration_minutes: null,
        eligibility_reason:
          "Medical rep manual expense submission; no manager outstation rule was applied.",
        eligibility_status: "needs_review",
        employee_hr_id: identity.employeeHrId,
        // The employee RECORD name — see outstationRecordName(). `identity.employeeName` is the
        // nickname-first display name and must not be frozen onto a payroll-bound row.
        employee_name: identity.employeeRecordName,
        employee_role: "Medical Rep",
        // Set EXPLICITLY, for the same reason createManagerExpenseAsAdmin does: this flow has no
        // photo step anywhere in it — a medical rep files a ticket amount and attachments, never a
        // live capture — so inheriting the column's fail-closed 'pending_arrival_photo' default
        // would hold every one of these out of payroll forever, waiting on a photo the UI cannot
        // take. That is exactly what happened to the nine admin-created expenses on 2026-08-08;
        // this path was the same defect still armed, and only escaped it because no medical rep
        // had submitted through it yet (zero rows at the time of the fix).
        //
        // If medical reps are ever given a capture step, this becomes nextEvidenceGateStatus()
        // like the wizard path — it must not stay 'grandfathered' once a photo is obtainable.
        evidence_gate_status: "grandfathered",
        expected_total_amount: normalized.ticketAmount,
        expense_type: "traveling",
        fuel_amount: 0,
        go_ticket_amount: normalized.goTicketAmount,
        line: identity.employeeLine,
        minimum_required_distance_km: 0,
        notes: normalized.notes,
        offline_captured: false,
        overnight_days: overnightDays,
        residence_address: residence?.residenceAddress ?? null,
        residence_area: residence?.residenceArea ?? null,
        residence_city: residence?.residenceCity ?? null,
        residence_latitude: residence?.residenceLatitude ?? null,
        residence_longitude: residence?.residenceLongitude ?? null,
        return_ticket_amount: normalized.returnTicketAmount,
        route_polyline: null,
        same_day_trip: sameDayTrip,
        status: "submitted",
        submitted_at: now,
        ticket_amount: normalized.ticketAmount,
        ticket_attachment_metadata: uploadedAttachments,
        ticket_attachment_paths: attachmentPaths,
        ...workloadPayload,
        meeting_amount: 0,
        other_amount: 0,
        // `to_area` and `to_city` stay null: resolving them needs a SECOND Google call (place
        // details), and this path measures no distance, so a governorate would buy nothing but
        // another billable lookup and another failure mode. The place id is what makes the
        // destination identifiable later; the label is what a human reads.
        to_area: null,
        to_city: null,
        to_label: normalized.toLocation,
        to_place_id: normalized.toPlaceId,
        transportation_type: "other",
        trip_end_date: normalized.tripEndDate,
        trip_start_date: normalized.tripStartDate,
        updated_at: now,
      })
      .select("*")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    const submitted = mapOutstationRequestRow(data as Record<string, unknown>);
    // Waits for a human, like every other submit path (owner decision 2026-08-08). The row was
    // inserted as `submitted`, so simply not approving it here is what leaves it in the queue —
    // and the alert that used to fire from inside the approval is raised directly instead, so
    // removing the auto-approval does not silently stop the mail.
    // After the reply (afterResponse): the claim is saved, and the notice swallows its own failures.
    await afterResponse("outstation_notice:submitted_simple", () =>
      notifyOutstationSubmitted(submitted, { heldForReview: true }),
    );
    return submitted;
  } catch (error) {
    await deleteOutstationTicketAttachments(
      uploadedAttachments.map((attachment) => attachment.path),
    );
    throw error;
  }
}

type LinkedOutstationPayrollExpense = {
  approvedAmount: number | null;
  id: string;
  importedPayrollBatchId: string | null;
  importedToPayrollAt: string | null;
  reportId: string | null;
  tripId: string;
};

export async function getLinkedOutstationPayrollExpense(
  requestId: number,
): Promise<LinkedOutstationPayrollExpense | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expenses")
    .select(
      `id,imported_payroll_batch_id,imported_to_payroll_at,report_id,${EXPENSE_DECISION_SELECT}`,
    )
    .eq("trip_id", outstationPayrollTripId(requestId))
    .maybeSingle();

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return null;
    throw new Error(error.message);
  }

  if (!data) return null;

  const approvedAmount = Number(data.approved_amount);

  return {
    // Already in the select (EXPENSE_DECISION_SELECT carries it) — surfaced so the approvals queue
    // can tell "HR trimmed this trip" from "nobody has touched the claim".
    approvedAmount: data.approved_amount == null || !Number.isFinite(approvedAmount) ? null : approvedAmount,
    id: String(data.id),
    importedPayrollBatchId: data.imported_payroll_batch_id
      ? String(data.imported_payroll_batch_id)
      : null,
    importedToPayrollAt: data.imported_to_payroll_at
      ? String(data.imported_to_payroll_at)
      : null,
    reportId: data.report_id ? String(data.report_id) : null,
    tripId: String(data.trip_id),
  };
}

async function syncLinkedOutstationPayrollExpense(input: {
  access: AccessContext;
  linkedPayroll: LinkedOutstationPayrollExpense | null;
  request: OutstationExpenseRequest;
}) {
  if (!input.linkedPayroll) return 0;
  if (!input.request.status.startsWith("accepted")) return 0;
  if (isOutstationExpenseInPayroll(input.linkedPayroll)) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }

  const expenseRecord = mapOutstationRequestToPayrollExpenseRecord(input.request, {
    reportId: input.linkedPayroll?.reportId ?? null,
  });
  const saved = await savePayrollExpenseApprovals({
    fileName: workflowExpenseReportFileName(input.request.id),
    records: [expenseRecord],
    reportId: input.linkedPayroll?.reportId ?? null,
  }, input.access, { allowWorkflowTripIds: true });

  return saved.length;
}

// Pushes an already-accepted outstation request into payroll (idempotent — skips if the
// linked expense row was already imported into a paid batch). Used by the auto-accept at
// submit and by a Super Admin's accept override.
async function pushAcceptedOutstationExpenseToPayroll(
  request: OutstationExpenseRequest,
  access: AccessContext,
): Promise<number> {
  const linkedPayroll = await getLinkedOutstationPayrollExpense(request.id);
  if (isOutstationExpenseInPayroll(linkedPayroll)) {
    return 0;
  }
  const expenseRecord = mapOutstationRequestToPayrollExpenseRecord(request, {
    reportId: linkedPayroll?.reportId ?? null,
  });
  const savedExpenses = await savePayrollExpenseApprovals({
    fileName: workflowExpenseReportFileName(request.id),
    records: [expenseRecord],
    reportId: linkedPayroll?.reportId ?? null,
  }, access, { allowWorkflowTripIds: true });
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(request.id),
    entityType: "outstation_request",
    newValues: {
      expenseTripId: expenseRecord.tripId,
      payrollExpenseRows: savedExpenses.length,
      status: request.status,
    },
    summary: `Outstation request ${request.id} accepted; expense pushed to payroll.`,
  });
  return savedExpenses.length;
}

// Accept an outstation request and push it to payroll. At submit this runs as the system
// (accepted_by_system); a Super Admin may also call it to OVERRIDE a system rejection
// (accepted_by_admin). It intentionally does not block on the prior status — accepting a
// rejected request is the whole point of the override.
/**
 * The request's stored `updated_at`, exactly as the database holds it.
 *
 * Read raw rather than taken from a mapped request: the approval below pins its write to this
 * value, and the mapper rounds to the millisecond. Throws when the request is gone.
 */
async function readOutstationRequestStoredUpdatedAt(requestId: number): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("updated_at")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Outstation request was not found.");
  return String((data as { updated_at?: unknown }).updated_at ?? "");
}

/** The stored approval reason with the raw `updated_at` it was read at — to compose a note and pin its write. */
async function readOutstationRequestStoredReason(
  requestId: number,
): Promise<{ approvalReason: string | null; updatedAt: string }> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("approval_reason, updated_at")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Outstation request was not found.");
  const row = data as { approval_reason?: unknown; updated_at?: unknown };
  return {
    approvalReason: row.approval_reason == null ? null : String(row.approval_reason),
    updatedAt: String(row.updated_at ?? ""),
  };
}

export async function approveOutstationRequestForPayroll(
  requestId: number,
  access: AccessContext,
  options: {
    comment?: string | null;
    /**
     * The `updatedAt` of the claim the reviewer was looking at. REQUIRED: an approval pays the
     * claim's current figures, so it has to say which figures it was given. Refused with an
     * OutstationClaimChangedError (409 at the routes) when the claim has moved since, or when this
     * is blank. See claim-revision.ts.
     */
    expectedRevision: string;
  },
) {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (isOutstationExpenseInPayroll(linkedPayroll)) {
    throw new Error("This outstation expense has already been added to payroll and cannot be changed.");
  }

  // Validate the accept transition through the workflow registry for the normal path (a
  // freshly submitted / needs-review request). A Super Admin OVERRIDE of an already-decided
  // request skips it — accepting a rejected request is not a registry transition, and the
  // Super-Admin code gate above is the control.
  if (!existing.status.startsWith("rejected") && !existing.status.startsWith("accepted")) {
    await assertOutstationExpenseWorkflowTransition({
      access,
      actionKey: "approve",
      expectedNextStatus: "approved",
      status: existing.status,
    });
  }

  // ── The claim he approves is the claim he saw (2026-10-19) ──────────────────────────────────
  // The figures pushed to payroll below are the row's CURRENT ones, and a claim keeps moving while
  // it waits in the queue (an employee's extra tickets, a journey stop that re-prices the trip).
  // So the version he loaded is checked here, and the write is pinned to the exact stored
  // timestamp it was checked against: a change landing between this read and the update leaves no
  // row to update, instead of being approved unseen. The write returned is the row that was
  // checked, so what goes to payroll is what he saw.
  const checkedUpdatedAt = await readOutstationRequestStoredUpdatedAt(requestId);
  assertOutstationClaimUnchanged({ current: checkedUpdatedAt, expected: options.expectedRevision });

  const acceptedStatus = access.scope === "system" ? "accepted_by_system" : "accepted_by_admin";
  const now = new Date().toISOString();
  const typedComment = cleanText(options.comment);
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({
      // His words, with the system's "Journey check:" group kept at the end (decision-note.ts).
      approval_reason: typedComment
        ? composeDecisionNote(existing.approvalReason, typedComment)
        : existing.approvalReason,
      calculation_status: acceptedStatus,
      status: acceptedStatus,
      updated_at: now,
    })
    .eq("id", requestId)
    .eq("updated_at", checkedUpdatedAt)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    // Not found, or the row moved after it was checked: either way it is no longer the claim he saw.
    throw new OutstationClaimChangedError("changed");
  }

  const request = mapOutstationRequestRow(data as Record<string, unknown>);

  // ── The two-photo + workload gate (owner rule, 2026-08-04) ──────────────────
  // Acceptance and PAYMENT are separated here. The request is still accepted and recorded
  // above — what the gate withholds is the push into payroll, until both photos and the trip
  // workload exist. Throwing instead would leave the employee unable to submit at all, which
  // is not what was asked for.
  //
  // A request that pre-dates the rule reads 'grandfathered' and passes untouched. That is also
  // what a row read BEFORE the migration applies returns (see mapOutstationRequestRow), so this
  // code deploying ahead of the migration cannot strand a single payment.
  //
  // Requests held here are released by releaseOutstationRequestToPayrollIfReady, which runs as
  // soon as the missing evidence lands.
  const gate = resolveOutstationGateState({
    employeeRole: request.employeeRole,
    evidenceGateStatus: request.evidenceGateStatus,
    hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
    hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
    workloadGateStatus: request.workloadGateStatus,
  });

  const payrollExpenseRows = gate.isPayrollEligible
    ? await pushAcceptedOutstationExpenseToPayroll(request, access)
    : [];

  if (!gate.isPayrollEligible) {
    logError("Outstation request accepted but held out of payroll by the evidence gate", {
      labels: {
        blocker: gate.blocker ?? "unknown",
        event: "outstation_request_held_by_gate",
        requestId: String(request.id),
      },
    });
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(request.id),
    entityType: "outstation_request",
    newValues: { gateBlocker: gate.blocker, inPayroll: gate.isPayrollEligible, status: request.status },
    oldValues: { status: existing.status },
    summary: gate.isPayrollEligible
      ? `Outstation request ${request.id} accepted (${acceptedStatus}) and added to payroll.`
      : `Outstation request ${request.id} accepted (${acceptedStatus}) but HELD out of payroll: ${gate.message}`,
  });

  // Narrowed 2026-08-08, when submission stopped auto-approving. Every ordinary claim is now
  // alerted the moment it is submitted, so firing here too would mail the employee, his manager
  // and the Super Admins a second "submitted" notice for the same trip — on every single claim.
  //
  // The one case that still needs it is a Super Admin OVERRIDING a system rejection: that path
  // sent a rejection email at submit and never sent the submission alert at all, so this is its
  // first and only one. Approving an ordinary pending claim stays silent, which is what the
  // owner's standing rule already says approval should be.
  if (existing.status.startsWith("rejected")) {
    await afterResponse("outstation_notice:override", () => notifyOutstationSubmitted(request));
  }

  return {
    expenseTripId: outstationPayrollTripId(request.id),
    gate,
    payrollExpenseRows,
    request,
  };
}

/**
 * Push a previously-held request into payroll once its evidence is complete.
 *
 * The counterpart to the gate in approveOutstationRequestForPayroll: that function withholds the
 * payroll row, this one delivers it when the missing piece finally arrives. Without this, gating
 * a request would strand it forever, which is strictly worse than not gating it at all.
 *
 * Safe to call repeatedly and from several triggers — it re-reads the request, re-resolves the
 * gate, and refuses to act unless the request is accepted, eligible, and not already in payroll.
 * Never throws: it runs as a follow-on to a photo or workload capture, and a payroll hiccup must
 * not fail the capture the employee just made.
 */
export async function releaseOutstationRequestToPayrollIfReady(
  requestId: number,
  access: AccessContext,
): Promise<{ released: boolean; reason: string; awaitingDecision?: boolean }> {
  try {
    const request = await getOutstationRequestById(requestId);
    if (!request) return { reason: "The request is no longer available.", released: false };

    // Only an ACCEPTED request belongs in payroll. A rejected or still-pending one is not held
    // by the evidence gate — it is held by a decision, and this must never override that.
    //
    // `awaitingDecision` marks exactly this case for an automatic caller: the decline is the normal
    // order of events (evidence captured before a Super Admin accepts), not a stranded claim, so it
    // must not be logged as an error. The guard itself is unchanged and load-bearing.
    if (!request.status.startsWith("accepted")) {
      return {
        awaitingDecision: true,
        reason: `The request is ${request.status}, so it is not waiting on evidence.`,
        released: false,
      };
    }

    // A queued-but-unimported expense row is NOT "already in payroll" — releasing is exactly what
    // still has to happen to it. Testing the row's existence here stranded every held claim.
    const linked = await getLinkedOutstationPayrollExpense(request.id);
    if (isOutstationExpenseInPayroll(linked)) {
      return { reason: "The request is already in payroll.", released: false };
    }

    const gate = resolveOutstationGateState({
      employeeRole: request.employeeRole,
      evidenceGateStatus: request.evidenceGateStatus,
      hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
      hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
      workloadGateStatus: request.workloadGateStatus,
    });
    if (!gate.isPayrollEligible) return { reason: gate.message, released: false };

    await pushAcceptedOutstationExpenseToPayroll(request, access);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
      entityId: String(request.id),
      entityType: "outstation_request",
      newValues: { inPayroll: true },
      oldValues: { inPayroll: false },
      summary: `Outstation request ${request.id} released into payroll — evidence complete.`,
    });
    return { reason: gate.message, released: true };
  } catch (error) {
    logError("Outstation payroll release failed (non-blocking)", {
      error,
      labels: { event: "outstation_payroll_release_failed", requestId: String(requestId) },
    });
    return {
      reason: error instanceof Error ? error.message : "The payroll release failed.",
      released: false,
    };
  }
}

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => text(value)).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function sumBy<T>(rows: T[], selector: (row: T) => number) {
  return rows.reduce((sum, row) => sum + selector(row), 0);
}

function groupNumeric<T>(
  rows: T[],
  labelSelector: (row: T) => string,
  valueSelector: (row: T) => number,
  countSelector?: (row: T) => number,
) {
  const groups = new Map<string, { label: string; trips: number; value: number }>();
  rows.forEach((row) => {
    const label = labelSelector(row) || "Unassigned";
    const existing = groups.get(label) ?? { label, trips: 0, value: 0 };
    existing.trips += countSelector ? countSelector(row) : 1;
    existing.value += valueSelector(row);
    groups.set(label, existing);
  });
  return Array.from(groups.values()).sort((left, right) => right.value - left.value);
}

export async function getOutstationHeatmapData(): Promise<OutstationHeatmapData> {
  const requests = await listOutstationRequests();
  const markers: OutstationHeatmapMarker[] = requests
    .filter(
      (request) =>
        request.capturedLatitude != null &&
        request.capturedLongitude != null &&
        Number.isFinite(request.capturedLatitude) &&
        Number.isFinite(request.capturedLongitude),
    )
    .map((request) => ({
      area: request.toArea ?? request.employeeArea,
      city: request.toCity,
      employeeName: request.employeeName,
      id: request.id,
      latitude: request.capturedLatitude,
      line: request.employeeLine,
      longitude: request.capturedLongitude,
      recommendation: request.approvalRecommendation,
      status: request.eligibilityStatus,
    }));

  return {
    filterOptions: {
      areas: uniqueValues(requests.map((request) => request.toArea ?? request.employeeArea)),
      lines: uniqueValues(requests.map((request) => request.employeeLine)),
      statuses: ["eligible", "not_eligible", "needs_review"],
    },
    heatmapRows: {
      byArea: groupNumeric(
        requests,
        (request) => request.toArea ?? request.employeeArea ?? "Unassigned",
        (request) => request.claimedTotalAmount,
      ).map((row) => ({
        label: row.label,
        totalExpenses: roundMoney(row.value),
        trips: row.trips,
      })),
      byCity: groupNumeric(
        requests,
        (request) => request.toCity ?? "Unknown city",
        (request) => request.claimedTotalAmount,
      ).map((row) => ({
        label: row.label,
        totalExpenses: roundMoney(row.value),
        trips: row.trips,
      })),
      byLine: groupNumeric(
        requests,
        (request) => request.employeeLine ?? "Unassigned",
        (request) => request.claimedTotalAmount,
      ).map((row) => ({
        label: row.label,
        totalExpenses: roundMoney(row.value),
        trips: row.trips,
      })),
    },
    kpis: {
      totalClaimed: roundMoney(sumBy(requests, (request) => request.claimedTotalAmount)),
      totalExpected: roundMoney(sumBy(requests, (request) => request.expectedTotalAmount)),
      totalRequests: requests.length,
    },
    markers,
  };
}

export type ManagerExpenseCalculationPreview = {
  allowanceAmount: number;
  allowanceBreakdown: OutstationAllowanceBreakdown;
  claimedTotalAmount: number;
  eligibilityStatus: OutstationEligibilityStatus;
  expectedTotalAmount: number;
  fuelAmount: number;
  fuelRatePerKm: number;
  meetingAmount: number;
  otherAmount: number;
  overnightDays: number;
  ticketAmount: number;
  travelCost: number;
  sameDayTrip: boolean;
};

/**
 * Computes the fuel + allowance breakdown for a manual admin outstation expense
 * WITHOUT persisting anything. Used by the add-expense modal to show a live
 * calculation preview. The fuel + total math here is intentionally identical to
 * `createManagerExpenseAsAdmin`; keep the two in sync.
 */
export async function previewManagerExpenseCalculation(
  access: AccessContext,
  input: {
    claimedTotalAmount?: number;
    // The selected destination, so the preview can apply the Cairo no-allowance rule and never
    // show an allowance the save will then zero. Optional: absent until a destination is picked.
    destinationArea?: string | null;
    destinationCity?: string | null;
    destinationCountry?: string | null;
    destinationLabel?: string | null;
    distanceKm: number;
    employeeHrId: string;
    expenseType: OutstationExpenseType;
    meetingAmount?: number;
    otherAmount?: number;
    transportationType: OutstationTransportationType;
    travelCostAmount?: number | null;
    tripEndDate: string;
    tripStartDate: string;
  },
): Promise<ManagerExpenseCalculationPreview> {
  await assertOutstationAdminAccess(access, "approve");

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find(
    (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(input.employeeHrId),
  );
  if (!employee?.hrId) {
    throw new Error(`Employee ${input.employeeHrId} was not found in the employee directory.`);
  }

  const policy = await getActivePolicyForRole(resolveJobFunctionRole(employee.jobTitle ?? ""));
  const meetingAmount = positiveMoney(input.meetingAmount);
  const otherAmount = positiveMoney(input.otherAmount);

  // A Meeting entry is priced on the meeting cost alone — no distance-driven travel cost, no
  // allowance, and no distance-eligibility floor. Owner rule, 2026-09-04.
  const isMeetingExpense = input.expenseType === "meeting";

  let fuelAmount = 0;
  let ticketAmount = 0;
  let travelCost = 0;
  let allowance = zeroAllowanceBreakdown();
  let eligibilityStatus: OutstationEligibilityStatus = "eligible";

  if (!isMeetingExpense) {
    const residence = await getResidenceLocationForEmployee(employee.hrId);
    const residenceGovernorate = resolveFirstGovernorate(
      residence?.residenceCity,
      residence?.residenceArea,
      residence?.residenceAddress,
    );
    const destinationGovernorate = resolveFirstGovernorate(
      input.destinationCity,
      input.destinationArea,
      input.destinationLabel,
      input.destinationCountry,
    );
    allowance = await calculateGuardedAllowanceBreakdown({
      destinationGovernorate,
      employeeHrId: employee.hrId,
      policy,
      residenceGovernorate,
      tripEndDate: input.tripEndDate,
      tripStartDate: input.tripStartDate,
    });

    if (input.transportationType === "car") {
      fuelAmount = roundMoney(input.distanceKm * 2 * policy.fuelRatePerKm);
    }
    travelCost = optionalPositiveMoney(input.travelCostAmount) ?? fuelAmount;
    ticketAmount =
      input.transportationType === "car" ? 0 : roundMoney(Math.max(0, travelCost - fuelAmount));

    const distanceEligibility = classifyOutstationExpenseEligibility({
      actualDistanceKm: input.distanceKm,
      policy: {
        officialMinimumDistanceKm: policy.minimumDistanceKm,
        toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
      },
    });
    eligibilityStatus =
      distanceEligibility.classification === "not_eligible" ? "not_eligible" : "eligible";
  }

  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus,
      meetingAmount,
      otherAmount,
      travelCost,
    });
  const claimedInput = Number(input.claimedTotalAmount ?? 0);
  const claimedTotalAmount =
    Number.isFinite(claimedInput) && claimedInput > 0 ? claimedInput : expectedTotalAmount;
  return {
    allowanceAmount: allowance.allowanceAmount,
    allowanceBreakdown: allowance.breakdown,
    claimedTotalAmount,
    eligibilityStatus,
    expectedTotalAmount,
    fuelAmount,
    fuelRatePerKm: policy.fuelRatePerKm,
    meetingAmount,
    otherAmount,
    overnightDays: allowance.overnightDays,
    ticketAmount,
    travelCost,
    sameDayTrip: allowance.sameDayTrip,
  };
}

export async function createManagerExpenseAsAdmin(
  access: AccessContext,
  input: ManagerExpenseAdminInput,
): Promise<OutstationExpenseRequest> {
  await assertOutstationAdminAccess(access, "approve");
  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending",
    status: "draft",
  });

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find(
    (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(input.employeeHrId),
  );
  if (!employee?.hrId) {
    throw new Error(`Employee ${input.employeeHrId} was not found in the employee directory.`);
  }

  const residence = await getResidenceLocationForEmployee(employee.hrId);
  // Resolved once and reused: the row's employee_role, the policy lookup and the no-hold rule
  // must all read the SAME role, or the claim is judged against a role it was not filed under.
  const employeeRole = resolveJobFunctionRole(employee.jobTitle ?? "");
  // Owner rule, 2026-08-28, extended to this path the same day: a National Sales Manager's
  // outstation expense is never held, for any reason — including one an admin enters for him.
  const noHoldRole = isOutstationNoHoldRole(employeeRole);
  const adminWorkflowStatus = noHoldRole ? "accepted_by_system" : "submitted";
  const policy = await getActivePolicyForRole(employeeRole);
  const residenceGovernorate = resolveFirstGovernorate(
    residence?.residenceCity,
    residence?.residenceArea,
    residence?.residenceAddress,
  );
  const destinationGovernorate = resolveFirstGovernorate(
    input.destination.city,
    input.destination.area,
    input.destination.label,
    input.destination.country,
  );
  // A Meeting entry is priced on the meeting cost alone — no distance-driven travel cost, no
  // allowance, and no distance-eligibility floor. Owner rule, 2026-09-04: for expenseType
  // "meeting" the admin only records where the meeting happened (destinationGovernorate above)
  // and what it cost — there is no trip to price.
  const isMeetingExpense = input.expenseType === "meeting";

  const allowance = isMeetingExpense
    ? zeroAllowanceBreakdown()
    : await calculateGuardedAllowanceBreakdown({
        destinationGovernorate,
        employeeHrId: employee.hrId,
        policy,
        residenceGovernorate,
        tripEndDate: input.tripEndDate,
        tripStartDate: input.tripStartDate,
      });

  let fuelAmount = 0;
  if (!isMeetingExpense && input.transportationType === "car") {
    fuelAmount = roundMoney(input.distanceKm * 2 * policy.fuelRatePerKm);
  }
  const reportTravelCost = isMeetingExpense
    ? 0
    : optionalPositiveMoney(input.travelCostAmount) ?? fuelAmount;
  // Keep fuelAmount + ticketAmount === reportTravelCost: the payroll mapper rebuilds
  // travel cost from those two columns, so a ticket trip that leaves ticket_amount at 0
  // reaches payroll with the ticket price missing.
  const ticketAmount = isMeetingExpense
    ? 0
    : input.transportationType === "car"
      ? 0
      : roundMoney(Math.max(0, reportTravelCost - fuelAmount));
  const reportMeetingAmount = positiveMoney(input.meetingAmount);
  const reportOtherAmount = positiveMoney(input.otherAmount);

  const distanceEligibility = classifyOutstationExpenseEligibility({
    actualDistanceKm: input.distanceKm,
    policy: {
      officialMinimumDistanceKm: policy.minimumDistanceKm,
      toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
    },
  });

  const eligibilityStatus: OutstationEligibilityStatus = isMeetingExpense
    ? "eligible"
    : distanceEligibility.classification === "not_eligible" ? "not_eligible" : "eligible";
  const eligibilityReason = isMeetingExpense
    ? "Admin-created manual meeting expense — no distance eligibility floor applies."
    : `Admin-created manual outstation expense. ${distanceEligibility.reason}`;

  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      travelCost: reportTravelCost,
    });
  const claimedTotalAmount =
    input.claimedTotalAmount > 0 ? input.claimedTotalAmount : expectedTotalAmount;
  const now = new Date().toISOString();
  // Only the hr id is canonicalised; `system` is a marker, not a person, and must survive.
  const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
  const workloadPayload = await resolveOutstationWorkloadPayload({
    employeeHrId: employee.hrId,
    tripEndDate: input.tripEndDate,
    tripStartDate: input.tripStartDate,
  });

  // Uploaded BEFORE the insert, on a synthetic draft id — the row's real id does not exist yet.
  // Mirrors the mobile submit path (car evidence / ticket attachments upload, then the insert
  // references the path), so a failed insert never leaves a DB row an admin thought had its
  // invoice attached.
  let meetingInvoiceMetadata: OutstationTicketAttachmentMetadata | null = null;
  if (input.meetingInvoiceDataUrl) {
    meetingInvoiceMetadata = await uploadOutstationMeetingInvoice({
      dataUrl: input.meetingInvoiceDataUrl,
      employeeHrId: employee.hrId,
      fileName: input.meetingInvoiceFileName ?? "invoice",
      requestId: `admin-manual-${randomUUID()}`,
    });
  }

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .insert({
      allowance_amount: allowance.allowanceAmount,
      allowance_breakdown_json: JSON.stringify(allowance.breakdown),
      approval_reason: noHoldRole
        ? OUTSTATION_NO_HOLD_ADMIN_APPROVAL_REASON
        : "Manual outstation expense created by admin. Requires manual review.",
      approval_recommendation: "manager_review",
      area: employee.areaName ?? null,
      attachment_count: 0,
      calculation_status: adminWorkflowStatus,
      captured_accuracy_meters: 0,
      captured_at: now,
      captured_latitude: input.destination.latitude,
      captured_location_source: "browser_gps",
      captured_longitude: input.destination.longitude,
      claimed_total_amount: claimedTotalAmount,
      distance_from_residence_km: input.distanceKm,
      distance_km: input.distanceKm,
      duration_minutes: input.durationMinutes ?? null,
      eligibility_reason: eligibilityReason,
      eligibility_status: eligibilityStatus,
      employee_hr_id: employee.hrId,
      // Already the record name; routed through the shared resolver so a blank full name falls
      // back the same way the other two insert paths do. See outstationRecordName().
      employee_name: outstationRecordName(employee),
      employee_role: employeeRole,
      // Set EXPLICITLY, and to 'grandfathered' rather than a pending state. This path has no
      // photo step at all — an admin types the trip in on behalf of an employee who never opened
      // the app — so the row can never satisfy the two-photo gate and there is no employee who
      // failed to take anything. Omitting this let the column default ('pending_arrival_photo',
      // deliberately fail-closed for rows that skip the submit path) apply, which froze every
      // manual expense out of payroll the moment #1707 landed: 9 requests worth 6,587.56 EGP
      // between 2026-08-05 and 2026-08-08, each logging "Waiting for the arrival photo. Capture
      // it in the app at your destination" at an employee who had no request to photograph.
      // 'grandfathered' is the only value that clears it — resolveOutstationGateState checks the
      // photos themselves before it trusts this column, so 'complete' on a photo-less row is
      // held as inconsistent, by design.
      evidence_gate_status: "grandfathered",
      expected_total_amount: expectedTotalAmount,
      expense_type: input.expenseType,
      fuel_amount: fuelAmount,
      go_ticket_amount: 0,
      line: employee.lineName ?? null,
      minimum_required_distance_km: policy.minimumDistanceKm,
      notes: appendAllowanceGuardNote(input.notes ?? null, allowance.breakdown),
      offline_captured: false,
      overnight_days: allowance.overnightDays,
      report_am_workload: positiveMoney(input.amWorkload),
      report_meeting_amount: reportMeetingAmount,
      report_other_amount: reportOtherAmount,
      report_pm_workload: positiveMoney(input.pmWorkload),
      report_travel_cost: reportTravelCost,
      report_trip_type: reportTripTypeLabel({
        override: input.tripType,
        overnightDays: allowance.overnightDays,
        sameDayTrip: allowance.sameDayTrip,
      }),
      residence_address: residence?.residenceAddress ?? null,
      residence_area: residence?.residenceArea ?? null,
      residence_city: residence?.residenceCity ?? null,
      residence_latitude: residence?.residenceLatitude ?? null,
      residence_longitude: residence?.residenceLongitude ?? null,
      return_ticket_amount: 0,
      route_polyline: input.routePolyline ?? null,
      same_day_trip: allowance.sameDayTrip,
      status: adminWorkflowStatus,
      submitted_at: now,
      territory_validation_reason: "Admin-created expense; territory check not applicable.",
      territory_validation_status: "not_available",
      ...workloadPayload,
      meeting_amount: input.meetingAmount ?? 0,
      meeting_invoice_metadata: meetingInvoiceMetadata,
      meeting_invoice_path: meetingInvoiceMetadata?.path ?? null,
      other_amount: input.otherAmount ?? 0,
      ticket_amount: ticketAmount,
      ticket_attachment_metadata: [],
      ticket_attachment_paths: [],
      to_area: input.destination.area ?? null,
      to_city: input.destination.city ?? null,
      to_country: input.destination.country ?? null,
      to_label: input.destination.label,
      transportation_type: input.transportationType,
      trip_end_date: input.tripEndDate,
      trip_start_date: input.tripStartDate,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    await deleteOutstationMeetingInvoice(meetingInvoiceMetadata?.path ?? null);
    throw new Error(error.message);
  }

  const created = mapOutstationRequestRow(data as Record<string, unknown>);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(created.id),
    entityType: "outstation_request",
    newValues: {
      destination: input.destination.label,
      distanceKm: input.distanceKm,
      employeeHrId: employee.hrId,
      expenseType: input.expenseType,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      source: "admin_manual_outstation_expense",
      status: adminWorkflowStatus,
      travelCost: reportTravelCost,
      tripEndDate: input.tripEndDate,
      tripStartDate: input.tripStartDate,
    },
    summary: `Admin created manual outstation expense for ${employee.hrId} to ${input.destination.label} (${input.distanceKm} km).`,
  });

  // An admin-created expense waits for an approval too (owner decision 2026-08-08). Creating a
  // claim on someone's behalf and approving it in the same call is one action wearing the clothes
  // of two — the queue is where the amount is confirmed, for this path as much as for a rep's own
  // submission.
  //
  // ONE exception, added 2026-08-28 on the owner's instruction after the rule had already
  // shipped for the employee's own submissions: a National Sales Manager is never held here
  // either. Leaving this path out would have meant his claim was instant when he filed it and
  // queued when an admin filed it for him — the same money treated two ways for a reason that
  // has nothing to do with him.
  // After the reply (afterResponse): the claim is saved, and the notice swallows its own failures.
  await afterResponse("outstation_notice:admin_created", () =>
    notifyOutstationSubmitted(created, { heldForReview: !noHoldRole }),
  );

  // Runs as the SYSTEM for the same reason the submit path does: the payroll write asserts a
  // manual-approval permission, and it was the rule that accepted this claim rather than the
  // admin who typed it. Never throws — a payroll hiccup must not fail a creation that already
  // succeeded — so a failure is logged rather than swallowed.
  if (noHoldRole) {
    const release = await releaseOutstationRequestToPayrollIfReady(created.id, systemAccessContext);
    if (!release.released) {
      logError("Outstation no-hold admin expense accepted on creation but not released into payroll", {
        labels: {
          event: "outstation_no_hold_release_failed",
          reason: release.reason,
          requestId: String(created.id),
        },
      });
    }
  }

  return created;
}

export async function updateManagerExpenseAsAdmin(
  requestId: number,
  access: AccessContext,
  input: Partial<ManagerExpenseAdminInput>,
): Promise<OutstationExpenseRequest> {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (isOutstationExpenseInPayroll(linkedPayroll)) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }
  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "edit_before_payroll",
    status: existing.status,
  });

  const now = new Date().toISOString();
  // Only the hr id is canonicalised; `system` is a marker, not a person, and must survive.
  const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

  const employeeHrId = existing.employeeHrId;
  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find(
    (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(employeeHrId),
  );
  const policy = await getActivePolicyForRole(
    resolveJobFunctionRole(employee?.jobTitle ?? existing.employeeRole),
  );

  const tripStartDate = input.tripStartDate ?? existing.tripStartDate;
  const tripEndDate = input.tripEndDate ?? existing.tripEndDate;
  const transportationType = input.transportationType ?? existing.transportationType;
  const expenseType = input.expenseType ?? existing.expenseType;
  const notes = "notes" in input ? (input.notes ?? null) : existing.notes;

  const destination = input.destination;
  const distanceKm = input.distanceKm ?? existing.distanceFromResidenceKm ?? 0;
  const durationMinutes = "durationMinutes" in input
    ? (input.durationMinutes ?? null)
    : existing.durationMinutes;
  const routePolyline = "routePolyline" in input
    ? (input.routePolyline ?? null)
    : existing.routePolyline;

  // Cairo rule inputs: resolve the residence governorate (from the employee's location record,
  // falling back to whatever the stored request captured) and the destination governorate (from
  // the edited destination when one was supplied, else the request's existing destination).
  const residenceForGovernorate = await getResidenceLocationForEmployee(employeeHrId);
  const residenceGovernorate = resolveFirstGovernorate(
    residenceForGovernorate?.residenceCity ?? existing.residenceCity,
    residenceForGovernorate?.residenceArea ?? existing.residenceArea,
    residenceForGovernorate?.residenceAddress ?? existing.residenceAddress,
  );
  const destinationGovernorate = resolveFirstGovernorate(
    destination?.city ?? existing.toCity,
    destination?.area ?? existing.toArea,
    destination?.label ?? existing.toLabel,
    destination?.country ?? existing.toCountry,
  );

  // A Meeting entry is priced on the meeting cost alone — no distance-driven travel cost, no
  // allowance, and no distance-eligibility floor. Owner rule, 2026-09-04.
  const isMeetingExpense = expenseType === "meeting";

  const allowance = isMeetingExpense
    ? zeroAllowanceBreakdown()
    : await calculateGuardedAllowanceBreakdown({
        destinationGovernorate,
        employeeHrId,
        excludeRequestId: requestId,
        policy,
        residenceGovernorate,
        tripEndDate,
        tripStartDate,
      });
  let fuelAmount = 0;
  // A journey with added stops keeps the chained price through an admin edit (owner rule,
  // 2026-10-18): the stops and their road legs are the employee's live photos, so an edit re-prices
  // them with the edited dates, distance and destination rather than falling back to home and back.
  let journeyPricing: ChainedJourneyPricing | null = null;
  if (!isMeetingExpense && transportationType === "car") {
    fuelAmount = roundMoney(distanceKm * 2 * policy.fuelRatePerKm);
    const stops = existing.journeyStops ?? [];
    if (stops.length > 0) {
      journeyPricing = priceChainedJourney({
        arrival: {
          capturedAt: existing.carEvidenceMetadata?.capturedAt ?? existing.capturedAt ?? null,
          distanceFromResidenceKm: distanceKm,
          // The arrival governorate the stops were priced against (read from the arrival photo's
          // GPS), unless this edit moved the destination: an unchanged save must not re-price.
          governorate: destination
            ? destinationGovernorate
            : existing.journeyPricing?.legs[0]?.toGovernorate ?? destinationGovernorate,
        },
        fuelRatePerKm: policy.fuelRatePerKm,
        gpsAccuracyThresholdMeters: policy.gpsAccuracyThresholdMeters,
        otherCarTripsByDay: await otherCarTripsByCairoDay(existing, journeyStopDays(stops)),
        residenceGovernorate,
        stops,
        tripEndDate,
        tripStartDate,
      });
      fuelAmount = journeyPricing.fuelAmount;
    }
  }
  const existingTravelCost =
    existing.reportTravelCost ?? roundMoney(existing.fuelAmount + existing.ticketAmount);
  const computedTravelCost =
    transportationType === "car" ? fuelAmount : existingTravelCost;
  const reportTravelCost = isMeetingExpense
    ? 0
    : "travelCostAmount" in input
      ? optionalPositiveMoney(input.travelCostAmount) ?? computedTravelCost
      : existingTravelCost;
  const ticketAmount = isMeetingExpense
    ? 0
    : transportationType === "car"
      ? 0
      : roundMoney(Math.max(0, reportTravelCost - fuelAmount));
  // Left NULL when the caller sent no override and the row never had one — writing a 0 back would
  // record an override nobody made, which is exactly the state the two mappers must be able to tell
  // apart. `resolved*` below is what the pricing and the audit row read.
  const reportMeetingAmount =
    "meetingAmount" in input
      ? positiveMoney(input.meetingAmount)
      : existing.reportMeetingAmount;
  const reportOtherAmount =
    "otherAmount" in input ? positiveMoney(input.otherAmount) : existing.reportOtherAmount;
  const resolvedMeetingAmount = outstationReportOverride(reportMeetingAmount, existing.meetingAmount);
  const resolvedOtherAmount = outstationReportOverride(reportOtherAmount, existing.otherAmount);
  const reportAmWorkload =
    "amWorkload" in input ? positiveMoney(input.amWorkload) : existing.reportAmWorkload;
  const reportPmWorkload =
    "pmWorkload" in input ? positiveMoney(input.pmWorkload) : existing.reportPmWorkload;
  const reportTripType =
    "tripType" in input
      ? reportTripTypeLabel({
          override: input.tripType,
          overnightDays: allowance.overnightDays,
          sameDayTrip: allowance.sameDayTrip,
        })
      : existing.reportTripType ??
        reportTripTypeLabel({
          overnightDays: allowance.overnightDays,
          sameDayTrip: allowance.sameDayTrip,
        });

  const distanceEligibility = classifyOutstationExpenseEligibility({
    actualDistanceKm: distanceKm,
    policy: {
      officialMinimumDistanceKm: policy.minimumDistanceKm,
      toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
    },
  });

  const eligibilityStatus: OutstationEligibilityStatus = isMeetingExpense
    ? "eligible"
    : distanceEligibility.classification === "not_eligible" ? "not_eligible" : "eligible";
  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus,
      meetingAmount: resolvedMeetingAmount,
      otherAmount: resolvedOtherAmount,
      travelCost: reportTravelCost,
    });
  const claimedTotal = input.claimedTotalAmount;
  const claimedTotalAmount = claimedTotal != null && claimedTotal > 0
    ? claimedTotal
    : expectedTotalAmount;
  const workloadPayload = await resolveOutstationWorkloadPayload({
    employeeHrId,
    tripEndDate,
    tripStartDate,
  });

  // Meeting invoice: upload the replacement BEFORE the update (same ordering as
  // addExtraOutstationTickets) so a failed write never leaves the row pointing at a file that was
  // never saved. The OLD file (if any) is deleted only once the new row state is confirmed,
  // below — deleting it up front would lose the only copy if the update then failed.
  // `"meetingInvoiceDataUrl" in input` is the tri-state: absent leaves the existing invoice
  // untouched, a data URL replaces it, and an explicit `null` removes it.
  let meetingInvoiceMetadata: OutstationTicketAttachmentMetadata | null | undefined;
  if ("meetingInvoiceDataUrl" in input) {
    meetingInvoiceMetadata = input.meetingInvoiceDataUrl
      ? await uploadOutstationMeetingInvoice({
          dataUrl: input.meetingInvoiceDataUrl,
          employeeHrId,
          fileName:
            input.meetingInvoiceFileName ?? existing.meetingInvoiceMetadata?.name ?? "invoice",
          requestId,
        })
      : null;
  }

  const updatePayload: Record<string, unknown> = {
    allowance_amount: allowance.allowanceAmount,
    allowance_breakdown_json: JSON.stringify(allowance.breakdown),
    ...workloadPayload,
    claimed_total_amount: claimedTotalAmount,
    distance_from_residence_km: distanceKm,
    distance_km: distanceKm,
    duration_minutes: durationMinutes,
    eligibility_reason: isMeetingExpense
      ? "Admin-updated manual meeting expense — no distance eligibility floor applies."
      : `Admin-updated manual outstation expense. ${distanceEligibility.reason}`,
    eligibility_status: eligibilityStatus,
    expense_type: expenseType,
    expected_total_amount: expectedTotalAmount,
    fuel_amount: fuelAmount,
    meeting_amount: input.meetingAmount ?? existing.meetingAmount ?? 0,
    ...(meetingInvoiceMetadata !== undefined
      ? {
          meeting_invoice_metadata: meetingInvoiceMetadata,
          meeting_invoice_path: meetingInvoiceMetadata?.path ?? null,
        }
      : {}),
    notes: appendAllowanceGuardNote(notes, allowance.breakdown),
    other_amount: input.otherAmount ?? existing.otherAmount ?? 0,
    overnight_days: allowance.overnightDays,
    report_am_workload: reportAmWorkload,
    report_meeting_amount: reportMeetingAmount,
    report_other_amount: reportOtherAmount,
    report_pm_workload: reportPmWorkload,
    report_travel_cost: reportTravelCost,
    report_trip_type: reportTripType,
    route_polyline: routePolyline,
    same_day_trip: allowance.sameDayTrip,
    ticket_amount: ticketAmount,
    transportation_type: transportationType,
    trip_end_date: tripEndDate,
    trip_start_date: tripStartDate,
    updated_at: now,
  };
  if ((existing.journeyStops ?? []).length > 0) {
    // Null when the edit made it a meeting or a non-car trip: the stops stay on record, unpriced.
    updatePayload.journey_pricing = journeyPricing;
    updatePayload.approval_reason = withJourneyReason(existing.approvalReason, journeyPricing);
  }

  if (destination) {
    updatePayload.captured_latitude = destination.latitude;
    updatePayload.captured_longitude = destination.longitude;
    updatePayload.to_area = destination.area ?? null;
    updatePayload.to_city = destination.city ?? null;
    updatePayload.to_country = destination.country ?? null;
    updatePayload.to_label = destination.label;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update(updatePayload)
    .eq("id", requestId)
    .eq("status", existing.status)
    .select("*")
    .maybeSingle();

  if (error) {
    if (meetingInvoiceMetadata) await deleteOutstationMeetingInvoice(meetingInvoiceMetadata.path);
    throw new Error(error.message);
  }
  if (!data) {
    if (meetingInvoiceMetadata) await deleteOutstationMeetingInvoice(meetingInvoiceMetadata.path);
    throw new Error("Outstation request state changed. Refresh and retry.");
  }

  // The write landed — now it is safe to drop the file it replaced or removed.
  if (meetingInvoiceMetadata !== undefined && existing.meetingInvoicePath) {
    if (existing.meetingInvoicePath !== meetingInvoiceMetadata?.path) {
      await deleteOutstationMeetingInvoice(existing.meetingInvoicePath);
    }
  }

  const updated = mapOutstationRequestRow(data as Record<string, unknown>);
  const syncedPayrollRows = await syncLinkedOutstationPayrollExpense({
    access,
    linkedPayroll,
    request: updated,
  });

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(updated.id),
    entityType: "outstation_request",
    newValues: {
      destination: destination?.label ?? existing.toLabel,
      distanceKm,
      expenseType,
      meetingAmount: resolvedMeetingAmount,
      otherAmount: resolvedOtherAmount,
      payrollExpenseRows: syncedPayrollRows,
      source: "admin_manual_outstation_expense_edit",
      status: updated.status,
      travelCost: reportTravelCost,
      tripEndDate,
      tripStartDate,
    },
    oldValues: {
      destination: existing.toLabel,
      distanceKm: existing.distanceFromResidenceKm,
      expenseType: existing.expenseType,
      status: existing.status,
    },
    summary: `Admin updated manual outstation expense ${requestId} for ${employeeHrId}.`,
  });

  return updated;
}

export async function rejectOutstationRequestAsAdmin(
  requestId: number,
  access: AccessContext,
  options: {
    comment: string;
    /**
     * The `updatedAt` of the claim the reviewer was looking at — REQUIRED, like the approval's. A
     * rejection is decided on the figures in front of him, so one made on a claim that has since
     * moved (a corrected stop, an extra ticket) is refused until he has seen the new figures.
     */
    expectedRevision: string;
  },
): Promise<OutstationExpenseRequest> {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");

  const expenseTripId = outstationPayrollTripId(existing.id);
  const supabase = getSupabaseAdmin();
  const { data: linkedPayrollRows, error: linkedPayrollError } = await supabase
    .from("outstation_expenses")
    .select(
      `id,imported_payroll_batch_id,imported_to_payroll_at,report_id,${EXPENSE_DECISION_SELECT}`,
    )
    .eq("trip_id", expenseTripId);

  if (linkedPayrollError && !isPayrollExpensesSchemaMissing(linkedPayrollError)) {
    throw new Error(linkedPayrollError.message);
  }

  const linkedRows = (linkedPayrollRows ?? []) as Array<Record<string, unknown>>;
  const addedToPayroll = linkedRows.some(
    (row) => row.imported_payroll_batch_id != null || row.imported_to_payroll_at != null,
  );
  if (addedToPayroll) {
    throw new Error("This outstation expense has already been added to payroll and cannot be rejected.");
  }

  const comment = cleanText(options.comment);
  if (!comment) {
    throw new Error("A rejection reason is required.");
  }

  if (!existing.status.startsWith("rejected")) {
    await assertOutstationExpenseWorkflowTransition({
      access,
      actionKey: existing.status.startsWith("accepted") ? "reject_before_payroll" : "reject",
      expectedNextStatus: "rejected",
      status: existing.status,
    });
  }

  // Checked BEFORE anything below is touched: an accepted claim's payroll rows are deleted next, and
  // that must not happen on the strength of a screen that is out of date. Only a check, not a pin to
  // HIS version on the final write — that would let any unrelated stamp (a photo arriving) fail the
  // update AFTER the payroll rows were gone. The final write pins only the reason it composes from.
  assertOutstationClaimUnchanged({
    current: await readOutstationRequestStoredUpdatedAt(requestId),
    expected: options.expectedRevision,
  });

  const now = new Date().toISOString();
  // Only the hr id is canonicalised; `system` is a marker, not a person, and must survive.
  const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
  const linkedReportIds = Array.from(
    new Set(
      linkedRows
        .map((row) => row.report_id ? String(row.report_id) : null)
        .filter(Boolean),
    ),
  );

  if (existing.status.startsWith("accepted") && linkedRows.length > 0) {
    const { error: deletePayrollError } = await supabase
      .from("outstation_expenses")
      .delete()
      .eq("trip_id", expenseTripId);

    if (deletePayrollError) throw new Error(deletePayrollError.message);

    // The trip is gone from the expense table, but an already-confirmed payroll Expenses step
    // still holds the figure it was confirmed with and would keep reimbursing the rejected trip.
    await resyncPayrollExpenseStepForRemovedTrips(linkedRows);

    for (const reportId of linkedReportIds) {
      const { count: remainingRows, error: remainingRowsError } = await supabase
        .from("outstation_expenses")
        .select("id", { count: "exact", head: true })
        .eq("report_id", reportId);

      if (remainingRowsError) throw new Error(remainingRowsError.message);
      if ((remainingRows ?? 0) > 0) continue;

      const { error: deleteReportError } = await supabase
        .from("outstation_expense_reports")
        .delete()
        .eq("id", reportId);

      if (deleteReportError) throw new Error(deleteReportError.message);
    }
  }

  // His reason, with the system's "Journey check:" group kept at the end (decision-note.ts) —
  // composed from the reason as stored at the moment of the write and pinned to that version, so a
  // stop saved since the check above cannot have its group wiped. A miss re-reads and composes again
  // rather than failing: the payroll rows may already be gone, and a rejection pays nothing.
  let data: unknown = null;
  let error: { message: string } | null = null;
  for (let attempt = 0; attempt < 3 && !data && !error; attempt += 1) {
    const stored = await readOutstationRequestStoredReason(requestId);
    ({ data, error } = await supabase
      .from("outstation_expense_requests")
      .update({
        approval_reason: composeDecisionNote(stored.approvalReason, comment),
        approval_recommendation: "reject",
        calculation_status: "rejected_by_admin",
        status: "rejected_by_admin",
        updated_at: now,
      })
      .eq("id", requestId)
      .eq("updated_at", stored.updatedAt)
      .in("status", ["submitted", "approved", "rejected", "needs_review", "accepted_by_system", "accepted_by_admin", "rejected_by_system", "rejected_by_admin"])
      .select("*")
      .maybeSingle());
  }

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("Outstation request state changed. Refresh and retry.");
  }

  const rejected = mapOutstationRequestRow(data as Record<string, unknown>);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(rejected.id),
    entityType: "outstation_request",
    newValues: {
      approvalReason: comment,
      removedPayrollExpenseRows: existing.status.startsWith("accepted") ? linkedRows.length : 0,
      status: rejected.status,
    },
    oldValues: {
      status: existing.status,
    },
    summary: `Admin rejected outstation request ${rejected.id}.`,
  });

  // After the reply (afterResponse): the rejection is saved and audited, and the notice used to be
  // awaited before the answer left. It swallows its own failures, so the answer never depended on it.
  await afterResponse("outstation_notice:rejected", () =>
    notifyOutstationDecision({ comment, decision: "reject", request: rejected }),
  );
  return rejected;
}

/** One queue row's decision, narrowed to the fields the outstation workflow actually needs. */
export type OutstationRequestExpenseDecisionInput = {
  approvedAmount?: number | null;
  hrApproved?: boolean;
  hrComment?: string;
  /**
   * The claim's version token the queue row was loaded with (`requestRevision` on the row). An
   * approve, a reject or a trimmed amount without it is skipped, never applied blind.
   */
  requestRevision?: string | null;
  status?: string | null;
  total: number;
  tripId: string;
};

export type OutstationRequestExpenseDecisionResult = {
  applied: number;
  /**
   * Rows deliberately not written, each with a reason the reviewer can act on. `code` is
   * OUTSTATION_CLAIM_CHANGED_CODE when the claim moved after the queue loaded it.
   */
  skipped: Array<{ code?: string; reason: string; tripId: string }>;
};

/**
 * Writes HR's adjusted payable figure onto the request's linked payroll row.
 *
 * Goes through `savePayrollExpenseApprovals` rather than a bare UPDATE for one reason: that is
 * what re-syncs an already-confirmed payroll Expenses step. A direct write would leave a confirmed
 * step still reimbursing the figure it was confirmed with — the exact failure the July 2026 resync
 * was built for.
 *
 * Returns false when the request has no linked payroll row at all, which happens when the evidence
 * gate is holding an accepted trip out of payroll. There is nothing to carry the figure, so the
 * caller reports that instead of pretending the amount was stored.
 */
async function writeOutstationRequestPayableAmount(input: {
  access: AccessContext;
  approvedAmount: number | null;
  hrComment: string;
  request: OutstationExpenseRequest;
}): Promise<boolean> {
  const linked = await getLinkedOutstationPayrollExpense(input.request.id);
  if (!linked) return false;

  const record = mapOutstationRequestToPayrollExpenseRecord(input.request, {
    hrComment: input.hrComment.trim() || null,
    // The ONE outstation caller that is genuinely deciding: this is HR's typed figure and reason
    // arriving from the approvals queue, so it overwrites the stored decision rather than
    // deferring to it. Every other caller here re-pushes figures and must preserve.
    preserveExistingDecision: false,
    reportId: linked.reportId,
  });

  await savePayrollExpenseApprovals(
    {
      fileName: workflowExpenseReportFileName(input.request.id),
      records: [{ ...record, approvedAmount: input.approvedAmount }],
      reportId: linked.reportId,
    },
    input.access,
    { allowWorkflowTripIds: true },
  );

  return true;
}

/**
 * Writes HR's comment onto a request without touching its decision.
 *
 * `approval_reason` is the column the approvals queue reads a request's comment back from, so a
 * reply HR types there has to land in it — writing it only to the linked payroll row (what the
 * payable-figure path does) left the queue showing the old text after the reload, as if the reply
 * had never been saved (2026-09-18). A note moves no money, so this writes the one column and an
 * audit row, and deliberately runs no workflow transition, payroll push or notification.
 *
 * The column is NOT NULL, so a cleared comment is stored as an empty string.
 */
async function writeOutstationRequestDecisionNote(input: {
  access: AccessContext;
  comment: string;
  request: OutstationExpenseRequest;
}): Promise<void> {
  // His words, with the system's "Journey check:" group kept at the end (decision-note.ts) — the
  // comment box is pre-filled with the whole stored reason, so clearing it must not erase the group.
  // Composed from the reason as stored NOW and written only over that version: a journey stop saved
  // since the queue loaded rewrites the group, and the older copy would put back stale flags.
  const stored = await readOutstationRequestStoredReason(input.request.id);
  const next = composeDecisionNote(stored.approvalReason, cleanText(input.comment));
  const previous = cleanText(stored.approvalReason) ?? "";
  if (next === previous) return;

  await assertOutstationAdminAccess(input.access, "approve");

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({ approval_reason: next, updated_at: new Date().toISOString() })
    .eq("id", input.request.id)
    .eq("updated_at", stored.updatedAt)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new OutstationClaimChangedError("changed");

  await writeRequiredAuditLog({
    actorLoginId: input.access.loginId ?? resolveEmployeeIdentityId(input.access) ?? "system",
    entityId: String(input.request.id),
    entityType: "outstation_request",
    newValues: { approvalReason: next },
    oldValues: { approvalReason: previous },
    summary: `Outstation request ${input.request.id}: HR comment updated from Expense Approvals.`,
  });
}

/**
 * Applies Expense Approvals decisions to Phoenix-submitted outstation requests.
 *
 * The screen submits its whole visible record set on every Save, so most rows arriving here are
 * unchanged — `planOutstationRequestDecision` filters those to "skip" and they never reach the
 * workflow, never re-push payroll and never write an audit row. Only a genuine state change, a
 * moved payable figure or an edited comment does anything.
 *
 * Each row is decided independently: one refusal does not abandon the rest of the batch, and every
 * refusal comes back named so the queue can say which trip was not written and why. Approve and
 * reject delegate wholesale to the same two functions the Queue tab calls, so the evidence gate,
 * the in-payroll lock, audit logging and the employee notification are inherited, not re-created.
 */
export async function applyOutstationRequestExpenseDecisions(input: {
  access: AccessContext;
  entries: ReadonlyArray<{ record: OutstationRequestExpenseDecisionInput; requestId: number }>;
}): Promise<OutstationRequestExpenseDecisionResult> {
  let applied = 0;
  const skipped: OutstationRequestExpenseDecisionResult["skipped"] = [];

  for (const { record, requestId } of input.entries) {
    const hrComment = String(record.hrComment ?? "");
    const requestedAmount = Number(record.approvedAmount ?? record.total);

    // The figure that belongs in `approved_amount`: null unless HR moved it off the claim, so an
    // untouched trip is never rewritten with a redundant copy of its own total.
    const payableAmount = isAdjustedAmount(requestedAmount, record.total) ? requestedAmount : null;

    // Everything for one row sits inside the try, lookups included: a single unreadable request
    // must cost that row and nothing else. The imported expense rows in the same Save are written
    // after this returns, and one bad request row must not take them down with it.
    try {
      const existing = await getOutstationRequestById(requestId);
      if (!existing) {
        skipped.push({ reason: "the request no longer exists", tripId: record.tripId });
        continue;
      }

      const linked = await getLinkedOutstationPayrollExpense(requestId);
      const plan = planOutstationRequestDecision({
        claimedTotal: record.total,
        currentStatus: existing.status,
        decision: {
          approvedAmount: requestedAmount,
          hrApproved: Boolean(record.hrApproved),
          hrComment,
          status: record.status,
        },
        storedApprovedAmount: linked?.approvedAmount ?? null,
        storedComment: existing.approvalReason,
      });

      if (plan.action === "skip") continue;
      if (plan.action === "blocked") {
        skipped.push({ reason: plan.reason ?? "this decision is not supported here", tripId: record.tripId });
        continue;
      }

      if (plan.action === "comment") {
        await writeOutstationRequestDecisionNote({ access: input.access, comment: hrComment, request: existing });
        applied += 1;
        continue;
      }

      // ── A decision that moves money carries the claim he was looking at (2026-10-19) ─────────
      // Approve, reject and a trimmed amount are all decided on the figures on screen, and the
      // queue can be minutes old. A row that arrives without its version token (a hand-built POST,
      // an uploaded sheet, a tab opened before this check shipped) is skipped by name rather than
      // decided blind; a row whose claim has since moved is refused by the same check inside the two
      // workflow functions (approve pins its write to it) or just below (a trimmed amount).
      // A comment-only edit above moves no money and is not held to it.
      const seenRevision = cleanText(record.requestRevision) ?? "";
      if (!seenRevision) {
        skipped.push({
          code: OUTSTATION_CLAIM_CHANGED_CODE,
          reason: OUTSTATION_CLAIM_REVISION_MISSING_MESSAGE,
          tripId: record.tripId,
        });
        continue;
      }
      if (plan.action === "amount") {
        assertOutstationClaimUnchanged({ current: existing.updatedAt, expected: seenRevision });
      }

      // The payable-figure write below carries the reason only onto the linked payroll row, which
      // the queue does not read a request's comment from — so a trim's reason is written here too.
      if (plan.action === "amount") {
        await writeOutstationRequestDecisionNote({ access: input.access, comment: hrComment, request: existing });
      }

      if (plan.action === "reject") {
        await rejectOutstationRequestAsAdmin(requestId, input.access, {
          comment: hrComment,
          expectedRevision: seenRevision,
        });
        applied += 1;
        continue;
      }

      const request =
        plan.action === "approve"
          ? (
              await approveOutstationRequestForPayroll(requestId, input.access, {
                comment: hrComment || null,
                expectedRevision: seenRevision,
              })
            ).request
          : existing;

      applied += 1;

      // AN APPROVE ALWAYS NEEDS THIS SECOND WRITE — it is the only one that carries HR's decision.
      //
      // This used to skip it whenever the payable figure had not moved, on the reasoning that
      // "accepting the request already pushed its payroll row". That push goes through
      // `mapOutstationRequestToPayrollExpenseRecord`, which carries `preserveExistingDecision:
      // true` — correct for a figures-only re-push, and correct here too when the trip reaches
      // payroll for the FIRST time, because there is no stored decision to preserve. But a request
      // that ALREADY had an `outstation_expenses` row sitting pending keeps that pending decision:
      // the row is re-pushed with `hr_approved` left false and no `approved_at`.
      //
      // The trip then reads "Approved" everywhere the queue shows it (that state comes from
      // `outstation_expense_requests.status`) while the row payroll actually pays from says
      // otherwise, so the money silently never moves. It also breaks the `expense_claims` mirror:
      // `expense_claims_approved_needs_decision` refuses an approved claim with no `decided_at`,
      // and because the rebuild is one transaction, ONE such row freezes the whole screen.
      // Measured on production 2026-09-07: four trips approved at 22:50 Cairo (requests 38, 39,
      // 41 and 55, 2,859.17 EGP against the August payout) and every hourly refresh failing after.
      //
      // `writeOutstationRequestPayableAmount` is the one caller that opts OUT of preservation, so
      // routing every approve through it is what makes the stored row agree with the decision.
      // `payableAmount` is still null for an untouched claim, so this does not invent a reduction.
      //
      // (The opt-out flag is deliberately not spelled out here: a sibling regression test counts
      // its literal occurrences in this file to prove exactly one caller holds it, and a mention
      // in prose would read as a second one.)
      if (plan.action !== "amount" && plan.action !== "approve" && payableAmount === null) continue;

      const stored = await writeOutstationRequestPayableAmount({
        access: input.access,
        approvedAmount: payableAmount,
        hrComment,
        request,
      });

      if (!stored) {
        skipped.push({
          // Named for what did not land. An adjusted figure and a plain approval fail here for the
          // same reason — the evidence gate is holding the trip out of payroll, so there is no row
          // to carry either — but telling a reviewer their "adjusted amount" was lost when they
          // never changed one sends them hunting for a deduction that does not exist.
          reason:
            payableAmount === null
              ? "the trip was accepted, but the approval has not reached payroll — it is held out until its photos and workload land"
              : "the decision was saved, but the adjusted amount was not — this trip is held out of payroll until its photos and workload land",
          tripId: record.tripId,
        });
      }
    } catch (error) {
      skipped.push({
        ...(isOutstationClaimChangedError(error) ? { code: OUTSTATION_CLAIM_CHANGED_CODE } : {}),
        reason: error instanceof Error ? error.message : "the decision could not be applied",
        tripId: record.tripId,
      });
    }
  }

  return { applied, skipped };
}

export async function deleteOutstationRequestAsAdmin(
  requestId: number,
  access: AccessContext,
) {
  await assertOutstationAdminAccess(access, "delete");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");

  // Only the hr id is canonicalised; `system` is a marker, not a person, and must survive.
  const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
  const expenseTripId = outstationPayrollTripId(existing.id);
  const supabase = getSupabaseAdmin();

  const { data: linkedPayrollRows, error: linkedPayrollError } = await supabase
    .from("outstation_expenses")
    .select(
      `id,imported_payroll_batch_id,imported_to_payroll_at,report_id,${EXPENSE_DECISION_SELECT}`,
    )
    .eq("trip_id", expenseTripId);

  if (linkedPayrollError && !isPayrollExpensesSchemaMissing(linkedPayrollError)) {
    throw new Error(linkedPayrollError.message);
  }

  const linkedRows = (linkedPayrollRows ?? []) as Array<Record<string, unknown>>;
  const addedToPayroll = linkedRows.some(
    (row) => row.imported_payroll_batch_id != null || row.imported_to_payroll_at != null,
  );
  if (addedToPayroll) {
    throw new Error("This outstation expense has already been added to payroll and cannot be deleted.");
  }

  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "delete_before_payroll",
    expectedNextStatus: "deleted",
    status: existing.status,
  });

  let deletedPayrollRows = 0;
  const linkedReportIds = Array.from(
    new Set(
      linkedRows
        .map((row) => row.report_id ? String(row.report_id) : null)
        .filter(Boolean),
    ),
  );

  if (linkedRows.length > 0) {
    const { count, error: deletePayrollError } = await supabase
      .from("outstation_expenses")
      .delete({ count: "exact" })
      .eq("trip_id", expenseTripId);

    if (deletePayrollError) throw new Error(deletePayrollError.message);
    deletedPayrollRows = count ?? linkedRows.length;

    // Same reason as the rejection path: a confirmed Expenses step keeps paying a deleted trip.
    await resyncPayrollExpenseStepForRemovedTrips(linkedRows);

    for (const reportId of linkedReportIds) {
      const { count: remainingRows, error: remainingRowsError } = await supabase
        .from("outstation_expenses")
        .select("id", { count: "exact", head: true })
        .eq("report_id", reportId);

      if (remainingRowsError) throw new Error(remainingRowsError.message);
      if ((remainingRows ?? 0) > 0) continue;

      const { error: deleteReportError } = await supabase
        .from("outstation_expense_reports")
        .delete()
        .eq("id", reportId);

      if (deleteReportError) throw new Error(deleteReportError.message);
    }
  }

  await deleteOutstationCarEvidenceImage(existing.carEvidenceImagePath);
  await deleteOutstationTicketAttachments(existing.ticketAttachmentPaths);

  const { error } = await supabase
    .from("outstation_expense_requests")
    .delete()
    .eq("id", requestId);

  if (error) throw new Error(error.message);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actor,
    entityId: String(existing.id),
    entityType: "outstation_request",
    oldValues: {
      employeeHrId: existing.employeeHrId,
      expenseTripId,
      status: existing.status,
      toLabel: existing.toLabel,
      tripEndDate: existing.tripEndDate,
      tripStartDate: existing.tripStartDate,
    },
    summary: `Admin deleted outstation request ${existing.id}.`,
  });

  return {
    linkedPayroll: {
      deletedRows: deletedPayrollRows,
      expenseTripId,
    },
    request: existing,
  };
}


/**
 * Tell an employee his departure photo is due, on the day it stops being easy.
 *
 * Until this existed nothing ever told him. The capture card appears only if he happens to open
 * the right portal page, and the window closes at the end of the trip's last day — so the normal
 * way to discover the requirement was to notice, weeks later, that the money never came. Every
 * request held on a departure photo in production got there this way.
 *
 * Two deliberate choices:
 *   - The recipient is the SUBMITTER, not an approver. He is the only person on earth who can
 *     satisfy this — the photo has to be taken where he is standing — so there is no recipient
 *     question to ask here.
 *   - It fires on the trip's LAST DAY and on no other day. Not before, because a reminder on day
 *     one of a five-day trip is noise. Not after, because once he is home there is no photo left
 *     to take: chasing him then asks either for nothing or for a capture in the wrong place. That
 *     request is released by a Super Admin instead. Owner's decision, 2026-08-19; the reasoning is
 *     written out in full over outstationDeparturePhotoReminderDue.
 *
 * Not behind a notification toggle, unlike the SLA reminder: an unregistered toggle key resolves
 * to false, which would leave this silently dead while appearing to be wired up — the exact
 * failure mode it exists to prevent.
 *
 * Called from THREE places, which is why it is a function rather than a loop body: the daily job
 * below, the moment a request is submitted, and the Super Admin resend. The daily job alone was
 * not enough — see the note at the submit call site. Returns whether a notification was actually
 * raised, so a caller can count it; it decides for itself whether one is due and says no by
 * returning false.
 */
export async function sendOutstationDeparturePhotoReminder(
  row: OutstationExpenseRequest,
  todayCairo: string,
  // A caller may supply its own idempotency key to deliberately step around the automatic one.
  // Only the Super Admin resend does, and it exists because the automatic key is UNREPEATABLE by
  // design: claimDelivery upserts it with ignoreDuplicates, so once a key is claimed — even by an
  // attempt that then died at the provider — nothing on that key ever sends again. That property
  // is what stops a retro-blast when this code is fixed, and it is also what can leave a
  // genuinely-owed employee silent forever. The way out is a NEW key, never a re-run of the old.
  options?: { idempotencyKey?: string },
): Promise<boolean> {
  // A Meeting or Other claim is not a trip, so there is no departure photo to remind anyone of.
  // Decided here rather than at one caller, so the daily job and the Super Admin resend agree.
  if (isNonTravelExpenseType(row.expenseType)) return false;
  const gate = resolveOutstationGateState({
    employeeRole: row.employeeRole,
    evidenceGateStatus: row.evidenceGateStatus,
    hasArrivalPhoto: Boolean(row.carEvidenceImagePath),
    hasDeparturePhoto: Boolean(row.departureEvidenceImagePath),
    workloadGateStatus: row.workloadGateStatus,
  });
  const { due } = outstationDeparturePhotoReminderDue({
    gateBlocker: gate.blocker,
    todayCairo,
    tripEndDate: row.tripEndDate,
  });
  if (!due) return false;

  const destination =
    tidyOutstationAddress(row.toLabel) || text(row.toCity) || text(row.toArea) || "your destination";

  await createSystemNotificationForRecipients(
    {
      actionUrl: "/employee-portals/expense-submissions",
      // in_app added 2026-09-06 on the owner decision. It is the only channel that cannot fail
      // for want of external configuration: three of these reminders reached NOBODY because the
      // email was refused by the identity guard and the employee had no push subscription, and
      // push is separately unreliable here ("OneSignal is not configured"). A departure photo is
      // expense evidence — a reminder nobody receives becomes a claim with nothing to back it.
      channels: ["in_app", "email", "push"],
      email: {
        ctaHref: "/employee-portals/expense-submissions",
        ctaLabel: "Take the photo",
        // Pinned to the plain template. Left to module routing, `outstation` picked the SUBMIT
        // template, so this reminder reached the employee as "An Outstation / Expense request for
        // B-119 needs your review … submitted automatically and requires your review", with the HR
        // ID where his name belongs and blank Job Title and Line rows — that template reads its
        // fields from submit-only metrics this reminder never carries (production, 2026-09-12).
        templateKey: "general",
        tone: "neutral" as const,
      },
      eventType: "outstation_departure_photo_due",
      message: `Today is the last day to take the departure photo for your trip to ${destination}. Your expense does not reach payroll until it is captured.`,
      // Keyed WITHOUT the date, unlike the SLA reminder. The daily job would otherwise nag the
      // same person about the same trip every morning — and a reminder that arrives every day is
      // one people learn to delete. ONE is the whole budget per request, ever, now that the
      // overdue message is gone. The key is also what makes it safe for the submit path to raise
      // this as well: whichever caller gets there first wins, and the other is deduplicated
      // rather than doubling the message.
      metadata: {
        idempotencyKey:
          options?.idempotencyKey ??
          `outstation:${String(row.id)}:departure-photo:due`,
      },
      module: "outstation",
      priority: "normal",
      // Without this the EMAIL half is skipped outright. `outstation` is an employee-subject
      // workflow module, so resolvedEmailIdentity() requires a subject HR ID and refuses the send
      // when none of its six sources carries one — and this call carried none. Every reminder
      // raised between 2026-08-10 and 2026-08-18 lost its email exactly that way, 8 out of 8,
      // while the event row still read "sent" and the failure sat only in the delivery's
      // last_error. Push covered the employees who had a subscription; three had none and were
      // therefore told nothing at all, on any channel. The three other outstation notifications
      // all pass this correctly — this one call was the omission.
      subjectHrId: row.employeeHrId,
      title: "Departure photo due today",
    },
    [row.employeeHrId],
  );
  return true;
}

export async function runOutstationDeparturePhotoReminders(): Promise<{
  processed: number;
  errors: number;
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .neq("evidence_gate_status", "grandfathered");
  if (error || !data) return { errors: error ? 1 : 0, processed: 0 };

  const today = cairoDateOnly(new Date());
  if (!today) return { errors: 1, processed: 0 };

  let processed = 0;
  let errors = 0;

  for (const row of (data as Array<Record<string, unknown>>).map(mapOutstationRequestRow)) {
    try {
      if (await sendOutstationDeparturePhotoReminder(row, today)) processed += 1;
    } catch (notifyError) {
      logError("Outstation departure-photo reminder failed", {
        error: notifyError,
        labels: {
          event: "outstation_departure_reminder_failed",
          requestId: String(row.id),
        },
      });
      errors += 1;
    }
  }

  return { errors, processed };
}

export async function runOutstationSlaDaily(): Promise<{ processed: number; errors: number }> {
  if (!(await resolveNotificationRoleEnabled("outstation_sla_reminder"))) return { processed: 0, errors: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("id, employee_name, employee_hr_id, trip_start_date, created_at")
    .eq("status", "submitted");
  if (error) return { processed: 0, errors: 1 };

  // Find HR-level approver HR IDs — resolved, filtered and deduped by person in one place.
  // This carried the identical `String(a.hr_id)` hole as the resignation reminder and was quiet only
  // because `outstation_sla_reminder` is disabled by default; enabling it would have produced the
  // same daily foreign-key failure on the admin-HR console's NULL hr_id.
  const approverHrIds = await resolveRoleRecipientHrIds("outstation_sla_reminder");
  if (approverHrIds.length === 0) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;
  const now = Date.now();
  // The name an approver is chased with is resolved live, not read off the row: this message is
  // the one place the employee is named to somebody who is not them, and a request that has sat
  // for three days is exactly the kind that predates a correction to the employee record.
  const liveNames = await loadLiveOutstationEmployeeNames();
  for (const row of data ?? []) {
    const ageDays = Math.max(0, Math.floor((now - new Date(row.created_at as string).getTime()) / 86400000));
    if (ageDays < 3) continue;
    const employeeName = liveOutstationEmployeeName(
      liveNames,
      String(row.employee_hr_id ?? ""),
      String(row.employee_name ?? ""),
    );
    try {
      await createSystemNotificationForRecipients(
        {
          // in_app added 2026-09-06 on the owner decision, alongside the departure-photo reminder.
          channels: ["in_app", "email", "push"],
          eventType: "outstation_sla_reminder",
          message: `${employeeName}'s outstation request (trip: ${String(row.trip_start_date)}) has been pending ${ageDays} day${ageDays === 1 ? "" : "s"}.`,
          metadata: { idempotencyKey: `outstation:${String(row.id)}:sla:${today}` },
          module: "outstation",
          priority: "normal",
          // The request belongs to the EMPLOYEE; the recipients are the approvers. Module
          // "outstation" is an employee-subject workflow module, so without this the email half
          // would be refused by the identity guard the first time this job ever fires. It has
          // produced ZERO deliveries to date, so unlike its three siblings the fault here was
          // latent rather than measured — it would have shipped as a brand-new silent skip.
          subjectHrId: String(row.employee_hr_id),
          title: "Outstation approval overdue",
          actionUrl: `/admin/approvals-hub?module=outstation&id=${String(row.id)}`,
          email: {
            ctaHref: `/admin/approvals-hub?module=outstation&id=${String(row.id)}`,
            ctaLabel: "Review now",
            // Plain template: the submit template's table reads submit-only metrics and would
            // print the HR ID as the employee's name.
            templateKey: "general",
            tone: "warning" as const,
          },
        },
        approverHrIds,
      );
      processed += approverHrIds.length;
    } catch (error) {
      logError("Outstation SLA reminder failed for recipients", { labels: { event: "outstation_sla_reminder_failed", cron: "outstation-sla-reminder", requestId: String(row.id) }, error });
      errors += approverHrIds.length;
    }
  }
  return { processed, errors };
}

// ── Departure photos refused for having no location ──────────────────────────
// Owner, 2026-09-18, "Record refused tries": each refusal is kept on the request with its time and
// its cause (departure-location-refusals.ts), and the approver sees it where the departure photo
// would be. Best effort on purpose: recording must never turn the refusal the employee reads into a
// different error, so a failed write is logged and nothing more.
async function appendDepartureLocationRefusal(
  request: OutstationExpenseRequest,
  reason: DepartureLocationRefusalReason,
): Promise<void> {
  try {
    const refusals = withDepartureLocationRefusal(request.departureLocationRefusals, {
      at: new Date().toISOString(),
      reason,
    });
    const { error } = await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .update({ departure_location_refusals: refusals })
      .eq("id", request.id);
    if (error) throw error;
  } catch (error) {
    logError("Outstation departure photo refusal could not be recorded", {
      labels: { event: "outstation_departure_refusal_record_failed", requestId: String(request.id) },
      error,
    });
  }
}

/**
 * A departure photo the web card or the app refused for having no location, recorded with its
 * cause. The same ownership rule as the capture: the employee's own request, or an outstation
 * admin. It throws only when the request is missing or the caller may not touch it.
 */
export async function recordOutstationDepartureLocationRefusal(
  access: AccessContext,
  input: { reason: DepartureLocationRefusalReason; requestId: number },
): Promise<void> {
  const request = await getOutstationRequestById(input.requestId);
  if (!request) throw new Error("That outstation request is not available.");

  const callerHrId = normalizeHrIdForAccess(access.hrId);
  const ownsRequest =
    Boolean(callerHrId) && callerHrId === normalizeHrIdForAccess(request.employeeHrId);
  if (!ownsRequest) {
    await assertOutstationAdminAccess(access, "approve");
  }

  await appendDepartureLocationRefusal(request, input.reason);
}

// ── Departure photo capture ───────────────────────────────────────────────────
// The second of the two photos every request must carry (owner request 2026-08-04). Records the
// photo, reviews it against the arrival capture, and advances the evidence gate.
//
// The review NEVER refuses the photo — the owner chose to flag a suspicious pair rather than
// block it, so an employee with a poor GPS fix is never stranded. What it does is make the
// distance, the gap and a late capture visible to whoever approves the request.
export async function captureOutstationDeparturePhoto(
  access: AccessContext,
  input: { imageDataUrl: string; latitude?: number | null; locationLabel?: string | null; longitude?: number | null; requestId: number },
): Promise<{ gateStatus: OutstationEvidenceGateStatus; review: DepartureEvidenceReview }> {
  const request = await getOutstationRequestById(input.requestId);
  if (!request) throw new Error("That outstation request is not available.");

  // Own request only, unless the caller is an outstation admin. Checked here rather than in the
  // route because this is the security boundary — a second caller must not be able to skip it.
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  const ownsRequest =
    Boolean(callerHrId) && callerHrId === normalizeHrIdForAccess(request.employeeHrId);
  if (!ownsRequest) {
    await assertOutstationAdminAccess(access, "approve");
  }

  // A RETAKE, not an overwrite (owner decision 2026-08-08). Blurred photos, a thumb over the lens
  // and a camera that fired early are all real, and refusing them outright pushed honest people
  // towards asking an admin to waive the gate entirely. Two conditions keep it safe, and both are
  // the owner's explicit choice:
  //
  //   - It is bounded by the SAME deadline as the first capture — the end of the trip's last day,
  //     Cairo. That is what preserves the meaning of the pair: every version was taken while he
  //     was still on the trip. After the window it needs a Super Admin, exactly as before.
  //   - Nothing is ever discarded. The superseded capture keeps its own storage object and is
  //     recorded in previousVersions below, so a retake can correct a photo but never erase one.
  const isRetake = Boolean(request.departureEvidenceImagePath);
  if (isRetake) {
    const stillOpen = isWithinDepartureWindow({
      capturedAt: new Date().toISOString(),
      tripEndDate: request.tripEndDate,
    });
    if (!stillOpen) {
      throw new Error(
        "The departure photo can only be retaken while the trip window is open, and it closed at the end of " +
          `${String(request.tripEndDate).slice(0, 10)}. Ask a system administrator if this needs changing.`,
      );
    }
  }
  if (!request.carEvidenceImagePath) {
    throw new Error(
      "The arrival photo is missing, so a departure photo cannot be accepted yet — capture the arrival photo first.",
    );
  }
  // No location, no photo (owner ruling, 2026-09-18): refused like an arrival photo without GPS,
  // and BEFORE the upload, so nothing is stored. It used to be saved stamped "no GPS fix" with its
  // distance unknown and no flag, which cost the employee nothing. Distance is still only flagged.
  // The refused try is recorded first, with its cause, for the approver (owner, 2026-09-18). The web
  // card and the current app refuse before they get here and record through the refusal route; this
  // catches an older app build that still sends a photo without a position, and says no cause.
  if (!usablePosition(input.latitude, input.longitude)) {
    await appendDepartureLocationRefusal(request, "not_reported");
  }
  const locationRefusal = departurePhotoLocationRefusal(input.latitude, input.longitude);
  if (locationRefusal) throw new Error(locationRefusal);

  const capturedAt = new Date().toISOString();
  const review = reviewDepartureEvidence({
    arrivalCapturedAt: request.carEvidenceMetadata?.capturedAt ?? request.capturedAt,
    arrivalLatitude: request.carEvidenceMetadata?.capturedLatitude ?? request.capturedLatitude,
    arrivalLongitude: request.carEvidenceMetadata?.capturedLongitude ?? request.capturedLongitude,
    departureCapturedAt: capturedAt,
    departureLatitude: input.latitude ?? null,
    departureLongitude: input.longitude ?? null,
    tripEndDate: request.tripEndDate,
  });

  // The capture being replaced, preserved whole before the new one is written. Built from the
  // CURRENT row rather than recomputed, so what is archived is exactly what the approver would
  // have seen a moment ago.
  const existing = request.departureEvidenceMetadata;
  const previousVersions: OutstationDepartureEvidenceVersion[] = [
    ...(existing?.previousVersions ?? []),
    ...(isRetake && request.departureEvidenceImagePath
      ? [
          {
            capturedAt: existing?.capturedAt ?? request.departureCapturedAt ?? capturedAt,
            capturedLatitude: existing?.capturedLatitude ?? null,
            capturedLocationLabel: existing?.capturedLocationLabel ?? null,
            capturedLongitude: existing?.capturedLongitude ?? null,
            distanceFromArrivalKm: existing?.distanceFromArrivalKm ?? null,
            flags: existing?.flags ?? [],
            imagePath: request.departureEvidenceImagePath,
            minutesAfterArrival: existing?.minutesAfterArrival ?? null,
            version: existing?.version ?? 1,
          },
        ]
      : []),
  ];

  const version = previousVersions.length + 1;

  const path = await uploadOutstationDepartureEvidenceImage({
    employeeHrId: request.employeeHrId,
    imageDataUrl: input.imageDataUrl,
    requestId: request.id,
    version,
  });

  const metadata: OutstationDepartureEvidenceMetadata = {
    capturedAt,
    capturedLatitude: typeof input.latitude === "number" ? input.latitude : null,
    capturedLocationLabel: text(input.locationLabel) || null,
    capturedLongitude: typeof input.longitude === "number" ? input.longitude : null,
    distanceFromArrivalKm: review.distanceFromArrivalKm,
    flags: review.flags,
    minutesAfterArrival: review.minutesAfterArrival,
    previousVersions,
    source: "live_camera",
    // The retake count rides in the SUMMARY as well as the structured field, because the summary
    // is the line the approver actually reads on the approvals screen. A photo retaken four times
    // may be perfectly innocent, but he must not have to go looking to find that out.
    summary:
      version > 1
        ? `${review.summary} Retaken ${version - 1} time${version === 2 ? "" : "s"} — ${version} captures in total, all kept.`
        : review.summary,
    version,
  };

  const gateStatus = nextEvidenceGateStatus({
    hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
    hasDeparturePhoto: true,
  });

  const { error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({
      departure_captured_at: capturedAt,
      departure_evidence_image_path: path,
      departure_evidence_metadata: metadata,
      evidence_gate_status: gateStatus,
      updated_at: capturedAt,
    })
    .eq("id", request.id);

  if (error) {
    // The photo is already in storage. Leave it: an orphaned object is cheap, whereas deleting it
    // here would discard the employee's only capture if the retry then succeeds against a row
    // that did save. The upload is keyed on the request id, so a retry overwrites nothing.
    throw new Error(`The departure photo was uploaded but the request could not be updated: ${error.message}`);
  }

  // With both photos in hand the trip is over, so this is the natural moment to grab the
  // workload — and then to release the request into payroll if that succeeded. Both steps are
  // best-effort follow-ons: the photo is already saved, and neither a dead CRM nor a payroll
  // hiccup may turn the employee's successful capture into an error he has to retry.
  await captureWorkloadAndReleaseIfReady(request, access);

  return { gateStatus, review };
}

/** A stop may be added only while nobody has decided the trip yet — the same list an extra ticket obeys. */
const JOURNEY_STOP_OPEN_STATUSES = OUTSTATION_UNDECIDED_STATUSES;

/**
 * The employee's OTHER live car trips touching the given Cairo days — the double-pay check for a
 * stop. A failed read throws: an unread sibling list must never price as "no other trip".
 */
async function otherCarTripsByCairoDay(
  request: OutstationExpenseRequest,
  days: string[],
): Promise<Record<string, number[]>> {
  if (days.length === 0) return {};
  // Only trips that can touch these days, a day wider each side than the exact test below: the whole
  // history would ride every stop and fall under PostgREST's silent 1,000-row ceiling.
  const sortedDays = [...days].sort();
  const dayMs = 24 * 60 * 60 * 1000;
  const windowStart = new Date(Date.parse(`${sortedDays[0]}T00:00:00.000Z`) - dayMs).toISOString();
  const windowEnd = new Date(Date.parse(`${sortedDays[sortedDays.length - 1]}T00:00:00.000Z`) + 2 * dayMs).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("id, employee_hr_id, status, expense_type, transportation_type, trip_start_date, trip_end_date")
    // The lookup keys, never one spelling: the column can hold "B-12" or "b12" for one person.
    .in("employee_hr_id", hrIdLookupKeys(request.employeeHrId))
    .neq("id", request.id)
    .lt("trip_start_date", windowEnd)
    .gte("trip_end_date", windowStart);
  if (error) throw new Error(`The employee's other trips could not be read: ${error.message}`);
  const owner = normalizeHrIdForAccess(request.employeeHrId);
  const byDay: Record<string, number[]> = {};
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (normalizeHrIdForAccess(text(row.employee_hr_id)) !== owner) continue;
    if (text(row.status).startsWith("rejected")) continue;
    if (text(row.transportation_type).toLowerCase() !== "car") continue;
    if (isNonTravelExpenseType(text(row.expense_type).toLowerCase() as OutstationExpenseType)) continue;
    const first = text(row.trip_start_date).slice(0, 10);
    const last = text(row.trip_end_date).slice(0, 10) || first;
    for (const day of days) {
      if (first && day >= first && day <= last) (byDay[day] ??= []).push(Number(row.id));
    }
  }
  return byDay;
}

/** The employee's journeys that reached a day through a stop, with those days — for the submit hold. */
async function journeysWithStopsForEmployee(employeeHrId: string): Promise<Array<{ id: number; stopDays: string[] }>> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("id, employee_hr_id, status, journey_stops")
    .in("employee_hr_id", hrIdLookupKeys(employeeHrId))
    // Only journeys that carry a stop (the column is NOT NULL, default []): the whole history would
    // ride every car submit and fall under PostgREST's silent 1,000-row ceiling.
    .neq("journey_stops", "[]");
  if (error) throw new Error(`The employee's other trips could not be read: ${error.message}`);
  const owner = normalizeHrIdForAccess(employeeHrId);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => normalizeHrIdForAccess(text(row.employee_hr_id)) === owner)
    .filter((row) => !text(row.status).startsWith("rejected"))
    .map((row) => ({ id: Number(row.id), stopDays: journeyStopDays(readJourneyStops(row.journey_stops)) }))
    .filter((journey) => journey.stopDays.length > 0);
}

/**
 * Add a STOP to a car trip: the next place of a chained journey (owner rule, 2026-10-18 —
 * "Minya → Fayoum × 1.8, Fayoum → Beni Suef × 1.8, Beni Suef → Minya × 1.8, only governorate to
 * governorate, over 40 km"; pricing in chained-journey.ts).
 *
 * The anti-abuse rules (owner, same evening: "make sure that no one abuses it"), each here
 * because this is the security boundary — the portal card only mirrors them:
 *
 *   - Only the employee on the trip, only a CAR trip, only while nobody has decided it and it is
 *     not in payroll, and only until the end of the trip's last Cairo day (the departure window).
 *   - A live in-app JPEG with a GPS position, or nothing is stored — refused like a departure photo
 *     without a location. The capture time is the SERVER's, never the phone's.
 *   - The place and its governorate are the reverse-geocode of that position; every distance is
 *     Google's road distance between two live photo positions. Nothing is typed.
 *   - At most MAX_JOURNEY_STOPS stops. Every stop photo has its own never-overwritten path.
 *   - Every suspicious shape — impossible speed, ping-pong, a stop at home, another trip filed for
 *     the same day, a weak GPS fix, a chain more than twice the old price — is FLAGGED onto the
 *     approval reason for the Super Admin and never refused (the 2026-08-09 flag-never-reject rule).
 *   - The money moves by exactly the fuel's change, so the claim still equals its components.
 *   - The final write matches the row's exact updated_at, so a second capture or a decision that
 *     lands in between makes this one fail rather than overwrite it.
 */
export async function captureOutstationJourneyStop(
  access: AccessContext,
  input: {
    accuracyMeters?: number | null;
    imageDataUrl: string;
    latitude?: number | null;
    locationLabel?: string | null;
    longitude?: number | null;
    requestId: number;
  },
): Promise<{ pricing: ChainedJourneyPricing; request: OutstationExpenseRequest; stop: OutstationJourneyStop }> {
  const supabase = getSupabaseAdmin();
  // The concurrency token, read RAW and FIRST: the final update matches this exact text, so any
  // write after this point — another stop, an approval, an admin edit — makes this one fail.
  const { data: token, error: tokenError } = await supabase
    .from("outstation_expense_requests")
    .select("updated_at")
    .eq("id", input.requestId)
    .maybeSingle();
  if (tokenError) throw new Error(tokenError.message);
  const request = token ? await getOutstationRequestById(input.requestId) : null;
  if (!token || !request) throw new Error("That outstation request is not available.");

  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId || callerHrId !== normalizeHrIdForAccess(request.employeeHrId)) {
    throw forbiddenError("A stop can only be added by the employee on the trip.");
  }
  if (request.expenseType !== "traveling" || request.transportationType !== "car") {
    throw new Error("A stop can only be added to a car trip.");
  }
  if (!(JOURNEY_STOP_OPEN_STATUSES as readonly string[]).includes(request.status)) {
    throw new Error(
      "This trip has already been decided, so a stop can no longer be added. Ask a system administrator if it needs changing.",
    );
  }
  const linkedPayroll = await getLinkedOutstationPayrollExpense(request.id);
  if (isOutstationExpenseInPayroll(linkedPayroll)) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }
  const capturedAt = new Date().toISOString();
  if (!isWithinDepartureWindow({ capturedAt, tripEndDate: request.tripEndDate })) {
    throw new Error(
      `A stop can only be added while the trip is open, and it closed at the end of ${String(request.tripEndDate).slice(0, 10)}. ` +
        "Ask a system administrator if this needs changing.",
    );
  }
  if (!request.carEvidenceImagePath) {
    throw new Error("The arrival photo is missing, so a stop cannot be added yet — capture the arrival photo first.");
  }
  const existingStops = request.journeyStops ?? [];
  if (existingStops.length >= MAX_JOURNEY_STOPS) {
    throw new Error(
      `This trip already has ${MAX_JOURNEY_STOPS} stops, the most one trip may carry. Ask a system administrator if more are needed.`,
    );
  }
  if (!usablePosition(input.latitude, input.longitude)) {
    throw new Error(JOURNEY_STOP_LOCATION_REQUIRED_MESSAGE);
  }
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const residenceLatitude = request.residenceLatitude;
  const residenceLongitude = request.residenceLongitude;
  if (!usablePosition(residenceLatitude, residenceLongitude)) {
    throw new Error(
      "Your registered residence location is missing or invalid, so the drive home cannot be measured. Please contact HR.",
    );
  }

  const origin = pickJourneyLegOrigin({
    arrival: {
      capturedAt: request.carEvidenceMetadata?.capturedAt ?? request.capturedAt ?? null,
      latitude: request.carEvidenceMetadata?.capturedLatitude ?? request.capturedLatitude,
      longitude: request.carEvidenceMetadata?.capturedLongitude ?? request.capturedLongitude,
    },
    departure: request.departureEvidenceImagePath
      ? {
          capturedAt: request.departureCapturedAt ?? request.departureEvidenceMetadata?.capturedAt ?? null,
          latitude: request.departureEvidenceMetadata?.capturedLatitude ?? null,
          longitude: request.departureEvidenceMetadata?.capturedLongitude ?? null,
        }
      : null,
    nowIso: capturedAt,
    stops: existingStops,
  });
  if (!origin) {
    throw new Error(
      "The trip's earlier photos carry no location, so the drive to this stop cannot be measured. Ask a system administrator.",
    );
  }

  const roadLeg = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    try {
      const route = await googleDirectionsRoute(from, to);
      const km = route.distanceMeters != null ? Number((route.distanceMeters / 1000).toFixed(2)) : null;
      return {
        error: km == null ? "Google returned no driving route." : null,
        km,
        minutes: minutesFromSeconds(route.durationInTrafficSeconds) ?? minutesFromSeconds(route.durationSeconds),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Google Routes API failed to calculate the driving route.",
        km: null,
        minutes: null,
      };
    }
  };
  const stopPoint = { lat: latitude, lng: longitude };
  // Every governorate here is Google's reading of a GPS position, never a label the phone posted
  // (risk review, 2026-10-18: a crafted departure label "Beni Suef" turned a Fayoum-only trip into
  // a paid chain). The arrival's is read once and kept on the first leg of the stored pricing, so a
  // later stop or an admin edit prices against the same answer.
  const storedArrivalGovernorate = request.journeyPricing?.legs[0]?.toGovernorate ?? null;
  const arrivalPoint = {
    lat: Number(request.carEvidenceMetadata?.capturedLatitude ?? request.capturedLatitude),
    lng: Number(request.carEvidenceMetadata?.capturedLongitude ?? request.capturedLongitude),
  };
  const readGovernorate = async (point: { lat: number; lng: number }) => {
    if (!usablePosition(point.lat, point.lng)) return null;
    const found = await googleReverseGeocode(point).catch(() => null);
    return resolveFirstGovernorate(found?.governorate, found?.formattedAddress, found?.city, found?.area);
  };
  const [reverse, leg, home, originGovernorate, arrivalReadGovernorate] = await Promise.all([
    googleReverseGeocode(stopPoint).catch(() => null),
    roadLeg({ lat: origin.latitude, lng: origin.longitude }, stopPoint),
    roadLeg(stopPoint, { lat: Number(residenceLatitude), lng: Number(residenceLongitude) }),
    origin.kind === "departure"
      ? readGovernorate({ lat: origin.latitude, lng: origin.longitude })
      : Promise.resolve(null),
    storedArrivalGovernorate ? Promise.resolve(storedArrivalGovernorate) : readGovernorate(arrivalPoint),
  ]);

  const residenceGovernorate = resolveFirstGovernorate(
    request.residenceCity,
    request.residenceArea,
    request.residenceAddress,
  );
  // The stored destination fields were themselves written from Google's reverse geocode at submit;
  // they are the fallback only when the arrival position cannot be read now.
  const arrivalGovernorate =
    arrivalReadGovernorate ??
    resolveFirstGovernorate(request.toCity, request.toArea, request.toLabel, request.toCountry);
  const governorate = resolveFirstGovernorate(
    reverse?.governorate,
    reverse?.formattedAddress,
    reverse?.city,
    reverse?.area,
  );
  const legFromGovernorate =
    origin.kind === "stop"
      ? existingStops.at(-1)?.governorate ?? null
      : origin.kind === "departure"
        ? originGovernorate
        : arrivalGovernorate;

  const stopNumber = Math.max(1, ...existingStops.map((entry) => entry.stopNumber)) + 1;
  const photoPath = await uploadOutstationJourneyStopImage({
    capturedAtMs: new Date(capturedAt).getTime(),
    employeeHrId: request.employeeHrId,
    imageDataUrl: input.imageDataUrl,
    requestId: request.id,
    stopNumber,
  });

  const stop: OutstationJourneyStop = {
    accuracyMeters: readAccuracyInput(input.accuracyMeters),
    capturedAt,
    governorate,
    latitude,
    legFrom: origin.kind,
    legFromCapturedAt: origin.capturedAt,
    legFromGovernorate,
    legFromPreviousKm: leg.km,
    legFromPreviousMinutes: leg.minutes,
    locationLabel: reverse?.formattedAddress ?? (text(input.locationLabel) || null),
    longitude,
    photoPath,
    returnHomeKm: home.km,
    routeError: [leg.error, home.error].filter(Boolean).join(" ") || null,
    stopNumber,
  };
  const stops = [...existingStops, stop];

  const policy = await getActivePolicyForRole(resolveJobFunctionRole(request.employeeRole));
  const pricing = priceChainedJourney({
    arrival: {
      capturedAt: request.carEvidenceMetadata?.capturedAt ?? request.capturedAt ?? null,
      distanceFromResidenceKm: request.distanceFromResidenceKm,
      governorate: arrivalGovernorate,
    },
    fuelRatePerKm: policy.fuelRatePerKm,
    gpsAccuracyThresholdMeters: policy.gpsAccuracyThresholdMeters,
    otherCarTripsByDay: await otherCarTripsByCairoDay(request, journeyStopDays(stops)),
    residenceGovernorate,
    stops,
    tripEndDate: request.tripEndDate,
    tripStartDate: request.tripStartDate,
  });
  // A trip the system already found NOT eligible keeps its money exactly as it is: a stop must
  // never raise the payable on a claim the approver is being told not to pay (risk review,
  // 2026-10-18 — the travel cost rose while the claim stood still). The chain is still priced and
  // recorded, and the approver reads what it would have paid.
  const moneyMoves = request.eligibilityStatus !== "not_eligible";
  const notEligibleNote = moneyMoves
    ? []
    : [
        `The trip is not eligible, so the stops did not change the claim; priced as a journey the fuel would be ${pricing.fuelAmount.toFixed(2)}.`,
      ];
  const amounts = moneyMoves
    ? rebaseClaimOnNewFuel({
        claimedTotalAmount: request.claimedTotalAmount,
        expectedTotalAmount: request.expectedTotalAmount,
        expectedTotalFor: (travelCost) =>
          reportExpectedTotal({
            allowanceAmount: request.allowanceAmount,
            eligibilityStatus: request.eligibilityStatus,
            meetingAmount: outstationReportOverride(request.reportMeetingAmount, request.meetingAmount),
            otherAmount: outstationReportOverride(request.reportOtherAmount, request.otherAmount),
            travelCost,
          }),
        fuelAmount: request.fuelAmount,
        newFuelAmount: pricing.fuelAmount,
        reportTravelCost: request.reportTravelCost,
        ticketAmount: request.ticketAmount,
      })
    : {
        claimedTotalAmount: request.claimedTotalAmount,
        expectedTotalAmount: request.expectedTotalAmount,
        fuelAmount: request.fuelAmount,
        reportTravelCost: request.reportTravelCost,
      };

  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .update({
      approval_reason: withJourneyReason(request.approvalReason, pricing, notEligibleNote),
      ...(pricing.flags.length > 0 && request.approvalRecommendation === "auto_approve"
        ? { approval_recommendation: "hr_review" }
        : {}),
      claimed_total_amount: amounts.claimedTotalAmount,
      expected_total_amount: amounts.expectedTotalAmount,
      fuel_amount: amounts.fuelAmount,
      journey_pricing: pricing,
      journey_stops: stops,
      report_travel_cost: amounts.reportTravelCost,
      updated_at: capturedAt,
    })
    .eq("id", request.id)
    .eq("updated_at", (token as { updated_at: string }).updated_at)
    .in("status", [...JOURNEY_STOP_OPEN_STATUSES])
    .select("*")
    .maybeSingle();
  if (error) {
    // The photo is already stored under its own path; it is left, never deleted — an orphaned
    // object is cheap, a deleted capture is evidence lost.
    throw new Error(`The stop photo was uploaded but the trip could not be updated: ${error.message}`);
  }
  if (!data) {
    throw new Error("This trip changed while the stop was being saved. Refresh and take the stop photo again.");
  }
  const updated = mapOutstationRequestRow(data as Record<string, unknown>);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(updated.id),
    entityType: "outstation_request",
    newValues: {
      claimedTotalAmount: updated.claimedTotalAmount,
      fuelAmount: updated.fuelAmount,
      journeyFlags: pricing.flags,
      journeyMode: pricing.mode,
      paidKm: pricing.paidKm,
      source: "employee_journey_stop",
      stopGovernorate: governorate,
      stopNumber,
    },
    oldValues: {
      claimedTotalAmount: request.claimedTotalAmount,
      fuelAmount: request.fuelAmount,
      stopCount: existingStops.length,
    },
    summary:
      `Employee added stop ${stopNumber} (${governorate ?? "governorate unknown"}) to outstation request ${updated.id}: ` +
      `fuel ${formatEgp(request.fuelAmount)} → ${formatEgp(updated.fuelAmount)}` +
      (pricing.flags.length > 0 ? `, flagged: ${pricing.flags.join(", ")}.` : "."),
  });

  return { pricing, request: updated, stop };
}

/**
 * Run the automatic release and record it when it does not happen.
 *
 * releaseOutstationRequestToPayrollIfReady never throws — it reports failure in its return value.
 * Both automatic callers used to discard that value, so a request that stayed held after the
 * employee's photo capture produced no signal anywhere: the employee saw success, no log line was
 * written, and the claim simply never reached payroll. The admin-triggered callers already surface
 * `release.reason`; these two now at least log it under their own event label.
 */
async function runAutomaticOutstationRelease(
  request: OutstationExpenseRequest,
  access: AccessContext,
) {
  const release = await releaseOutstationRequestToPayrollIfReady(request.id, access);
  if (!release.released) {
    if (release.awaitingDecision) {
      // The employee has captured evidence while the request is still `submitted` — i.e. waiting on
      // a Super Admin to accept or reject it. That is the normal order of events, not a stranded
      // claim: the release fires correctly once the admin accepts. Logging it at ERROR wrote a
      // false-positive row into app_error_events / the System Issues dashboard on every such capture
      // (~14/week in production), burying the genuinely-held case this log exists to surface. INFO
      // keeps it searchable (event=outstation_auto_release_awaiting_decision) without persisting or
      // paging.
      logInfo("Outstation automatic release skipped — request not yet accepted", {
        labels: { event: "outstation_auto_release_awaiting_decision", requestId: String(request.id) },
      });
    } else {
      logError("Outstation request stayed held after an automatic release attempt", {
        error: new Error(release.reason),
        labels: { event: "outstation_auto_release_held", requestId: String(request.id) },
      });
    }
  }
  return release;
}

/**
 * Attempt the CRM workload grab for a request whose photos are complete, then release it into
 * payroll if that closed the last gate.
 *
 * A FAILED grab is recorded, not swallowed: workload_capture_attempts, the timestamp and the
 * error text are what the Super Admin repair screen reads to decide between retrying and typing
 * the numbers in. Deliberately never writes zeros on failure — a zero workload reads as "he did
 * no work", which is a reason to reject a claim, not a missing measurement.
 *
 * Returns the release attempt's own outcome, or null when it never got as far as attempting one.
 * The caller needs the REASON, not just the fact: releaseOutstationRequestToPayrollIfReady
 * declines for three genuinely different causes — the request is not accepted yet, it is already
 * in payroll, or the gate still holds it — and a caller that re-derives only the gate cannot tell
 * the first two apart from a bug. See retryOutstationWorkloadCapture.
 */
async function captureWorkloadAndReleaseIfReady(
  request: OutstationExpenseRequest,
  access: AccessContext,
): Promise<{ reason: string; released: boolean } | null> {
  try {
    if (request.workloadGateStatus !== "pending_workload") {
      return await runAutomaticOutstationRelease(request, access);
    }

    const capture = await captureOutstationTripWorkload({
      employeeHrId: request.employeeHrId,
      employeeRole: request.employeeRole,
      tripEndDate: request.tripEndDate,
      tripStartDate: request.tripStartDate,
    });

    const now = new Date().toISOString();
    if (!capture.captured) {
      await getSupabaseAdmin()
        .from("outstation_expense_requests")
        .update({
          workload_capture_attempts: (request.workloadCaptureAttempts ?? 0) + 1,
          workload_last_attempt_at: now,
          workload_last_attempt_error: capture.reason,
        })
        .eq("id", request.id);
      return null;
    }

    await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .update({
        // AM · PM · Pharmacies, the match verdict kept in step with them (a re-grabbed row once read
        // "no_activity" beside a real AM 2 / PM 7), and the per-day breakdown an approver reads —
        // one shape, shared with the morning refresh (workload-stamp.ts).
        ...capturedWorkloadColumns(capture, now),
        workload_capture_attempts: (request.workloadCaptureAttempts ?? 0) + 1,
        workload_gate_status: "complete",
        workload_last_attempt_at: now,
        workload_last_attempt_error: null,
      })
      .eq("id", request.id);

    return await runAutomaticOutstationRelease(request, access);
  } catch (error) {
    logError("Outstation workload capture failed after the departure photo (non-blocking)", {
      error,
      labels: { event: "outstation_workload_capture_failed", requestId: String(request.id) },
    });
    return null;
  }
}

/**
 * The morning refresh of a workload stamped too early (owner, 2026-10-22 — workload-stamp.ts).
 *
 * The first stamp is read the moment the departure photo lands, which is usually before the
 * manager has typed the day's visits; nothing re-read it afterwards, so a worked day stayed "no
 * activity" in front of the approver. Each morning this re-reads the CRM for every undecided,
 * system-stamped claim whose trip ended in the last 45 days, and rewrites the stamp only when the
 * CRM now holds MORE work. Evidence only: no amount, no gate status, no `updated_at` (the approval
 * revision belongs to money) and no approval reason is touched, and the write is pinned to the
 * claim still being undecided and still carrying the figures that were read.
 */
export async function runOutstationWorkloadRestamp(): Promise<{
  checked: number;
  errors: number;
  restamped: number;
}> {
  const today = cairoTodayIso();
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("*")
    .in("status", [...OUTSTATION_UNDECIDED_STATUSES])
    .eq("workload_gate_status", "complete")
    .gte("trip_end_date", restampWindowStart(today))
    .order("trip_end_date", { ascending: false })
    .limit(WORKLOAD_RESTAMP_MAX_ROWS);
  if (error) throw new Error(error.message);

  const candidates = ((data ?? []) as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((row) => isWorkloadRestampCandidate(row, today));

  let restamped = 0;
  let errors = 0;
  for (const request of candidates) {
    try {
      const capture = await captureOutstationTripWorkload({
        employeeHrId: request.employeeHrId,
        employeeRole: request.employeeRole,
        tripEndDate: request.tripEndDate,
        tripStartDate: request.tripStartDate,
      });
      if (!capture.captured || !shouldRestampWorkload(request, capture)) continue;

      const now = new Date().toISOString();
      let write = getSupabaseAdmin()
        .from("outstation_expense_requests")
        .update(
          capturedWorkloadColumns(capture, now, {
            amWorkload: request.amWorkload,
            matchedAt: request.workloadMatchedAt,
            pharmacyWorkload: request.pharmacyWorkload,
            pmWorkload: request.pmWorkload,
          }),
        )
        .eq("id", request.id)
        .in("status", [...OUTSTATION_UNDECIDED_STATUSES])
        .eq("workload_gate_status", "complete")
        .eq("workload_source", "ireports360")
        .eq("am_workload", request.amWorkload)
        .eq("pm_workload", request.pmWorkload);
      write =
        request.pharmacyWorkload === null || request.pharmacyWorkload === undefined
          ? write.is("pharmacy_workload", null)
          : write.eq("pharmacy_workload", request.pharmacyWorkload);
      const { data: written, error: writeError } = await write.select("id").maybeSingle();
      if (writeError) throw new Error(writeError.message);
      // Decided, re-typed or re-stamped between the read and this write: the row is not ours to change.
      if (!written) continue;

      restamped += 1;
      await writeRequiredAuditLog({
        actorLoginId: "system",
        entityId: String(request.id),
        entityType: "outstation_request",
        newValues: {
          amWorkload: capture.amWorkload,
          pharmacyWorkload: capture.pharmacyWorkload,
          pmWorkload: capture.pmWorkload,
          source: "workload_restamp",
        },
        oldValues: {
          amWorkload: request.amWorkload,
          pharmacyWorkload: request.pharmacyWorkload,
          pmWorkload: request.pmWorkload,
          workloadMatchedAt: request.workloadMatchedAt,
        },
        summary: `Outstation request ${request.id} workload refreshed from the CRM after more visits were saved: AM ${request.amWorkload ?? 0} · PM ${request.pmWorkload ?? 0} → AM ${capture.amWorkload} · PM ${capture.pmWorkload} · Pharmacies ${capture.pharmacyWorkload}.`,
      });
    } catch (restampError) {
      errors += 1;
      logError("Outstation workload refresh failed for one request", {
        error: restampError,
        labels: { event: "outstation_workload_restamp_failed", requestId: String(request.id) },
      });
    }
  }

  return { checked: candidates.length, errors, restamped };
}

/** One of the caller's own requests still owing its departure photo. */
export type OutstationDeparturePhotoDue = {
  destination: string;
  id: number;
  tripEndDate: string;
  tripStartDate: string;
};

/**
 * The caller's own requests waiting on a departure photo — what the portal card offers to
 * capture. Scoped to the caller by HR ID, never by a client-supplied id.
 *
 * Membership is decided by resolveOutstationGateState — the SAME resolver the payroll gate uses —
 * rather than by matching evidence_gate_status to a string. Two reasons, both learned the hard
 * way:
 *   - the resolver deliberately does not trust that column (a row can claim a state its photos
 *     contradict), so a status-equality query would disagree with the thing that actually
 *     withholds the money;
 *   - a status-equality query silently returns nothing when a row carries an unexpected value.
 *     An earlier version selected `= 'pending_departure_photo'` while nothing set that on insert,
 *     which would have held every new request out of payroll while never showing its owner the
 *     card to fix it.
 * A pre-rule ('grandfathered') request resolves to no blocker, so it can never be dragged back
 * and asked to photograph a trip that finished weeks ago.
 */
export async function getOwnOutstationRequestsAwaitingDeparturePhoto(
  access: AccessContext,
): Promise<OutstationDeparturePhotoDue[]> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("*")
    .neq("evidence_gate_status", "grandfathered")
    .order("created_at", { ascending: false });

  // Best-effort: the portal must still render its other cards if this read fails, and before the
  // gate migration has applied the column does not exist at all.
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((row) => normalizeHrIdForAccess(row.employeeHrId) === callerHrId)
    .filter(
      (row) =>
        resolveOutstationGateState({
          employeeRole: row.employeeRole,
          evidenceGateStatus: row.evidenceGateStatus,
          hasArrivalPhoto: Boolean(row.carEvidenceImagePath),
          hasDeparturePhoto: Boolean(row.departureEvidenceImagePath),
          workloadGateStatus: row.workloadGateStatus,
        }).blocker === "departure_photo",
    )
    .map((row) => ({
      destination: text(row.toLabel) || text(row.toCity) || text(row.toArea) || "—",
      id: row.id,
      tripEndDate: row.tripEndDate,
      tripStartDate: row.tripStartDate,
    }));
}

/** One of the caller's undecided train or bus claims that arrived with no ticket (missing-ticket.ts). */
export type OutstationMissingTicketDue = OutstationDeparturePhotoDue & {
  transportationType: string;
};

/** Everything the caller himself must still do on his own claims — what Submit Expense opens with. */
export type OwnOutstationPendingActions = {
  departurePhotoDue: OutstationDeparturePhotoDue[];
  missingTicket: OutstationMissingTicketDue[];
};

/**
 * The caller's own undecided train or bus claims that arrived with NO ticket — what the missing-ticket
 * card offers to fix (owner, 2026-10-22: "fix the offline ticket gap in outstation"). Decided by
 * canAttachMissingOutstationTicket, the same rule the attach route enforces, so the card is offered
 * exactly where the write would be accepted. Read narrow with hrIdLookupKeys and filtered by the
 * comparison key, like listOwnOutstationSubmissions. Best effort: the page renders without it.
 */
export async function getOwnOutstationRequestsMissingTicket(
  access: AccessContext,
): Promise<OutstationMissingTicketDue[]> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("*")
    .in("employee_hr_id", hrIdLookupKeys(access.hrId))
    .in("status", [...OUTSTATION_UNDECIDED_STATUSES])
    .in("transportation_type", ["train", "bus"])
    .order("created_at", { ascending: false });
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((row) => normalizeHrIdForAccess(row.employeeHrId) === callerHrId)
    .filter((row) =>
      canAttachMissingOutstationTicket({
        status: row.status,
        ticketAttachmentCount: row.ticketAttachmentPaths.length,
        transportationType: row.transportationType,
      }),
    )
    .map((row) => ({
      destination: text(row.toLabel) || text(row.toCity) || text(row.toArea) || "—",
      id: row.id,
      transportationType: row.transportationType,
      tripEndDate: row.tripEndDate,
      tripStartDate: row.tripStartDate,
    }));
}

/**
 * Everything the caller must still do on his own claims, for the top of Submit Expense and the
 * Expense Dashboard (owner, 2026-10-22: Osama took his arrival photo on Submit Expense and never
 * learned a departure photo was owed — its card lived only on the dashboard and inside a collapsed
 * row of Expense Submissions). Two readers, each the module's own rule; neither failing hides the other.
 */
export async function getOwnOutstationPendingActions(
  access: AccessContext,
): Promise<OwnOutstationPendingActions> {
  const [departurePhotoDue, missingTicket] = await Promise.all([
    getOwnOutstationRequestsAwaitingDeparturePhoto(access).catch(() => []),
    getOwnOutstationRequestsMissingTicket(access).catch(() => []),
  ]);
  return { departurePhotoDue, missingTicket };
}

// ── The submitter's own view of his submissions ───────────────────────────────
// Owner request 2026-08-08: the person who submitted a trip must be able to open it and see the
// whole thing — where the money is, what HR decided and why, and both evidence photos — without
// going near the admin approvals workspace, which carries authority he must never hold over his
// own claim.
//
// Deliberately a READ. Nothing here can approve, adjust or decide; the only write the portal
// offers on a submission is the departure photo, which already has its own guarded route.

/**
 * The employee-facing part of a request's notes.
 *
 * `appendCarEvidenceNote` writes an audit line into the same column the employee's own note lives
 * in — "Car live evidence: source=live_camera hr_id=B-12 gps=31.11,30.93 draft_id=10ba37cf…".
 * That belongs to the approver, not to the person who took the photo: it is raw codes, an internal
 * draft id and a duplicate of information already shown properly elsewhere on the page. Stripped
 * here rather than in the component so no future consumer re-leaks it.
 */
function employeeVisibleNotes(notes: string | null): string | null {
  if (!notes) return null;
  const cleaned = notes
    .split("\n")
    .filter((line) => !/^\s*(car live evidence|arrival photo evidence)\s*:/i.test(line))
    .join("\n")
    .trim();
  return cleaned || null;
}

/** What HR decided about one submission, read from the payroll expense row it produced. */
export type MyOutstationSubmissionDecision = {
  approvedAmount: number | null;
  approvedAt: string | null;
  hrApproved: boolean | null;
  /** HR's note to the employee. Owner decision 2026-08-08: he sees this, not just the number. */
  hrComment: string | null;
  hrNotes: string | null;
  hrStatus: string | null;
  /** Set once the expense has actually been pulled into a payroll batch. */
  paidAt: string | null;
  payoutMonth: number | null;
  payoutYear: number | null;
};

/** One of the caller's own submissions, with everything the portal detail view renders. */
export type MyOutstationSubmission = {
  allowanceAmount: number;
  amWorkload: number;
  /** True while the employee can still fix this himself from the portal. */
  canCaptureDeparturePhoto: boolean;
  /**
   * True when a departure photo EXISTS and the trip window is still open, so he may replace a
   * blurred or mis-aimed one. Bounded by the same deadline as the first capture (owner decision
   * 2026-08-08) — that is what keeps every version something taken while he was still on the trip.
   */
  canRetakeDeparturePhoto: boolean;
  /** How many times the departure photo has been replaced. 0 on a first capture. */
  departureRetakeCount: number;
  /**
   * True while he may add a STOP (owner rule, 2026-10-18 — chained-journey.ts): his own car trip,
   * arrival photo taken, nobody has decided it, the trip window still open, under the stop cap. The
   * server re-checks every one of these and payroll as well; this only decides whether to offer it.
   */
  canAddJourneyStop: boolean;
  /**
   * True while he may attach the ticket this train or bus claim arrived WITHOUT (owner,
   * 2026-10-22 — missing-ticket.ts): undecided, and no ticket on it at all. Evidence only; the
   * server re-checks every condition.
   */
  canAttachMissingTicket: boolean;
  /** How the journey is priced once it has a stop; null for a trip with no stop. */
  journey: {
    /** True when the approver has something to look at — the WORDING is the approver's only. */
    flagged: boolean;
    fuelAmount: number;
    legs: Array<{ distanceKm: number | null; from: string; paid: boolean; to: string }>;
    mode: "chained" | "single_destination";
    modeReason: string;
    singleDestinationFuelAmount: number;
  } | null;
  journeyStops: Array<{
    capturedAt: string;
    governorate: string | null;
    locationLabel: string | null;
    stopNumber: number;
  }>;
  /**
   * Where the arrival GPS point actually falls in Phoenix geography, split into its three
   * levels rather than left as one address string. Derived at read time from the stored
   * coordinates, so it always reflects TODAY's brick tree — the owner's standing rule.
   */
  capturedArea: string;
  capturedBrick: string;
  /** Nearest-centroid match quality, e.g. "High · 0.4 km". Null when nothing matched. */
  capturedConfidence: string | null;
  capturedRegion: string;
  claimedTotalAmount: number;
  decision: MyOutstationSubmissionDecision | null;
  departureCapturedAt: string | null;
  departureDistanceFromArrivalKm: number | null;
  departureFlags: string[];
  departureLocationLabel: string | null;
  departureMinutesAfterArrival: number | null;
  destination: string;
  distanceKm: number | null;
  /** Cairo calendar day after which the departure photo needs a Super Admin to release it. */
  departureDeadline: string;
  expectedTotalAmount: number;
  fuelAmount: number;
  /** The single next thing this submission is waiting for, or null when nothing. */
  gateBlocker: OutstationGateBlocker | null;
  gateMessage: string;
  hasArrivalPhoto: boolean;
  hasDeparturePhoto: boolean;
  id: number;
  isPayrollEligible: boolean;
  meetingAmount: number;
  notes: string | null;
  origin: string;
  otherAmount: number;
  overnightDays: number;
  /** The third workload figure; null = not counted separately (see OutstationExpenseRequest). */
  pharmacyWorkload: number | null;
  pmWorkload: number;
  sameDayTrip: boolean;
  status: string;
  submittedAt: string | null;
  ticketAmount: number;
  ticketAttachmentCount: number;
  transportationType: string;
  travelCost: number;
  tripEndDate: string;
  tripStartDate: string;
  tripType: string | null;
  workloadSource: string | null;
};

/**
 * Maps one raw request row (plus its resolved captured location and payroll decision) into the
 * detail-view shape shared by the caller's own submissions list and the manager's read-only
 * review of a single report's submission — one mapping, so the two views can never drift apart
 * on what a "stage" or a "gate blocker" means.
 */
function buildMyOutstationSubmission(
  request: OutstationExpenseRequest,
  capturedLocation: Awaited<ReturnType<typeof resolveOutstationCapturedLocation>>,
  decision: MyOutstationSubmissionDecision | null,
): MyOutstationSubmission {
  const gate = resolveOutstationGateState({
    employeeRole: request.employeeRole,
    evidenceGateStatus: request.evidenceGateStatus,
    hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
    hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
    workloadGateStatus: request.workloadGateStatus,
  });

  const journeyStops = request.journeyStops ?? [];
  const journeyPricing = journeyStops.length > 0 ? request.journeyPricing ?? null : null;

  return {
    allowanceAmount: request.allowanceAmount,
    amWorkload: request.amWorkload ?? 0,
    canAddJourneyStop:
      request.expenseType === "traveling" &&
      request.transportationType === "car" &&
      (JOURNEY_STOP_OPEN_STATUSES as readonly string[]).includes(request.status) &&
      Boolean(request.carEvidenceImagePath) &&
      journeyStops.length < MAX_JOURNEY_STOPS &&
      isWithinDepartureWindow({ capturedAt: new Date().toISOString(), tripEndDate: request.tripEndDate }),
    canAttachMissingTicket: canAttachMissingOutstationTicket({
      status: request.status,
      ticketAttachmentCount: request.ticketAttachmentPaths.length,
      transportationType: request.transportationType,
    }),
    canCaptureDeparturePhoto: gate.blocker === "departure_photo",
    canRetakeDeparturePhoto:
      Boolean(request.departureEvidenceImagePath) &&
      isWithinDepartureWindow({
        capturedAt: new Date().toISOString(),
        tripEndDate: request.tripEndDate,
      }),
    capturedArea: capturedLocation.areaLabel,
    capturedBrick: capturedLocation.brickLabel,
    capturedConfidence: capturedLocation.confidence,
    capturedRegion: capturedLocation.regionLabel,
    claimedTotalAmount: request.claimedTotalAmount,
    decision,
    departureCapturedAt: request.departureCapturedAt,
    departureDeadline: request.tripEndDate,
    departureDistanceFromArrivalKm: request.departureEvidenceMetadata?.distanceFromArrivalKm ?? null,
    departureFlags: request.departureEvidenceMetadata?.flags ?? [],
    departureLocationLabel: request.departureEvidenceMetadata?.capturedLocationLabel ?? null,
    departureMinutesAfterArrival: request.departureEvidenceMetadata?.minutesAfterArrival ?? null,
    departureRetakeCount: Math.max(0, (request.departureEvidenceMetadata?.version ?? 1) - 1),
    destination: text(request.toLabel) || text(request.toCity) || text(request.toArea) || "—",
    distanceKm: request.distanceFromResidenceKm,
    expectedTotalAmount: request.expectedTotalAmount,
    fuelAmount: request.fuelAmount,
    gateBlocker: gate.blocker,
    gateMessage: gate.message,
    hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
    hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
    id: request.id,
    isPayrollEligible: gate.isPayrollEligible,
    journey: journeyPricing
      ? {
          flagged: journeyPricing.flags.length > 0,
          fuelAmount: journeyPricing.fuelAmount,
          legs: journeyPricing.legs.map((leg) => ({
            distanceKm: leg.distanceKm,
            from: leg.from,
            paid: leg.paid,
            to: leg.to,
          })),
          mode: journeyPricing.mode,
          modeReason: journeyPricing.modeReason,
          singleDestinationFuelAmount: journeyPricing.singleDestinationFuelAmount,
        }
      : null,
    journeyStops: journeyStops.map((stop) => ({
      capturedAt: stop.capturedAt,
      governorate: stop.governorate,
      locationLabel: stop.locationLabel,
      stopNumber: stop.stopNumber,
    })),
    meetingAmount: outstationReportOverride(request.reportMeetingAmount, request.meetingAmount),
    notes: employeeVisibleNotes(request.notes),
    origin:
      [request.residenceArea, request.residenceCity].filter(Boolean).join(", ") ||
      text(request.residenceAddress) ||
      "—",
    otherAmount: outstationReportOverride(request.reportOtherAmount, request.otherAmount),
    overnightDays: request.overnightDays,
    pharmacyWorkload: request.pharmacyWorkload ?? null,
    pmWorkload: request.pmWorkload ?? 0,
    sameDayTrip: request.sameDayTrip,
    status: request.status,
    submittedAt: request.submittedAt,
    ticketAmount: request.ticketAmount ?? 0,
    ticketAttachmentCount: request.attachmentCount,
    transportationType: request.transportationType,
    travelCost: request.reportTravelCost ?? request.fuelAmount,
    tripEndDate: request.tripEndDate,
    tripStartDate: request.tripStartDate,
    tripType: request.reportTripType,
    workloadSource: request.workloadSource,
  };
}

/**
 * Every submission belonging to the caller, newest first.
 *
 * Scoped by the caller's own HR ID and never by a client-supplied one — the id in the URL of the
 * detail view decides what is SHOWN, never whose data is read.
 *
 * The gate state is resolved through resolveOutstationGateState rather than read off the status
 * column, for the same reason the departure-photo card does it: the column can disagree with the
 * row's own evidence, and the resolver is what actually withholds the money. An employee asking
 * "why has this not been paid" must get the answer the payroll gate would give, not a second
 * opinion.
 *
 * No signed URLs here. Minting them for every photo of every trip would cost one storage call per
 * image on a page that lists dozens; the detail reader below does it for one submission at a time.
 */
export async function listOwnOutstationSubmissions(
  access: AccessContext,
): Promise<MyOutstationSubmission[]> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return [];

  // Narrowed with hrIdLookupKeys, never with normalizeHrIdForAccess: that helper strips every
  // non-alphanumeric character ("B-12" -> "b12"), so using its output as a WHERE value matches
  // nothing at all — the column stores "B-12". It is a comparison key, not a query key. The JS
  // filter below is the real boundary; this `in` is only there to keep the read narrow.
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("*")
    .in("employee_hr_id", hrIdLookupKeys(access.hrId))
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const requests = ((data ?? []) as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((row) => normalizeHrIdForAccess(row.employeeHrId) === callerHrId);

  const decisions = await getOwnOutstationSubmissionDecisions(requests.map((row) => row.id));

  // Resolved per row rather than once, but safe to do for a whole list: the brick centroid index
  // is cached in-process and the match is pure arithmetic, so this costs no network call at all —
  // unlike the reverse-geocode that produced the stored address string, which is billed per row.
  const capturedLocations = await Promise.all(
    requests.map((request) =>
      resolveOutstationCapturedLocation({
        latitude: request.capturedLatitude,
        longitude: request.capturedLongitude,
      }),
    ),
  );

  return requests.map((request, index) =>
    buildMyOutstationSubmission(request, capturedLocations[index], decisions.get(request.id) ?? null),
  );
}

export type ManagerOutstationSubmissionView = MyOutstationSubmission & {
  employeeHrId: string;
  employeeName: string;
};

/**
 * One direct/indirect report's outstation submission, read-only, for the manager the submit
 * notification addressed — never a browse-anyone-by-id lookup. Authorization is re-checked here
 * against the caller's live expense scope (resolveExpenseAccessFilter's SELF/TEAM/HIERARCHY/
 * LINE/COMPANY rule via canViewEmployeeExpenseScope), the same primitive the admin queue and
 * team-expenses already trust — a request id lifted from a notification link must never turn
 * into a view of someone outside the caller's own reporting line. Returns null on "not found" AND
 * on "not yours to see" alike, so the page can render one honest empty state without leaking
 * which case it was.
 */
export async function getOutstationSubmissionForManager(
  access: AccessContext,
  requestId: number,
): Promise<ManagerOutstationSubmissionView | null> {
  const request = await getOutstationRequestById(requestId);
  if (!request) return null;
  if (!(await canViewEmployeeExpenseScope(access, request.employeeHrId))) return null;

  const decisions = await getOwnOutstationSubmissionDecisions([request.id]);
  const submission = buildMyOutstationSubmission(
    request,
    request.capturedLocation,
    decisions.get(request.id) ?? null,
  );
  return { ...submission, employeeHrId: request.employeeHrId, employeeName: request.employeeName };
}

/**
 * Why a notification link to an outstation request finds nothing, when the answer is "it was
 * deleted". The notifications raised at submit are history and outlive the request, so a link in
 * them can point at a row a Super Admin has since removed — request 136 on 2026-09-12, deleted and
 * resubmitted as 139 the same afternoon. The page then said "not available, or outside what you can
 * view", which reads as a permissions fault to the employee who filed it.
 *
 * Read from the audit row deleteOutstationRequest writes. Scoped exactly like the live request: the
 * notice is returned only to a viewer who could have seen that employee's request, so the page
 * never confirms to anyone else that a request with this id existed.
 */
export async function getDeletedOutstationRequestNotice(
  access: AccessContext,
  requestId: number,
): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("audit_logs")
    .select("old_values,created_at")
    .eq("entity_type", "outstation_request")
    .eq("entity_id", String(requestId))
    .like("summary", "Admin deleted outstation request%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { created_at?: string | null; old_values?: Record<string, unknown> | null };
  const employeeHrId = text(row.old_values?.employeeHrId);
  if (!employeeHrId || !(await canViewEmployeeExpenseScope(access, employeeHrId))) return null;
  return `This outstation request was deleted by a Super Admin on ${formatPhoenixDateTime(row.created_at ?? null)}, so there is nothing left to open here. If it was submitted again, the new request is in Expense Submissions.`;
}

/**
 * HR's decision for each of the given request ids, keyed by request id.
 *
 * Best-effort by design: a submission that has not reached payroll yet simply has no row here, and
 * that is the normal early state rather than an error. Returning an empty map on failure keeps the
 * list rendering with the money columns blank instead of failing the whole page.
 */
async function getOwnOutstationSubmissionDecisions(
  requestIds: number[],
): Promise<Map<number, MyOutstationSubmissionDecision>> {
  const result = new Map<number, MyOutstationSubmissionDecision>();
  if (requestIds.length === 0) return result;

  const tripIds = requestIds.map((id) => outstationPayrollTripId(id));
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expenses")
    .select(
      "trip_id,approved_amount,approved_at,hr_approved,hr_comment,hr_notes,hr_status,imported_to_payroll_at,payout_month,payout_year",
    )
    .in("trip_id", tripIds);

  if (error || !data) return result;

  for (const row of data as Array<Record<string, unknown>>) {
    const tripId = text(row.trip_id);
    const requestId = Number(tripId.replace(/^OUTSTATION-/i, ""));
    if (!Number.isFinite(requestId)) continue;

    result.set(requestId, {
      approvedAmount: row.approved_amount === null || row.approved_amount === undefined
        ? null
        : Number(row.approved_amount),
      approvedAt: text(row.approved_at) || null,
      hrApproved: typeof row.hr_approved === "boolean" ? row.hr_approved : null,
      hrComment: text(row.hr_comment) || null,
      hrNotes: text(row.hr_notes) || null,
      hrStatus: text(row.hr_status) || null,
      paidAt: text(row.imported_to_payroll_at) || null,
      payoutMonth: row.payout_month === null || row.payout_month === undefined ? null : Number(row.payout_month),
      payoutYear: row.payout_year === null || row.payout_year === undefined ? null : Number(row.payout_year),
    });
  }

  return result;
}

/**
 * Signed URLs for one submission's two evidence photos — the caller's own submission only.
 *
 * Split from the list so a page showing dozens of trips does not mint dozens of storage URLs it
 * will never display. Ownership is re-checked here rather than trusted from the caller, because
 * this is the point where a request id from the URL turns into a link to a private image.
 */
export async function getOwnOutstationSubmissionPhotos(
  access: AccessContext,
  requestId: number,
): Promise<{ arrivalUrl: string | null; departureUrl: string | null }> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  const request = await getOutstationRequestById(requestId);
  if (!request) throw new Error("That outstation request is not available.");
  if (!callerHrId || callerHrId !== normalizeHrIdForAccess(request.employeeHrId)) {
    throw forbiddenError("You can only open your own expense submissions.");
  }

  const [arrivalUrl, departureUrl] = await createOutstationEvidenceSignedUrls([
    request.carEvidenceImagePath ?? "",
    request.departureEvidenceImagePath ?? "",
  ]);

  return { arrivalUrl: arrivalUrl ?? null, departureUrl: departureUrl ?? null };
}

// ── Held-request repair (Phase 5) ─────────────────────────────────────────────
// A request held by the evidence gate is invisible without this: the employee sees only that
// his money has not arrived, and nobody is told the CRM grab failed. These three functions are
// the Super Admin's view of, and way out of, that state.

/** One request held by the gate, with everything needed to decide what to do about it. */
export type HeldOutstationRequest = {
  blocker: string;
  destination: string;
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  id: number;
  lastAttemptAt: string | null;
  lastAttemptError: string | null;
  message: string;
  /**
   * Whether asking this employee again could still achieve anything today.
   *
   * Computed by the SAME pure rule the sender uses, so the button on screen and the endpoint
   * behind it cannot disagree — a button offered on a row the server will refuse is worse than no
   * button, because the admin reads the 409 as a fault. In practice this is true only on the
   * trip's last day: after that the photo can no longer be taken where it had to be taken, and
   * the row wants the release instead.
   */
  reminderResendable: boolean;
  tripEndDate: string;
  tripStartDate: string;
  workloadCaptureAttempts: number;
};

/**
 * Every request currently held out of payroll by the evidence/workload gate.
 *
 * Read access deliberately, so the execution-only finance roles can SEE what is stuck without
 * being able to change it. The two repair actions below require approve (Super Admin).
 *
 * Grandfathered requests can never appear here — resolveOutstationGateState clears them — so
 * this queue is only ever the genuinely-stuck, never the historical.
 */
export async function listHeldOutstationRequests(
  access: AccessContext,
): Promise<HeldOutstationRequest[]> {
  await assertOutstationAdminAccess(access, "read");

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !data) return [];

  // One reading of "today", not one per row: a list computed either side of Cairo midnight would
  // otherwise drop or keep a trip depending on where in the loop it happened to fall.
  const today = cairoTodayIso();

  return (data as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .map((request) => ({
      request,
      gate: resolveOutstationGateState({
        employeeRole: request.employeeRole,
        evidenceGateStatus: request.evidenceGateStatus,
        hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
        hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
        workloadGateStatus: request.workloadGateStatus,
      }),
    }))
    .filter(({ gate, request }) =>
      isOutstationRequestHeldForRepair({
        cairoTodayIso: today,
        gate,
        status: request.status,
        tripEndDate: request.tripEndDate,
      }),
    )
    .map(({ gate, request }) => ({
      blocker: gate.blocker ?? "unknown",
      destination: text(request.toLabel) || text(request.toCity) || text(request.toArea) || "—",
      employeeHrId: request.employeeHrId,
      employeeName: request.employeeName,
      employeeRole: request.employeeRole,
      id: request.id,
      lastAttemptAt: request.workloadLastAttemptAt,
      lastAttemptError: request.workloadLastAttemptError,
      message: gate.message,
      reminderResendable: outstationDeparturePhotoReminderDue({
        gateBlocker: gate.blocker,
        todayCairo: today,
        tripEndDate: request.tripEndDate,
      }).due,
      tripEndDate: request.tripEndDate,
      tripStartDate: request.tripStartDate,
      workloadCaptureAttempts: request.workloadCaptureAttempts,
    }));
}

/**
 * Re-run the CRM workload grab for a held request — the "refresh" the owner asked for, and the
 * thing to try before typing numbers in by hand. Releases the request into payroll if it works.
 */
export async function retryOutstationWorkloadCapture(
  requestId: number,
  access: AccessContext,
): Promise<{ message: string; released: boolean }> {
  await assertOutstationAdminAccess(access, "approve");

  const request = await getOutstationRequestById(requestId);
  if (!request) throw new Error("That outstation request is not available.");
  if (request.workloadGateStatus !== "pending_workload") {
    throw new Error("This request is not waiting on its workload.");
  }

  const release = await captureWorkloadAndReleaseIfReady(request, access);

  // Re-read rather than infer: captureWorkloadAndReleaseIfReady is best-effort and swallows its
  // own failures, so the only honest answer about what happened is the row itself.
  const after = await getOutstationRequestById(requestId);
  const workloadCaptured = Boolean(after && after.workloadGateStatus !== "pending_workload");

  // `released` is read from the PAYROLL ROW, not from the workload gate. Those are two different
  // questions and this used to answer the wrong one: capturing the workload only clears the last
  // gate, and the push into payroll that follows is a separate, best-effort step that can fail on
  // its own. Reporting "released into payroll" because a gate moved told the caller money had
  // been queued when nothing had — and it did exactly that for all nine requests repaired on
  // 2026-08-08, which is how this was found.
  const linked = after ? await getLinkedOutstationPayrollExpense(after.id) : null;
  const released = Boolean(linked);

  if (released) {
    return {
      message: "Workload captured from the CRM and the request was released into payroll.",
      released,
    };
  }

  // Captured but NOT released is its own outcome, and naming it is the point: it means the gate
  // is satisfied and something downstream did not happen, which needs a different action from
  // "the CRM has no workload".
  //
  // The release's OWN reason is preferred over re-deriving the gate, because the gate is only one
  // of the three ways a release declines. Re-deriving it told a Super Admin "the request did not
  // reach payroll. Retry, or check the expense record" for requests 78, 79 and 80 on 2026-08-19,
  // when the true and actionable answer was already in hand: the request is still `submitted`, so
  // it is waiting for HIS approval, not for evidence. Retrying that forever changes nothing.
  if (workloadCaptured) {
    if (release && !release.released) {
      return { message: `Workload captured, but the request did not reach payroll: ${release.reason}`, released };
    }
    const gate = after
      ? resolveOutstationGateState({
          employeeRole: after.employeeRole,
          evidenceGateStatus: after.evidenceGateStatus,
          hasArrivalPhoto: Boolean(after.carEvidenceImagePath),
          hasDeparturePhoto: Boolean(after.departureEvidenceImagePath),
          workloadGateStatus: after.workloadGateStatus,
        })
      : null;
    return {
      message: gate && !gate.isPayrollEligible
        ? `Workload captured, but the request is still held: ${gate.message}`
        : "Workload captured, but the request did not reach payroll. Retry, or check the expense record.",
      released,
    };
  }

  return {
    message:
      after?.workloadLastAttemptError ||
      "The CRM still has no workload for these dates. Enter it by hand if the trip is genuine.",
    released,
  };
}

/**
 * Last resort: a Super Admin types the AM/PM workload in.
 *
 * Stored as `manual`/`override`, never as if it came from the CRM. That distinction is the whole
 * point — an approver looking at this request later must be able to tell a measured number from
 * a typed one, and the payroll figure is derived from it either way.
 *
 * A reason is REQUIRED. This is a hand-entered number that releases money; an unexplained one is
 * indistinguishable from a mistake six months later.
 */
export async function setOutstationWorkloadManually(
  requestId: number,
  access: AccessContext,
  input: { amWorkload: number; pmWorkload: number; reason: string },
): Promise<{ message: string; released: boolean }> {
  await assertOutstationAdminAccess(access, "approve");

  // Validated through the pure checker so the rules are assertable without a database — and so
  // a bad value is REFUSED rather than coerced. The previous inline version clamped-and-truncated
  // instead, which silently turned a negative into a measured-looking zero, and let NaN slip past
  // its own finiteness check. See validateManualWorkloadInput for the full reasoning.
  const validated = validateManualWorkloadInput(input);
  if (!validated.ok) throw new Error(validated.message);
  const { amWorkload, pmWorkload, reason } = validated;

  const request = await getOutstationRequestById(requestId);
  if (!request) throw new Error("That outstation request is not available.");

  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({
      am_workload: amWorkload,
      // A hand-typed workload is AM and PM only, so no measured pharmacy figure may sit beside it
      // (the submit-time read wrote one): NULL reads "not counted separately", never a mix.
      pharmacy_workload: null,
      pm_workload: pmWorkload,
      updated_at: now,
      workload_gate_status: "manual",
      workload_match_status: "manual_override",
      workload_matched_at: now,
      workload_override_reason: reason,
      workload_source: "override",
    })
    .eq("id", requestId);
  if (error) throw new Error(error.message);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(requestId),
    entityType: "outstation_request",
    newValues: { amWorkload, pmWorkload, reason, workloadSource: "override" },
    oldValues: {
      amWorkload: request.amWorkload,
      pharmacyWorkload: request.pharmacyWorkload,
      pmWorkload: request.pmWorkload,
      workloadSource: request.workloadSource,
    },
    summary: `Outstation request ${requestId} workload entered by hand (AM ${amWorkload} / PM ${pmWorkload}): ${reason}`,
  });

  const release = await releaseOutstationRequestToPayrollIfReady(requestId, access);
  return {
    message: release.released
      ? "Workload saved and the request was released into payroll."
      : `Workload saved. The request is still held: ${release.reason}`,
    released: release.released,
  };
}

/**
 * Release a request whose EVIDENCE can never arrive.
 *
 * The gate assumes a missing photo is a photo not taken yet. Sometimes it is a photo that cannot
 * exist: the trip was typed in by an administrator, or the employee's window closed weeks ago and
 * the destination is 400 km behind him. Until this existed there was no way out of that state at
 * all — the repair panel says so in as many words — and clearing the nine requests stuck on
 * 2026-08-08 meant writing SQL against the production database by hand. That is not a repair
 * procedure, it is an incident.
 *
 * Three deliberate constraints:
 *   - A REASON is mandatory, exactly as it is for a hand-entered workload. This waives the control
 *     that stands between a claim and real money; an unexplained waiver is indistinguishable from
 *     a mistake six months later.
 *   - It refuses a WORKLOAD block. That one is repairable properly (retry the grab, or type the
 *     numbers in), and offering a waiver as an easier alternative would make the honest path the
 *     inconvenient one.
 *   - It records 'grandfathered' — the same state a pre-rule request carries — because that is
 *     the truth: the request is exempt from the gate, not compliant with it. Note this also clears
 *     the workload gate, since an exempt request is exempt from both; the caller is told so.
 */
export async function releaseOutstationRequestWithoutEvidence(
  requestId: number,
  access: AccessContext,
  input: { reason: unknown },
): Promise<{ message: string; released: boolean }> {
  await assertOutstationAdminAccess(access, "approve");

  const reason = text(input.reason).trim();
  if (!reason) {
    throw new Error("A reason is required to release a request without its evidence.");
  }

  const request = await getOutstationRequestById(requestId);
  if (!request) throw new Error("That outstation request is not available.");

  const gate = resolveOutstationGateState({
    employeeRole: request.employeeRole,
    evidenceGateStatus: request.evidenceGateStatus,
    hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
    hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
    workloadGateStatus: request.workloadGateStatus,
  });

  if (gate.blocker === null) {
    throw new Error("This request is not held by the evidence gate — nothing to release.");
  }
  if (gate.blocker === "workload") {
    throw new Error(
      "This request is waiting on its workload, not its evidence. Retry the CRM grab or enter the workload by hand.",
    );
  }

  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({ evidence_gate_status: "grandfathered", updated_at: now })
    .eq("id", requestId);
  if (error) throw new Error(error.message);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(requestId),
    entityType: "outstation_request",
    newValues: { evidenceGateStatus: "grandfathered", reason, waivedBlocker: gate.blocker },
    oldValues: { evidenceGateStatus: request.evidenceGateStatus },
    summary: `Outstation request ${requestId} released without its evidence (was: ${gate.blocker}): ${reason}`,
  });

  const release = await releaseOutstationRequestToPayrollIfReady(requestId, access);
  return {
    message: release.released
      ? "Evidence waived and the request was released into payroll. Both gates are now marked exempt."
      : `Evidence waived, but the request did not reach payroll: ${release.reason}`,
    released: release.released,
  };
}

/**
 * Ask an employee again for the departure photo his expense is stuck behind.
 *
 * This exists because a reminder that failed is indistinguishable, afterwards, from one that was
 * never owed. Delivery dedupe claims the automatic key the instant the first attempt is made; if
 * that attempt then dies — at the identity guard, at the provider, anywhere — the key stays
 * claimed and the employee is never told, on any channel, ever again. Eight reminders were lost
 * exactly that way before 2026-08-19, and nothing in the system could re-ask. Re-running the
 * daily job would not have helped: it raises the same key and is deduplicated into silence.
 *
 * So this deliberately mints a NEW key, dated, which has two consequences worth stating plainly:
 * pressing the button twice on the same day sends once, and pressing it again tomorrow genuinely
 * sends again. That is the intended shape — one nudge per day is a nudge; more is nagging.
 *
 * It is NOT a way to message an employee freely. It refuses unless the departure photo is the
 * live blocker, so it cannot be pointed at somebody who owes nothing, and it reuses the reminder
 * the system sends itself rather than composing its own text — one wording, one timing rule.
 *
 * Since 2026-08-19 that shared rule fires on the trip's LAST DAY only, so this can only re-ask
 * someone who is still at the destination and can still act. Once the trip is over there is
 * nothing left to ask for and the button refuses — that request is released, not chased.
 */
export async function resendOutstationDeparturePhotoReminder(
  requestId: number,
  access: AccessContext,
): Promise<{ message: string; sent: boolean }> {
  // Same authority as the waiver, not merely "can view". This sends real mail to a real employee
  // in the owner's name, so it sits with approve, above the execution-only finance roles.
  await assertOutstationAdminAccess(access, "approve");

  const request = await getOutstationRequestById(requestId);
  if (!request) throw new Error("That outstation request is not available.");

  const today = cairoTodayIso();
  const sent = await sendOutstationDeparturePhotoReminder(request, today, {
    idempotencyKey: `outstation:${String(requestId)}:departure-photo:resend-${today}`,
  });

  if (!sent) {
    // The shared rule declined. Say WHY in the terms the admin can act on, rather than reporting
    // a bare "not sent" that reads like a fault. Three reasons, and they need three answers.
    const gate = resolveOutstationGateState({
      employeeRole: request.employeeRole,
      evidenceGateStatus: request.evidenceGateStatus,
      hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
      hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
      workloadGateStatus: request.workloadGateStatus,
    });
    if (gate.blocker !== "departure_photo") {
      throw new Error(
        "This request is not waiting on its departure photo, so there is nothing to remind them about.",
      );
    }

    const lastDay = String(request.tripEndDate ?? "").slice(0, 10);
    if (lastDay && lastDay < today) {
      // The common one, and the whole reason the overdue reminder was retired: he is home, the
      // photo can no longer be taken where it had to be taken, and asking again would only get
      // him to capture the wrong place or ignore the mail. Point at the release instead.
      throw new Error(
        `The trip ended on ${lastDay}, so the departure photo can no longer be taken at the destination — ` +
          "there is nothing left to ask them for. Release the request without the photo instead.",
      );
    }
    throw new Error(
      "The trip has not finished yet — the departure photo is not due until the employee leaves.",
    );
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(requestId),
    entityType: "outstation_request",
    newValues: { channel: "email+push", reminderResentOn: today },
    oldValues: {},
    summary: `Departure-photo reminder re-sent by hand for outstation request ${requestId} to ${request.employeeHrId}`,
  });

  return {
    message: `Reminder sent again to ${request.employeeName || request.employeeHrId}. Pressing this again today will not send a second copy.`,
    sent: true,
  };
}
