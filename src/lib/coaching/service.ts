import { hrIdForStorage } from "@/lib/hr-id";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import {
  type AccessContext,
  canManageCoachingReports,
  normalizeHrId,
  resolveEmployeeIdentityId,
} from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  isWithinManagerHierarchy,
  lineScopeIncludesEmployee,
  reportsToManagerSeat,
  sameWorkforceLine,
} from "@/lib/workforce/hierarchy-resolver";
import { coachingMaxScore } from "@/lib/coaching/constants";
import { buildDownwardCut, type DownwardCut } from "@/lib/crm/doctor-coverage-scope";
import {
  buildCoachingScoreAnalytics,
  emptyCoachingScoreAnalytics,
  type CoachingScoreAnalyticsInputRow,
} from "@/lib/coaching/analytics";
import { calculateCoachingScore, normalizeCoachingScoreItems, toCoachingScoreRows } from "@/lib/coaching/scoring";
import { assertCoachingWorkflowTransition } from "@/lib/coaching/workflow";
import { refuseOldCoachingFormCreate } from "@/lib/coaching/old-form-retired";
import type {
  CoachingAcknowledgmentInput,
  CoachingPerformanceZone,
  CoachingQuarterlySummaryRow,
  CoachingReportAuditAction,
  CoachingReportCreateInput,
  CoachingReportDetail,
  CoachingReportFilters,
  CoachingReportMutationInput,
  CoachingReportRow,
  CoachingReportStatus,
  CoachingScoreAnalytics,
  CoachingReportSummaryRow,
  CoachingScoreItemRow,
} from "@/lib/coaching/types";

type CoachingSummaryDbRow = {
  acknowledged: boolean;
  acknowledged_at: string | null;
  actual_score: number | string | null;
  area_id: number | null;
  area_name: string | null;
  coach_hr_id: string;
  coach_name: string;
  coaching_date: string;
  coaching_month: number;
  coaching_quarter: number;
  coaching_year: number;
  created_at: string;
  final_score_percent: number | string | null;
  line_id: number | null;
  line_name: string | null;
  max_score: number | string | null;
  medical_rep_hr_id: string;
  medical_rep_name: string;
  performance_zone: string | null;
  report_id: string;
  report_number: string;
  status: CoachingReportStatus;
  submitted_at: string | null;
  team_id: number | null;
  team_name: string | null;
  updated_at: string;
};

type CoachingQuarterlySummaryDbRow = {
  average_score: number | string | null;
  best_score: number | string | null;
  coaching_count: number | string | null;
  first_score: number | string | null;
  improvement_score: number | string | null;
  latest_score: number | string | null;
  latest_zone: string | null;
  lowest_score: number | string | null;
  medical_rep_hr_id: string;
  quarter: number | string;
  year: number | string;
};

const editableStatuses = new Set<CoachingReportStatus>(["draft"]);
const submittedStatuses = new Set<CoachingReportStatus>(["submitted", "reviewed_by_employee"]);
const companyRoles = new Set<AccessContext["role"]>(["Super Admin", "CEO"]);
// Org-wide coaching VIEW oversight: company roles plus Training Manager and Marketing Manager,
// who have company-wide oversight and therefore see all coaching reports (not just their own).
// This widens read/list visibility only — write authority still flows through
// canManageCoachingReports + assertOwnDraftOrOverride + the workflow registry, so these oversight
// roles never gain edit rights on others' reports (Marketing Manager is view-only by design).
//
// SFE Manager joined the oversight set on 2026-10-20 (owner: every role a module applies to must
// find its people). He sat in lineRoles, but his own seat is on the Head Office line, so "same line
// AND same department" matched no field rep at all — 0 of 122 coaching reports in production. He is
// company-wide everywhere else he reads field work (double-visit analytics, doctor coverage), and he
// holds coaching:read only, so this widens what he can READ and nothing he can write.
const coachingOversightRoles = new Set<AccessContext["role"]>([
  ...companyRoles,
  "Training Manager",
  "Marketing Manager",
  "SFE Manager",
]);
// Line-scoped coaching READ roles. Marketing Manager and SFE Manager are intentionally NOT here:
// both are in coachingOversightRoles, which short-circuits to full company-wide read in
// canAccessCoachingEmployee before this branch is reached — so a line entry is dead code that
// misrepresents the scope.
const lineRoles = new Set<AccessContext["role"]>([
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
]);
// These bound a COMPANY-WIDE read whose per-viewer scope (filterSummariesForAccess) is applied
// afterwards, in memory. The window therefore truncates the wrong end: once the company's report
// count exceeds it, a scoped viewer's own rows can fall outside the window and silently disappear —
// the page looks empty rather than truncated. Production held 104 coaching_reports when this was
// raised, so the old 500 was not yet biting; it is lifted to keep a wide margin. If this table ever
// approaches the ceiling, the fix is to push the scope filter into the query (scope-then-page), not
// to raise these again. Same defect class as MARKETING_WORKSPACE_SAFETY_LIMIT.
const defaultCoachingReportLimit = 5000;
const maxCoachingReportLimit = 10000;

function cleanText(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function coachingRange(filters: CoachingReportFilters) {
  const limit = Math.min(normalizePositiveInteger(filters.limit, defaultCoachingReportLimit), maxCoachingReportLimit);
  const page = normalizePositiveInteger(filters.page, 1);
  const from = (page - 1) * limit;
  return { from, to: from + limit - 1 };
}

function normalizeDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // Parse and format both anchored at UTC (the trailing "Z") so this is a pure
  // date-only validation with no dependency on the runtime's local timezone — the
  // previous local-parse/UTC-format round trip shifted the date back a day on any
  // non-UTC host (the exact pattern tests/coaching-date-formatting.test.ts guards
  // the UI layer against; this is the same bug one layer down, in storage).
  const date = new Date(`${raw.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * A coaching report records a visit that already happened, so it can never be dated ahead of
 * today. Nothing enforced this before: the form's date input had no `max`, {@link normalizeDate}
 * only checked the string parsed, and there is no CHECK constraint — so any future date saved
 * silently, and `coaching_month`/`coaching_quarter`/`coaching_year` (GENERATED from
 * `coaching_date`) filed the report in a quarter that has not happened yet, polluting every
 * period-scoped analytic. Two rows reached production this way.
 *
 * Compared in Africa/Cairo, not UTC: between 22:00 and 23:59 UTC it is already tomorrow in Cairo,
 * and a coach entering today's date would otherwise be rejected for a date "in the future".
 */
export function assertCoachingDateNotFuture(date: string, today: string = cairoTodayIso()) {
  if (date > today) {
    throw new Error(
      `Coaching date ${date} is in the future. A coaching report can only be dated today (${today}) or earlier.`,
    );
  }
}

function toNumber(value: number | string | null | undefined) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function idsMatch(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeHrId(left);
  const b = normalizeHrId(right);
  return Boolean(a && b && a === b);
}

function actorId(access: AccessContext) {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
}

function requireActorHrId(access: AccessContext) {
  const hrId = normalizeHrId(access.hrId);
  if (!hrId) {
    throw new Error("A linked employee HR_ID is required for coaching actions.");
  }
  return hrId;
}

function assertCanManageCoachingLifecycle(access: AccessContext) {
  if (!canManageCoachingReports(access)) {
    throw new Error(
      "Forbidden: Only coaching roles (Training Manager, Product Manager, Group Product Manager) or Super Admin can manage coaching reports.",
    );
  }
}

function assertOwnDraftOrOverride(access: AccessContext, report: CoachingReportRow) {
  if (access.scope === "system" || access.role === "Super Admin") return;
  if (!idsMatch(access.hrId, report.coach_hr_id)) {
    throw new Error("Forbidden: A coach can only update and submit their own coaching drafts.");
  }
}

// UI-gating mirror of the submitCoachingReport authorization checks (lifecycle role +
// own-draft-or-override), so a Submit button only renders when the click would actually
// succeed. The server call remains the authoritative check (workflow registry + permission
// matrix overrides can still deny it), so this stays intentionally narrower than a full re-run
// of submitCoachingReport's assertions.
export function canSubmitCoachingDraft(
  access: AccessContext,
  report: Pick<CoachingReportRow, "coach_hr_id" | "status">,
) {
  if (report.status !== "draft") return false;
  if (!canManageCoachingReports(access)) return false;
  if (access.scope === "system" || access.role === "Super Admin") return true;
  return idsMatch(access.hrId, report.coach_hr_id);
}

function findEmployee(rows: EmployeeDirectoryRow[], hrId: string) {
  return rows.find((row) => idsMatch(row.hrId, hrId)) ?? null;
}

function buildCanonicalDirectory(rows: EmployeeDirectoryRow[]) {
  const byCanonicalHrId = new Map<string, EmployeeDirectoryRow>();
  for (const row of rows) {
    const key = normalizeHrId(row.hrId);
    if (key) byCanonicalHrId.set(key, row);
  }
  return byCanonicalHrId;
}

export function canAccessCoachingEmployee(
  access: AccessContext,
  employee: EmployeeDirectoryRow,
  directory: EmployeeDirectoryRow[],
  // Retained for call-site compatibility (callers pass the resolved coach). No longer consulted:
  // org-wide oversight roles (incl. Training Manager) short-circuit below, and own-draft write
  // scoping is enforced separately by assertOwnDraftOrOverride.
  _coach?: EmployeeDirectoryRow | null,
) {
  if (access.scope === "system" || coachingOversightRoles.has(access.role)) return true;
  const currentHrId = normalizeHrId(access.hrId);
  if (!currentHrId) return false;
  if (idsMatch(currentHrId, employee.hrId)) return true;
  // THE DOWNWARD RULE (owner, 2026-09-04) on the LINE-scoped branch — line membership is neither up
  // nor down, so a Product Manager's line includes his own manager. Chain cut first, ahead of the
  // direct-report shortcut, so a cyclic manager link can never re-admit an ancestor.
  const lineCut = lineRoles.has(access.role) ? downwardCutFor(access, directory) : null;
  if (lineCut?.isAboveViewer(employee)) return false;
  // TEAM (direct report): seat-continuity aware so a manager keeps their team
  // after a sub-manager resignation (vacant-seat marker), staying consistent with
  // the organogram. See src/lib/workforce/hierarchy-resolver.ts.
  if (reportsToManagerSeat({ employee, viewerCanonicalHrId: currentHrId, canonicalize: normalizeHrId })) {
    return true;
  }
  if (access.role === "Regional Manager" || access.role === "Manager") {
    // HIERARCHY: seat-continuity aware management-chain membership.
    return isWithinManagerHierarchy({
      employee,
      byCanonicalHrId: buildCanonicalDirectory(directory),
      viewerCanonicalHrId: currentHrId,
      canonicalize: normalizeHrId,
    });
  }
  if (lineRoles.has(access.role)) {
    const accessor = findEmployee(directory, currentHrId);
    if (!accessor) return false;
    // GPM and PM see ALL employees on their product line regardless of department, so they get a
    // full cross-department line view in coaching. A Product Manager sits in the Marketing
    // department while the reps he coaches sit in Sales, so "same department" hid every rep on his
    // own line from him (owner, 2026-10-20: every role a module applies to must find its people).
    // The ladder below still keeps him to the seats strictly beneath his own.
    // National Sales Manager stays department-safe — same line AND same department only, so a Sales
    // role never sees Marketing on a shared line.
    const onLine =
      access.role === "Group Product Manager" || access.role === "Product Manager"
        ? sameWorkforceLine(accessor, employee)
        : lineScopeIncludesEmployee(accessor, employee);
    if (!onLine) return false;
    // Cut 2 — the seat-rank ladder (peers, anyone above, unranked titles). Narrow-only: someone on
    // the line who genuinely sits in the viewer's own reporting subtree stays visible even with an
    // off-ladder title, because that subtree is downward by construction.
    if (!lineCut || lineCut.isStrictlyBelowViewer(employee)) return true;
    return isWithinManagerHierarchy({
      employee,
      byCanonicalHrId: buildCanonicalDirectory(directory),
      viewerCanonicalHrId: currentHrId,
      canonicalize: normalizeHrId,
    });
  }
  return false;
}

/**
 * The people a coaching analytics page may put in front of this viewer: the directory narrowed by
 * the SAME rule that scopes the reports (canAccessCoachingEmployee). The rep comparison, the
 * coverage table and the line/area filter options are built from the directory, not from the
 * reports, so handing them the whole company listed every line's reps as "never coached" to a
 * manager who may open only his own (owner, 2026-10-20). Oversight roles get the directory as-is.
 */
export function scopeCoachingDirectoryForAccess(
  access: AccessContext,
  employees: EmployeeDirectoryRow[],
): EmployeeDirectoryRow[] {
  if (access.scope === "system" || coachingOversightRoles.has(access.role)) return employees;
  return employees.filter((employee) => canAccessCoachingEmployee(access, employee, employees));
}

// filterSummariesForAccess calls canAccessCoachingEmployee once per report against the same
// directory array, so the O(directory) cut is built once per (directory, viewer, role).
const downwardCutCache = new WeakMap<EmployeeDirectoryRow[], Map<string, DownwardCut>>();

function downwardCutFor(access: AccessContext, directory: EmployeeDirectoryRow[]): DownwardCut {
  const cacheKey = `${access.role}|${normalizeHrId(access.hrId) ?? ""}`;
  let byViewer = downwardCutCache.get(directory);
  if (!byViewer) {
    byViewer = new Map();
    downwardCutCache.set(directory, byViewer);
  }
  let cut = byViewer.get(cacheKey);
  if (!cut) {
    cut = buildDownwardCut({ role: access.role, viewerHrId: access.hrId ?? null, employees: directory });
    byViewer.set(cacheKey, cut);
  }
  return cut;
}

function assertCanAccessEmployee(
  access: AccessContext,
  employee: EmployeeDirectoryRow,
  directory: EmployeeDirectoryRow[],
  coach?: EmployeeDirectoryRow | null,
) {
  if (!canAccessCoachingEmployee(access, employee, directory, coach)) {
    throw new Error(`Forbidden: ${access.role} cannot access coaching reports for this employee.`);
  }
}

function mapSummary(row: CoachingSummaryDbRow): CoachingReportSummaryRow {
  return {
    acknowledged: Boolean(row.acknowledged),
    acknowledgedAt: row.acknowledged_at,
    actualScore: toNumber(row.actual_score),
    areaId: row.area_id,
    areaName: row.area_name,
    coachHrId: row.coach_hr_id,
    coachName: row.coach_name,
    coachingDate: row.coaching_date,
    coachingMonth: Number(row.coaching_month),
    coachingQuarter: Number(row.coaching_quarter),
    coachingYear: Number(row.coaching_year),
    createdAt: row.created_at,
    finalScorePercent: toNumber(row.final_score_percent),
    lineId: row.line_id,
    lineName: row.line_name,
    maxScore: toNumber(row.max_score),
    medicalRepHrId: row.medical_rep_hr_id,
    medicalRepName: row.medical_rep_name,
    performanceZone: row.performance_zone as CoachingPerformanceZone | null,
    reportId: row.report_id,
    reportNumber: row.report_number,
    status: row.status,
    submittedAt: row.submitted_at,
    teamId: row.team_id,
    teamName: row.team_name,
    updatedAt: row.updated_at,
  };
}

function applyCoachingDisplayName(
  row: CoachingReportSummaryRow,
  directory: EmployeeDirectoryRow[],
): CoachingReportSummaryRow {
  const coach = findEmployee(directory, row.coachHrId);
  const medicalRep = findEmployee(directory, row.medicalRepHrId);
  return {
    ...row,
    coachName: coach?.displayName || row.coachName,
    medicalRepName: medicalRep?.displayName || row.medicalRepName,
  };
}

function mapQuarterly(row: CoachingQuarterlySummaryDbRow): CoachingQuarterlySummaryRow {
  return {
    averageScore: toNumber(row.average_score),
    bestScore: toNumber(row.best_score),
    coachingCount: Number(row.coaching_count ?? 0),
    firstScore: toNumber(row.first_score),
    improvementScore: toNumber(row.improvement_score),
    latestScore: toNumber(row.latest_score),
    latestZone: row.latest_zone as CoachingPerformanceZone | null,
    lowestScore: toNumber(row.lowest_score),
    medicalRepHrId: row.medical_rep_hr_id,
    quarter: Number(row.quarter),
    year: Number(row.year),
  };
}

export function coachingErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

type CoachingAuditInput = {
  action: CoachingReportAuditAction;
  actor: string;
  metadata?: Record<string, unknown>;
  newValues?: Record<string, unknown> | null;
  oldValues?: Record<string, unknown> | null;
  reportId: string;
};

async function writeGenericCoachingAudit(input: CoachingAuditInput) {
  const supabase = getSupabaseAdmin();

  // Generic audit_logs may have tenant-specific constraints/enums. Coaching's
  // module audit trail is the reliable source, so generic audit failures must
  // never block the coaching lifecycle action.
  const { error } = await supabase.from("audit_logs").insert({
    actor_login_id: input.actor,
    entity_id: input.reportId,
    entity_type: "coaching_report",
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    summary: `Coaching report ${input.action.replace(/_/g, " ")}`,
  });
  if (error) {
    console.warn("Non-blocking generic coaching audit write failed.", coachingErrorMessage(error));
  }
}

async function writeCoachingAudit(input: CoachingAuditInput) {
  const supabase = getSupabaseAdmin();
  const payload = {
    action: input.action,
    actor_hr_id: input.actor,
    metadata: input.metadata ?? {},
    new_values: input.newValues ?? null,
    old_values: input.oldValues ?? null,
    report_id: input.reportId,
  };

  const { error } = await supabase.from("coaching_report_audit_logs").insert(payload);
  if (error) throw error;

  await writeGenericCoachingAudit(input);
}

async function loadReport(id: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_reports")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return (data as CoachingReportRow | null) ?? null;
}

async function loadScores(reportId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_score_items")
    .select("*")
    .eq("report_id", reportId)
    .order("display_order", { ascending: true });

  if (error) throw error;
  return (data ?? []) as CoachingScoreItemRow[];
}

async function replaceScores(reportId: string, input: NonNullable<CoachingReportMutationInput["scores"]>) {
  const result = calculateCoachingScore(input);
  const supabase = getSupabaseAdmin();

  const { error: deleteError } = await supabase
    .from("coaching_score_items")
    .delete()
    .eq("report_id", reportId);
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabase
    .from("coaching_score_items")
    .insert(toCoachingScoreRows(reportId, result, input));
  if (insertError) throw insertError;

  return result;
}

function scoreInputFromRows(rows: CoachingScoreItemRow[]) {
  return Object.fromEntries(rows.map((row) => [row.score_item_key, row.score]));
}

export async function createDraftCoachingReport(input: CoachingReportCreateInput, access: AccessContext) {
  // The old form takes no new reports (owner, 2026-10-31) — the Team Coaching Skills Survey replaced it.
  refuseOldCoachingFormCreate();
  await assertCoachingWorkflowTransition({
    access,
    actionKey: "create_draft",
    expectedNextStatus: "draft",
    status: "draft",
  });
  assertCanManageCoachingLifecycle(access);
  const coachHrId = requireActorHrId(access);
  const directory = await getEmployeeDirectoryRows();
  const medicalRepHrId = cleanText(input.medicalRepHrId)?.toUpperCase();
  if (!medicalRepHrId) throw new Error("Medical Rep HR_ID is required.");

  const medicalRep = findEmployee(directory, medicalRepHrId);
  if (!medicalRep) throw new Error("Medical Rep was not found in employees.");

  const coach = findEmployee(directory, coachHrId);
  if (!coach) throw new Error("Coach was not found in employees.");
  assertCanAccessEmployee(access, medicalRep, directory, coach);

  const coachingDate = normalizeDate(input.coachingDate);
  if (!coachingDate) throw new Error("A valid coaching date is required.");
  assertCoachingDateNotFuture(coachingDate);

  const scoreResult = input.scores ? calculateCoachingScore(input.scores) : null;
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_reports")
    .insert({
      actual_score: scoreResult?.actualScore ?? 0,
      area_id: medicalRep.areaId,
      area_of_development: cleanText(input.areaOfDevelopment),
      coach_hr_id: coach.hrId,
      coach_role: access.role,
      coaching_date: coachingDate,
      created_by: actorId(access),
      final_score_percent: scoreResult?.finalScorePercent ?? 0,
      general_remarks: cleanText(input.generalRemarks),
      line_id: medicalRep.lineId,
      max_score: scoreResult?.maxScore ?? coachingMaxScore,
      medical_rep_hr_id: medicalRep.hrId,
      performance_zone: scoreResult?.performanceZone ?? null,
      status: "draft",
      strength_points: cleanText(input.strengthPoints),
      team_id: medicalRep.teamId,
      updated_at: now,
      updated_by: actorId(access),
    })
    .select("*")
    .single();

  if (error) throw error;
  const report = data as CoachingReportRow;
  if (scoreResult && input.scores) {
    await replaceScores(report.id, input.scores);
  }
  await writeCoachingAudit({
    action: "created_draft",
    actor: actorId(access),
    newValues: { medicalRepHrId: medicalRep.hrId, score: scoreResult?.finalScorePercent ?? 0 },
    reportId: report.id,
  });

  return getCoachingReportById(report.id, access);
}

export async function updateDraftCoachingReport(
  id: string,
  input: CoachingReportMutationInput,
  access: AccessContext,
) {
  const report = await loadReport(id);
  if (!report) throw new Error("Coaching report was not found.");
  if (!editableStatuses.has(report.status)) {
    throw new Error("Only draft coaching reports can be edited.");
  }
  await assertCoachingWorkflowTransition({
    access,
    actionKey: "update_draft",
    status: report.status,
  });
  assertCanManageCoachingLifecycle(access);
  assertOwnDraftOrOverride(access, report);

  const directory = await getEmployeeDirectoryRows();
  const coach = findEmployee(directory, report.coach_hr_id);
  const medicalRep = findEmployee(directory, report.medical_rep_hr_id);
  if (!medicalRep) throw new Error("Medical Rep was not found in employees.");
  assertCanAccessEmployee(access, medicalRep, directory, coach);

  const updates: Record<string, unknown> = {
    updated_by: actorId(access),
  };

  if (input.coachingDate !== undefined) {
    const date = normalizeDate(input.coachingDate);
    if (!date) throw new Error("A valid coaching date is required.");
    assertCoachingDateNotFuture(date);
    updates.coaching_date = date;
  }
  if (input.areaOfDevelopment !== undefined) updates.area_of_development = cleanText(input.areaOfDevelopment);
  if (input.strengthPoints !== undefined) updates.strength_points = cleanText(input.strengthPoints);
  if (input.generalRemarks !== undefined) updates.general_remarks = cleanText(input.generalRemarks);

  let scoreResult = null;
  if (input.scores) {
    scoreResult = await replaceScores(id, input.scores);
    updates.actual_score = scoreResult.actualScore;
    updates.max_score = scoreResult.maxScore;
    updates.final_score_percent = scoreResult.finalScorePercent;
    updates.performance_zone = scoreResult.performanceZone;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("coaching_reports")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  await writeCoachingAudit({
    action: "updated_draft",
    actor: actorId(access),
    newValues: updates,
    oldValues: {
      coachingDate: report.coaching_date,
      finalScorePercent: report.final_score_percent,
      status: report.status,
    },
    reportId: id,
  });

  return getCoachingReportById((data as CoachingReportRow).id, access);
}

export async function submitCoachingReport(
  id: string,
  input: Pick<CoachingReportMutationInput, "areaOfDevelopment" | "generalRemarks" | "scores" | "strengthPoints"> | null,
  access: AccessContext,
) {
  const report = await loadReport(id);
  if (!report) throw new Error("Coaching report was not found.");
  if (!editableStatuses.has(report.status)) {
    throw new Error("Only draft coaching reports can be submitted.");
  }
  await assertCoachingWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "submitted",
    status: report.status,
  });
  assertCanManageCoachingLifecycle(access);
  assertOwnDraftOrOverride(access, report);

  const directory = await getEmployeeDirectoryRows();
  const medicalRep = findEmployee(directory, report.medical_rep_hr_id);
  if (!medicalRep) throw new Error("Medical Rep was not found in employees.");
  assertCanAccessEmployee(access, medicalRep, directory, findEmployee(directory, report.coach_hr_id));

  const scorePayload = input?.scores ? normalizeCoachingScoreItems(input.scores) : null;
  const existingScores = scorePayload ? [] : await loadScores(id);
  if (!scorePayload && existingScores.length !== 20) {
    throw new Error("Exactly 20 coaching scores are required before submission.");
  }

  const scoreResult = scorePayload
    ? calculateCoachingScore(input?.scores ?? {})
    : calculateCoachingScore(scoreInputFromRows(existingScores));

  const { data, error } = await getSupabaseAdmin().rpc("submit_coaching_report", {
    p_actor_hr_id: actorId(access),
    p_area_of_development: input && "areaOfDevelopment" in input ? cleanText(input.areaOfDevelopment) : null,
    p_general_remarks: input && "generalRemarks" in input ? cleanText(input.generalRemarks) : null,
    p_report_id: id,
    p_scores: scorePayload,
    p_strength_points: input && "strengthPoints" in input ? cleanText(input.strengthPoints) : null,
  });

  if (error) throw error;
  await writeGenericCoachingAudit({
    action: "submitted",
    actor: actorId(access),
    newValues: { finalScorePercent: scoreResult.finalScorePercent, status: "submitted" },
    oldValues: { status: report.status },
    reportId: id,
  });

  return getCoachingReportById((data as CoachingReportRow).id, access);
}

export async function lockSubmittedCoachingReport(id: string, access: AccessContext) {
  const report = await loadReport(id);
  if (!report) throw new Error("Coaching report was not found.");
  if (!submittedStatuses.has(report.status)) {
    throw new Error("Only submitted or employee-reviewed coaching reports can be locked.");
  }
  await assertCoachingWorkflowTransition({
    access,
    actionKey: "lock",
    expectedNextStatus: "locked",
    status: report.status,
  });

  const directory = await getEmployeeDirectoryRows();
  const medicalRep = findEmployee(directory, report.medical_rep_hr_id);
  if (!medicalRep) throw new Error("Medical Rep was not found in employees.");
  assertCanAccessEmployee(access, medicalRep, directory, findEmployee(directory, report.coach_hr_id));

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_reports")
    .update({
      locked_at: now,
      status: "locked",
      updated_by: actorId(access),
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  await writeCoachingAudit({
    action: "locked",
    actor: actorId(access),
    newValues: { status: "locked" },
    oldValues: { status: report.status },
    reportId: id,
  });

  return getCoachingReportById((data as CoachingReportRow).id, access);
}

export async function acknowledgeCoachingReport(
  id: string,
  access: AccessContext,
  input: CoachingAcknowledgmentInput = {},
) {
  const employeeHrId = requireActorHrId(access);
  const report = await loadReport(id);
  if (!report) throw new Error("Coaching report was not found.");
  await assertCoachingWorkflowTransition({
    access,
    actionKey: "acknowledge",
    expectedNextStatus: "reviewed_by_employee",
    status: report.status,
  });
  const acknowledgmentText = cleanText(input.acknowledgmentText) ?? "I acknowledge and submit this coaching report review.";
  const { data, error } = await getSupabaseAdmin().rpc("acknowledge_coaching_report", {
    p_acknowledgment_text: acknowledgmentText,
    p_employee_hr_id: employeeHrId,
    p_ip_address: cleanText(input.ipAddress),
    p_report_id: id,
    p_user_agent: cleanText(input.userAgent),
  });

  if (error) throw error;
  await writeGenericCoachingAudit({
    action: "acknowledged",
    actor: actorId(access),
    metadata: { acknowledgmentText },
    newValues: { status: "reviewed_by_employee" },
    oldValues: { status: report.status },
    reportId: id,
  });

  return getCoachingReportById((data as CoachingReportRow).id, access);
}

/**
 * Acknowledge a coaching report on behalf of the medical rep when backfilling
 * historical reports via the Excel importer. Calls the acknowledge RPC directly
 * (with the rep's HR_ID) so it is not gated by the interactive employee-only
 * workflow check; the RPC still enforces that the HR_ID matches the report's rep
 * and that the report is in the "submitted" state.
 */
export async function acknowledgeImportedCoachingReport(
  id: string,
  employeeHrId: string,
  acknowledgmentText = "Acknowledged automatically on historical coaching report import.",
) {
  const { error } = await getSupabaseAdmin().rpc("acknowledge_coaching_report", {
    p_acknowledgment_text: acknowledgmentText,
    p_employee_hr_id: employeeHrId,
    p_ip_address: null,
    p_report_id: id,
    p_user_agent: null,
  });
  if (error) throw error;
}

export async function getCoachingReportById(id: string, access: AccessContext): Promise<CoachingReportDetail> {
  const [report, scores, summaries] = await Promise.all([
    loadReport(id),
    loadScores(id),
    getSupabaseAdmin().from("coaching_reports_summary").select("*").eq("report_id", id).maybeSingle(),
  ]);

  if (!report) throw new Error("Coaching report was not found.");

  // includeInactive: a resigned/terminated Medical Rep's own historical report must still
  // resolve here — assertCanAccessEmployee below is the real access-scope gate and operates
  // correctly on the employee row regardless of status.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const medicalRep = findEmployee(directory, report.medical_rep_hr_id);
  if (!medicalRep) throw new Error("Medical Rep was not found in employees.");
  assertCanAccessEmployee(access, medicalRep, directory, findEmployee(directory, report.coach_hr_id));

  if (summaries.error) throw summaries.error;
  const scoreResult = scores.length === 20 ? calculateCoachingScore(scoreInputFromRows(scores)) : null;

  return {
    report,
    scoreResult,
    scores,
    summary: summaries.data
      ? applyCoachingDisplayName(mapSummary(summaries.data as CoachingSummaryDbRow), directory)
      : null,
  };
}

// Batched equivalent of calling getCoachingReportById once per id: 3 queries total (report +
// scores + summary, each fetched once with .in(ids)) plus one cached directory read, instead of
// up to 3N queries. Same fail-together semantics as Promise.all(ids.map(getCoachingReportById)) —
// a missing report or an access-scope violation on any id throws and aborts the whole batch.
export async function getCoachingReportsByIds(ids: string[], access: AccessContext): Promise<CoachingReportDetail[]> {
  if (ids.length === 0) return [];
  const supabase = getSupabaseAdmin();
  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — coachingRange() allows up to 1000 ids here, so batch every .in().
  const reportRows: CoachingReportRow[] = [];
  const scoreRows: CoachingScoreItemRow[] = [];
  const summaryRows: CoachingSummaryDbRow[] = [];
  const [, directory] = await Promise.all([
    (async () => {
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const [reportsResult, scoresResult, summariesResult] = await Promise.all([
          supabase.from("coaching_reports").select("*").in("id", batch),
          supabase.from("coaching_score_items").select("*").in("report_id", batch).order("display_order", { ascending: true }),
          supabase.from("coaching_reports_summary").select("*").in("report_id", batch),
        ]);
        if (reportsResult.error) throw reportsResult.error;
        if (scoresResult.error) throw scoresResult.error;
        if (summariesResult.error) throw summariesResult.error;
        reportRows.push(...((reportsResult.data ?? []) as CoachingReportRow[]));
        scoreRows.push(...((scoresResult.data ?? []) as CoachingScoreItemRow[]));
        summaryRows.push(...((summariesResult.data ?? []) as CoachingSummaryDbRow[]));
      }
    })(),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);

  const reportsById = new Map(reportRows.map((row) => [row.id, row]));
  const scoresByReportId = new Map<string, CoachingScoreItemRow[]>();
  for (const row of scoreRows) {
    const list = scoresByReportId.get(row.report_id) ?? [];
    list.push(row);
    scoresByReportId.set(row.report_id, list);
  }
  const summaryByReportId = new Map(summaryRows.map((row) => [row.report_id, row]));

  return ids.map((id) => {
    const report = reportsById.get(id);
    if (!report) throw new Error("Coaching report was not found.");

    const medicalRep = findEmployee(directory, report.medical_rep_hr_id);
    if (!medicalRep) throw new Error("Medical Rep was not found in employees.");
    assertCanAccessEmployee(access, medicalRep, directory, findEmployee(directory, report.coach_hr_id));

    const scores = (scoresByReportId.get(id) ?? []).slice().sort((a, b) => a.display_order - b.display_order);
    const scoreResult = scores.length === 20 ? calculateCoachingScore(scoreInputFromRows(scores)) : null;
    const summary = summaryByReportId.get(id);

    return {
      report,
      scoreResult,
      scores,
      summary: summary ? applyCoachingDisplayName(mapSummary(summary), directory) : null,
    };
  });
}

async function filterSummariesForAccess(rows: CoachingReportSummaryRow[], access: AccessContext) {
  if (access.scope === "system" || coachingOversightRoles.has(access.role)) return rows;
  // includeInactive: scoped (non-oversight) roles must see the same historical rows for a
  // resigned rep that oversight roles already see — canAccessCoachingEmployee below is the
  // real access-scope gate and operates correctly on the employee row regardless of status.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const coach = access.hrId ? findEmployee(directory, access.hrId) : null;
  return rows.filter((row) => {
    const employee = findEmployee(directory, row.medicalRepHrId);
    return employee ? canAccessCoachingEmployee(access, employee, directory, coach) : false;
  });
}

export async function getCoachingReports(filters: CoachingReportFilters, access: AccessContext) {
  let query = getSupabaseAdmin()
    .from("coaching_reports_summary")
    .select("*");

  if (filters.medicalRepHrId) query = query.eq("medical_rep_hr_id", String(filters.medicalRepHrId).toUpperCase());
  if (filters.coachHrId) query = query.eq("coach_hr_id", String(filters.coachHrId).toUpperCase());
  if (filters.lineId) query = query.eq("line_id", Number(filters.lineId));
  if (filters.areaId) query = query.eq("area_id", Number(filters.areaId));
  if (filters.teamId) query = query.eq("team_id", Number(filters.teamId));
  if (filters.status) query = query.eq("status", String(filters.status));
  if (filters.performanceZone) query = query.eq("performance_zone", String(filters.performanceZone));
  if (filters.month) query = query.eq("coaching_month", Number(filters.month));
  if (filters.quarter) query = query.eq("coaching_quarter", Number(filters.quarter));
  if (filters.year) query = query.eq("coaching_year", Number(filters.year));
  if (filters.dateFrom) query = query.gte("coaching_date", String(filters.dateFrom).slice(0, 10));
  if (filters.dateTo) query = query.lte("coaching_date", String(filters.dateTo).slice(0, 10));

  query = query
    .order("coaching_date", { ascending: false })
    .order("created_at", { ascending: false });
  const { from, to } = coachingRange(filters);
  query = query.range(from, to);

  const { data, error } = await query;
  if (error) throw error;

  const directory = await getEmployeeDirectoryRows();
  const summaries = ((data ?? []) as CoachingSummaryDbRow[]).map((row) =>
    applyCoachingDisplayName(mapSummary(row), directory),
  );
  return filterSummariesForAccess(summaries, access);
}

export async function getMyCoachingReports(access: AccessContext) {
  const hrId = requireActorHrId(access);
  return getCoachingReports({ medicalRepHrId: hrId }, access);
}

export async function getTeamCoachingReports(access: AccessContext, filters: CoachingReportFilters = {}) {
  requireActorHrId(access);
  return getCoachingReports(filters, access);
}

export async function getCoachingQuarterlySummary(filters: Pick<CoachingReportFilters, "medicalRepHrId" | "quarter" | "year">, access: AccessContext) {
  let query = getSupabaseAdmin()
    .from("coaching_quarterly_summary")
    .select("*")
    .order("year", { ascending: false })
    .order("quarter", { ascending: false });

  if (filters.medicalRepHrId) query = query.eq("medical_rep_hr_id", String(filters.medicalRepHrId).toUpperCase());
  if (filters.year) query = query.eq("year", Number(filters.year));
  if (filters.quarter) query = query.eq("quarter", Number(filters.quarter));

  const { data, error } = await query;
  if (error) throw error;

  const rows = ((data ?? []) as CoachingQuarterlySummaryDbRow[]).map(mapQuarterly);
  if (access.scope === "system" || coachingOversightRoles.has(access.role)) return rows;

  const visibleReports = await getCoachingReports({ medicalRepHrId: filters.medicalRepHrId }, access);
  const visibleHrIds = new Set(visibleReports.map((row) => normalizeHrId(row.medicalRepHrId)));
  return rows.filter((row) => visibleHrIds.has(normalizeHrId(row.medicalRepHrId)));
}

export async function getCoachingScoreAnalyticsForReports(
  reports: CoachingReportSummaryRow[],
): Promise<CoachingScoreAnalytics> {
  const reportIds = reports
    .filter((report) => submittedStatuses.has(report.status) || report.status === "locked")
    .map((report) => report.reportId);

  if (reportIds.length === 0) return emptyCoachingScoreAnalytics;

  // PostgREST folds every .in() value into the request URL; batch since reportIds can reach the
  // same coachingRange()-capped scale as getCoachingReportsByIds above.
  const rows: CoachingScoreAnalyticsInputRow[] = [];
  for (let i = 0; i < reportIds.length; i += 100) {
    const batch = reportIds.slice(i, i + 100);
    const { data, error } = await getSupabaseAdmin()
      .from("coaching_score_items")
      .select("report_id,parameter_category,score_item_key,score_item_label,score")
      .in("report_id", batch);
    if (error) throw error;
    rows.push(...((data ?? []) as CoachingScoreAnalyticsInputRow[]));
  }

  return buildCoachingScoreAnalytics(rows);
}
