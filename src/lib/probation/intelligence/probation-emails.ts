// Probation event & milestone emails (Phase 9, P9-T02/T03/T04/T05).
//
// Recipients are the OWNER-CONFIRMED set (2026-07-13); see the confirmed matrix in
// docs/memory. Templates live in the admin email-template engine (keys probation_dv_snapshot,
// probation_day30/60/75) — this module only resolves recipients + builds token context and emits
// via createSystemNotification with the template key. Every send carries an idempotency key so a
// repeated CRM sync or cron run never re-sends the same email.

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { normalizeHrId } from "@/lib/auth/permissions";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { systemDeployment } from "@/config/system-settings";

import { getProbationConfig } from "./config";
import { computeDvProgress, currentProbationDay, type DvDayLite } from "./report-metrics";
import { getCaseScore } from "./scoring-service";
import { probationDaysRemaining } from "@/lib/probation/date";
import type { ProbationEvaluatorRole } from "./types";

type EmployeeRow = Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number];

const ROLE_LABEL: Record<string, string> = {
  dm: "District Manager", tm: "Training Manager", pm_gpm: "PM / GPM", nsm: "National Sales Manager",
};

async function activeHrIdsByRole(roles: string[]): Promise<string[]> {
  const { data } = await getSupabaseAdmin()
    .from("app_auth_users").select("hr_id, role").in("role", roles).eq("is_active", true);
  return ((data ?? []) as Array<{ hr_id?: string | null }>).map((r) => normalizeHrId(r.hr_id)).filter(Boolean) as string[];
}

function managerOf(emp: EmployeeRow | null, byHrId: Map<string, EmployeeRow>): EmployeeRow | null {
  const mid = normalizeHrId(emp?.managerHrId);
  return mid ? byHrId.get(mid) ?? null : null;
}

/**
 * Resolve the owner-confirmed stakeholder set.
 *   DV snapshot: CEO + HR + SFE + DM + NSM + TM + PM/GPM(line-matched) + evaluator.
 *   Milestone:   CEO + HR + DM + NSM + SFE.
 */
async function resolveStakeholders(
  employeeHrId: string,
  opts: { includeEvaluator?: string | null; includeTm?: boolean; includePmGpm?: boolean; includeSfe?: boolean },
): Promise<string[]> {
  const rows = await getEmployeeDirectoryRows();
  const byHrId = new Map(rows.map((r) => [normalizeHrId(r.hrId) ?? "", r] as const));
  const employee = byHrId.get(normalizeHrId(employeeHrId) ?? "") ?? null;

  const recipients = new Set<string>();

  const [ceo, hr] = await Promise.all([
    activeHrIdsByRole(["CEO"]),
    activeHrIdsByRole(["HR Manager", "Super Admin"]),
  ]);
  ceo.forEach((h) => recipients.add(h));
  hr.forEach((h) => recipients.add(h));

  if (opts.includeSfe) (await activeHrIdsByRole(["SFE Manager"])).forEach((h) => recipients.add(h));
  if (opts.includeTm) (await activeHrIdsByRole(["Training Manager"])).forEach((h) => recipients.add(h));

  // DM = the employee's direct manager.
  const dm = normalizeHrId(employee?.managerHrId);
  if (dm) recipients.add(dm);

  // NSM = walk the management chain up to the National Sales Manager.
  const nsmSet = new Set(await activeHrIdsByRole(["National Sales Manager"]));
  let cur = managerOf(employee, byHrId);
  const seen = new Set<string>();
  while (cur) {
    const h = normalizeHrId(cur.hrId);
    if (!h || seen.has(h)) break;
    seen.add(h);
    if (nsmSet.has(h)) { recipients.add(h); break; }
    cur = managerOf(cur, byHrId);
  }

  // PM/GPM matched to the employee's line; not applicable to CNS.
  if (opts.includePmGpm && employee && (employee.lineName ?? "").toLowerCase() !== "cns" && employee.lineId != null) {
    const pmGpm = await activeHrIdsByRole(["Product Manager", "Group Product Manager"]);
    for (const h of pmGpm) {
      const pm = byHrId.get(h);
      if (pm?.lineId === employee.lineId) recipients.add(h);
    }
  }

  const evaluator = normalizeHrId(opts.includeEvaluator);
  if (evaluator) recipients.add(evaluator);

  return Array.from(recipients);
}

async function buildCaseContext(caseId: string, employeeHrId: string, hireDate: string | null, today: string) {
  const config = await getProbationConfig();
  const { data: dvRows } = await getSupabaseAdmin()
    .from("probation_dv_days").select("evaluator_role, dv_status").eq("case_id", caseId);
  const dvDays = (dvRows ?? []) as Array<{ evaluator_role: ProbationEvaluatorRole | null; dv_status: string }>;
  const progress = computeDvProgress(dvDays.map<DvDayLite>((d) => ({ evaluatorRole: d.evaluator_role, dvStatus: d.dv_status })), config);
  const p = progress.byRole;
  const dvProgress = `DM ${p.dm.feedbackCompleted}/${p.dm.required} · TM ${p.tm.feedbackCompleted}/${p.tm.required} · PM/GPM ${p.pm_gpm.feedbackCompleted}/${p.pm_gpm.required} · NSM ${p.nsm.feedbackCompleted}/${p.nsm.required} · Total ${progress.totalFeedbackCompleted}/${progress.totalRequired}`;

  const scored = await getCaseScore(caseId);
  const scoreVal = scored.score.finalScore ?? scored.score.provisionalScore;
  const provisionalScore = scoreVal != null ? `${scoreVal} / 10` : "—";
  const riskStatus = scored.provisionalReadiness.replace(/_/g, " ");

  return {
    dvProgress,
    provisionalScore,
    riskStatus,
    probationDay: String(currentProbationDay(hireDate, today) ?? "—"),
    daysRemaining: String(probationDaysRemaining(hireDate) ?? "—"),
    reportUrl: `${systemDeployment.productionUrl}/probation/cases/${caseId}`,
  };
}

async function emitToRecipients(
  recipients: string[],
  input: {
    templateKey: string; eventType: string; module?: string; subjectHrId: string;
    title: string; message: string; idempotencyKeyBase: string;
    priority?: "high" | "normal"; ctaUrl: string;
    templateContext: Record<string, string | null>;
  },
): Promise<number> {
  // Recipients are independent (own idempotency key, atomic claimDelivery upsert) — dispatch in
  // parallel. A serial loop here, across every stakeholder of every milestone-crossing case, was
  // part of what made this step exceed its 30s cron budget (see 2026-07-15/16 notifications cron
  // 504 outage).
  await Promise.all(
    recipients.map((recipientHrId) =>
      createSystemNotification({
        actorId: "system",
        module: input.module ?? "probation",
        eventType: input.eventType,
        title: input.title,
        message: input.message,
        priority: input.priority ?? "high",
        subjectHrId: input.subjectHrId,
        recipientHrId,
        // Telegram carries full content (E3); actual delivery still needs the global switch, a bot token,
        // and each recipient's per-user opt-in + connected chat (admin/DB, not code).
        channels: ["in_app", "email", "telegram"],
        actionUrl: input.ctaUrl,
        email: {
          templateKey: input.templateKey,
          notificationType: "probation",
          ctaHref: input.ctaUrl,
          ctaLabel: "Open live report",
          subject: input.title,
          summary: input.message,
          title: input.title,
          templateContext: input.templateContext,
        },
        metadata: {
          // Dedup: one email per (event, recipient). Re-runs are no-ops.
          idempotencyKey: `${input.idempotencyKeyBase}:${recipientHrId}`,
        },
      }).catch(() => undefined),
    ),
  );
  return recipients.length;
}

/** Send the DV-Day snapshot email after a DV Day is validated. Idempotent per DV-Day. */
export async function sendDvSnapshotEmail(dvDayId: string, nowIso: string = new Date().toISOString()): Promise<{ sent: number }> {
  const today = nowIso.slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data: dv } = await supabase
    .from("probation_dv_days")
    .select("id, case_id, employee_hr_id, evaluator_hr_id, evaluator_role, dv_date, area_name, visit_count, dv_status")
    .eq("id", dvDayId).maybeSingle();
  if (!dv) return { sent: 0 };
  const d = dv as {
    id: string; case_id: string | null; employee_hr_id: string; evaluator_hr_id: string | null;
    evaluator_role: ProbationEvaluatorRole | null; dv_date: string; area_name: string | null;
    visit_count: number; dv_status: string;
  };
  // Only for validated / feedback-in-progress DV-Days.
  if (d.dv_status !== "validated" && d.dv_status !== "feedback_completed") return { sent: 0 };
  if (!d.case_id) return { sent: 0 };
  // Recency guard: the snapshot email announces a FRESH field day to ~8 stakeholders. On the first
  // production sync / go-live backfill, many historical DV-Days are inserted "new" at once and would
  // burst ~8 emails each (Resend daily-cap risk). Skip snapshots for DV-Days whose field date is older
  // than the grace window — genuinely fresh syncs still notify. (Mirrors the milestone burst guard.)
  if (daysBetween(d.dv_date, today) > DV_SNAPSHOT_GRACE_DAYS) return { sent: 0 };

  const { data: caseRow } = await supabase
    .from("probation_cases").select("employee_name, hire_date").eq("id", d.case_id).maybeSingle();
  const employeeName = (caseRow as { employee_name?: string | null } | null)?.employee_name ?? d.employee_hr_id;
  const hireDate = (caseRow as { hire_date?: string | null } | null)?.hire_date ?? null;

  // Evaluator display name.
  let evaluatorName: string | null = null;
  if (d.evaluator_hr_id) {
    const { data: emp } = await supabase.from("employees").select("full_name").ilike("hr_id", d.evaluator_hr_id).maybeSingle();
    evaluatorName = (emp as { full_name?: string | null } | null)?.full_name ?? d.evaluator_hr_id;
  }

  const ctx = await buildCaseContext(d.case_id, d.employee_hr_id, hireDate, today);
  const recipients = await resolveStakeholders(d.employee_hr_id, {
    includeEvaluator: d.evaluator_hr_id, includeTm: true, includePmGpm: true, includeSfe: true,
  });

  const sent = await emitToRecipients(recipients, {
    templateKey: "probation_dv_snapshot",
    eventType: "dv_snapshot",
    subjectHrId: d.employee_hr_id,
    title: `Probation DV snapshot — ${employeeName}`,
    message: `Validated double-visit day on ${d.dv_date} for ${employeeName}. Progress: ${ctx.dvProgress}.`,
    idempotencyKeyBase: `probation:dv-snapshot:${d.id}`,
    ctaUrl: ctx.reportUrl,
    templateContext: {
      employeeName, employeeHrId: d.employee_hr_id, dvDate: d.dv_date,
      evaluatorName, evaluatorRole: d.evaluator_role ? ROLE_LABEL[d.evaluator_role] ?? d.evaluator_role : "—",
      visitCount: String(d.visit_count), area: d.area_name ?? "—",
      status: d.dv_status === "feedback_completed" ? "Feedback completed" : "Feedback pending",
      ...ctx,
    },
  });
  return { sent };
}

const MILESTONES = [
  { day: 30, key: "probation_day30", label: "Day 30 — early progress" },
  { day: 60, key: "probation_day60", label: "Day 60 — completion planning" },
  { day: 75, key: "probation_day75", label: "Day 75 — decision readiness" },
] as const;

// A milestone email fires only if the case is within this many days PAST the threshold — so a
// freshly-backfilled case already past a milestone is treated as historical (no stale send), while the
// sub-daily cron still has a comfortable window to catch a genuinely just-crossed milestone.
const MILESTONE_GRACE_DAYS = 7;

// A DV-snapshot email fires only if the field day is within this many days of "now" — so a first-sync /
// backfill that inserts a batch of historical DV-Days does not burst ~8 stakeholder emails per day.
const DV_SNAPSHOT_GRACE_DAYS = 5;

// Whole days from an ISO date (YYYY-MM-DD) to a reference YYYY-MM-DD (positive when `from` is earlier).
function daysBetween(fromDate: string, toDate: string): number {
  const a = new Date(`${fromDate}T00:00:00.000Z`).getTime();
  const b = new Date(`${toDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Daily sweep: send Day 30/60/75 milestone emails once each as cases cross the threshold. */
export async function processProbationMilestoneEmails(nowIso: string = new Date().toISOString()): Promise<{ scanned: number; sent: number }> {
  const today = nowIso.slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data: cases } = await supabase
    .from("probation_cases").select("id, employee_hr_id, employee_name, hire_date").eq("status", "active");
  const rows = (cases ?? []) as Array<{ id: string; employee_hr_id: string; employee_name: string | null; hire_date: string | null }>;

  // Cases are independent — fan out in parallel instead of a serial per-case await chain. At most
  // one MILESTONES entry can match a given case (the day-30/60/75 grace windows don't overlap), so
  // the inner loop stays a simple sequential scan; it's the outer case fan-out (each doing its own
  // buildCaseContext + resolveStakeholders + email dispatch) that made this step exceed its 30s
  // cron budget (see 2026-07-15/16 notifications cron 504 outage).
  const sentPerCase = await Promise.all(
    rows.map(async (c) => {
      try {
        const day = currentProbationDay(c.hire_date, today);
        if (day == null) return 0;
        let sentForCase = 0;
        for (const m of MILESTONES) {
          // Fire a milestone only when it was crossed RECENTLY (within the grace window), not merely
          // "day is past threshold". Without this, a go-live backfill of cases already well past Day
          // 30/60/75 would burst every crossed milestone at once (stale "Day 30 early progress" for a
          // rep near their decision, and a Resend daily-cap risk). The dedup key still makes re-runs
          // within the window no-ops.
          if (day < m.day || day > m.day + MILESTONE_GRACE_DAYS) continue;
          const ctx = await buildCaseContext(c.id, c.employee_hr_id, c.hire_date, today);
          const recipients = await resolveStakeholders(c.employee_hr_id, { includeSfe: true });
          const employeeName = c.employee_name ?? c.employee_hr_id;
          sentForCase += await emitToRecipients(recipients, {
            templateKey: m.key,
            eventType: `milestone_day${m.day}`,
            subjectHrId: c.employee_hr_id,
            title: `Probation ${m.label} — ${employeeName}`,
            message: `${employeeName} reached ${m.label}. Progress: ${ctx.dvProgress} · ${ctx.provisionalScore} · ${ctx.riskStatus}.`,
            idempotencyKeyBase: `probation:milestone:${c.id}:day${m.day}`,
            ctaUrl: ctx.reportUrl,
            templateContext: {
              employeeName, employeeHrId: c.employee_hr_id, milestoneDay: String(m.day), ...ctx,
              summary: `${employeeName} reached ${m.label}.`,
            },
          });
        }
        return sentForCase;
      } catch {
        // One un-scoreable case (e.g. a transient getCaseScore error) must not abort milestone
        // emails for the rest of the cohort — log-and-continue, matching the DV-snapshot guard.
        return 0;
      }
    }),
  );
  return { scanned: rows.length, sent: sentPerCase.reduce((sum, n) => sum + n, 0) };
}
