// Probation event & milestone emails (Phase 9, P9-T02/T03/T04/T05).
//
// Recipients are the OWNER-CONFIRMED set (2026-07-13); see the confirmed matrix in
// docs/memory. Templates live in the admin email-template engine (keys probation_dv_snapshot,
// probation_day30/60/75) — this module only resolves recipients + builds token context and emits
// via createSystemNotification with the template key. Every send carries an idempotency key so a
// repeated CRM sync or cron run never re-sends the same email.

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { normalizeHrId, type PhoenixRole } from "@/lib/auth/permissions";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { systemDeployment } from "@/config/system-settings";

import { getProbationConfig } from "./config";
import { filterResolvedProbationCases } from "./cases";
import { computeDvProgress, currentProbationDay, type DvDayLite } from "./report-metrics";
import { createProbationDailyCap, type ProbationDailyCap } from "./notification-cap";
import { isDateBeforeProbationEmailFreshStart, PROBATION_EMAIL_FRESH_START_ISO } from "./email-fresh-start";
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
 * The CEO/HR/SFE/TM broadcast portion of resolveStakeholders. `broadcastRoleOverride`, when
 * present, replaces the whole lookup with an admin-configurable role list (only
 * processProbationWeeklyDigest passes it today — see "probation_weekly_dv_digest" in
 * role-recipients.ts) and includeSfe/includeTm are ignored for that call. Every other caller
 * leaves broadcastRoleOverride undefined and gets the exact legacy CEO+HR(+SFE)(+TM) behavior.
 */
async function resolveBroadcastRoleIds(opts: { includeSfe?: boolean; includeTm?: boolean; broadcastRoleOverride?: PhoenixRole[] }): Promise<string[]> {
  if (opts.broadcastRoleOverride) return activeHrIdsByRole(opts.broadcastRoleOverride);
  const [ceo, hr, sfe, tm] = await Promise.all([
    activeHrIdsByRole(["CEO"]),
    activeHrIdsByRole(["HR Manager", "Super Admin"]),
    opts.includeSfe ? activeHrIdsByRole(["SFE Manager"]) : Promise.resolve([]),
    opts.includeTm ? activeHrIdsByRole(["Training Manager"]) : Promise.resolve([]),
  ]);
  return [...ceo, ...hr, ...sfe, ...tm];
}

/**
 * Resolve the owner-confirmed stakeholder set.
 *   DV snapshot: CEO + HR + SFE + DM + NSM + TM + PM/GPM(line-matched) + evaluator.
 *   Milestone:   CEO + HR + DM + NSM + SFE.
 */
async function resolveStakeholders(
  employeeHrId: string,
  opts: {
    includeEvaluator?: string | null;
    includeTm?: boolean;
    includePmGpm?: boolean;
    includeSfe?: boolean;
    /** Admin-configurable broadcast set — see resolveBroadcastRoleIds above. */
    broadcastRoleOverride?: PhoenixRole[];
  },
): Promise<string[]> {
  const rows = await getEmployeeDirectoryRows();
  const byHrId = new Map(rows.map((r) => [normalizeHrId(r.hrId) ?? "", r] as const));
  const employee = byHrId.get(normalizeHrId(employeeHrId) ?? "") ?? null;

  const recipients = new Set<string>();

  // The broadcast lookup doesn't depend on the NSM chain — resolve them concurrently instead
  // of one-at-a-time (this function is called once per case/milestone, so a sequential chain
  // here multiplied straight into the sweep's total wall-clock).
  const [broadcastIds, nsmList] = await Promise.all([
    resolveBroadcastRoleIds(opts),
    activeHrIdsByRole(["National Sales Manager"]),
  ]);
  broadcastIds.forEach((h) => recipients.add(h));

  // DM = the employee's direct manager.
  const dm = normalizeHrId(employee?.managerHrId);
  if (dm) recipients.add(dm);

  // NSM = walk the management chain up to the National Sales Manager.
  const nsmSet = new Set(nsmList);
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
    cap?: ProbationDailyCap;
  },
): Promise<number> {
  // Per-recipient daily cap (MOD-3, 2026-07-17): a recipient over their 2/day probation limit is
  // skipped this run; the daily idempotent sweep re-emits tomorrow. No cap → send to all.
  const allowed = input.cap ? recipients.filter((h) => input.cap!.allow(h)) : recipients;
  if (allowed.length === 0) return 0;
  // Recipients are independent (own idempotency key, atomic claimDelivery upsert) — dispatch in
  // parallel. A serial loop here, across every stakeholder of every milestone-crossing case, was
  // part of what made this step exceed its 30s cron budget (see 2026-07-15/16 notifications cron
  // 504 outage).
  await Promise.all(
    allowed.map((recipientHrId) =>
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
  return allowed.length;
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
    const { data: emp } = await supabase.from("employees").select("full_name, nickname").ilike("hr_id", d.evaluator_hr_id).maybeSingle();
    const empRow = emp as { full_name?: string | null; nickname?: string | null } | null;
    evaluatorName = empRow?.full_name ? resolveEmployeeDisplayName(empRow.full_name, empRow.nickname) : d.evaluator_hr_id;
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

// ── Weekly Double-Visit digest (MOD-1, 2026-07-17) ──────────────────────────────────────────────
// Replaces the per-DV-day snapshot email: instead of ~8 emails on every field day, one weekly
// roll-up per probationer to the line management chain. Self-gates to a single Cairo weekday so the
// daily notifications cron only fires it once a week; a per-week idempotency key makes re-runs on
// that day no-ops.

const CAIRO_TZ = "Africa/Cairo";
// Which Cairo weekday the digest goes out (0=Sun … 6=Sat). Sunday matches the weekly system-health
// digest. Adjust here if the owner picks a different day (open item at time of build).
const WEEKLY_DIGEST_WEEKDAY = 0;

function cairoWeekday(when: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: CAIRO_TZ, weekday: "short" }).format(when);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}
function cairoDate(when: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(when);
}

const WEEKLY_ROLE_LABEL: Record<string, string> = {
  dm: "District Manager", tm: "Training Manager", pm_gpm: "PM / GPM", nsm: "National Sales Manager", sfe: "SFE",
};

function buildWeeklyDigestTable(rows: Array<{ dv_date: string; evaluator_role: string | null; visit_count: number; dv_status: string }>): { html: string; text: string } {
  const feedbackLabel = (s: string) => (s === "feedback_completed" ? "Feedback done" : "Feedback pending");
  const cells = "padding:8px 12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;border-bottom:1px solid #e2e8f0";
  const bodyRows = rows
    .map((r, i) => {
      const bg = i % 2 === 1 ? "background:#f8fafc" : "background:#ffffff";
      const role = r.evaluator_role ? WEEKLY_ROLE_LABEL[r.evaluator_role] ?? r.evaluator_role : "—";
      return `<tr style="${bg}"><td style="${cells};${bg}">${r.dv_date}</td><td style="${cells};${bg}">${role}</td><td style="${cells};${bg};text-align:center">${r.visit_count}</td><td style="${cells};${bg}">${feedbackLabel(r.dv_status)}</td></tr>`;
    })
    .join("");
  const html =
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0;width:100%;border-collapse:collapse;border-top:1px solid #e2e8f0">` +
    `<thead><tr>${["Date", "Manager role", "Visits", "Feedback"].map((h) => `<th style="${cells};text-align:left;color:#475569;font-weight:700">${h}</th>`).join("")}</tr></thead>` +
    `<tbody>${bodyRows}</tbody></table>`;
  const text = rows.map((r) => `${r.dv_date} · ${r.evaluator_role ? WEEKLY_ROLE_LABEL[r.evaluator_role] ?? r.evaluator_role : "—"} · ${r.visit_count} visit(s) · ${feedbackLabel(r.dv_status)}`).join("\n");
  return { html, text };
}

/**
 * Weekly sweep (call daily; self-gates to WEEKLY_DIGEST_WEEKDAY): one digest email per probationer
 * who had ≥1 validated Double-Visit day in the past 7 days, to the line management chain.
 */
export async function processProbationWeeklyDigest(nowIso: string = new Date().toISOString()): Promise<{ scanned: number; sent: number; skipped?: string }> {
  const now = new Date(nowIso);
  if (cairoWeekday(now) !== WEEKLY_DIGEST_WEEKDAY) return { scanned: 0, sent: 0, skipped: "not the weekly digest day" };

  const today = cairoDate(now);
  const weekStart = cairoDate(new Date(now.getTime() - 6 * 86_400_000)); // inclusive 7-day window
  const weekLabel = `${weekStart} to ${today}`;
  const supabase = getSupabaseAdmin();

  const { data: dvRows } = await supabase
    .from("probation_dv_days")
    .select("id, case_id, dv_date, evaluator_role, visit_count, dv_status")
    .gte("dv_date", weekStart)
    .lte("dv_date", today)
    // FRESH START (owner directive 2026-07-17): the first digests only summarise DV-Days captured
    // on/after the reset instant — never a catch-up roll-up of pre-reset history.
    .gte("created_at", PROBATION_EMAIL_FRESH_START_ISO)
    .in("dv_status", ["validated", "feedback_completed"]);
  const dvs = (dvRows ?? []) as Array<{ id: string; case_id: string | null; dv_date: string; evaluator_role: string | null; visit_count: number; dv_status: string }>;

  const byCase = new Map<string, typeof dvs>();
  for (const d of dvs) {
    if (!d.case_id) continue;
    const arr = byCase.get(d.case_id) ?? [];
    arr.push(d);
    byCase.set(d.case_id, arr);
  }
  if (byCase.size === 0) return { scanned: 0, sent: 0 };

  const { data: caseRows } = await supabase
    .from("probation_cases")
    .select("id, employee_hr_id, employee_name, hire_date, line_name, status")
    .in("id", Array.from(byCase.keys()));
  const loadedCases = (caseRows ?? []) as Array<{ id: string; employee_hr_id: string; employee_name: string | null; hire_date: string | null; line_name: string | null; status: string }>;
  // Defense-in-depth (legacy-decision desync): same guard as the milestone sweep — drop any case whose
  // employee was resolved via the LEGACY workflow but never mirrored into probation_cases, so a
  // legacy-decided rep with recent DV activity stops receiving weekly digests. Fails OPEN.
  const cases = await filterResolvedProbationCases(loadedCases);

  const cap = await createProbationDailyCap(now);
  // Resolved once per digest run (not once per probationer) — see "probation_weekly_dv_digest"
  // in role-recipients.ts. includeTm/includeSfe are ignored once broadcastRoleOverride is set.
  const weeklyDigestBroadcastRoles = await resolveNotificationRoleRecipients("probation_weekly_dv_digest");

  const sentPerCase = await Promise.all(
    cases
      .filter((c) => c.status === "active")
      .map(async (c) => {
        try {
          const rows = (byCase.get(c.id) ?? []).slice().sort((a, b) => a.dv_date.localeCompare(b.dv_date));
          const table = buildWeeklyDigestTable(rows);
          const ctx = await buildCaseContext(c.id, c.employee_hr_id, c.hire_date, today);
          const recipients = await resolveStakeholders(c.employee_hr_id, {
            includePmGpm: true,
            broadcastRoleOverride: weeklyDigestBroadcastRoles,
          });
          const employeeName = c.employee_name ?? c.employee_hr_id;
          return await emitToRecipients(recipients, {
            templateKey: "probation_weekly_digest",
            eventType: "weekly_digest",
            subjectHrId: c.employee_hr_id,
            title: `Probation weekly summary — ${employeeName} (${weekLabel})`,
            message: `This week's Double-Visit summary for ${employeeName}: ${rows.length} day(s). Progress: ${ctx.dvProgress}.`,
            idempotencyKeyBase: `probation:weekly-digest:${c.id}:${weekStart}`,
            ctaUrl: ctx.reportUrl,
            cap,
            templateContext: {
              employeeName, employeeHrId: c.employee_hr_id,
              line: c.line_name ?? "—",
              weekLabel,
              digestTable: table.html,
              digestTableText: table.text,
              ...ctx,
            },
          });
        } catch {
          return 0;
        }
      }),
  );
  return { scanned: byCase.size, sent: sentPerCase.reduce((sum, n) => sum + n, 0) };
}

/** Daily sweep: send Day 30/60/75 milestone emails once each as cases cross the threshold. */
export async function processProbationMilestoneEmails(nowIso: string = new Date().toISOString()): Promise<{ scanned: number; sent: number }> {
  const today = nowIso.slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data: cases } = await supabase
    .from("probation_cases").select("id, employee_hr_id, employee_name, hire_date").eq("status", "active");
  // Defense-in-depth (legacy-decision desync): skip any "active" case whose employee is already
  // resolved via the LEGACY workflow (employee_probation passed/terminated OR terminal employment
  // status) but whose outcome wasn't mirrored into probation_cases — otherwise a legacy-decided rep
  // keeps receiving milestone emails forever. Fails OPEN.
  const rows = await filterResolvedProbationCases(
    (cases ?? []) as Array<{ id: string; employee_hr_id: string; employee_name: string | null; hire_date: string | null }>,
  );
  const cap = await createProbationDailyCap(new Date(nowIso));

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
          // FRESH START (owner directive 2026-07-17): a milestone crossed BEFORE the reset instant
          // must not fire a catch-up email. crossing date = today − (day − m.day) days.
          const crossingDate = new Date(new Date(`${today}T00:00:00Z`).getTime() - (day - m.day) * 86_400_000)
            .toISOString().slice(0, 10);
          if (isDateBeforeProbationEmailFreshStart(crossingDate)) continue;
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
            cap,
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
