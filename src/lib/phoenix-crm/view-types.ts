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
  VisitPerson,
  VisitRow,
} from "@/lib/phoenix-crm/server/visits";
export type {
  CustomerPharmacy,
  ListCustomer,
  ListPlace,
  ListReferenceEntry,
  ListRequest,
  SeatReadiness,
  TerritoryListView,
  ValidateResult,
} from "@/lib/phoenix-crm/server/list";
export type { DoctorDirectoryRow, DoctorDirectoryView } from "@/lib/phoenix-crm/server/doctors";
export type { TeamRequest, TeamTerritoryRow, TeamView } from "@/lib/phoenix-crm/server/team";
export type {
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
  VisitsReportView,
} from "@/lib/phoenix-crm/server/reports";
export type { PhotoSlot } from "@/lib/phoenix-crm/server/photos";
export type { PhoenixCrmSettingsView, SettingsLine, SettingsRamadan } from "@/lib/phoenix-crm/server/admin-settings";
