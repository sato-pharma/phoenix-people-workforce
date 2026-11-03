/**
 * The weekly Needs You email — the WHOLE board, once a week, to one person.
 *
 * 🔴 WHAT MAKES IT DIFFERENT FROM THE DAILY DIGEST, AND WHY BOTH EXIST. Telegram is 900 characters
 * of plain text sliced from the END, mid-word, with no marker, so the daily digest is a message
 * built TO A BUDGET: it fits what it can and counts what it left out. Email has no such ceiling, so
 * this one is COMPLETE — every item in every lane, plus the full source roster with each source's
 * own verdict. The daily answers "what needs me today"; the weekly answers "what is the state of all
 * every source", which is the question a budgeted message structurally cannot answer.
 *
 * 🔴 ONE EMAIL TO HIM IS ALREADY THREE DELIVERIES. `send-phoenix-email.ts` always BCCs
 * `ADMIN_STANDING_EMAIL` and mirrors a preview to his Telegram, with no opt-out. That is the whole
 * reason this is WEEKLY while the Telegram digest is daily, and the reason this never requests the
 * `telegram` channel: it would arrive twice on the same wire.
 *
 * 🔴 THE RECIPIENT IS GUARDED TWICE, ON PURPOSE. This module resolves the owner by his own hr id and
 * skips if it cannot; `enforceNeedsYouOwnerOnlyEmail` then strips `email` at the end of
 * `basePolicyChannels` unless the resolved recipient is provably him. Neither layer is redundant:
 * this one decides WHO to send to, the guard decides whether email may survive at all, and email
 * re-enters that pipeline from places this file cannot see — an explicit `channels` argument, the
 * code defaults, and the Telegram-failure fallback. A sent email cannot be recalled.
 *
 * It rides the 06:36 daily route and self-gates to one weekday, the same shape as
 * the weekly system health digest had (retired 2026-10-23). No new schedule: see `./daily.ts` for why a dedicated cron job is
 * the expensive mistake here.
 */
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { NEEDS_YOU_EMAIL_HR_ID, NEEDS_YOU_MODULE } from "@/lib/notifications/needs-you-recipient-guard";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logStructured } from "@/lib/observability/log";
import { systemAccessContext } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";

import { buildNeedsYouSections, needsYouHeroDescription } from "../render/sections";
import { getNeedsYouBoard } from "../service";
import type { NeedsYouBoard } from "../types";
import { NEEDS_YOU_VENDORS_NOT_READ_LINE } from "../vendor-accounts-rules";

import { NEEDS_YOU_BOARD_PATH } from "./daily";

export const NEEDS_YOU_WEEKLY_JOB = "needs-you-weekly-email";
export const NEEDS_YOU_WEEKLY_EVENT = "needs_you_weekly_digest";

/**
 * Sunday — the start of the Egyptian work week, and the day the retired weekly system health digest
 * used. The complete board is a planning document, so it belongs at the start of the week rather
 * than the end of one. 0=Sun … 6=Sat.
 */
export const NEEDS_YOU_WEEKLY_WEEKDAY = 0;

const DAY_MAP: Record<string, number> = { Fri: 5, Mon: 1, Sat: 6, Sun: 0, Thu: 4, Tue: 2, Wed: 3 };

/** Weekday (0=Sun … 6=Sat) in Cairo — the cron's business timezone, never the server's. */
export function cairoWeekday(now: Date): number {
  const label =
    new Intl.DateTimeFormat("en-US", { timeZone: PHOENIX_BUSINESS_TIME_ZONE, weekday: "short" })
      .formatToParts(now)
      .find((part) => part.type === "weekday")?.value ?? "Sun";
  return DAY_MAP[label] ?? 0;
}

function cairoDateKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PHOENIX_BUSINESS_TIME_ZONE }).format(now);
}

export type NeedsYouWeeklyResult = {
  delivered: number;
  skipped: boolean;
  reason: string | null;
  notProven: number;
};

/**
 * The subject line.
 *
 * It states the board's verdict rather than a fixed phrase, because a subject that reads the same
 * every week is a subject nobody reads. `needsYouHeroDescription` already owns that sentence for the
 * page — reused here so the email and the screen cannot disagree about what the week looks like.
 */
export function buildNeedsYouWeeklySubject(board: NeedsYouBoard): string {
  return `Needs You — ${needsYouHeroDescription(board)}`;
}

/**
 * The complete body.
 *
 * PURE. No clock, no database, no access context.
 *
 * 🔴 COULD-NOT-BE-READ LEADS HERE TOO. Email does not truncate, so the reason is different from
 * Telegram's — but a reader leaves after the first screen, and a source that did not answer is the
 * one thing that changes how every number below it should be read. Same rule, same position, every
 * channel.
 *
 * 🔴 AND IT ENDS WITH THE FULL SOURCE ROSTER, which is this channel's entire reason for existing.
 * The daily digest can never carry every source verdict inside 900 characters, so "which sources
 * answered this week" is a question only the email can answer. `board.sources` holds one entry per
 * source ALWAYS — pinned by a test — so a source dropped by a lost `await` shows up here as a row
 * rather than as an absence nobody notices.
 */
export function buildNeedsYouWeeklyEmail(input: { board: NeedsYouBoard; boardUrl: string }): string {
  const { board, boardUrl } = input;
  const sections = buildNeedsYouSections(board);
  const out: string[] = [needsYouHeroDescription(board), ""];

  // The page's own section order already puts not-proven first; this asserts it rather than
  // assuming it, so a reorder over there cannot quietly demote it here.
  const ordered = [
    ...sections.filter((section) => section.id === "not-proven"),
    ...sections.filter((section) => section.id !== "not-proven"),
  ];

  for (const section of ordered) {
    if (section.band === "notices") {
      if (section.notices.length === 0) continue;
      out.push(section.title.toUpperCase(), section.description, "");
      for (const notice of section.notices) out.push(`• ${notice.label} — ${notice.because}`);
      out.push("");
      continue;
    }
    if (section.band === "table") {
      out.push(section.title.toUpperCase(), section.description, "");
      if (section.rows.length === 0) {
        out.push(section.emptyLine, "");
        continue;
      }
      for (const row of section.rows) {
        const parts = [row.what, row.howMany, row.whoSince].map((part) => String(part ?? "").trim()).filter(Boolean);
        out.push(`• ${parts.join(" · ")}`);
        if (row.overdueLabel) out.push(`  ${row.overdueLabel}`);
        if (row.note) out.push(`  ${row.note}`);
        out.push(`  ${row.whereLabel}`);
      }
      out.push("");
      continue;
    }
    if (section.band === "prose") {
      out.push(section.title.toUpperCase(), section.description, "");
      if (section.lines.length === 0) {
        out.push(section.emptyLine, "");
        continue;
      }
      for (const line of section.lines) out.push(`• ${line.text} — ${line.whereLabel}`);
      out.push("");
      continue;
    }
    out.push(section.title.toUpperCase(), section.description, "");
    for (const row of section.rows) {
      out.push(`• ${row.label}: ${row.verdict}${row.because ? ` — ${row.because}` : ""}`);
    }
    out.push("");
  }

  out.push(NEEDS_YOU_VENDORS_NOT_READ_LINE, "");
  out.push(`The full board: ${boardUrl}`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The owner's account, or nothing. By hr id, never by role — see `./daily.ts`. */
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

/**
 * The job. NEVER throws — every exit carries a sentence, for the same reason the daily one does:
 * a job that throws loses the reason, and the reason is what separates "nothing was waiting" from
 * "the board could not be built".
 */
export async function runNeedsYouWeeklyEmail(options?: { force?: boolean; now?: Date }): Promise<NeedsYouWeeklyResult> {
  const now = options?.now ?? new Date();
  if (!options?.force && cairoWeekday(now) !== NEEDS_YOU_WEEKLY_WEEKDAY) {
    return { delivered: 0, notProven: 0, reason: "not the weekly email day", skipped: true };
  }

  let board: NeedsYouBoard;
  try {
    board = await getNeedsYouBoard(systemAccessContext, now);
  } catch (error) {
    const reason = String((error as Error | undefined)?.message ?? error ?? "").split("\n")[0].trim();
    logStructured("ERROR", "Needs You weekly email could not build the board", {
      labels: { event: "needs_you_weekly_board_failed", job: NEEDS_YOU_WEEKLY_JOB },
      error,
    });
    return { delivered: 0, notProven: 0, reason: reason || "the board could not be built", skipped: true };
  }

  let recipient: { hrId: string; userId: string | null } | null = null;
  try {
    recipient = await resolveOwnerRecipient();
  } catch (error) {
    logStructured("ERROR", "Needs You weekly email could not resolve its recipient", {
      labels: { event: "needs_you_weekly_recipient_failed", job: NEEDS_YOU_WEEKLY_JOB },
      error,
    });
  }

  if (!recipient) {
    await writeAuditLog({
      actorLoginId: "daily-dispatcher",
      entityId: "needs_you.weekly_email",
      entityType: "notification",
      newValues: { failClosed: true, notProven: board.notProven.length },
      summary: "Needs You weekly email skipped because the owner's account could not be resolved.",
    });
    return {
      delivered: 0,
      notProven: board.notProven.length,
      reason: "the owner's account could not be resolved, and this email is never sent to anyone else",
      skipped: true,
    };
  }

  const result = await createSystemNotification({
    actionUrl: NEEDS_YOU_BOARD_PATH,
    actorId: "daily-dispatcher",
    // 🔴 NO `telegram` HERE. The email already mirrors a preview to his Telegram on its way out, so
    // asking for the channel as well delivers the same board twice on the same wire.
    channels: ["in_app", "email"],
    eventType: NEEDS_YOU_WEEKLY_EVENT,
    message: buildNeedsYouWeeklyEmail({ board, boardUrl: NEEDS_YOU_BOARD_PATH }),
    metadata: {
      allClearProvable: board.allClearProvable,
      generatedAt: board.generatedAt,
      idempotencyKey: `needs-you-weekly-email:${recipient.hrId}:${cairoDateKey(now)}`,
      notProven: board.notProven.map((entry) => entry.label),
      sourceCount: board.sources.length,
      yoursCount: board.yours.length,
    },
    module: NEEDS_YOU_MODULE,
    priority: "normal",
    recipientHrId: recipient.hrId,
    recipientUserId: recipient.userId,
    // 🔴 `title` IS the subject line — there is no `subject` field on this input, and the
    // similarly-named `subjectHrId` is something else entirely (the person a notification is
    // ABOUT, used for the sensitive-module recipient checks). Setting that one here would hand the
    // governance layer a bogus subject and change who is allowed to receive this.
    title: buildNeedsYouWeeklySubject(board),
  });

  // `sent` is the only status meaning it left; `queuedForRetry` is documented as no proof.
  const sent = result.deliveries.filter((delivery) => delivery.status === "sent" && !delivery.queuedForRetry);
  const notes: string[] = [];
  if (board.notProven.length > 0) {
    notes.push(
      `${board.notProven.length} source${board.notProven.length === 1 ? "" : "s"} could not be read, and the email says so`,
    );
  }
  if (sent.length === 0) notes.push("no channel confirmed delivery");

  return {
    delivered: sent.length,
    notProven: board.notProven.length,
    reason: notes.length > 0 ? notes.join("; ") : null,
    skipped: false,
  };
}
