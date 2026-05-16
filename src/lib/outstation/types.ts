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
  | "finance_review"
  | "reject";

export type OutstationFraudFlag =
  | "poor_accuracy"
  | "impossible_speed"
  | "location_permission_denied"
  | "missing_residence_location"
  | "repeated_same_coordinates"
  | "outside_expected_territory"
  | "distance_below_policy"
  | "offline_delay"
  | "missing_ticket_attachments"
  | "timestamp_mismatch";

export type OutstationCarEvidenceSource = "live_camera";

export type OutstationCarEvidenceMetadata = {
  capturedAt: string;
  capturedLatitude: number;
  capturedLongitude: number;
  employeeHrId: string;
  requestDraftId: string | null;
  requestId: string | null;
  source: OutstationCarEvidenceSource;
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
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  employeeArea: string | null;
  employeeLine: string | null;
  fraudFlags: OutstationFraudFlag[];
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
  suspiciousLocationScore: number;
  territoryValidationReason: string;
  territoryValidationStatus: OutstationTerritoryValidationStatus;
  toArea: string | null;
  toCity: string | null;
  toLabel: string | null;
};

export type OutstationCalculationInput = {
  attachmentCount?: number;
  capturedAccuracyMeters: number;
  capturedAt?: string;
  capturedLatitude: number;
  capturedLongitude: number;
  claimedTotalAmount: number;
  expenseType: OutstationExpenseType;
  goTicketAmount?: number;
  hasTicketAttachments?: boolean;
  kilometerReading?: number;
  medicalTripHrId?: string | null;
  medicalTripName?: string | null;
  notes?: string | null;
  offlineCaptured?: boolean;
  returnTicketAmount?: number;
  carEvidenceMetadata?: OutstationCarEvidenceMetadata;
  transportationType: OutstationTransportationType;
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
  sameDayTrip: boolean;
  ticketAmount: number;
  transportationType: OutstationTransportationType;
  tripEndDate: string;
  tripStartDate: string;
  varianceAmount: number;
  variancePercent: number;
};

export type OutstationExpenseRequest = {
  allowanceAmount: number;
  allowanceBreakdown: OutstationAllowanceBreakdown | null;
  attachmentCount: number;
  approvalRecommendation: OutstationApprovalRecommendation;
  approvalReason: string;
  capturedAccuracyMeters: number;
  capturedAt: string;
  capturedLatitude: number;
  capturedLongitude: number;
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
  fraudFlags: OutstationFraudFlag[];
  fuelAmount: number;
  id: number;
  kilometerReading: number | null;
  medicalTripHrId: string | null;
  medicalTripName: string | null;
  minimumRequiredDistanceKm: number;
  notes: string | null;
  offlineCaptured: boolean;
  overnightDays: number;
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
  suspiciousLocationScore: number;
  territoryValidationReason: string;
  territoryValidationStatus: OutstationTerritoryValidationStatus;
  ticketAmount: number;
  toArea: string | null;
  toCity: string | null;
  toLabel: string | null;
  transportationType: OutstationTransportationType;
  carEvidenceMetadata?: OutstationCarEvidenceMetadata;
  tripEndDate: string;
  tripStartDate: string;
  updatedAt: string;
  varianceAmount: number;
  variancePercent: number;
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
  varianceAmount: number;
};

export type OutstationHeatmapData = {
  filterOptions: {
    areas: string[];
    lines: string[];
    statuses: OutstationEligibilityStatus[];
  };
  heatmapRows: {
    byArea: Array<{ label: string; totalVariance: number; trips: number }>;
    byCity: Array<{ label: string; totalExpenses: number; trips: number }>;
    byLine: Array<{ label: string; totalExpenses: number; trips: number }>;
    highRiskByLocation: Array<{ label: string; highRiskTrips: number }>;
  };
  kpis: {
    highRiskRequests: number;
    totalClaimed: number;
    totalExpected: number;
    totalRequests: number;
    totalVariance: number;
  };
  markers: OutstationHeatmapMarker[];
};
