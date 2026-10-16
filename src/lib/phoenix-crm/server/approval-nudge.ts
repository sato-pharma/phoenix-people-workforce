/**
 * Phoenix CRM — the daily nudge to a slow approver, sent.
 *
 * The I/O half of `src/lib/phoenix-crm/approval-nudge-rules.ts`, which holds the owner's words, who is
 * told and when an item counts as waiting too long. This reads what is waiting right now — REAL entries
 * only — and delivers one message per approver.
 *
 * 🔴 NEVER FIRED FROM A LAPTOP. It is a production cron (09:57 Cairo). A hand-run spends the day's keys,
 * so the real tick that morning stays silent for everyone it reached.
 *
 * Reads, each narrowed in the database to what can possibly be overdue (raised more than a day ago —
 * an item cannot have waited at its step longer than it has existed), and then judged exactly by the
 * rules:
 *
 *   - `phoenix_crm_list_requests`, `pending`, step from `stage`;
 *   - `phoenix_crm_unplanned_visits`, `manager_pending` / `sfe_pending`;
 *   - `phoenix_crm_plan_edit_requests`, `manager_pending` / `sfe_pending`, on a week that still has a
 *     day ahead — the same window the Team tab lists them in (`loadPlanEditRows`); a request whose week
 *     is over has nothing left to change and is not anyone's to be chased for.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import {
  APPROVAL_NUDGE_AFTER_MS,
  composeApprovalNudges,
  listRequestStage,
  pendingStage,
  waitingSinceOf,
  type ApprovalNudgeNotice,
  type WaitingApproval,
} from "@/lib/phoenix-crm/approval-nudge-rules";
import { plannableWeeks } from "@/lib/phoenix-crm/calendar";
import { isWithRep } from "@/lib/phoenix-crm/list-request-rules";
import { seatIdIsInLiveTeam } from "@/lib/phoenix-crm/live-team-rules";
import { textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadLiveTeamSeatIds } from "@/lib/phoenix-crm/server/live-teams";
import {
  PHOENIX_CRM_NOTIFICATION_CATEGORY,
  PHOENIX_CRM_NOTIFICATION_MODULE,
  PHOENIX_CRM_PORTAL_PATH,
  sfeManagerHrIds,
} from "@/lib/phoenix-crm/server/notifications";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPhoenixCrmConfig, openLineCodes } from "@/lib/phoenix-crm/server/settings";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** How many approvers are being sent their nudge at once. */
const DELIVERIES_AT_ONCE = 4;

export type ApprovalNudgeRun = {
  /** Waiting more than a day at their step, real entries in open lines or not. */
  overdue: number;
  /** Overdue with nobody at the step to tell. */
  unaddressed: number;
  approvers: number;
  delivered: number;
  failed: number;
};

/** What is waiting at a manager or SFE step and was raised before `raisedBefore`, real entries only. */
async function loadWaitingApprovals(raisedBefore: string, cairoToday: string): Promise<WaitingApproval[]> {
  const supabase = getSupabaseAdmin();
  const [listRequests, unplannedVisits, planEdits, sentPlans] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_list_requests")
          .select("id, seat_id, stage, requested_at, manager_decided_at")
          .eq("is_test", false)
          .eq("status", "pending")
          .lt("requested_at", raisedBefore),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_unplanned_visits")
          .select("visit_id, seat_id, status, created_at, manager_decided_at")
          .eq("is_test", false)
          .in("status", ["manager_pending", "sfe_pending"])
          .lt("created_at", raisedBefore),
      { cursorColumn: "visit_id", cursorOf: (row) => String(row.visit_id) },
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_plan_edit_requests")
          .select("id, seat_id, status, created_at, manager_decided_at, week_start")
          .eq("is_test", false)
          .in("status", ["manager_pending", "sfe_pending"])
          .lt("created_at", raisedBefore)
          // The earliest Saturday whose week still has a day from today on — the Team tab's own window.
          .gte("week_start", addDaysIso(cairoToday, -5)),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_plans")
          .select("id, seat_id, submitted_at")
          .eq("is_test", false)
          .eq("status", "submitted")
          .lt("submitted_at", raisedBefore)
          // The Team tab's own window: a week that is over waits for nobody.
          .gte("week_start", plannableWeeks(cairoToday)[0]),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  ]);

  const items: WaitingApproval[] = [];
  for (const row of listRequests) {
    const seatId = textOrNull(row.seat_id);
    const raisedAt = textOrNull(row.requested_at);
    if (!seatId || !raisedAt) continue;
    // Returned to the rep for a comment: it waits for HIM, not for a manager, so nobody is nudged for it.
    if (isWithRep(row.stage)) continue;
    const stage = listRequestStage(row.stage);
    items.push({ kind: "list_request", seatId, stage, waitingSince: waitingSinceOf(stage, raisedAt, textOrNull(row.manager_decided_at)) });
  }
  // A sent week waits at ONE step and only ever the reviewer's — `approversFor` resolves it through
  // `territoryReviewer`, the same person `canReviewTerritory` lets approve it.
  for (const row of sentPlans) {
    const seatId = textOrNull(row.seat_id);
    const sentAt = textOrNull(row.submitted_at);
    if (!seatId || !sentAt) continue;
    items.push({ kind: "weekly_plan", seatId, stage: "manager", waitingSince: waitingSinceOf("manager", sentAt, null) });
  }
  for (const [kind, rows] of [
    ["unplanned_visit", unplannedVisits],
    ["plan_edit", planEdits],
  ] as const) {
    for (const row of rows) {
      const seatId = textOrNull(row.seat_id);
      const raisedAt = textOrNull(row.created_at);
      const stage = pendingStage(row.status);
      if (!seatId || !raisedAt || !stage) continue;
      items.push({ kind, seatId, stage, waitingSince: waitingSinceOf(stage, raisedAt, textOrNull(row.manager_decided_at)) });
    }
  }
  return items;
}

async function deliver(notice: ApprovalNudgeNotice): Promise<void> {
  // The Team module's own page, where every one of these is decided.
  const actionUrl = `${PHOENIX_CRM_PORTAL_PATH}/team`;
  await createSystemNotificationForRecipients(
    {
      actionUrl,
      category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
      // The guard's allowlist answers for every channel (email included since 2026-10-08), never this file.
      channels: phoenixCrmChannels("approval_nudge"),
      eventType: "approval_nudge",
      message: notice.message,
      metadata: { idempotencyKey: notice.idempotencyKey },
      module: PHOENIX_CRM_NOTIFICATION_MODULE,
      priority: "normal",
      subjectHrId: notice.hrId,
      telegram: { ctaLabel: "Open Team", ctaUrl: actionUrl },
      title: notice.title,
    },
    [notice.hrId],
  );
}

/**
 * One pass. Never throws for a single failed delivery: one approver whose phone is unreachable must not
 * cost the others their message. A failed READ does throw, so the dead-man's switch records the run as
 * failed rather than as a quiet morning.
 */
export async function runPhoenixCrmApprovalNudge(
  send: (notice: ApprovalNudgeNotice) => Promise<void> = deliver,
  now: Date = new Date(),
): Promise<ApprovalNudgeRun> {
  const cairoToday = currentCairoDateOnlyIso(now);
  const raisedBefore = new Date(now.getTime() - APPROVAL_NUDGE_AFTER_MS).toISOString();
  const [org, config, allItems, live] = await Promise.all([
    loadPhoenixCrmOrg(),
    loadPhoenixCrmConfig(),
    loadWaitingApprovals(raisedBefore, cairoToday),
    loadLiveTeamSeatIds(cairoToday),
  ]);
  // Only a LIVE team's approvals are chased (owner, 2026-10-08); an unreadable gate fails open.
  const items = live ? allItems.filter((item) => seatIdIsInLiveTeam(org.seats, item.seatId, live)) : allItems;
  // The SFE Managers are read only when an item is waiting at their step — most mornings none is.
  const sfeHrIds = items.some((item) => item.stage === "sfe") ? await sfeManagerHrIds() : [];
  const plan = composeApprovalNudges({ org, items, sfeHrIds, openLines: openLineCodes(config.lineRollout, cairoToday), now, cairoToday });

  // Several approvers at once rather than one after another (Phoenix CRM performance audit,
  // 2026-10-16); anyone sent more than one still gets his in their order. Every send is still
  // counted once, delivered or failed.
  const perPerson = new Map<string, ApprovalNudgeNotice[]>();
  for (const notice of plan.notices) perPerson.set(notice.hrId, [...(perPerson.get(notice.hrId) ?? []), notice]);
  let delivered = 0;
  let failed = 0;
  await mapWithConcurrency([...perPerson.values()], DELIVERIES_AT_ONCE, async (theirs) => {
    for (const notice of theirs) {
      try {
        await send(notice);
        delivered += 1;
      } catch (error) {
        failed += 1;
        logError("Phoenix CRM approval nudge could not be delivered", {
          error,
          labels: { event: "phoenix_crm_approval_nudge_failed", hrId: notice.hrId },
        });
      }
    }
  });

  return { overdue: plan.overdue, unaddressed: plan.unaddressed, approvers: plan.notices.length, delivered, failed };
}
