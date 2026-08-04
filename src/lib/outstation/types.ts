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

export type OutstationCarEvidenceSource = "live_camera";

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
  carEvidenceImagePath: string | null;
  carEvidenceImageUrl: string | null;
  carEvidenceMetadata: OutstationCarEvidenceMetadata | null;
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
