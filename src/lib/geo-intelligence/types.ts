export type GeoSourceType =
  | "employee_area"
  | "brick"
  | "trip_origin"
  | "trip_destination"
  | "vacancy"
  | "custom";

export type GeoTripStatus = "normal" | "review_required" | "high_risk";
export type GeoBrickCoverageStatus =
  | "covered"
  | "vacant"
  | "overlapping"
  | "unassigned";

export type GeoLocationRecord = {
  addressText: string | null;
  area: string | null;
  city: string | null;
  createdAt: string;
  geocodeProvider: string | null;
  geocodeStatus: string | null;
  id: number;
  label: string;
  latitude: number | null;
  line: string | null;
  longitude: number | null;
  sourceKey: string;
  sourceType: GeoSourceType;
  updatedAt: string;
};

export type GeoTripRouteRecord = {
  claimedAmount: number;
  createdAt: string;
  employeeHrId: string | null;
  employeeName: string | null;
  expectedAmount: number;
  fromLat: number | null;
  fromLng: number | null;
  fromText: string;
  googleDistanceMeters: number | null;
  googleDurationSeconds: number | null;
  id: number;
  sourceFileMonth: string | null;
  status: GeoTripStatus;
  toLat: number | null;
  toLng: number | null;
  toText: string;
  tripDate: string | null;
  updatedAt: string;
  varianceAmount: number;
  variancePercent: number;
};

export type GeoBrickRecord = {
  area: string | null;
  brickCode: string;
  brickName: string;
  coverageStatus: GeoBrickCoverageStatus;
  createdAt: string;
  employeeHrId: string | null;
  employeeName: string | null;
  id: number;
  latitude: number | null;
  line: string | null;
  longitude: number | null;
  updatedAt: string;
};

export type GeoDashboardFilters = {
  area?: string | null;
  employeeHrId?: string | null;
  line?: string | null;
  month?: string | null;
  status?: GeoTripStatus | "" | null;
};

export type GeoKpiSummary = {
  coveredBricks: number;
  highRiskTrips: number;
  totalClaimedExpenses: number;
  totalExpectedExpenses: number;
  totalMappedBricks: number;
  totalTrips: number;
  totalVariance: number;
  vacantBricks: number;
};

export type GeoChartPoint = {
  label: string;
  value: number;
};

export type GeoCoveragePoint = {
  covered: number;
  label: string;
  vacant: number;
};

export type GeoMarker = {
  area: string | null;
  employeeHrId: string | null;
  employeeName: string | null;
  id: string;
  label: string;
  latitude: number;
  line: string | null;
  longitude: number;
  meta: string | null;
  source: "brick" | "vacancy" | "trip_origin" | "trip_destination";
  status: GeoBrickCoverageStatus | GeoTripStatus | "mapped";
};

export type GeoDashboardData = {
  anomalies: GeoTripRouteRecord[];
  browserKeyConfigured: boolean;
  bricks: GeoBrickRecord[];
  chartData: {
    coverageByLine: GeoCoveragePoint[];
    highRiskTripsOverTime: GeoChartPoint[];
    tripsByDestinationCity: GeoChartPoint[];
    varianceByArea: GeoChartPoint[];
    varianceByEmployee: GeoChartPoint[];
  };
  expenseRoutes: GeoTripRouteRecord[];
  filterOptions: {
    areas: string[];
    employees: Array<{ hrId: string; name: string }>;
    lines: string[];
    months: string[];
    statuses: GeoTripStatus[];
  };
  filters: Required<GeoDashboardFilters>;
  kpis: GeoKpiSummary;
  serverKeyConfigured: boolean;
  territoryMarkers: GeoMarker[];
};

export type GeoBrickImportRow = {
  area: string;
  brickCode: string;
  brickName: string;
  employeeHrId: string | null;
  employeeName: string | null;
  line: string;
};

export type GeoExpenseImportRow = {
  claimedAmount: number;
  employeeHrId: string | null;
  employeeName: string;
  fromText: string;
  sourceFileMonth: string | null;
  toText: string;
  tripDate: string | null;
};

export type GeoImportSummary = {
  inserted: number;
  issues: string[];
  processed: number;
};
