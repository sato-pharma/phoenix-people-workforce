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
  VisitProductManager,
  VisitRow,
} from "@/lib/phoenix-crm/server/visits";
export type {
  CustomerPharmacy,
  ListCustomer,
  ListMoveTarget,
  ListPlace,
  ListReferenceEntry,
  ListRequest,
  PharmacyPin,
  PlaceReading,
  SeatReadiness,
  TerritoryListView,
  ValidateResult,
} from "@/lib/phoenix-crm/server/list";
export type { AddedVenueTimetable } from "@/lib/phoenix-crm/server/venue-timetable";
export type { PlaceMoveResult, PlaceMoveTarget, SeatedInVenueResult } from "@/lib/phoenix-crm/server/place-move";
export type { PlannedActivityDraft, PlannedActivityRow } from "@/lib/phoenix-crm/server/plan-activities";
export type { DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
export type { DayInterview } from "@/lib/phoenix-crm/server/interview-cvs";
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
/** The rep's own open commitments, and his prep for the next day a plan can hold. Both read-only. */
export type { RepCommitmentsView } from "@/lib/phoenix-crm/server/commitments";
export type { CallPrepView } from "@/lib/phoenix-crm/server/call-prep";
export type { EnteredMissedVisit, MissedRecordChainManager, MissedRecordCustomer, MissedRecordForm } from "@/lib/phoenix-crm/server/missed-records";
export type {
  EnteredManagerMissedVisit,
  ManagerMissedRecordCustomer,
  ManagerMissedRecordForm,
  ManagerMissedRecordList,
} from "@/lib/phoenix-crm/server/manager-missed-records";
export type { SavedVisitEdit, VisitEditForm, VisitEditPerson } from "@/lib/phoenix-crm/server/visit-edit";
export type { SavedVisitDetail, VisitDetailForm } from "@/lib/phoenix-crm/server/visit-detail-edit";
export type { DoctorDirectoryRow, DoctorDirectoryView } from "@/lib/phoenix-crm/server/doctors";
export type { TodayView } from "@/lib/phoenix-crm/server/today";
export type { TeamPlanEdit, TeamRequest, TeamTerritoryRow, TeamUnplannedVisit, TeamView } from "@/lib/phoenix-crm/server/team";
export type { UnplannedVisitView } from "@/lib/phoenix-crm/server/unplanned";
export type { PlanEditRequestView, PlanEditResult } from "@/lib/phoenix-crm/server/plan-edits";
export type {
  DoubleVisitDayView,
  DoubleVisitManagerOption,
  DoubleVisitPlanReach,
  DoubleVisitPlanView,
  DoubleVisitRepOption,
  DoubleVisitSlotView,
} from "@/lib/phoenix-crm/server/double-visit-plans";
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
export type { CapacityBoardView, FieldHeardView, MissingStockView, ObjectionsByDoctorView, SamplesReportView } from "@/lib/phoenix-crm/server/insight-reports";
export type { CustomerTimelineView } from "@/lib/phoenix-crm/server/customer-timeline";
export type {
  VisitAskCustomerView,
  VisitAskInboxView,
  VisitAskOffer,
  VisitAskSummary,
  VisitAskView,
} from "@/lib/phoenix-crm/server/visit-asks";
export type {
  DoubleVisitCustomerView,
  DoubleVisitPersonView,
  DoubleVisitReport,
  DoubleVisitRequestView,
} from "@/lib/phoenix-crm/server/double-visit-requests";
export type { PhotoSlot } from "@/lib/phoenix-crm/server/photos";
export type { TimeAnchorView } from "@/lib/phoenix-crm/server/time-anchor";
export type { PhoenixCrmSettingsView, SettingsLine, SettingsRamadan } from "@/lib/phoenix-crm/server/admin-settings";
export type { ReopenedCustomerRow, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/server/validation-reviews";
export type { PlaceNoteIndex, PlaceNoteView, PlaceRecommendationView, RepPlaceNote } from "@/lib/phoenix-crm/server/place-notes";
export type { SharedPlaceBoardRow, SharedPlaceReading, SharedPlaceRow } from "@/lib/phoenix-crm/server/shared-places";
/** The district manager's weekly plan (owner, 2026-10-16): his board, his own list, his single visits, the report. */
export type {
  ManagerBoardArea,
  ManagerBoardDay,
  ManagerBoardRep,
  ManagerBoardRepHalf,
  ManagerBoardScope,
  ManagerBoardSlot,
  ManagerBoardSlotCustomer,
  ManagerPlanBoardView,
  ManagerPlanTransitionResult,
  RepDayCustomer,
} from "@/lib/phoenix-crm/server/manager-plans";
export type {
  AreaCustomer,
  AreaCustomersView,
  CustomerMatch,
  ManagerAreaBricks,
  ManagerCustomerLocated,
  ManagerCustomerView,
  ManagerOwnListView,
} from "@/lib/phoenix-crm/server/manager-customers";
export type { ManagerTodayCustomer, ManagerTodayOwnCustomer, ManagerTodayView } from "@/lib/phoenix-crm/server/manager-visits";
export type {
  ManagerReport as ManagerPlanReport,
  ManagerReportView as ManagerPlanReportView,
} from "@/lib/phoenix-crm/server/manager-plan-report";
export type { PhoenixCrmManagerDayDetail } from "@/lib/phoenix-crm/server/manager-day-detail";
export type { SingleVisitDayAskView, SingleVisitDaysView } from "@/lib/phoenix-crm/server/manager-single-visit-days";
/** The Super Admin's "Test accounts" tab (owner, 2026-10-22): the test personas' approvals, one step each. */
export type { TestApprovalItem, TestApprovalsView } from "@/lib/phoenix-crm/server/test-approvals";
