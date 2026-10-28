import { systemDeployment } from "@/config/system-settings";
import { codeOrWords } from "@/lib/format/code-label";
import { MARKETING_REQUEST_LINK_BASE } from "@/lib/marketing-requests/notification-link";
import type { CellValue, TableColumn } from "@/lib/sales/sales-workbook-kit";

// ─────────────────────────────────────────────────────────────────────────────
// The Marketing Request report column set — every field the system holds about a request.
//
// SCOPE: requests RAISED IN PHOENIX only (`origin = 'phoenix'`). The 217 legacy rows imported
// from the historical ROI sheet are deliberately excluded: they never went through the capture
// flow, so their address, GPS, evidence, approval trail and contact are all empty, and mixing
// them in would make a full-detail report look 99% blank.
//
// LAYOUT. The owner's template is one flat sheet of 16 columns, but a request has repeating
// children (5 products, 4 approval steps, N pharmacies) that cannot fit a single row without
// either truncating them or repeating the request on every child row. So:
//   - Sheet "Requests" keeps HIS 16 COLUMNS FIRST, in his exact order and wording, then appends
//     every remaining scalar field.
//   - Each repeating child gets its own sheet, keyed by Request code.
// Nothing is dropped and nothing is summarised — his rule is "do not minus even one field".
//
// COLUMNS and the matching row builder below are POSITIONAL TWINS with no compile-time link.
// Adding to one without the other silently shifts every later column, so the header would sit
// over the wrong data. `tests/marketing-request-report-columns.test.ts` asserts every pair has
// equal length; keep that test passing rather than trusting care.
// ─────────────────────────────────────────────────────────────────────────────

const UNITS_FMT = "#,##0";
const VALUE_FMT = "#,##0.00";
const PCT_FMT = "0.0%";

// ── Cairo / week helpers ─────────────────────────────────────────────────────
// Written here rather than imported from crm/ or attendance/: those helpers carry their own
// domain's rounding and vendor-timezone rules, and this report only needs plain rendering.

const DATE_CAIRO = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric",
});
const TIME_CAIRO = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", hour12: false, minute: "2-digit", timeZone: "Africa/Cairo",
});
const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC", year: "numeric" });

/** A true instant we recorded (submitted_at, approved_at …) rendered in Cairo, never raw UTC. */
export function cairoDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${DATE_CAIRO.format(date)}, ${TIME_CAIRO.format(date)}`;
}

/** A plain calendar date (request_date, pay_date) — no time-of-day, so no zone conversion. */
export function plainDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return DATE_CAIRO.format(date);
}

function utcDateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The Sunday on or before a date. The owner's week runs Sunday → Thursday (his rule, 2026-08-05). */
export function sundayOnOrBefore(date: Date): Date {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() - shifted.getUTCDay());
  return shifted;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Month / Week Start / Week End / Week, all anchored on REQUEST DATE (his answer, 2026-08-05).
 *
 * Week End is the Thursday of the same week — Sunday + 4 — because the Egyptian working week ends
 * there. The week NUMBER counts from the week containing the 1st of the request's own month, so
 * W1 is always the month's first working week even when its Sunday falls in the previous month:
 * 1 Aug 2026 is a Saturday, so the request dated Sunday 2 Aug lands in W2, not W1. Numbering by
 * the request's month rather than the week-start's month keeps the Month and Week columns
 * consistent for a week that straddles a month boundary.
 */
export function weekBreakdown(requestDate: string | null | undefined): {
  month: string | null;
  weekStart: string | null;
  weekEnd: string | null;
  week: string | null;
} {
  const date = utcDateOf(requestDate);
  if (!date) return { month: null, week: null, weekEnd: null, weekStart: null };

  const weekStart = sundayOnOrBefore(date);
  const weekEnd = new Date(weekStart.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 4);

  const firstOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const firstWeekStart = sundayOnOrBefore(firstOfMonth);
  const weekIndex = Math.round((weekStart.getTime() - firstWeekStart.getTime()) / (7 * 86_400_000)) + 1;

  return {
    month: MONTH_LABEL.format(date),
    week: `W${weekIndex}`,
    weekEnd: plainDate(isoDay(weekEnd)),
    weekStart: plainDate(isoDay(weekStart)),
  };
}

/** Booleans read as words — the owner's rule is human-readable values, never raw codes. */
function yesNo(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? "Yes" : "No";
}

/** snake_case enum → sentence case, e.g. "pending_validation" → "Pending validation". */
export function humanize(value: string | null | undefined): string | null {
  if (!value) return null;
  const spaced = codeOrWords(value).trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whole days between two instants, or null when either end is missing. */
function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round(((end - start) / 86_400_000) * 10) / 10;
}

/**
 * The deep link the owner asked "Request Preview" to hold — opens the request in Phoenix.
 *
 * It points at the shell-neutral Case File, NOT at the decision page. The decision page is the
 * one-tap Telegram/email target and it *requires* a `?decision=approve|reject|return`; a bare
 * `/decision/<code>` fails `parseMarketingRequestDecision` and renders "Invalid Decision Link" for
 * every viewer, Super Admin included. A sheet column has no decision to carry — the reader is
 * opening the row to READ it — so a decision URL was never the right shape here.
 *
 * `/marketing-requests/<code>` resolves per viewer: admin-shell and portal roles both land on the
 * Case File, `?decision=` still redirects to the shell-correct decision page, and a signed-out
 * reader gets "Login Required" instead of a dead end.
 */
export function requestPreviewUrl(requestCode: string): string {
  const base = systemDeployment.productionUrl.replace(/\/+$/, "");
  return `${base}${MARKETING_REQUEST_LINK_BASE}/${encodeURIComponent(requestCode)}`;
}

// ── The shape the loader hands over ──────────────────────────────────────────

export type FullReportProduct = {
  expectedValue: number | null;
  factoryPriceSnapshot: number | null;
  forecastQuantity: number | null;
  lineSnapshot: string | null;
  productCode: string | null;
  productFamily: string | null;
  productName: string | null;
  sourceCompany: string | null;
  valueShare: number | null;
};

export type FullReportApprovalStep = {
  allowReject: boolean | null;
  allowReturn: boolean | null;
  assignedHrId: string | null;
  assignedName: string | null;
  assignedRole: string | null;
  decidedAt: string | null;
  decidedByHrId: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  executedAt: string | null;
  isCc: boolean | null;
  sequence: number | null;
  status: string | null;
  stepCode: string | null;
  stepKind: string | null;
  stepName: string | null;
  terminalStatus: string | null;
};

export type FullReportPharmacy = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  distributorCode: string | null;
  distributorName: string | null;
  distributorPharmacyCode: string | null;
  evidenceStatus: string | null;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  notes: string | null;
  pharmacyCode: string | null;
  pharmacyName: string | null;
  referenceMatchCount: number | null;
  referenceStatus: string | null;
  regionName: string | null;
  trackingStatus: string | null;
  validatedAt: string | null;
  validatedByName: string | null;
  validationNotes: string | null;
  validationStatus: string | null;
};

export type FullReportRequest = {
  // request
  approvedAt: string | null;
  areaName: string | null;
  closedAt: string | null;
  createdAt: string | null;
  createdByName: string | null;
  estimatedCost: number | null;
  executedAt: string | null;
  expectedRoiValue: number | null;
  lineName: string | null;
  notes: string | null;
  origin: string | null;
  otherRequestType: string | null;
  payDate: string | null;
  rejectedAt: string | null;
  requestCode: string;
  requestDate: string | null;
  requesterAreaName: string | null;
  requesterHrId: string | null;
  requesterName: string | null;
  requesterRegionName: string | null;
  requiredRoiValue: number | null;
  returnedAt: string | null;
  returnedStepSequence: number | null;
  roiCoverageRatio: number | null;
  roiDurationMonths: number | null;
  roiStatus: string | null;
  status: string | null;
  submittedAt: string | null;
  trackDirectSales: boolean | null;
  updatedAt: string | null;
  updatedByName: string | null;
  managerHrId: string | null;
  managerName: string | null;
  // request type
  requestTypeCode: string | null;
  requestTypeDescription: string | null;
  requestTypeName: string | null;
  requestTypeRequiresDescription: boolean | null;
  // customer
  customerCapturedAccuracyMeters: number | null;
  customerCapturedAddress: string | null;
  customerCapturedAt: string | null;
  customerCapturedLatitude: number | null;
  customerCapturedLongitude: number | null;
  customerCode: string | null;
  customerCreatedAt: string | null;
  customerCreatedByName: string | null;
  customerEvidenceHasTimestamp: boolean | null;
  customerEvidencePhotoCapturedAt: string | null;
  customerEvidencePhotoName: string | null;
  customerEvidenceStatus: string | null;
  customerExtractedAreaName: string | null;
  customerExtractedGovernorateName: string | null;
  customerManagerName: string | null;
  customerName: string | null;
  customerOtherTypeDescription: string | null;
  customerOwnerName: string | null;
  customerRegionName: string | null;
  customerType: string | null;
  customerValidatedAt: string | null;
  customerValidatedByName: string | null;
  customerValidationNotes: string | null;
  customerValidationStatus: string | null;
  // contact (the "Dr." half of the owner's column H)
  contactCode: string | null;
  contactCrmCode: string | null;
  contactMobileNumber: string | null;
  contactName: string | null;
  contactNotes: string | null;
  contactSpecialty: string | null;
  // finance
  financeInvoiceDeadlineDate: string | null;
  financeInvoiceFileName: string | null;
  financeInvoiceRequired: boolean | null;
  financeInvoiceStatus: string | null;
  financeInvoiceUploadedAt: string | null;
  financeInvoiceUploadedByName: string | null;
  financeNotes: string | null;
  financeReviewedAt: string | null;
  financeReviewerName: string | null;
  financeTransferProofFileName: string | null;
  financeTransferProofUploadedAt: string | null;
  financeTransferProofUploadedByName: string | null;
  // ROI actuals (only exist once sales for the ROI window have landed)
  roiActualCoverageRatio: number | null;
  roiActualSalesUnits: number | null;
  roiActualSalesValue: number | null;
  roiActualStatus: string | null;
  roiAttributionQuality: string | null;
  roiCalculatedAt: string | null;
  roiCoverageGap: number | null;
  roiExactSalesRows: number | null;
  roiExpectedGap: number | null;
  roiFallbackSalesRows: number | null;
  roiPayMonth: string | null;
  roiRecommendedAction: string | null;
  roiSalesRows: number | null;
  // children
  approvalSteps: FullReportApprovalStep[];
  currentStepName: string | null;
  pharmacies: FullReportPharmacy[];
  products: FullReportProduct[];
};

// ── Sheet 1: Requests ────────────────────────────────────────────────────────
// The owner's 16 template columns come FIRST, spelled exactly as his template spells them
// ("Account/Dr.Name", "Contact for money transfer", "Money transfer Date") so the sheet he
// already designed is recognisably his. Everything the system also knows follows after.

export const REQUEST_COLUMNS: TableColumn[] = [
  // — the owner's template, columns A–P —
  { label: "Serial", right: true, width: 8 },
  { label: "Month", width: 16 },
  { label: "Week Start", width: 14 },
  { label: "Week End", width: 14 },
  { label: "Week", width: 8 },
  { label: "Line", width: 14 },
  { label: "Type", width: 20 },
  { label: "Account/Dr.Name", width: 30 },
  { label: "Address", width: 46 },
  { label: "Region", width: 22 },
  { label: "Contact for money transfer", width: 30 },
  { label: "Money transfer Date", width: 16 },
  { label: "Amount", numFmt: VALUE_FMT, right: true, width: 14 },
  { label: "Estimated ROI", numFmt: VALUE_FMT, right: true, width: 16 },
  { label: "Notes", width: 40 },
  { label: "Request Preview", width: 62 },
  // — everything else the system holds —
  { label: "Request code", width: 26 },
  { label: "Status", width: 18 },
  { label: "Origin", width: 14 },
  { label: "Request date", width: 14 },
  { label: "Other request type", width: 24 },
  { label: "Request type code", width: 18 },
  { label: "Request type description", width: 40 },
  { label: "Requires description", width: 16 },
  { label: "Requester", width: 30 },
  { label: "Requester HR_ID", width: 14 },
  { label: "Requester sales region", width: 20 },
  { label: "Requester area", width: 20 },
  { label: "Manager", width: 30 },
  { label: "Manager HR_ID", width: 14 },
  { label: "Request line", width: 14 },
  { label: "Request area", width: 20 },
  { label: "ROI duration (months)", numFmt: UNITS_FMT, right: true, width: 14 },
  { label: "Required ROI", numFmt: VALUE_FMT, right: true, width: 16 },
  { label: "ROI coverage", numFmt: PCT_FMT, right: true, width: 12 },
  { label: "ROI status", width: 18 },
  { label: "Track direct sales", width: 14 },
  { label: "Products", numFmt: UNITS_FMT, right: true, width: 10 },
  { label: "Pharmacies", numFmt: UNITS_FMT, right: true, width: 11 },
  { label: "Approval steps", numFmt: UNITS_FMT, right: true, width: 12 },
  { label: "Current step", width: 26 },
  { label: "Submitted at", width: 22 },
  { label: "Approved at", width: 22 },
  { label: "Days to approve", numFmt: "#,##0.0", right: true, width: 13 },
  { label: "Rejected at", width: 22 },
  { label: "Returned at", width: 22 },
  { label: "Returned at step", numFmt: UNITS_FMT, right: true, width: 12 },
  { label: "Executed at", width: 22 },
  { label: "Closed at", width: 22 },
  { label: "Created at", width: 22 },
  { label: "Created by", width: 30 },
  { label: "Updated at", width: 22 },
  { label: "Updated by", width: 30 },
  // customer
  { label: "Customer code", width: 26 },
  { label: "Customer type", width: 16 },
  { label: "Customer other type", width: 22 },
  { label: "Customer geographic region", width: 28 },
  { label: "Customer area (extracted)", width: 22 },
  { label: "Customer governorate", width: 24 },
  { label: "Customer GPS latitude", right: true, width: 16 },
  { label: "Customer GPS longitude", right: true, width: 16 },
  { label: "Customer GPS accuracy (m)", numFmt: "#,##0.0", right: true, width: 16 },
  { label: "Customer location captured at", width: 22 },
  { label: "Customer evidence photo", width: 44 },
  { label: "Customer evidence photo taken at", width: 22 },
  { label: "Customer evidence has timestamp", width: 16 },
  { label: "Customer evidence status", width: 18 },
  { label: "Customer validation status", width: 20 },
  { label: "Customer validated by", width: 30 },
  { label: "Customer validated at", width: 22 },
  { label: "Customer validation notes", width: 36 },
  { label: "Customer owner", width: 30 },
  { label: "Customer manager", width: 30 },
  { label: "Customer created by", width: 30 },
  { label: "Customer created at", width: 22 },
  // contact
  { label: "Dr. / contact name", width: 30 },
  { label: "Dr. specialty", width: 22 },
  { label: "Dr. mobile", width: 18 },
  { label: "Dr. CRM code", width: 16 },
  { label: "Dr. contact code", width: 22 },
  { label: "Dr. notes", width: 36 },
  // finance
  { label: "Invoice required", width: 14 },
  { label: "Invoice status", width: 18 },
  { label: "Invoice deadline", width: 16 },
  { label: "Invoice file", width: 40 },
  { label: "Invoice uploaded by", width: 30 },
  { label: "Invoice uploaded at", width: 22 },
  { label: "Money transfer proof file", width: 40 },
  { label: "Money transfer proof uploaded by", width: 30 },
  { label: "Money transfer proof uploaded at", width: 22 },
  { label: "Finance reviewer", width: 30 },
  { label: "Finance reviewed at", width: 22 },
  { label: "Finance notes", width: 36 },
  // ROI actuals
  { label: "Actual sales value", numFmt: VALUE_FMT, right: true, width: 18 },
  { label: "Actual sales units", numFmt: UNITS_FMT, right: true, width: 16 },
  { label: "Actual ROI coverage", numFmt: PCT_FMT, right: true, width: 16 },
  { label: "Actual ROI status", width: 20 },
  { label: "Attribution quality", width: 20 },
  { label: "Coverage gap", numFmt: VALUE_FMT, right: true, width: 16 },
  { label: "Expected gap", numFmt: VALUE_FMT, right: true, width: 16 },
  { label: "Sales rows", numFmt: UNITS_FMT, right: true, width: 11 },
  { label: "Exact sales rows", numFmt: UNITS_FMT, right: true, width: 13 },
  { label: "Fallback sales rows", numFmt: UNITS_FMT, right: true, width: 14 },
  { label: "Recommended action", width: 34 },
  { label: "ROI pay month", width: 14 },
  { label: "ROI calculated at", width: 22 },
  // Clickable files. The URL differs by surface — the .xlsx points at the authenticated app, the
  // live sheet at a token-scoped route — but the COLUMNS are the same three in the same place, so
  // the download and the sheet stay the same report. See RequestFileLinks below.
  { label: "Evidence photo link", width: 52 },
  { label: "Money transfer proof link", width: 52 },
  { label: "Invoice link", width: 52 },
];

/**
 * Where the three file columns point for this surface. Null means "there is no such file", which
 * renders blank — deliberately different from a link that 404s, because a reader who clicks a dead
 * link concludes the system lost the photo rather than that none was ever taken.
 */
export type RequestFileLinks = {
  evidence: string | null;
  invoice: string | null;
  transferProof: string | null;
};

const NO_FILE_LINKS: RequestFileLinks = { evidence: null, invoice: null, transferProof: null };

export function requestRowCells(
  request: FullReportRequest,
  serial: number,
  links: RequestFileLinks = NO_FILE_LINKS,
): CellValue[] {
  const week = weekBreakdown(request.requestDate);
  return [
    // — the owner's template, columns A–P —
    serial,
    week.month,
    week.weekStart,
    week.weekEnd,
    week.week,
    request.lineName,
    request.otherRequestType ? `${request.requestTypeName} — ${request.otherRequestType}` : request.requestTypeName,
    request.contactName ? `${request.customerName} / ${request.contactName}` : request.customerName,
    request.customerCapturedAddress,
    request.requesterRegionName,
    request.requesterName,
    plainDate(request.payDate),
    request.estimatedCost,
    request.expectedRoiValue,
    request.notes,
    requestPreviewUrl(request.requestCode),
    // — everything else —
    request.requestCode,
    humanize(request.status),
    humanize(request.origin),
    plainDate(request.requestDate),
    request.otherRequestType,
    request.requestTypeCode,
    request.requestTypeDescription,
    yesNo(request.requestTypeRequiresDescription),
    request.requesterName,
    request.requesterHrId,
    request.requesterRegionName,
    request.requesterAreaName,
    request.managerName,
    request.managerHrId,
    request.lineName,
    request.areaName,
    request.roiDurationMonths,
    request.requiredRoiValue,
    request.roiCoverageRatio,
    humanize(request.roiStatus),
    yesNo(request.trackDirectSales),
    request.products.length,
    request.pharmacies.length,
    request.approvalSteps.length,
    request.currentStepName,
    cairoDateTime(request.submittedAt),
    cairoDateTime(request.approvedAt),
    daysBetween(request.submittedAt, request.approvedAt),
    cairoDateTime(request.rejectedAt),
    cairoDateTime(request.returnedAt),
    request.returnedStepSequence,
    cairoDateTime(request.executedAt),
    cairoDateTime(request.closedAt),
    cairoDateTime(request.createdAt),
    request.createdByName,
    cairoDateTime(request.updatedAt),
    request.updatedByName,
    // customer
    request.customerCode,
    humanize(request.customerType),
    request.customerOtherTypeDescription,
    request.customerRegionName,
    request.customerExtractedAreaName,
    request.customerExtractedGovernorateName,
    request.customerCapturedLatitude,
    request.customerCapturedLongitude,
    request.customerCapturedAccuracyMeters,
    cairoDateTime(request.customerCapturedAt),
    request.customerEvidencePhotoName,
    cairoDateTime(request.customerEvidencePhotoCapturedAt),
    yesNo(request.customerEvidenceHasTimestamp),
    humanize(request.customerEvidenceStatus),
    humanize(request.customerValidationStatus),
    request.customerValidatedByName,
    cairoDateTime(request.customerValidatedAt),
    request.customerValidationNotes,
    request.customerOwnerName,
    request.customerManagerName,
    request.customerCreatedByName,
    cairoDateTime(request.customerCreatedAt),
    // contact
    request.contactName,
    request.contactSpecialty,
    request.contactMobileNumber,
    request.contactCrmCode,
    request.contactCode,
    request.contactNotes,
    // finance
    yesNo(request.financeInvoiceRequired),
    humanize(request.financeInvoiceStatus),
    plainDate(request.financeInvoiceDeadlineDate),
    request.financeInvoiceFileName,
    request.financeInvoiceUploadedByName,
    cairoDateTime(request.financeInvoiceUploadedAt),
    request.financeTransferProofFileName,
    request.financeTransferProofUploadedByName,
    cairoDateTime(request.financeTransferProofUploadedAt),
    request.financeReviewerName,
    cairoDateTime(request.financeReviewedAt),
    request.financeNotes,
    // ROI actuals
    request.roiActualSalesValue,
    request.roiActualSalesUnits,
    request.roiActualCoverageRatio,
    humanize(request.roiActualStatus),
    humanize(request.roiAttributionQuality),
    request.roiCoverageGap,
    request.roiExpectedGap,
    request.roiSalesRows,
    request.roiExactSalesRows,
    request.roiFallbackSalesRows,
    request.roiRecommendedAction,
    request.roiPayMonth,
    cairoDateTime(request.roiCalculatedAt),
    // A link is emitted only when the underlying file actually exists — see RequestFileLinks.
    request.customerEvidencePhotoName ? links.evidence : null,
    request.financeTransferProofFileName ? links.transferProof : null,
    request.financeInvoiceFileName ? links.invoice : null,
  ];
}

// ── Sheet 2: Products ────────────────────────────────────────────────────────

export const PRODUCT_COLUMNS: TableColumn[] = [
  { label: "Request code", width: 26 },
  { label: "Account/Dr.Name", width: 30 },
  { label: "Product", width: 30 },
  { label: "Product code", width: 14 },
  { label: "Line", width: 14 },
  { label: "Family", width: 18 },
  { label: "Source company", width: 20 },
  { label: "Factory price", numFmt: VALUE_FMT, right: true, width: 14 },
  { label: "Forecast quantity", numFmt: UNITS_FMT, right: true, width: 15 },
  { label: "Expected value", numFmt: VALUE_FMT, right: true, width: 16 },
  { label: "Share of ROI", numFmt: PCT_FMT, right: true, width: 12 },
];

export function productRowCells(request: FullReportRequest, product: FullReportProduct): CellValue[] {
  return [
    request.requestCode,
    request.customerName,
    product.productName,
    product.productCode,
    product.lineSnapshot,
    product.productFamily,
    product.sourceCompany,
    product.factoryPriceSnapshot,
    product.forecastQuantity,
    product.expectedValue,
    product.valueShare,
  ];
}

// ── Sheet 3: Approval trail ──────────────────────────────────────────────────

export const APPROVAL_COLUMNS: TableColumn[] = [
  { label: "Request code", width: 26 },
  { label: "Step", numFmt: UNITS_FMT, right: true, width: 7 },
  { label: "Step name", width: 30 },
  { label: "Step code", width: 20 },
  { label: "Step kind", width: 16 },
  { label: "Assigned role", width: 26 },
  { label: "Assigned to", width: 30 },
  { label: "Assigned HR_ID", width: 14 },
  { label: "Status", width: 16 },
  { label: "Decided by", width: 30 },
  { label: "Decided by HR_ID", width: 14 },
  { label: "Decided at", width: 22 },
  { label: "Decision note", width: 40 },
  { label: "Executed at", width: 22 },
  { label: "Information only (CC)", width: 16 },
  { label: "May reject", width: 12 },
  { label: "May return", width: 12 },
  { label: "Terminal status", width: 18 },
];

export function approvalRowCells(request: FullReportRequest, step: FullReportApprovalStep): CellValue[] {
  return [
    request.requestCode,
    step.sequence,
    step.stepName,
    step.stepCode,
    humanize(step.stepKind),
    step.assignedRole,
    step.assignedName,
    step.assignedHrId,
    humanize(step.status),
    step.decidedByName,
    step.decidedByHrId,
    cairoDateTime(step.decidedAt),
    step.decisionNote,
    cairoDateTime(step.executedAt),
    yesNo(step.isCc),
    yesNo(step.allowReject),
    yesNo(step.allowReturn),
    humanize(step.terminalStatus),
  ];
}

// ── Sheet 4: Pharmacies ──────────────────────────────────────────────────────

export const PHARMACY_COLUMNS: TableColumn[] = [
  { label: "Request code", width: 26 },
  { label: "Pharmacy", width: 30 },
  { label: "Pharmacy code", width: 26 },
  { label: "Distributor", width: 22 },
  { label: "Distributor code", width: 16 },
  { label: "Distributor pharmacy code", width: 20 },
  { label: "Tracking status", width: 20 },
  { label: "Reference status", width: 18 },
  { label: "Reference matches", numFmt: UNITS_FMT, right: true, width: 14 },
  { label: "Region", width: 24 },
  { label: "Area (extracted)", width: 20 },
  { label: "Governorate", width: 24 },
  { label: "Address", width: 46 },
  { label: "GPS latitude", right: true, width: 14 },
  { label: "GPS longitude", right: true, width: 14 },
  { label: "GPS accuracy (m)", numFmt: "#,##0.0", right: true, width: 14 },
  { label: "Location captured at", width: 22 },
  { label: "Evidence status", width: 18 },
  { label: "Validation status", width: 18 },
  { label: "Validated by", width: 30 },
  { label: "Validated at", width: 22 },
  { label: "Validation notes", width: 36 },
  { label: "Notes", width: 36 },
];

export function pharmacyRowCells(request: FullReportRequest, pharmacy: FullReportPharmacy): CellValue[] {
  return [
    request.requestCode,
    pharmacy.pharmacyName,
    pharmacy.pharmacyCode,
    pharmacy.distributorName,
    pharmacy.distributorCode,
    pharmacy.distributorPharmacyCode,
    humanize(pharmacy.trackingStatus),
    humanize(pharmacy.referenceStatus),
    pharmacy.referenceMatchCount,
    pharmacy.regionName,
    pharmacy.extractedAreaName,
    pharmacy.extractedGovernorateName,
    pharmacy.capturedAddress,
    pharmacy.capturedLatitude,
    pharmacy.capturedLongitude,
    pharmacy.capturedAccuracyMeters,
    cairoDateTime(pharmacy.capturedAt),
    humanize(pharmacy.evidenceStatus),
    humanize(pharmacy.validationStatus),
    pharmacy.validatedByName,
    cairoDateTime(pharmacy.validatedAt),
    pharmacy.validationNotes,
    pharmacy.notes,
  ];
}
