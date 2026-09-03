import type { DoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/types";

export type OutstationEligibilityStatus =
  | "eligible"
  | "not_eligible"
  | "needs_review";

export type OutstationExpenseType = "traveling" | "meeting" | "other";

export type OutstationTransportationType = "car" | "train" | "bus" | "other";

export type OutstationCalculationStatus =
  | "blocked"
  | "calculated"
  | "submitted";

export type OutstationApprovalRecommendation =
  | "auto_approve"
  | "manager_review"
  | "hr_review"
  | "reject";

// `upload` was added on 2026-08-05 (owner request) for NON-CAR trips only — see
// validateLiveArrivalEvidence, which still refuses anything but `live_camera` on a car trip.
// The two are NOT equivalent evidence: a live capture is taken in-app, at a known time, at GPS
// the browser reported, whereas an upload is a file of unknown provenance whose GPS is copied
// from the trip's destination capture. Anything weighing this evidence must read this field
// rather than assume every arrival photo was taken live.
export type OutstationCarEvidenceSource = "live_camera" | "upload";

export type OutstationCarEvidenceMetadata = {
  capturedAt: string;
  capturedLatitude: number;
  capturedLocationLabel: string | null;
  capturedLongitude: number;
  employeeHrId: string;
  requestDraftId: string | null;
  requestId: string | null;
  source: OutstationCarEvidenceSource;
};

export type OutstationTicketAttachmentMetadata = {
  contentType: string;
  name: string;
  path: string;
  size: number;
  uploadedAt: string;
};

/**
 * Two-photo gate (owner request 2026-08-04). `grandfathered` marks a request that pre-dates the
 * rule: its trip is over and can never now be photographed, so it is EXEMPT rather than blocked.
 * It is a separate state from `complete` on purpose — see expense-gate.ts.
 */
export type OutstationEvidenceGateStatus =
  | "pending_arrival_photo"
  | "pending_departure_photo"
  | "complete"
  | "grandfathered";

/**
 * What is stored alongside the departure photo. `review` is advisory only — the owner chose to
 * FLAG a suspicious pair rather than refuse it, so nothing here blocks a submission.
 */
export type OutstationDepartureEvidenceMetadata = {
  capturedAt: string;
  capturedLatitude: number | null;
  capturedLocationLabel: string | null;
  capturedLongitude: number | null;
  distanceFromArrivalKm: number | null;
  flags: string[];
  minutesAfterArrival: number | null;
  /**
   * Every capture this one replaced, oldest first. Empty on a first capture.
   *
   * Retakes were allowed on 2026-08-08 on one explicit condition: nothing is ever overwritten.
   * That is what keeps the control meaningful — an employee fixing a blurred photo costs nothing,
   * and a photo substituted from somewhere else leaves a permanent trail beside it.
   */
  previousVersions?: OutstationDepartureEvidenceVersion[];
  source: "live_camera";
  summary: string;
  /** 1 for a first capture, 2+ after a retake. Absent on rows written before retakes existed. */
  version?: number;
};

/** One superseded departure capture, kept so a retake can never erase what it replaced. */
export type OutstationDepartureEvidenceVersion = {
  capturedAt: string;
  capturedLatitude: number | null;
  capturedLocationLabel: string | null;
  capturedLongitude: number | null;
  distanceFromArrivalKm: number | null;
  flags: string[];
  imagePath: string;
  minutesAfterArrival: number | null;
  version: number;
};

/** Workload gate. `manual` = a system admin entered it by hand after the CRM grab failed. */
export type OutstationWorkloadGateStatus =
  | "pending_workload"
  | "complete"
  | "manual"
  | "grandfathered";

/**
 * Readable geography for a captured GPS point — the replacement for showing a raw
 * coordinate pair. Lives here (rather than in captured-location.ts) so the request type can
 * reference it without a circular import back through the resolver.
 */
export type OutstationCapturedLocationSummary = {
  areaLabel: string;
  brickLabel: string;
  /** Nearest-centroid match quality, e.g. "High · 0.4 km". Null when nothing matched. */
  confidence: string | null;
  label: string;
  regionLabel: string;
};

export type OutstationTerritoryValidationStatus =
  | "matched"
  | "outside_expected_territory"
  | "not_available";

export type OutstationRouteAlternative = {
  distanceKm: number | null;
  durationInTrafficMinutes: number | null;
  durationMinutes: number | null;
  encodedPolyline: string | null;
  index: number;
  isSelected: boolean;
  summary: string | null;
};

export type EmployeeResidenceLocation = {
  employeeHrId: string;
  geocodeStatus: string | null;
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
};

export type OutstationPolicyRule = {
  active: boolean;
  createdAt: string;
  fuelRatePerKm: number;
  gpsAccuracyThresholdMeters: number;
  id: number;
  maxOfflineSyncDelayHours: number;
  minimumDistanceKm: number;
  toleranceMinimumDistanceKm?: number | null;
  overnightAllowance: number;
  requiresTicketAttachment: boolean;
  returnDayAllowance: number;
  roleName: string;
  sameDayAllowance: number;
  updatedAt: string;
};

export type OutstationAllowanceBreakdown = {
  overnightDays: number;
  returnDayApplied: boolean;
  rows: Array<{
    amount: number;
    label: string;
    /** True when this day's allowance was zeroed because another live request already
     * claimed it. See skipReason for which one. Optional: absent on every row written
     * before the duplicate-day guard existed. */
    skipped?: boolean;
    skipReason?: string | null;
    type: "overnight" | "return_day" | "same_day";
  }>;
  sameDayTrip: boolean;
};

export type OutstationCaptureResult = {
  capturedAccuracyMeters: number;
  capturedAt: string;
  capturedLatitude: number;
  capturedLocationSource: "browser_gps";
  capturedLongitude: number;
  distanceFromResidenceKm: number | null;
  durationMinutes: number | null;
  eligibilityReason: string;
  eligibilityStatus: OutstationEligibilityStatus;
  /**
   * True when the residence-vs-destination governorate rule could NOT be
   * confirmed (either governorate was unresolved). Such a request is not
   * auto-paid — it is held for Super Admin review. Optional so existing
   * result mocks / stored drafts stay valid; the server always sets it.
   */
  governorateReviewRequired?: boolean;
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  employeeArea: string | null;
  employeeLine: string | null;
  minimumRequiredDistanceKm: number;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  routeAlternatives: OutstationRouteAlternative[];
  routePolyline: string | null;
  routeProvider: "google_maps";
  routeError: string | null;
  selectedRouteIndex: number | null;
  selectedRouteReason: "fastest_duration" | null;
  submittedAt: string;
  territoryValidationReason: string;
  territoryValidationStatus: OutstationTerritoryValidationStatus;
  toArea: string | null;
  toCity: string | null;
  toLabel: string | null;
};

export type OutstationCalculationInput = {
  amWorkload?: number;
  attachmentCount?: number;
  capturedAccuracyMeters: number;
  capturedAt?: string;
  capturedLatitude: number;
  capturedLongitude: number;
  carEvidenceImageDataUrl?: string;
  claimedTotalAmount: number;
  expenseType: OutstationExpenseType;
  goTicketAmount?: number;
  hasTicketAttachments?: boolean;
  hrNotes?: string | null;
  hrStatus?: string | null;
  kilometerReading?: number;
  medicalTripHrId?: string | null;
  medicalTripName?: string | null;
  meetingAmount?: number;
  notes?: string | null;
  offlineCaptured?: boolean;
  otherAmount?: number;
  pmWorkload?: number;
  returnTicketAmount?: number;
  carEvidenceMetadata?: OutstationCarEvidenceMetadata;
  transportationType: OutstationTransportationType;
  travelCostAmount?: number | null;
  tripType?: string | null;
  tripEndDate: string;
  tripStartDate: string;
};

export type OutstationCalculationResult = OutstationCaptureResult & {
  allowanceAmount: number;
  allowanceBreakdown: OutstationAllowanceBreakdown;
  attachmentCount: number;
  approvalRecommendation: OutstationApprovalRecommendation;
  approvalReason: string;
  calculationStatus: OutstationCalculationStatus;
  claimedTotalAmount: number;
  expenseType: OutstationExpenseType;
  expectedTotalAmount: number;
  fuelAmount: number;
  kilometerReading: number | null;
  medicalTripHrId: string | null;
  medicalTripName: string | null;
  notes: string | null;
  offlineCaptured: boolean;
  overnightDays: number;
  reportAmWorkload: number;
  reportHrNotes: string | null;
  reportHrStatus: string | null;
  reportMeetingAmount: number;
  reportOtherAmount: number;
  reportPmWorkload: number;
  reportTravelCost: number;
  reportTripType: string | null;
  sameDayTrip: boolean;
  ticketAmount: number;
  carEvidenceImagePath?: string | null;
  carEvidenceMetadata?: OutstationCarEvidenceMetadata;
  transportationType: OutstationTransportationType;
  tripEndDate: string;
  tripStartDate: string;
};

export type OutstationExpenseRequest = {
  allowanceAmount: number;
  allowanceBreakdown: OutstationAllowanceBreakdown | null;
  /**
   * Brick / area / region for the captured GPS point, DERIVED at read time from
   * captured_latitude/longitude — never stored, so it always reflects today's geography
   * (see captured-location.ts). Null on read paths that do not enrich, which is why every
   * consumer must treat it as optional rather than assume it is present.
   */
  capturedLocation?: OutstationCapturedLocationSummary | null;
  attachmentCount: number;
  approvalRecommendation: OutstationApprovalRecommendation;
  approvalReason: string;
  capturedAccuracyMeters: number;
  capturedAt: string;
  capturedLatitude: number;
  capturedLongitude: number;
  /** The ARRIVAL photo — see the column comment in the 2026-08-04 migration for why it is still
   * named car_*. Required for every transportation type since that date. */
  carEvidenceImagePath: string | null;
  carEvidenceImageUrl: string | null;
  carEvidenceMetadata: OutstationCarEvidenceMetadata | null;
  departureCapturedAt: string | null;
  departureEvidenceImagePath: string | null;
  departureEvidenceMetadata: OutstationDepartureEvidenceMetadata | null;
  evidenceGateStatus: OutstationEvidenceGateStatus;
  /** How many times the CRM workload grab has been tried. Drives the admin repair screen. */
  workloadCaptureAttempts: number;
  workloadLastAttemptAt: string | null;
  workloadLastAttemptError: string | null;
  workloadGateStatus: OutstationWorkloadGateStatus;
  claimedTotalAmount: number;
  createdAt: string;
  distanceFromResidenceKm: number | null;
  durationMinutes: number | null;
  expenseType: OutstationExpenseType;
  eligibilityReason: string;
  eligibilityStatus: OutstationEligibilityStatus;
  employeeArea: string | null;
  employeeHrId: string;
  employeeLine: string | null;
  employeeName: string;
  employeeRole: string;
  expectedTotalAmount: number;
  fuelAmount: number;
  goTicketAmount: number;
  id: number;
  kilometerReading: number | null;
  medicalTripHrId: string | null;
  medicalTripName: string | null;
  /** The invoice attached to a Meeting-type manual expense. Null when none was uploaded. */
  meetingInvoiceMetadata: OutstationTicketAttachmentMetadata | null;
  meetingInvoicePath: string | null;
  /** Signed URL for meetingInvoicePath, same read-path caveat as carEvidenceImageUrl. */
  meetingInvoiceUrl?: string | null;
  minimumRequiredDistanceKm: number;
  notes: string | null;
  offlineCaptured: boolean;
  overnightDays: number;
  reportAmWorkload: number;
  reportHrNotes: string | null;
  reportHrStatus: string | null;
  reportMeetingAmount: number;
  reportOtherAmount: number;
  reportPmWorkload: number;
  reportTravelCost: number | null;
  reportTripType: string | null;
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  routeAlternatives?: OutstationRouteAlternative[];
  routePolyline: string | null;
  routeError: string | null;
  selectedRouteIndex?: number | null;
  selectedRouteReason?: "fastest_duration" | null;
  sameDayTrip: boolean;
  status: string;
  submittedAt: string | null;
  territoryValidationReason: string;
  territoryValidationStatus: OutstationTerritoryValidationStatus;
  returnTicketAmount: number;
  ticketAttachmentMetadata: OutstationTicketAttachmentMetadata[];
  ticketAttachmentPaths: string[];
  /**
   * Signed, time-limited URLs for `ticketAttachmentPaths`, index-aligned with it (and so with
   * `ticketAttachmentMetadata`). Only populated on read paths that ask for signed URLs; an
   * entry is null when that one path could not be signed. Optional for the same reason
   * `carEvidenceImageUrl` is nullable — most read paths never sign.
   */
  ticketAttachmentUrls?: Array<string | null>;
  ticketAmount: number;
  toArea: string | null;
  toCity: string | null;
  toCountry: string | null;
  toLabel: string | null;
  transportationType: OutstationTransportationType;
  tripEndDate: string;
  tripStartDate: string;
  updatedAt: string;
  amWorkload: number;
  meetingAmount: number;
  otherAmount: number;
  pmWorkload: number;
  workloadEvidenceSnapshot: DoubleVisitExpenseWorkloadEvidence | Record<string, unknown>;
  workloadMatchedAt: string | null;
  workloadMatchStatus: string;
  workloadOverrideReason: string | null;
  workloadSource: string;
  workloadSourceImportId: string | null;
};

export type PlacesPrediction = {
  description: string;
  placeId: string;
};

export type ManagerExpenseDestination = {
  area: string | null;
  city: string | null;
  country: string | null;
  label: string;
  latitude: number;
  longitude: number;
  placeId: string;
};

export type ManagerExpenseAdminInput = {
  amWorkload?: number | null;
  claimedTotalAmount: number;
  destination: ManagerExpenseDestination;
  distanceKm: number;
  durationMinutes: number | null;
  employeeHrId: string;
  expenseType: OutstationExpenseType;
  hrNotes?: string | null;
  hrStatus?: string | null;
  meetingAmount?: number | null;
  /**
   * Base64 data URL (`data:<mime>;base64,<payload>`) of an invoice to attach to the Meeting
   * amount, PDF/JPG/PNG up to 5MB. Omit to leave any existing invoice unchanged; pass `null`
   * explicitly (edit only) to remove it.
   */
  meetingInvoiceDataUrl?: string | null;
  meetingInvoiceFileName?: string | null;
  notes: string | null;
  otherAmount?: number | null;
  pmWorkload?: number | null;
  routePolyline: string | null;
  transportationType: OutstationTransportationType;
  travelCostAmount?: number | null;
  tripType?: string | null;
  tripEndDate: string;
  tripStartDate: string;
};

export type OutstationHeatmapMarker = {
  area: string | null;
  city: string | null;
  employeeName: string;
  id: number;
  latitude: number;
  line: string | null;
  longitude: number;
  recommendation: OutstationApprovalRecommendation;
  status: OutstationEligibilityStatus;
};

export type OutstationHeatmapData = {
  filterOptions: {
    areas: string[];
    lines: string[];
    statuses: OutstationEligibilityStatus[];
  };
  heatmapRows: {
    byArea: Array<{ label: string; totalExpenses: number; trips: number }>;
    byCity: Array<{ label: string; totalExpenses: number; trips: number }>;
    byLine: Array<{ label: string; totalExpenses: number; trips: number }>;
  };
  kpis: {
    totalClaimed: number;
    totalExpected: number;
    totalRequests: number;
  };
  markers: OutstationHeatmapMarker[];
};
