/**
 * Phoenix CRM — the shapes the screens read, for client components.
 *
 * Type-only re-exports of what the server services return. `export type` is erased at build time, so a
 * client component importing from here pulls no server code (no database client, no node:crypto) into
 * the phone's bundle — it only borrows the names.
 */

export type { PhoenixCrmOverview, PhoenixCrmTabs } from "@/lib/phoenix-crm/server/overview";
export type { TerritorySummary } from "@/lib/phoenix-crm/server/territory";
export type {
  SavedVisit,
  VisitCustomerOption,
  VisitDayView,
  VisitFormView,
  VisitLocationFlag,
  VisitOutcomeView,
  VisitPerson,
  VisitRow,
} from "@/lib/phoenix-crm/server/visits";
export type {
  CustomerPharmacy,
  ListCustomer,
  ListPlace,
  ListReferenceEntry,
  ListRequest,
  PlaceReading,
  SeatReadiness,
  TerritoryListView,
  ValidateResult,
} from "@/lib/phoenix-crm/server/list";
export type { PlaceMoveResult, PlaceMoveTarget } from "@/lib/phoenix-crm/server/place-move";
export type { PlannedActivityDraft, PlannedActivityRow } from "@/lib/phoenix-crm/server/plan-activities";
export type { DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
export type {
  ForecastAccuracyRow,
  ForecastAccuracyView,
  ForecastBoardRegion,
  ForecastBoardRow,
  ForecastBoardView,
  ForecastFormView,
  ForecastProductLine,
} from "@/lib/phoenix-crm/server/daily-forecast";
export type { PhoenixCrmDayDetail } from "@/lib/phoenix-crm/server/day-detail";
export type { EnteredMissedVisit, MissedRecordCustomer, MissedRecordForm } from "@/lib/phoenix-crm/server/missed-records";
export type { DoctorDirectoryRow, DoctorDirectoryView } from "@/lib/phoenix-crm/server/doctors";
export type { TodayView } from "@/lib/phoenix-crm/server/today";
export type { TeamPlanEdit, TeamRequest, TeamTerritoryRow, TeamUnplannedVisit, TeamView } from "@/lib/phoenix-crm/server/team";
export type { UnplannedVisitView } from "@/lib/phoenix-crm/server/unplanned";
export type { PlanEditRequestView, PlanEditResult } from "@/lib/phoenix-crm/server/plan-edits";
export type {
  PlanCopySourceView,
  PlanDayView,
  PlanItemView,
  PlannerView,
  PlanReviewRow,
  PlanReviewView,
  PlanSummary,
  SavedPlan,
} from "@/lib/phoenix-crm/server/plans";
export type {
  MonthlyDoctorRow,
  MonthlyPlannerView,
  MonthlyPlanSummary,
  MonthlyReviewRow,
  MonthlyReviewView,
  MonthlyTransitionResult,
  MonthlyWeekView,
} from "@/lib/phoenix-crm/server/monthly-plans";
export type { PlanHistoryEntry, PlanHistoryView } from "@/lib/phoenix-crm/server/plan-history";
export type {
  CoverageReportView,
  CustomerFrequencyReportView,
  ManagerReportEntry,
  ManagerReportRow,
  ManagerReportView,
  PlanCell,
  PlanReportView,
  ReportScopeView,
  ReportTerritory,
  RepVisitRow,
  TerritoryCoverageRow,
  TerritoryPlanRow,
  TrackingSheetReportView,
  ReportComparison,
  VisitLocationReportView,
  VisitLocationRow,
  VisitsReportView,
} from "@/lib/phoenix-crm/server/reports";
export type { AdoptionView } from "@/lib/phoenix-crm/server/adoption";
export type { ExceptionsView } from "@/lib/phoenix-crm/server/exceptions";
export type { BrickCoverageView } from "@/lib/phoenix-crm/server/brick-report";
export type { PhotoSlot } from "@/lib/phoenix-crm/server/photos";
export type { TimeAnchorView } from "@/lib/phoenix-crm/server/time-anchor";
export type { PhoenixCrmSettingsView, SettingsLine, SettingsRamadan } from "@/lib/phoenix-crm/server/admin-settings";
