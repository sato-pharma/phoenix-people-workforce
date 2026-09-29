// Probation Day 30 / 60 / 75 milestone emails.
//
// OWNER RULE (2026-09-29): these three emails go to ONE person — Yasmeena Elsafory (HR-009, HR
// Generalist) — with Omar Gawish (B-10, omar.anwar@satopharma.com) on CC. That is the whole
// recipient list. This is NOT the 2026-07 stakeholder fan-out (CEO + HR + DM + NSM + SFE, ~8
// people per milestone) that the owner retired on 2026-08-02 in #1624/#1626 — do not restore it,
// and do not "improve" this into a role-resolved recipient set.
//
// Why a separate notification type. The module-wide `probation` email policy is OFF: the owner
// turned it off on 2026-07-19 and confirmed on 2026-08-13 that it STAYS off. It still governs the
// legacy per-manager probation reminders, which are wired to the 5-minute notification cron and
// would resume the moment that toggle flipped. So these milestone emails carry their own
// notification type, `probation_milestone`, with its own admin toggle — re-enabling the one the
// owner asked for never re-opens the flood he switched off.
//
// One email per (case, milestone), idempotent, so the daily sweep is a no-op after the first send.

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { normalizeHrId } from "@/lib/auth/permissions";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { systemDeployment } from "@/config/system-settings";
import { PROBATION_TOTAL_DAYS, probationDaysRemaining } from "@/lib/probation/date";

import { filterResolvedProbationCases } from "./cases";
import { getProbationConfig } from "./config";
import { isDateBeforeProbationEmailFreshStart } from "./email-fresh-start";
import { computeDvProgress, currentProbationDay, type DvDayLite } from "./report-metrics";
import { getCaseScore } from "./scoring-service";
import type { ProbationEvaluatorRole } from "./types";

/** Yasmeena Khaled Ahmed Hussein Elsafory — HR Generalist. The ONLY To recipient (owner, 2026-09-29). */
export const PROBATION_MILESTONE_TO_HR_ID = "HR-009";

/**
 * Omar Anwar Gawish (B-10) — BCC on every milestone email (owner, 2026-09-29: "to her only bccc
 * omar.anwar"). BCC, not CC: Yasmeena must be the only recipient the mail shows.
 */
export const PROBATION_MILESTONE_BCC_HR_IDS: readonly string[] = ["B-10"];

export const PROBATION_MILESTONES = [
  { day: 30, key: "probation_day30", label: "Day 30 — early progress" },
  { day: 60, key: "probation_day60", label: "Day 60 — completion planning" },
  { day: 75, key: "probation_day75", label: "Day 75 — decision readiness" },
] as const;

// A milestone is due from the day it is crossed until the probation itself ends, and the dedup key
// is what stops it repeating.
//
// The retired fan-out used a 7-day grace window instead, because a catch-up there meant ~8
// stakeholder emails per milestone. With ONE recipient that trade runs backwards: a window silently
// drops a milestone HR never saw. Owner, 2026-09-29 — "backfill any missings to her now". Yasmeena
// had received none of the 334 historical milestone deliveries; every one went to the CEO and the
// manager chain, and `HR-009` appears in that table nowhere.
//
// A milestone is therefore due for anyone still ON probation, and never once a probation is over —
// a "Day 30 — early progress" notice for someone 150 days in is wrong information, not a late email.
// One case can emit several milestones in one pass, and the dedup key means each happens once.

// THE CATCH-UP IS RELEASED (owner, 2026-09-29 — "release the held probation milestones"). It was
// asked for, measured, held back for a few hours under a start-date constant while Yasmeena's own
// address was corrected, and then released. The constant is gone rather than merely moved back: the
// rule above IS the rule, and a second dormant cutoff sitting beside the 2026-07-17 fresh start
// would only read as a live gate to whoever finds it next.

type ActiveCaseRow = {
  id: string;
  employee_hr_id: string;
  employee_name: string | null;
  hire_date: string | null;
};

/** Live work_email for each BCC'd HR ID, so a mailbox change follows the employee record. */
async function resolveBccAddresses(): Promise<string[]> {
  const hrIds = PROBATION_MILESTONE_BCC_HR_IDS.map((h) => normalizeHrId(h)).filter(Boolean) as string[];
  if (hrIds.length === 0) return [];
  const { data } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id, work_email")
    .in("hr_id", hrIds);
  const rows = (data ?? []) as Array<{ hr_id?: string | null; work_email?: string | null }>;
  return Array.from(
    new Set(
      rows
        .map((r) => String(r.work_email ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

async function buildCaseContext(caseId: string, hireDate: string | null, today: string) {
  const config = await getProbationConfig();
  const { data: dvRows } = await getSupabaseAdmin()
    .from("probation_dv_days")
    .select("evaluator_role, dv_status")
    .eq("case_id", caseId);
  const dvDays = (dvRows ?? []) as Array<{ evaluator_role: ProbationEvaluatorRole | null; dv_status: string }>;
  const progress = computeDvProgress(
    dvDays.map<DvDayLite>((d) => ({ evaluatorRole: d.evaluator_role, dvStatus: d.dv_status })),
    config,
  );
  const p = progress.byRole;
  const dvProgress = `DM ${p.dm.feedbackCompleted}/${p.dm.required} · TM ${p.tm.feedbackCompleted}/${p.tm.required} · PM/GPM ${p.pm_gpm.feedbackCompleted}/${p.pm_gpm.required} · NSM ${p.nsm.feedbackCompleted}/${p.nsm.required} · Total ${progress.totalFeedbackCompleted}/${progress.totalRequired}`;

  const scored = await getCaseScore(caseId);
  const scoreVal = scored.score.finalScore ?? scored.score.provisionalScore;

  return {
    dvProgress,
    provisionalScore: scoreVal != null ? `${scoreVal} / 10` : "—",
    riskStatus: scored.provisionalReadiness.replace(/_/g, " "),
    probationDay: String(currentProbationDay(hireDate, today) ?? "—"),
    // `today` is already Cairo's calendar day; re-anchoring it at UTC midnight lands on the same
    // calendar day inside probationDaysRemaining (Cairo is always ahead of UTC), so probationDay
    // and daysRemaining stay consistent with each other across the nightly boundary.
    daysRemaining: String(probationDaysRemaining(hireDate, new Date(`${today}T00:00:00Z`)) ?? "—"),
    reportUrl: `${systemDeployment.productionUrl}/probation/cases/${caseId}`,
  };
}

/**
 * Calendar date a milestone was crossed, given today's probation day. Read by the fresh-start
 * guard, so a milestone crossed before the 2026-07-17 reset never fires a catch-up email.
 */
export function milestoneCrossingDate(today: string, currentDay: number, milestoneDay: number): string {
  const ms = new Date(`${today}T00:00:00Z`).getTime() - (currentDay - milestoneDay) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}


/**
 * True if the milestone has been crossed AND the person is still on probation. `PROBATION_TOTAL_DAYS`
 * is the owner-locked 90-day window (src/lib/probation/date.ts), so this closes on the same day the
 * probation does.
 */
export function milestoneIsDue(currentDay: number, milestoneDay: number): boolean {
  return currentDay >= milestoneDay && currentDay <= PROBATION_TOTAL_DAYS;
}

/**
 * Send the Day 30 / 60 / 75 milestone email for every active probation case that crossed a
 * milestone within the grace window. One email per (case, milestone): To Yasmeena Elsafory,
 * CC Omar Gawish. Idempotent — safe to run on every daily cron tick.
 */
export async function processProbationMilestoneEmails(
  nowIso: string = new Date().toISOString(),
): Promise<{ scanned: number; sent: number }> {
  const today = currentCairoDateOnlyIso(new Date(nowIso));
  const supabase = getSupabaseAdmin();

  const { data: cases } = await supabase
    .from("probation_cases")
    .select("id, employee_hr_id, employee_name, hire_date")
    .eq("status", "active");

  // Defence in depth against legacy-decision desync: an "active" case whose employee was already
  // passed/terminated through the legacy workflow must not keep emailing forever. Fails OPEN.
  const rows = await filterResolvedProbationCases((cases ?? []) as ActiveCaseRow[]);
  if (rows.length === 0) return { scanned: 0, sent: 0 };

  const bcc = await resolveBccAddresses();

  const sentPerCase = await Promise.all(
    rows.map(async (c) => {
      try {
        const day = currentProbationDay(c.hire_date, today);
        if (day == null) return 0;
        let sentForCase = 0;
        for (const m of PROBATION_MILESTONES) {
          if (!milestoneIsDue(day, m.day)) continue;
          const crossedOn = milestoneCrossingDate(today, day, m.day);
          if (isDateBeforeProbationEmailFreshStart(crossedOn)) continue;

          const ctx = await buildCaseContext(c.id, c.hire_date, today);
          const employeeName = c.employee_name ?? c.employee_hr_id;
          const title = `Probation ${m.label} — ${employeeName}`;
          const message = `${employeeName} reached ${m.label}. Progress: ${ctx.dvProgress} · ${ctx.provisionalScore} · ${ctx.riskStatus}.`;

          await createSystemNotification({
            actorId: "system",
            module: "probation",
            eventType: `milestone_day${m.day}`,
            title,
            message,
            priority: "high",
            subjectHrId: c.employee_hr_id,
            recipientHrId: PROBATION_MILESTONE_TO_HR_ID,
            // In-app for the bell, email for the record. No Telegram or push: the owner asked for
            // an email, and a CC is an email-only concept.
            channels: ["in_app", "email"],
            actionUrl: ctx.reportUrl,
            email: {
              templateKey: m.key,
              notificationType: "probation_milestone",
              bcc,
              ctaHref: ctx.reportUrl,
              ctaLabel: "Open live report",
              subject: title,
              summary: message,
              title,
              templateContext: {
                employeeName,
                employeeHrId: c.employee_hr_id,
                milestoneDay: String(m.day),
                ...ctx,
                summary: `${employeeName} reached ${m.label}.`,
              },
            },
            metadata: {
              idempotencyKey: `probation:milestone:${c.id}:day${m.day}:${PROBATION_MILESTONE_TO_HR_ID}`,
            },
          }).catch(() => undefined);
          sentForCase += 1;
        }
        return sentForCase;
      } catch {
        // One un-scoreable case must never abort the rest of the cohort.
        return 0;
      }
    }),
  );

  return { scanned: rows.length, sent: sentPerCase.reduce((sum, n) => sum + n, 0) };
}
