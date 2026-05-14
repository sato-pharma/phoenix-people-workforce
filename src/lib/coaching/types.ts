import type {
  CoachingParameterKey,
  CoachingScoreItemKey,
} from "@/lib/coaching/constants";
import type { AccessContext } from "@/lib/auth/permissions";

export type CoachingReportStatus =
  | "draft"
  | "submitted"
  | "reviewed_by_employee"
  | "locked"
  | "cancelled";

export type CoachingPerformanceZone =
  | "critical_red"
  | "red_zone"
  | "yellow_zone"
  | "green_zone"
  | "excellence_zone";

export type CoachingScoreItemInput = {
  areaToBeImproved?: string | null;
  score: number;
  strengthPoint?: string | null;
};

export type CoachingScoreInput = Partial<Record<CoachingScoreItemKey, number | CoachingScoreItemInput>>;

export type NormalizedCoachingScoreItem = {
  areaToBeImproved: string | null;
  score: number;
  strengthPoint: string | null;
};

export type CoachingCategorySubtotal = {
  actualScore: number;
  averageScore: number;
  category: CoachingParameterKey;
  label: string;
  maxScore: number;
  percent: number;
  pointCount: number;
};

export type CoachingScoreResult = {
  actualScore: number;
  categorySubtotals: CoachingCategorySubtotal[];
  finalScorePercent: number;
  keyDevelopmentArea: CoachingCategorySubtotal;
  maxScore: number;
  normalizedScores: Record<CoachingScoreItemKey, number>;
  performanceZone: CoachingPerformanceZone;
  strongestParameter: CoachingCategorySubtotal;
};

export type CoachingReportRow = {
  acknowledged_at: string | null;
  actual_score: number | string | null;
  area_id: number | null;
  area_of_development: string | null;
  coach_hr_id: string;
  coach_role: string | null;
  coaching_date: string;
  coaching_month: number;
  coaching_quarter: number;
  coaching_year: number;
  created_at: string;
  created_by: string | null;
  employee_acknowledged: boolean;
  final_score_percent: number | string | null;
  general_remarks: string | null;
  id: string;
  line_id: number | null;
  locked_at: string | null;
  max_score: number | string | null;
  medical_rep_hr_id: string;
  performance_zone: string | null;
  report_number: string;
  status: CoachingReportStatus;
  strength_points: string | null;
  submitted_at: string | null;
  team_id: number | null;
  updated_at: string;
  updated_by: string | null;
};

export type CoachingScoreItemRow = {
  area_to_be_improved: string | null;
  created_at: string;
  display_order: number;
  id: string;
  parameter_category: CoachingParameterKey;
  report_id: string;
  score: number;
  score_item_key: CoachingScoreItemKey;
  score_item_label: string;
  strength_point: string | null;
  updated_at: string;
};

export type CoachingReportSummaryRow = {
  acknowledged: boolean;
  acknowledgedAt: string | null;
  actualScore: number;
  areaId: number | null;
  areaName: string | null;
  coachHrId: string;
  coachName: string;
  coachingDate: string;
  coachingMonth: number;
  coachingQuarter: number;
  coachingYear: number;
  createdAt: string;
  finalScorePercent: number;
  lineId: number | null;
  lineName: string | null;
  maxScore: number;
  medicalRepHrId: string;
  medicalRepName: string;
  performanceZone: CoachingPerformanceZone | null;
  reportId: string;
  reportNumber: string;
  status: CoachingReportStatus;
  submittedAt: string | null;
  teamId: number | null;
  teamName: string | null;
  updatedAt: string;
};

export type CoachingReportDetail = {
  report: CoachingReportRow;
  scoreResult: CoachingScoreResult | null;
  scores: CoachingScoreItemRow[];
  summary: CoachingReportSummaryRow | null;
};

export type CoachingReportFilters = {
  areaId?: number | string | null;
  coachHrId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  lineId?: number | string | null;
  limit?: number | string | null;
  medicalRepHrId?: string | null;
  month?: number | string | null;
  page?: number | string | null;
  performanceZone?: CoachingPerformanceZone | string | null;
  quarter?: number | string | null;
  status?: CoachingReportStatus | string | null;
  teamId?: number | string | null;
  year?: number | string | null;
};

export type CoachingReportMutationInput = {
  areaOfDevelopment?: string | null;
  coachingDate?: string | null;
  generalRemarks?: string | null;
  medicalRepHrId?: string | null;
  scores?: CoachingScoreInput | null;
  strengthPoints?: string | null;
};

export type CoachingReportCreateInput = CoachingReportMutationInput & {
  coachingDate: string;
  medicalRepHrId: string;
};

export type CoachingReportAuditAction =
  | "created_draft"
  | "updated_draft"
  | "submitted"
  | "locked"
  | "acknowledged";

export type CoachingAcknowledgmentInput = {
  acknowledgmentText?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type CoachingQuarterlySummaryRow = {
  averageScore: number;
  bestScore: number;
  coachingCount: number;
  firstScore: number;
  improvementScore: number;
  latestScore: number;
  latestZone: CoachingPerformanceZone | null;
  lowestScore: number;
  medicalRepHrId: string;
  quarter: number;
  year: number;
};

export type CoachingCategoryAverageScore = {
  averagePercent: number;
  averageScore: number;
  parameterCategory: CoachingParameterKey;
  parameterKey: CoachingParameterKey;
  parameterLabel: string;
  reportCount: number;
  scoreCount: number;
};

export type CoachingScoreItemAverageScore = {
  averagePercent: number;
  averageScore: number;
  parameterCategory: CoachingParameterKey;
  parameterKey: CoachingParameterKey;
  parameterLabel: string;
  reportCount: number;
  scoreCount: number;
  scoreItemKey: CoachingScoreItemKey;
  scoreItemLabel: string;
};

export type CoachingParameterDistributionRow = {
  count: number;
  parameterCategory: CoachingParameterKey;
  parameterKey: CoachingParameterKey;
  parameterLabel: string;
  percent: number;
};

export type CoachingScoreAnalytics = {
  categoryAverageScores: CoachingCategoryAverageScore[];
  keyDevelopmentAreaDistribution: CoachingParameterDistributionRow[];
  scoreItemAverageScores: CoachingScoreItemAverageScore[];
  strongestParameterDistribution: CoachingParameterDistributionRow[];
};

export type CoachingServiceContext = {
  access: AccessContext;
};
