/**
 * The daily Needs You digest — the board, once a morning, on Telegram.
 *
 * ITS OWN MORNING JOB SINCE 13 NOV 2026. It used to ride `/api/notifications/daily` at 06:36 Cairo,
 * awaited on its own before about thirty other jobs ran together. The owner then gave every one of
 * those jobs its own schedule (enterprise audit F-HR-012 / REC-049): this digest is now the job
 * `needs-you-daily-digest`, at the same 06:36, on `/api/cron/daily/needs-you-daily-digest`, with
 * its own heartbeat `phoenix-daily-needs-you-daily-digest` (src/lib/scheduled-jobs/daily-jobs.ts).
 * It runs on a request of its own, so nothing else competes with it for the database. A schedule
 * still carries the heartbeat-parity contract: a declaration whose job stops reporting pages every
 * Super Admin every 15 minutes, so its cron-job.org entry must exist (scripts/cronjob-sync.mjs).
 *
 * 🔴 AND THE RULE THE WHOLE MODULE TURNS ON REACHES THE DIGEST TOO: a board that under-reports is
 * worse than no board. A message that says nothing is waiting, on a morning when a source simply
 * did not answer, costs the decision more surely than no message would — because the looking has
 * been delegated. So:
 *
 *   - the NOT-PROVEN section is emitted FIRST, in every channel. Telegram is 900 characters of
 *     plain text truncated from the END, mid-word, with no marker, so a section that renders last
 *     is a section that silently disappears. The CLI prints it last, which is right for a terminal
 *     and fatal here.
 *   - the all-clear sentence is gated on `board.allClearProvable` and on nothing else — never on
 *     an empty list, because "no items" and "nothing could be read" are the two readings this
 *     module exists to keep apart.
 *   - the digest reports its OWN degradation inside the message. The route answers the scheduler
 *     202 before the job runs, so a caller reading the HTTP status learns nothing about this job.
 *
 * 🔴 IT FAILS CLOSED ON THE RECIPIENT. If the owner's account cannot be resolved, the digest is
 * SKIPPED and audited — never broadcast to whoever else happens to hold the role. This board is his
 * private decision queue: it names pending payroll months, unpublished closings and approval
 * backlogs, and a "safe" fallback audience is how that reaches somebody it was never meant for.
 *
 * The pure core (`boardToTelegramSections`, `buildNeedsYouDailyMessage`) takes no database, no clock
 * and no access context, so the rule whose wrong answer costs something is checkable without any of
 * them — the same split as `scripts/needs-you.mjs` and the rest of this module.
 */
import { NEEDS_YOU_EMAIL_HR_ID } from "@/lib/notifications/needs-you-recipient-guard";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logStructured } from "@/lib/observability/log";
import { systemAccessContext } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { createSystemNotification } from "@/lib/notifications/system";

import { summaryDroppedNotice } from "../ai/summary";
import { summarizeNeedsYouBoard } from "../ai/summarize";
import { getNeedsYouBoard } from "../service";
import { NEEDS_YOU_MODULE, buildNeedsYouTelegram, type TelegramSection } from "../render/telegram";
import type { NeedsYouBoard } from "../types";

/** The name the route's `onJobFailure` records, and the audit entity. One spelling, used by both. */
export const NEEDS_YOU_DAILY_JOB = "needs-you-daily-digest";

export const NEEDS_YOU_DAILY_EVENT = "needs_you_daily_digest";

/** The board's own screen. `actionUrlRequired` is true for this module's policy row. */
export const NEEDS_YOU_BOARD_PATH = "/admin/needs-you" as const;

export const NEEDS_YOU_DAILY_TITLE = "Needs You";

export type NeedsYouDailyResult = {
  delivered: number;
  skipped: boolean;
  /** Why it was skipped, or why it degraded. Always a sentence, never a code. */
  reason: string | null;
  /** How many sources could not be read. Reported so the route's JSON shows it without the body. */
  notProven: number;
};

/**
 * Board → the sections the Telegram renderer fits to budget.
 *
 * PURE. It phrases nothing that the board has not already phrased: every line is an item's own
 * `label`, which each adapter wrote with NAMES and never codes. The renderer fits; this maps; the
 * adapters phrase. Three jobs, three files, so a change to the wording cannot silently change the
 * budget arithmetic.
 *
 * 🔴 `someoneElse` IS INCLUDED, and it is not padding. A decision resting with a manager is the
 * thing he most often wants to chase, and leaving it out would make the digest disagree with the
 * board it links to — two surfaces, one question, two answers, which is the defect this module
 * spent a whole PR removing from the CEO command centre.
 */
export function boardToTelegramSections(board: NeedsYouBoard): TelegramSection[] {
  const sections: TelegramSection[] = [];

  if (board.notProven.length > 0) {
    sections.push({
      kind: "not-proven",
      heading: "Could not be read",
      lines: board.notProven.map((entry) => `${entry.label} — ${entry.because}`),
    });
  }
  if (board.yours.length > 0) {
    sections.push({
      kind: "yours",
      heading: "Waiting on you",
      // The overdue marker comes from UPSTREAM's own SLA verdict on the item, never recomputed here.
      lines: board.yours.map((item) => (item.overdue ? `${item.label} (overdue)` : item.label)),
    });
  }
  if (board.someoneElse.length > 0) {
    sections.push({
      kind: "elsewhere",
      heading: "With someone else",
      lines: board.someoneElse.map((item) => item.label),
    });
  }
  if (board.worthKnowing.length > 0) {
    sections.push({
      kind: "worth-knowing",
      heading: "Worth knowing",
      lines: board.worthKnowing.map((item) => item.label),
    });
  }
  return sections;
}

/**
 * The message body.
 *
 * PURE, and `summaryLead` is a PREFIX STRING and nothing else — that is the whole contract with the
 * tier-2 written summary. The delivered message is ALWAYS this deterministic render; a model can
 * put a sentence in front of it and can do nothing else, so there is no shape in which a summary
 * could reassure over a board that did not prove itself. Tier 2 can be deleted entirely and this
 * function does not change.
 */
export function buildNeedsYouDailyMessage(input: {
  board: NeedsYouBoard;
  boardUrl: string;
  summaryLead?: string | null;
}): string {
  const lead = String(input.summaryLead ?? "").trim();
  const body = buildNeedsYouTelegram({
    title: NEEDS_YOU_DAILY_TITLE,
    sections: boardToTelegramSections(input.board),
    boardUrl: input.boardUrl,
    allClearProvable: input.board.allClearProvable,
    // 🔴 THE LEAD SPENDS THE BODY'S BUDGET, and it has to be declared BEFORE the body is built.
    // Measured 2026-09-28, before this line existed: a 12-item board is 739 characters, and a
    // 220-character summary in front of it made 961 — past Telegram's 900, which slices from the
    // END with no marker. The summary would have pushed the BOARD off the bottom of its own digest.
    reserve: lead ? lead.length + 2 : 0,
  });
  return lead ? `${lead}\n\n${body}` : body;
}

/**
 * The owner's account, or nothing.
 *
 * 🔴 BY HR ID, NEVER BY ROLE. `resolveNotificationRoleRecipients` would hand back everyone holding
 * the role, and this board is one person's private decision queue. The role query is the right
 * shape for an HR digest and the wrong shape for this.
 */
async function resolveOwnerRecipient(): Promise<{ hrId: string; userId: string | null } | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,hr_id,is_active")
    .eq("hr_id", NEEDS_YOU_EMAIL_HR_ID)
    .eq("is_active", true)
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as { hr_id?: string | null; login_id?: string | null } | undefined;
  if (!row) return null;
  const hrId = String(row.hr_id ?? "").trim();
  if (!hrId) return null;
  return { hrId, userId: String(row.login_id ?? "").trim() || null };
}

/** Today in Cairo, as `YYYY-MM-DD`. The idempotency key's day, so a re-run cannot double-send. */
function cairoDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(now);
}

/**
 * The job.
 *
 * 🔴 IT NEVER THROWS. The route wraps every sub-job in its own `.catch(onJobFailure(...))`, and that
 * is a backstop rather than the design: a job that throws loses the reason, and the reason is the
 * only thing that distinguishes "nothing was waiting" from "the board could not be built". Every
 * exit here carries a sentence.
 */
export async function runNeedsYouDailyDigest(now: Date = new Date()): Promise<NeedsYouDailyResult> {
  let board: NeedsYouBoard;
  try {
    board = await getNeedsYouBoard(systemAccessContext, now);
  } catch (error) {
    const reason = String((error as Error | undefined)?.message ?? error ?? "").split("\n")[0].trim();
    logStructured("ERROR", "Needs You daily digest could not build the board", {
      labels: { event: "needs_you_daily_board_failed", job: NEEDS_YOU_DAILY_JOB },
      error,
    });
    return { delivered: 0, notProven: 0, reason: reason || "the board could not be built", skipped: true };
  }

  // Tier 2. `summarizeNeedsYouBoard` never throws and never spends a token on a day with an
  // unreadable source or nothing waiting, so this costs one call a morning at most.
  //
  // 🔴 A REFUSAL IS PRINTED, NOT SWALLOWED — except the two that mean "there was nothing to say".
  // Silent degradation is what hid the masked-key defect for days on 2026-09-02: a summary that
  // quietly stops appearing looks exactly like a quiet week. `summaryDroppedNotice` is the one
  // phrasing, exported so this file cannot invent a second one, and it states that the list below
  // is complete — because a missing summary must never read as a missing board.
  const verdict = await summarizeNeedsYouBoard(board);
  const readAtCairo = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  }).format(now);
  const silentRefusals = new Set([
    "a source could not be read, so no summary was attempted",
    "nothing is waiting, so there is nothing to lead with",
  ]);
  const summaryLead =
    verdict.lead ??
    (verdict.because && !silentRefusals.has(verdict.because)
      ? summaryDroppedNotice(verdict.because, readAtCairo)
      : null);

  const message = buildNeedsYouDailyMessage({ board, boardUrl: NEEDS_YOU_BOARD_PATH, summaryLead });

  let recipient: { hrId: string; userId: string | null } | null = null;
  try {
    recipient = await resolveOwnerRecipient();
  } catch (error) {
    logStructured("ERROR", "Needs You daily digest could not resolve its recipient", {
      labels: { event: "needs_you_daily_recipient_failed", job: NEEDS_YOU_DAILY_JOB },
      error,
    });
  }

  if (!recipient) {
    // Fail closed. Audited so a silently undelivered digest is still visible somewhere.
    await writeAuditLog({
      actorLoginId: "daily-dispatcher",
      entityId: "needs_you.daily_digest",
      entityType: "notification",
      newValues: { failClosed: true, notProven: board.notProven.length },
      summary: "Needs You daily digest skipped because the owner's account could not be resolved.",
    }).catch(() => undefined);
    return {
      delivered: 0,
      notProven: board.notProven.length,
      reason: "the owner's account could not be resolved, and this digest is never sent to anyone else",
      skipped: true,
    };
  }

  const result = await createSystemNotification({
    actionUrl: NEEDS_YOU_BOARD_PATH,
    actorId: "daily-dispatcher",
    // From the `needs_you.*` policy row. Email is DELIBERATELY absent here: one email to him is
    // already three deliveries (an always-BCC plus a Telegram mirror), which is why email is weekly
    // and this is daily.
    channels: ["in_app", "telegram"],
    eventType: NEEDS_YOU_DAILY_EVENT,
    message,
    metadata: {
      allClearProvable: board.allClearProvable,
      generatedAt: board.generatedAt,
      idempotencyKey: `needs-you-daily-digest:${recipient.hrId}:${cairoDay(now)}`,
      notProven: board.notProven.map((entry) => entry.label),
      someoneElseCount: board.someoneElse.length,
      worthKnowingCount: board.worthKnowing.length,
      yoursCount: board.yours.length,
    },
    module: NEEDS_YOU_MODULE,
    priority: board.yours.some((item) => item.overdue) ? "high" : "normal",
    recipientHrId: recipient.hrId,
    recipientUserId: recipient.userId,
    title: NEEDS_YOU_DAILY_TITLE,
  });

  // 🔴 COUNT THE CHANNELS THAT ACTUALLY WENT, never `deliveries.length`. Every REQUESTED channel
  // gets a row whatever happens to it, so the array's length is what was attempted — a digest that
  // failed on every channel reports the same number as one that landed. `sent` is the only status
  // meaning the message left, and `queuedForRetry` is documented as no proof the person was told.
  const sent = result.deliveries.filter((delivery) => delivery.status === "sent" && !delivery.queuedForRetry);
  const failed = result.deliveries.filter((delivery) => delivery.status === "failed");

  const notes: string[] = [];
  if (board.notProven.length > 0) {
    notes.push(
      `${board.notProven.length} source${board.notProven.length === 1 ? "" : "s"} could not be read, and the digest says so`,
    );
  }
  if (sent.length === 0) notes.push("no channel confirmed delivery");
  else if (failed.length > 0) notes.push(`${failed.length} channel${failed.length === 1 ? "" : "s"} failed`);

  return {
    delivered: sent.length,
    notProven: board.notProven.length,
    reason: notes.length > 0 ? notes.join("; ") : null,
    skipped: false,
  };
}
