import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { getDoubleVisitRows } from "@/lib/crm/reads";
import { withinWindow } from "./intelligence/dv-validation";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeedbackSubmitterRole = "dm" | "nsm" | "tm" | "pm_gpm";

export type FeedbackRecommendation =
  | "recommend_pass"
  | "recommend_dismissal"
  | "not_sure_yet";

export type FeedbackSubmission = {
  id: string;
  probationId: number;
  employeeHrId: string;
  cycleNumber: number;
  cycleKey: string;
  submitterHrId: string;
  submitterRole: FeedbackSubmitterRole;
  feedbackText: string;
  recommendation: FeedbackRecommendation;
  isOnceOnly: boolean;
  submittedAt: string;
  comments: FeedbackComment[];
};

export type FeedbackComment = {
  id: string;
  submissionId: string;
  commenterHrId: string;
  commenterName: string | null;
  commentText: string;
  createdAt: string;
};

export type FeedbackEligibility = {
  eligible: boolean;
  submitterRole: FeedbackSubmitterRole | null;
  isOnceOnly: boolean;
  alreadySubmittedForCycle: boolean;
  alreadySubmittedOnce: boolean;
  currentCycleNumber: number;
  currentCycleKey: string | null;
  probationId: number | null;
};

export type DvCheckboxState = {
  dmDvDone: boolean;
  dmDvDoneAt: string | null;
  dmDvDoneManually: boolean;
  nsmDvDone: boolean;
  nsmDvDoneAt: string | null;
  nsmDvDoneManually: boolean;
  pmGpmDvDone: boolean | null;
  pmGpmDvDoneAt: string | null;
  pmGpmDvDoneManually: boolean;
  tmDvDone: boolean;
  tmDvDoneAt: string | null;
  tmDvDoneManually: boolean;
};

export type AggregateFeedbackRow = {
  employeeHrId: string;
  employeeName: string;
  lineName: string | null;
  hireDate: string | null;
  probationEndDate: string | null;
  probationId: number | null;
  dvCheckboxes: DvCheckboxState | null;
  dvDoneCount: number;
  dvTotalApplicable: number;
  submissions: Array<{
    cycleNumber: number;
    submitterRole: FeedbackSubmitterRole;
    submitterHrId: string;
    recommendation: FeedbackRecommendation;
    submittedAt: string;
  }>;
};

// ── Cycle resolution ──────────────────────────────────────────────────────────

const CYCLE_KEYS = [
  "probation_day_30_check",         // cycle 1 — day 30 (60 days remaining)
  "probation_30_days_remaining",    // cycle 2 — day 60 (30 days remaining)
  "probation_15_days_remaining",    // cycle 3 — day 75 (15 days remaining)
] as const;

export function cycleKeyToNumber(cycleKey: string): number {
  const idx = CYCLE_KEYS.indexOf(cycleKey as (typeof CYCLE_KEYS)[number]);
  return idx >= 0 ? idx + 1 : 1;
}

// Returns the cycle number and key of the most recently processed notification
// event for this employee. Falls back to cycle 1 if none have fired yet.
export async function getCurrentCycleInfo(employeeHrId: string): Promise<{
  cycleNumber: number;
  cycleKey: string;
}> {
  const hrId = normalizeHrId(employeeHrId);
  if (!hrId) return { cycleNumber: 1, cycleKey: CYCLE_KEYS[0] };

  const { data } = await getSupabaseAdmin()
    .from("notification_events")
    .select("metadata")
    .eq("category", "probation")
    .ilike("employee_hr_id", hrId)
    .in("status", ["sent", "processed"])
    .order("scheduled_for", { ascending: false })
    .limit(10);

  if (!data || data.length === 0) return { cycleNumber: 1, cycleKey: CYCLE_KEYS[0] };

  // Find the latest sent cycle by checking metadata.reminder_type
  for (const row of data) {
    const reminderType = (row as { metadata?: { reminder_type?: string } }).metadata?.reminder_type;
    if (reminderType && CYCLE_KEYS.includes(reminderType as (typeof CYCLE_KEYS)[number])) {
      const cycleNumber = cycleKeyToNumber(reminderType);
      return { cycleNumber, cycleKey: reminderType };
    }
  }
  return { cycleNumber: 1, cycleKey: CYCLE_KEYS[0] };
}

// ── Role resolution ───────────────────────────────────────────────────────────

async function resolveProbationRecord(employeeHrId: string): Promise<{
  id: number;
  pm_gpm_dv_done: boolean | null;
} | null> {
  const hrId = normalizeHrId(employeeHrId);
  if (!hrId) return null;
  const { data } = await getSupabaseAdmin()
    .from("employee_probation")
    .select("id,pm_gpm_dv_done")
    .ilike("hr_id", hrId)
    .eq("status", "active")
    .maybeSingle();
  return data as { id: number; pm_gpm_dv_done: boolean | null } | null;
}

async function resolveSubmitterRole(
  access: AccessContext,
  employeeHrId: string,
): Promise<{ role: FeedbackSubmitterRole | null; isOnceOnly: boolean }> {
  const callerHrId = normalizeHrId(access.hrId);
  if (!callerHrId) return { role: null, isOnceOnly: false };

  const db = getSupabaseAdmin();

  // Check if caller is the direct manager of this employee
  const { data: emp } = await db
    .from("employees")
    .select("manager_hr_id,line_name")
    .ilike("hr_id", normalizeHrId(employeeHrId) ?? "")
    .maybeSingle();

  if (emp) {
    const dmHrId = normalizeHrId((emp as { manager_hr_id?: string | null }).manager_hr_id);
    if (dmHrId && dmHrId === callerHrId) {
      return { role: "dm", isOnceOnly: false };
    }
  }

  // Check app_auth_users for role
  const { data: authUser } = await db
    .from("app_auth_users")
    .select("role")
    .ilike("hr_id", callerHrId)
    .eq("is_active", true)
    .maybeSingle();

  const appRole = (authUser as { role?: string } | null)?.role ?? "";

  if (appRole === "National Sales Manager") return { role: "nsm", isOnceOnly: false };
  if (appRole === "Training Manager") return { role: "tm", isOnceOnly: true };
  if (appRole === "Product Manager" || appRole === "Group Product Manager") {
    // Skip PM/GPM for CNS line employees
    const lineName = (emp as { line_name?: string | null } | null)?.line_name ?? "";
    if (lineName.toLowerCase() === "cns") return { role: null, isOnceOnly: false };
    return { role: "pm_gpm", isOnceOnly: true };
  }

  return { role: null, isOnceOnly: false };
}

// ── Eligibility check ─────────────────────────────────────────────────────────

export async function checkFeedbackEligibility(
  access: AccessContext,
  employeeHrId: string,
): Promise<FeedbackEligibility> {
  const [probationRecord, cycleInfo, roleResult] = await Promise.all([
    resolveProbationRecord(employeeHrId),
    getCurrentCycleInfo(employeeHrId),
    resolveSubmitterRole(access, employeeHrId),
  ]);

  const canSeeAll = access.role === "Super Admin" || access.role === "CEO";
  if (!canSeeAll && !roleResult.role) {
    throw new Error("Forbidden: you are not authorized to view probation feedback for this employee.");
  }

  if (!probationRecord || !roleResult.role) {
    return {
      eligible: false,
      submitterRole: null,
      isOnceOnly: false,
      alreadySubmittedForCycle: false,
      alreadySubmittedOnce: false,
      currentCycleNumber: cycleInfo.cycleNumber,
      currentCycleKey: cycleInfo.cycleKey,
      probationId: probationRecord?.id ?? null,
    };
  }

  const callerHrId = normalizeHrId(access.hrId) ?? "";
  const db = getSupabaseAdmin();

  // Check existing submissions
  const { data: existing } = await db
    .from("probation_feedback_submissions")
    .select("id,cycle_number,is_once_only")
    .eq("probation_id", probationRecord.id)
    .ilike("submitter_hr_id", callerHrId)
    .limit(10);

  const rows = (existing ?? []) as Array<{ id: string; cycle_number: number; is_once_only: boolean }>;
  const alreadySubmittedForCycle = rows.some(r => r.cycle_number === cycleInfo.cycleNumber);
  const alreadySubmittedOnce = rows.length > 0;

  const eligible = roleResult.isOnceOnly ? !alreadySubmittedOnce : !alreadySubmittedForCycle;

  return {
    eligible,
    submitterRole: roleResult.role,
    isOnceOnly: roleResult.isOnceOnly,
    alreadySubmittedForCycle,
    alreadySubmittedOnce,
    currentCycleNumber: cycleInfo.cycleNumber,
    currentCycleKey: cycleInfo.cycleKey,
    probationId: probationRecord.id,
  };
}

// ── Notify HR/CEO of new feedback submission ─────────────────────────────────

const SUBMITTER_ROLE_LABELS: Record<FeedbackSubmitterRole, string> = {
  dm: "District Manager",
  nsm: "National Sales Manager",
  tm: "Training Manager",
  pm_gpm: "PM / GPM",
};

const RECOMMENDATION_LABELS_NOTIFY: Record<FeedbackRecommendation, string> = {
  recommend_pass: "Recommend Pass",
  recommend_dismissal: "Recommend Dismissal",
  not_sure_yet: "Not Sure Yet",
};

function notifySuperAdminsOfFeedbackAsync(submission: FeedbackSubmission): void {
  (async () => {
    const db = getSupabaseAdmin();
    const [empResult, adminsResult] = await Promise.all([
      db.from("employees").select("full_name,nickname").ilike("hr_id", submission.employeeHrId).maybeSingle(),
      db.from("app_auth_users").select("hr_id").in("role", ["Super Admin", "CEO"]).eq("is_active", true),
    ]);
    const empRow = empResult.data as { full_name?: string; nickname?: string | null } | null;
    const employeeName = empRow?.full_name
      ? resolveEmployeeDisplayName(empRow.full_name, empRow.nickname)
      : submission.employeeHrId;
    const recipientHrIds = (
      (adminsResult.data ?? []) as Array<{ hr_id?: string | null }>
    )
      .map((row) => normalizeHrId(row.hr_id))
      .filter(Boolean) as string[];
    if (recipientHrIds.length === 0) return;

    const roleLabel = SUBMITTER_ROLE_LABELS[submission.submitterRole] ?? submission.submitterRole;
    const recLabel = RECOMMENDATION_LABELS_NOTIFY[submission.recommendation] ?? submission.recommendation;
    const title = `Probation feedback: ${employeeName} — Cycle ${submission.cycleNumber}`;
    const message = `${roleLabel} submitted "${recLabel}" for ${employeeName}'s cycle ${submission.cycleNumber} probation review.`;
    const ctaHref = `/api/probation/redirect?action=feedback&employeeHrId=${submission.employeeHrId}&cycle=${submission.cycleNumber}`;

    await Promise.allSettled(
      recipientHrIds.map((hrId) =>
        createSystemNotification({
          actorId: "system",
          channels: ["email", "in_app"],
          email: {
            ctaHref,
            ctaLabel: "View feedback",
            metrics: [
              { label: "Employee", value: `${employeeName} (${submission.employeeHrId})` },
              { label: "Submitted by", value: roleLabel },
              { label: "Recommendation", value: recLabel },
              { label: "Cycle", value: `Cycle ${submission.cycleNumber}` },
            ],
            notificationType: "probation",
            subject: title,
            summary: message,
            title,
            tone: "neutral",
          },
          eventType: "feedback_submitted",
          message,
          metadata: {
            cycleNumber: submission.cycleNumber,
            employeeHrId: submission.employeeHrId,
            idempotencyKey: `probation:feedback:${submission.employeeHrId}:cycle${submission.cycleNumber}:${submission.submitterRole}:${hrId}`,
            submitterRole: submission.submitterRole,
          },
          module: "probation",
          priority: "high",
          recipientHrId: hrId,
          subjectHrId: submission.employeeHrId,
          title,
        }),
      ),
    );
  })().catch(() => undefined);
}

// ── Submit feedback ───────────────────────────────────────────────────────────

export async function submitFeedback(
  access: AccessContext,
  input: {
    employeeHrId: string;
    feedbackText: string;
    recommendation: FeedbackRecommendation;
  },
): Promise<FeedbackSubmission> {
  const eligibility = await checkFeedbackEligibility(access, input.employeeHrId);
  if (!eligibility.eligible || !eligibility.submitterRole || !eligibility.probationId) {
    throw new Error("Forbidden: you are not eligible to submit feedback for this employee at this time.");
  }

  const callerHrId = normalizeHrId(access.hrId) ?? "";
  const now = new Date().toISOString();

  const { data, error } = await getSupabaseAdmin()
    .from("probation_feedback_submissions")
    .insert({
      probation_id: eligibility.probationId,
      employee_hr_id: normalizeHrId(input.employeeHrId),
      cycle_number: eligibility.currentCycleNumber,
      cycle_key: eligibility.currentCycleKey ?? CYCLE_KEYS[0],
      submitter_hr_id: callerHrId,
      submitter_role: eligibility.submitterRole,
      feedback_text: input.feedbackText.trim(),
      recommendation: input.recommendation,
      is_once_only: eligibility.isOnceOnly,
      submitted_at: now,
      created_at: now,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to save feedback: ${error.message}`);
  const submission = mapSubmission(data as RawSubmissionRow, []);
  notifySuperAdminsOfFeedbackAsync(submission);
  return submission;
}

// ── Add follow-up comment ─────────────────────────────────────────────────────

export async function addFollowUpComment(
  access: AccessContext,
  submissionId: string,
  commentText: string,
): Promise<FeedbackComment> {
  const callerHrId = normalizeHrId(access.hrId) ?? "";
  const db = getSupabaseAdmin();

  // Load submission to verify the caller is the submitter, HR, or CEO
  const { data: sub } = await db
    .from("probation_feedback_submissions")
    .select("submitter_hr_id")
    .eq("id", submissionId)
    .maybeSingle();

  if (!sub) throw new Error("Submission not found.");

  const submitterHrId = normalizeHrId((sub as { submitter_hr_id: string }).submitter_hr_id);
  const isOwn = callerHrId === submitterHrId;
  const isHrOrCeo = access.role === "Super Admin" || access.role === "CEO";
  if (!isOwn && !isHrOrCeo) throw new Error("Forbidden: you may not comment on this submission.");

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("probation_feedback_comments")
    .insert({
      submission_id: submissionId,
      commenter_hr_id: callerHrId,
      comment_text: commentText.trim(),
      created_at: now,
    })
    .select("*")
    .single();

  if (error) throw new Error(`Failed to save comment: ${error.message}`);
  return mapComment(data as RawCommentRow);
}

// ── Read feedback for one employee ────────────────────────────────────────────

export async function getFeedbackForEmployee(
  access: AccessContext,
  employeeHrId: string,
): Promise<FeedbackSubmission[]> {
  const targetHrId = normalizeHrId(employeeHrId);
  if (!targetHrId) return [];

  // Employees cannot see their own probation feedback
  if (normalizeHrId(access.hrId) === targetHrId &&
      access.role !== "Super Admin" && access.role !== "CEO") {
    throw new Error("Forbidden: employees cannot view their own probation feedback.");
  }

  const db = getSupabaseAdmin();
  const { data: submissions } = await db
    .from("probation_feedback_submissions")
    .select("*")
    .ilike("employee_hr_id", targetHrId)
    .order("submitted_at", { ascending: false });

  if (!submissions || submissions.length === 0) return [];

  const submissionIds = (submissions as RawSubmissionRow[]).map(s => s.id);
  const { data: comments } = await db
    .from("probation_feedback_comments")
    .select("*,employees(full_name,nickname)")
    .in("submission_id", submissionIds)
    .order("created_at", { ascending: true });

  const commentsBySubmissionId = new Map<string, FeedbackComment[]>();
  for (const c of (comments ?? []) as Array<RawCommentRow & { employees?: { full_name?: string; nickname?: string | null } | null }>) {
    const arr = commentsBySubmissionId.get(c.submission_id) ?? [];
    arr.push(mapComment(c, c.employees?.full_name ? resolveEmployeeDisplayName(c.employees.full_name, c.employees.nickname) : null));
    commentsBySubmissionId.set(c.submission_id, arr);
  }

  // Scope: a manager sees only their own submissions; HR/CEO/Super Admin see all
  const callerHrId = normalizeHrId(access.hrId) ?? "";
  const canSeeAll = access.role === "Super Admin" || access.role === "CEO";

  return (submissions as RawSubmissionRow[])
    .filter(s => canSeeAll || normalizeHrId(s.submitter_hr_id) === callerHrId)
    .map(s => mapSubmission(s, commentsBySubmissionId.get(s.id) ?? []));
}

// ── Aggregate report ──────────────────────────────────────────────────────────

export async function getAggregateFeedbackReport(
  access: AccessContext,
): Promise<AggregateFeedbackRow[]> {
  const canSeeAll = access.role === "Super Admin" || access.role === "CEO" || access.role === "Training Manager";
  const db = getSupabaseAdmin();

  // Fetch all active probation employees with their DV checkbox state
  const probationQuery = db
    .from("employee_probation")
    .select(`
      id,hr_id,probation_end_date,status,
      dm_dv_done,dm_dv_done_at,dm_dv_done_manually,
      nsm_dv_done,nsm_dv_done_at,nsm_dv_done_manually,
      pm_gpm_dv_done,pm_gpm_dv_done_at,pm_gpm_dv_done_manually,
      tm_dv_done,tm_dv_done_at,tm_dv_done_manually,
      employees!inner(full_name,nickname,line_name,hire_date,manager_hr_id)
    `)
    .eq("status", "active");

  const { data: probationRows } = await probationQuery;
  if (!probationRows || probationRows.length === 0) return [];

  type RawProbationRow = {
    id: number;
    hr_id: string;
    probation_end_date: string | null;
    status: string;
    dm_dv_done: boolean;
    dm_dv_done_at: string | null;
    dm_dv_done_manually: boolean;
    nsm_dv_done: boolean;
    nsm_dv_done_at: string | null;
    nsm_dv_done_manually: boolean;
    pm_gpm_dv_done: boolean | null;
    pm_gpm_dv_done_at: string | null;
    pm_gpm_dv_done_manually: boolean;
    tm_dv_done: boolean;
    tm_dv_done_at: string | null;
    tm_dv_done_manually: boolean;
    employees: { full_name?: string | null; nickname?: string | null; line_name?: string | null; hire_date?: string | null; manager_hr_id?: string | null };
  };

  const callerHrId = normalizeHrId(access.hrId) ?? "";
  const rows = (probationRows as unknown as RawProbationRow[]).filter(row => {
    if (canSeeAll) return true;
    // Managers see only direct reports
    return normalizeHrId(row.employees.manager_hr_id) === callerHrId;
  });

  if (rows.length === 0) return [];

  const probationIds = rows.map(r => r.id);
  const { data: submissions } = await db
    .from("probation_feedback_submissions")
    .select("probation_id,cycle_number,submitter_role,submitter_hr_id,recommendation,submitted_at")
    .in("probation_id", probationIds)
    .order("submitted_at", { ascending: true });

  type SubRow = {
    probation_id: number;
    cycle_number: number;
    submitter_role: FeedbackSubmitterRole;
    submitter_hr_id: string;
    recommendation: FeedbackRecommendation;
    submitted_at: string;
  };

  const subsByProbationId = new Map<number, SubRow[]>();
  for (const s of (submissions ?? []) as SubRow[]) {
    const arr = subsByProbationId.get(s.probation_id) ?? [];
    arr.push(s);
    subsByProbationId.set(s.probation_id, arr);
  }

  return rows.map(row => {
    const dvCheckboxes: DvCheckboxState = {
      dmDvDone: row.dm_dv_done,
      dmDvDoneAt: row.dm_dv_done_at,
      dmDvDoneManually: row.dm_dv_done_manually,
      nsmDvDone: row.nsm_dv_done,
      nsmDvDoneAt: row.nsm_dv_done_at,
      nsmDvDoneManually: row.nsm_dv_done_manually,
      pmGpmDvDone: row.pm_gpm_dv_done,
      pmGpmDvDoneAt: row.pm_gpm_dv_done_at,
      pmGpmDvDoneManually: row.pm_gpm_dv_done_manually,
      tmDvDone: row.tm_dv_done,
      tmDvDoneAt: row.tm_dv_done_at,
      tmDvDoneManually: row.tm_dv_done_manually,
    };

    const dvApplicable = row.pm_gpm_dv_done === null ? 3 : 4; // CNS = 3 (no PM/GPM)
    const dvDoneCount = [
      row.dm_dv_done,
      row.nsm_dv_done,
      row.pm_gpm_dv_done === null ? null : row.pm_gpm_dv_done,
      row.tm_dv_done,
    ].filter(v => v === true).length;

    return {
      employeeHrId: row.hr_id,
      employeeName: row.employees.full_name ? resolveEmployeeDisplayName(row.employees.full_name, row.employees.nickname) : row.hr_id,
      lineName: row.employees.line_name ?? null,
      hireDate: row.employees.hire_date ?? null,
      probationEndDate: row.probation_end_date,
      probationId: row.id,
      dvCheckboxes,
      dvDoneCount,
      dvTotalApplicable: dvApplicable,
      submissions: (subsByProbationId.get(row.id) ?? []).map(s => ({
        cycleNumber: s.cycle_number,
        submitterRole: s.submitter_role,
        submitterHrId: s.submitter_hr_id,
        recommendation: s.recommendation,
        submittedAt: s.submitted_at,
      })),
    };
  });
}

// ── DV checkbox manual override (HR only) ────────────────────────────────────

export async function setDvCheckboxManual(
  access: AccessContext,
  probationId: number,
  field: "dm" | "nsm" | "pm_gpm" | "tm",
  value: boolean,
): Promise<void> {
  const allowed = access.role === "Super Admin";
  if (!allowed) throw new Error("Forbidden: only HR or Super Admin may manually set DV checkboxes.");

  const now = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {};
  updatePayload[`${field}_dv_done`] = value;
  updatePayload[`${field}_dv_done_at`] = value ? now : null;
  updatePayload[`${field}_dv_done_manually`] = true;
  updatePayload["updated_at"] = now;

  const { error } = await getSupabaseAdmin()
    .from("employee_probation")
    .update(updatePayload)
    .eq("id", probationId);

  if (error) throw new Error(`Failed to update DV checkbox: ${error.message}`);
}

// ── DV auto-tick from Visits Report sync ─────────────────────────────────────

/**
 * Called after each iReports360 Visits Report sync (see the cron route) instead of on a
 * "publish" event — Double Visit Analytics is now a live read of ireports360_visits with no
 * import/publish step. Scans the just-synced date window for double visits and auto-ticks the
 * matching probation DV checkboxes.
 */
export async function tickDvCheckboxesFromSync(dateFrom: string, dateTo: string): Promise<void> {
  const db = getSupabaseAdmin();

  // Load every double visit (Regular/Campaign with a double-visit partner — same canonical
  // definition as double-visit-analytics) in the just-synced window, through the CRM single door.
  const dvRows = await getDoubleVisitRows<{ agent_hr_id: string; double_hr_id: string; visit_date: string | null }>({
    dateFrom,
    dateTo,
    columns: "double_hr_id, agent_hr_id, visit_date",
    requireAgentHrId: true,
    requireDoubleHrId: true,
  });

  if (dvRows.length === 0) return;

  const rows = dvRows.map((row) => ({
    double_visitor_hr_id: row.double_hr_id,
    visited_employee_hr_id: row.agent_hr_id,
    visit_date: row.visit_date,
  }));

  // Load all active probation employees, with the probation-window END (probation_end_date) so a DV
  // outside the window never ticks a checkbox (parity with probation_dv_days — see the window gate
  // below). The window START (hire_date) comes from the employees query already loaded further down.
  const { data: activeProbation } = await db
    .from("employee_probation")
    .select("id,hr_id,probation_end_date,dm_dv_done,nsm_dv_done,pm_gpm_dv_done,tm_dv_done")
    .eq("status", "active");

  if (!activeProbation || activeProbation.length === 0) return;

  type ProbRow = {
    id: number;
    hr_id: string;
    probation_end_date: string | null;
    dm_dv_done: boolean | null;
    nsm_dv_done: boolean | null;
    pm_gpm_dv_done: boolean | null;
    tm_dv_done: boolean | null;
  };
  const probByHrId = new Map<string, ProbRow>(
    (activeProbation as ProbRow[]).map(p => [normalizeHrId(p.hr_id) ?? p.hr_id, p]),
  );

  // For each DV row, check if visited employee is in active probation
  const visitedHrIds = Array.from(new Set(rows.map(r => normalizeHrId(r.visited_employee_hr_id)).filter(Boolean) as string[]));
  const probationVisited = visitedHrIds.filter(hrId => probByHrId.has(hrId));
  if (probationVisited.length === 0) return;

  // Load visitor roles from app_auth_users. normalizeHrId lowercases, but app_auth_users.hr_id is
  // stored UPPERCASE and PostgREST `.in` is case-SENSITIVE — so expand every casing/alias variant
  // (same fix dv-sync uses for its cohort scope). Without this the role map is always empty and NO
  // checkbox ever auto-ticks (a silent no-op, previously masked by 0 active probation rows).
  const visitorHrIds = Array.from(new Set(rows.map(r => normalizeHrId(r.double_visitor_hr_id)).filter(Boolean) as string[]));
  const { data: authUsers } = await db
    .from("app_auth_users")
    .select("hr_id,role")
    .in("hr_id", Array.from(new Set(visitorHrIds.flatMap(hrIdLookupKeys))))
    .eq("is_active", true);

  type AuthRow = { hr_id: string; role: string };
  const roleByHrId = new Map<string, string>(
    (authUsers ?? [] as AuthRow[]).map((u: AuthRow) => [normalizeHrId(u.hr_id) ?? u.hr_id, u.role]),
  );

  // Load employees table for DM resolution (manager_hr_id). Same casing fix — employees.hr_id is
  // UPPERCASE, probationVisited is lowercase; expand variants so the case-sensitive `.in` matches.
  const { data: employees } = await db
    .from("employees")
    .select("hr_id,manager_hr_id,hire_date")
    .in("hr_id", Array.from(new Set(probationVisited.flatMap(hrIdLookupKeys))));

  type EmpRow = { hr_id: string; manager_hr_id: string | null; hire_date: string | null };
  const empByHrId = new Map<string, EmpRow>(
    (employees ?? [] as EmpRow[]).map((e: EmpRow) => [normalizeHrId(e.hr_id) ?? e.hr_id, e]),
  );

  const now = new Date().toISOString();

  // Process each visited probation employee
  for (const visitedHrId of probationVisited) {
    const probRecord = probByHrId.get(visitedHrId);
    if (!probRecord) continue;

    const visitingRows = rows.filter(r => normalizeHrId(r.visited_employee_hr_id) === visitedHrId);
    const updates: Record<string, unknown> = { updated_at: now };

    for (const dvRow of visitingRows) {
      const visitorHrId = normalizeHrId(dvRow.double_visitor_hr_id);
      if (!visitorHrId) continue;

      // Window gate (same predicate as probation_dv_days validateDvDay): a DV outside the
      // employee's probation window [hire_date, probation_end_date] is NOT a probation double
      // visit and must not tick a checkbox — otherwise the legacy checkbox shows a DV "done"
      // that the authoritative probation_dv_days path rejects as outside_probation_window.
      if (dvRow.visit_date && !withinWindow(dvRow.visit_date, empByHrId.get(visitedHrId)?.hire_date ?? null, probRecord.probation_end_date)) {
        continue;
      }

      const visitorRole = roleByHrId.get(visitorHrId) ?? "";
      const visitedEmp = empByHrId.get(visitedHrId);
      const isDm = visitedEmp && normalizeHrId(visitedEmp.manager_hr_id) === visitorHrId;

      // Only bump the "_at" timestamp on a false->true transition — this function reprocesses
      // ALL of an import's rows on every publish (including the automatic mirror-sync, which now
      // republishes the full history multiple times a day), so re-touching an already-true flag's
      // timestamp would keep bumping a months-old DV to "now" forever.
      if (isDm) {
        updates.dm_dv_done = true;
        if (probRecord.dm_dv_done !== true) updates.dm_dv_done_at = now;
        updates.dm_dv_done_manually = false;
      } else if (visitorRole === "National Sales Manager") {
        updates.nsm_dv_done = true;
        if (probRecord.nsm_dv_done !== true) updates.nsm_dv_done_at = now;
        updates.nsm_dv_done_manually = false;
      } else if (visitorRole === "Training Manager") {
        updates.tm_dv_done = true;
        if (probRecord.tm_dv_done !== true) updates.tm_dv_done_at = now;
        updates.tm_dv_done_manually = false;
      } else if (visitorRole === "Product Manager" || visitorRole === "Group Product Manager") {
        if (probRecord.pm_gpm_dv_done !== null) {
          // Not CNS (NULL = not applicable for CNS)
          updates.pm_gpm_dv_done = true;
          if (probRecord.pm_gpm_dv_done !== true) updates.pm_gpm_dv_done_at = now;
          updates.pm_gpm_dv_done_manually = false;
        }
      }
    }

    if (Object.keys(updates).length > 1) {
      await db.from("employee_probation").update(updates).eq("id", probRecord.id);
    }
  }
}

// ── Row mappers ───────────────────────────────────────────────────────────────

type RawSubmissionRow = {
  id: string;
  probation_id: number;
  employee_hr_id: string;
  cycle_number: number;
  cycle_key: string;
  submitter_hr_id: string;
  submitter_role: FeedbackSubmitterRole;
  feedback_text: string;
  recommendation: FeedbackRecommendation;
  is_once_only: boolean;
  submitted_at: string;
};

type RawCommentRow = {
  id: string;
  submission_id: string;
  commenter_hr_id: string;
  comment_text: string;
  created_at: string;
};

function mapSubmission(row: RawSubmissionRow, comments: FeedbackComment[]): FeedbackSubmission {
  return {
    id: row.id,
    probationId: row.probation_id,
    employeeHrId: row.employee_hr_id,
    cycleNumber: row.cycle_number,
    cycleKey: row.cycle_key,
    submitterHrId: row.submitter_hr_id,
    submitterRole: row.submitter_role,
    feedbackText: row.feedback_text,
    recommendation: row.recommendation,
    isOnceOnly: row.is_once_only,
    submittedAt: row.submitted_at,
    comments,
  };
}

function mapComment(row: RawCommentRow, commenterName?: string | null): FeedbackComment {
  return {
    id: row.id,
    submissionId: row.submission_id,
    commenterHrId: row.commenter_hr_id,
    commenterName: commenterName ?? null,
    commentText: row.comment_text,
    createdAt: row.created_at,
  };
}
