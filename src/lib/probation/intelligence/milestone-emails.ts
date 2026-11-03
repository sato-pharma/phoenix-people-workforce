// Probation Day 30 / 60 / 75 milestone emails.
//
// OWNER RULE (2026-10-20): these three emails go to ONE person — Omar Gawish (B-10), the owner —
// and nobody else ("To you only"). From 2026-09-29 they went to the HR Generalist of the day with
// him on BCC; she moved to her own seat (HR Operations Specialist) on 2026-10-20 and he took the
// milestones himself. The only other copy is the standing admin BCC every automated email carries
// (send-phoenix-email.ts), which is his own mailbox. This is NOT the 2026-07 stakeholder fan-out
// (CEO + HR + DM + NSM + SFE, ~8 people per milestone) that the owner retired on 2026-08-02 in
// #1624/#1626 — do not restore it, and do not "improve" this into a role-resolved recipient set.
//
// Why a separate notification type. The module-wide `probation` email policy is OFF: the owner
// turned it off on 2026-07-19 and confirmed on 2026-08-13 that it STAYS off. It still governs the
// legacy per-manager probation reminders, which are wired to the 5-minute notification cron and
// would resume the moment that toggle flipped. So these milestone emails carry their own
// notification type, `probation_milestone`, with its own admin toggle — re-enabling the one the
// owner asked for never re-opens the flood he switched off.
//
// One email per (case, milestone), idempotent, so the daily sweep is a no-op after the first send —
// and a change of recipient does NOT re-send what an earlier recipient already received (see
// `milestoneKeysToSend`).

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey } from "@/lib/hr-id";
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

/** Omar Gawish (B-10) — the ONLY recipient (owner, 2026-10-20: "To you only"). */
export const PROBATION_MILESTONE_TO_HR_ID = "B-10";

/**
 * The last segment of every milestone's dedup key. FROZEN — it is NOT a recipient, and changing it
 * would re-send every milestone currently due.
 *
 * It is the HR id the milestones were first addressed to (2026-09-29 to 2026-10-20), and every
 * milestone already delivered is recorded under a key ending in it. A key is a name for "this
 * case's Day N milestone", so it stays exactly as it was when the recipient changed; who the email
 * goes to is `PROBATION_MILESTONE_TO_HR_ID`, and nothing else reads this value.
 */
export const PROBATION_MILESTONE_KEY_SUFFIX = "HR-009";

export const PROBATION_MILESTONES = [
  { day: 30, key: "probation_day30", label: "Day 30 — early progress" },
  { day: 60, key: "probation_day60", label: "Day 60 — completion planning" },
  { day: 75, key: "probation_day75", label: "Day 75 — decision readiness" },
] as const;

type ProbationMilestone = (typeof PROBATION_MILESTONES)[number];

/** The event key one (case, milestone) is sent under — the same string since 2026-09-29. */
export function probationMilestoneEventKey(caseId: string, milestoneDay: number): string {
  return `probation:milestone:${caseId}:day${milestoneDay}:${PROBATION_MILESTONE_KEY_SUFFIX}`;
}

// A milestone is due from the day it is crossed until the probation itself ends, and the dedup key
// is what stops it repeating.
//
// The retired fan-out used a 7-day grace window instead, because a catch-up there meant ~8
// stakeholder emails per milestone. With ONE recipient that trade runs backwards: a window silently
// drops a milestone HR never saw. Owner, 2026-09-29 — "backfill any missings to her now". HR had
// received none of the 334 historical milestone deliveries; every one went to the CEO and the
// manager chain.
//
// A milestone is therefore due for anyone still ON probation, and never once a probation is over —
// a "Day 30 — early progress" notice for someone 150 days in is wrong information, not a late email.
// One case can emit several milestones in one pass, and the dedup key means each happens once.

// THE CATCH-UP IS RELEASED (owner, 2026-09-29 — "release the held probation milestones"). It was
// asked for, measured, held back for a few hours under a start-date constant while the recipient's
// own address was corrected, and then released. The constant is gone rather than merely moved back:
// the rule above IS the rule, and a second dormant cutoff sitting beside the 2026-07-17 fresh start
// would only read as a live gate to whoever finds it next.

type ActiveCaseRow = {
  id: string;
  employee_hr_id: string;
  employee_name: string | null;
  hire_date: string | null;
};

type MilestoneEventRow = { event_key?: string | null; employee_hr_id?: string | null };

/**
 * Which of the due milestone keys to hand to the notification layer, given the event rows already
 * written under them. Pure, so the re-send rule is testable without a database.
 *
 *   - No row: never sent — send it.
 *   - A row addressed to the current recipient: hand it over exactly as before. The layer's own
 *     per-recipient delivery claim makes it a no-op once sent, and completes one that never got
 *     that far.
 *   - A row addressed to anybody else: an EARLIER recipient already received this milestone. Skip
 *     it. The layer dedupes deliveries per recipient, so handing it over would email it a second
 *     time — to every case currently due, the day the recipient changed — and its event upsert
 *     would move the earlier recipient's bell row onto the new one.
 */
export function milestoneKeysToSend(
  dueKeys: readonly string[],
  existingRows: readonly MilestoneEventRow[],
  recipientHrId: string,
): Set<string> {
  const recipientKey = canonicalHrIdKey(recipientHrId);
  const sentElsewhere = new Set<string>();
  for (const row of existingRows) {
    const key = String(row.event_key ?? "");
    if (key && canonicalHrIdKey(row.employee_hr_id) !== recipientKey) sentElsewhere.add(key);
  }
  return new Set(dueKeys.filter((key) => !sentElsewhere.has(key)));
}

/**
 * The event rows already written for these keys. THROWS on a read error: the sweep must not guess,
 * because a guess of "nothing was sent" is the re-send `milestoneKeysToSend` exists to stop. Every
 * milestone stays due until day 90, so a failed run loses nothing — the next one sends it.
 */
async function readMilestoneEvents(keys: readonly string[]): Promise<MilestoneEventRow[]> {
  const rows: MilestoneEventRow[] = [];
  for (let start = 0; start < keys.length; start += 100) {
    const { data, error } = await getSupabaseAdmin()
      .from("notification_events")
      .select("event_key, employee_hr_id")
      .in("event_key", keys.slice(start, start + 100));
    if (error) throw new Error(`Probation milestone sweep could not read what was already sent: ${error.message}`);
    rows.push(...((data ?? []) as MilestoneEventRow[]));
  }
  return rows;
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
 * Send the Day 30 / 60 / 75 milestone email for every active probation case that has crossed a
 * milestone and is still on probation. One email per (case, milestone), To Omar Gawish alone.
 * Idempotent — safe to run on every daily cron tick.
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

  // What is due today, decided before anything is read or sent.
  const due: Array<{ c: ActiveCaseRow; milestones: ProbationMilestone[] }> = [];
  for (const c of rows) {
    const day = currentProbationDay(c.hire_date, today);
    if (day == null) continue;
    const milestones = PROBATION_MILESTONES.filter(
      (m) => milestoneIsDue(day, m.day) && !isDateBeforeProbationEmailFreshStart(milestoneCrossingDate(today, day, m.day)),
    );
    if (milestones.length > 0) due.push({ c, milestones });
  }
  if (due.length === 0) return { scanned: rows.length, sent: 0 };

  const dueKeys = due.flatMap(({ c, milestones }) => milestones.map((m) => probationMilestoneEventKey(c.id, m.day)));
  const toSend = milestoneKeysToSend(dueKeys, await readMilestoneEvents(dueKeys), PROBATION_MILESTONE_TO_HR_ID);
  // The case stores the name it was opened with; the email shows the display name (owner, 2026-11-03).
  // Best-effort: a failed read costs the nickname and nothing else.
  const shownNames = await namesByHrId(due.map(({ c }) => c.employee_hr_id)).catch(() => null);

  const sentPerCase = await Promise.all(
    due.map(async ({ c, milestones }) => {
      try {
        let sentForCase = 0;
        for (const m of milestones) {
          const eventKey = probationMilestoneEventKey(c.id, m.day);
          if (!toSend.has(eventKey)) continue;

          const ctx = await buildCaseContext(c.id, c.hire_date, today);
          const employeeName = shownNames?.get(c.employee_hr_id) ?? c.employee_name ?? c.employee_hr_id;
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
            // an email. No bcc and no cc — he is the To, and the standing admin BCC is his own.
            channels: ["in_app", "email"],
            actionUrl: ctx.reportUrl,
            email: {
              templateKey: m.key,
              notificationType: "probation_milestone",
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
              idempotencyKey: eventKey,
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
