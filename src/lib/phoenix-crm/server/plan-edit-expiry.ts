/**
 * Phoenix CRM — closing a request to edit a week that has passed.
 *
 * `status = 'expired'` was written in exactly one place: inside
 * `phoenix_crm_decide_plan_edit_request`, which runs only when somebody DECIDES a request. Nobody
 * ever decides one whose week is over, because by then it has dropped out of every queue
 * (`loadPlanEditRows` keeps `week_start >= today - 5`). So a request nobody got to simply stayed on
 * `manager_pending` for ever, and all three of its symptoms pointed away from the cause:
 *
 *   - its reviewer could not see it anywhere;
 *   - the rep's own week panel still read "Your district manager decides first, then SFE, then HR";
 *   - `plan_edit_expired` never went.
 *
 * This pass runs daily and closes them. It writes nothing itself: the database function picks the
 * stale rows and hands each to the decide function, whose expiry branch stays the only writer of
 * that status (migration 20261002220047 — and the SELECTION is deliberately made in SQL, in the same
 * transaction, because a caller choosing the rows against its own clock could be a day out across
 * midnight and would then APPROVE a live request, or at the HR step reopen a week nobody asked about).
 *
 * 🔴 IN-APP AND TELEGRAM, NEVER EMAIL, AND NEVER THE PHONE — the owner's own answer, 2026-10-02,
 * asked directly whether this pass should email when it closes a request. The other four steps of a
 * plan edit DO email, by his 2026-10-01 ruling, and the difference is the whole reason: those are
 * steps a PERSON took, while this is a week running out, closed in a batch, which is exactly the
 * unprompted-bulk mail he has ruled out standing. The channels are not chosen here — the module's
 * guard owns them (`PHOENIX_CRM_EMAIL_EVENT_TYPES` no longer lists `plan_edit_expired`, and
 * `PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES` does), so this file could not widen them if it tried.
 *
 * 🔴 NEVER FIRED FROM A LAPTOP. It is a production cron, and a hand-run would spend the idempotency
 * keys of whatever it closed — the rep and his managers would then never hear about those.
 */

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError, logWarning } from "@/lib/observability/log";
import { isPlanEditStatus, PLAN_EDIT_EXPIRY_ACTOR_HR_ID, type PlanEditStatus } from "@/lib/phoenix-crm/plan-edit-rules";
import { callPhoenixCrm } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";

type Row = Record<string, unknown>;

/** One request the pass closed, as the database function reports it. */
export type PlanEditExpiryClosed = {
  requestId: string;
  planId: string;
  seatId: string;
  weekStart: string;
  repHrId: string;
  /** The step it was still sitting on — the one nobody got to. */
  fromStatus: PlanEditStatus;
  version: number;
  isTest: boolean;
};

export type PlanEditExpiryRun = {
  cairoToday: string;
  /** Waiting requests whose week had passed. */
  stale: number;
  closed: number;
  /** Stale rows the function could not close — a version conflict, say. Tomorrow's pass takes them. */
  failed: number;
  /** Requests whose rep and managers were told — in-app and Telegram, never email (see the header). */
  told: number;
};

function closedFrom(raw: unknown): PlanEditExpiryClosed | null {
  const row = (raw && typeof raw === "object" ? raw : {}) as Row;
  const requestId = String(row.request_id ?? "");
  const fromStatus = row.from_status;
  if (!requestId || !isPlanEditStatus(fromStatus)) return null;
  return {
    requestId,
    planId: String(row.plan_id ?? ""),
    seatId: String(row.seat_id ?? ""),
    weekStart: String(row.week_start ?? ""),
    repHrId: String(row.rep_hr_id ?? ""),
    fromStatus,
    version: Number(row.version),
    isTest: row.is_test === true,
  };
}

/**
 * One pass.
 *
 * Never throws for a single failed notice: the request is already closed in the database by then,
 * and a notice that cannot be delivered must not look like a close that did not happen.
 */
export async function runPhoenixCrmPlanEditExpiry(): Promise<PlanEditExpiryRun> {
  const result = (await callPhoenixCrm<Row>("phoenix_crm_expire_plan_edit_requests", {
    p: { actor_hr_id: PLAN_EDIT_EXPIRY_ACTOR_HR_ID },
  })) as Row;
  const cairoToday = String(result.cairo_today ?? currentCairoDateOnlyIso());
  const stale = Number(result.stale ?? 0);
  const failed = Number(result.failed ?? 0);
  const closed = (Array.isArray(result.closed) ? result.closed : []).map(closedFrom).filter((row): row is PlanEditExpiryClosed => row !== null);

  if (stale > 0) {
    // Not an error — but a week that passed with a rep's request unanswered is worth a line in the
    // log, because the only other trace it leaves is a status nobody was watching.
    logWarning("Phoenix CRM closed requests to edit a week that had passed", {
      labels: { event: "phoenix_crm_plan_edit_expired", count: String(closed.length), stale: String(stale) },
    });
  }

  let told = 0;
  if (closed.length > 0) {
    const org = await loadPhoenixCrmOrg();
    for (const row of closed) {
      const seat = org.seats.get(row.seatId);
      // A territory that has since left the organogram has no name to put in the notice and no
      // reviewer to address. The close stands; only the telling is skipped.
      if (!seat) {
        logError("Phoenix CRM could not announce an expired plan edit: the territory is gone", {
          labels: { event: "phoenix_crm_plan_edit_expiry_seat_missing", seatId: row.seatId },
        });
        continue;
      }
      await notifyPhoenixCrm(
        {
          kind: "plan_edit",
          org,
          seat,
          requestId: row.requestId,
          version: row.version,
          weekStart: row.weekStart,
          status: "expired",
          repHrId: row.repHrId,
          // Nobody decided this, and the expired wording names no actor — see the constant's own note.
          actorHrId: PLAN_EDIT_EXPIRY_ACTOR_HR_ID,
          note: null,
        },
        row.isTest,
      );
      told += 1;
    }
  }

  return { cairoToday, stale, closed: closed.length, failed, told };
}
