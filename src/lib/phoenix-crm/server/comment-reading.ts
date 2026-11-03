/**
 * Phoenix CRM — reads visit comments in the background, and hands the results to the reports and to the rep's
 * own notes (the rules are ../comment-reading.ts).
 *
 * It rides the hourly visit roll-up rather than a cron of its own, after the reply, as the held signboards do.
 * Nothing here writes to a visit. A visit whose comment changes loses its reading to a trigger in the database,
 * so it comes back into the queue and an old quote is never left beside new words.
 *
 * The reports ask for the readings through `loadHeardCommentReadings`, which answers null rather than an empty
 * list when the read fails: the screen then says it could not read them, and never shows "nothing" for a
 * failure.
 */

import { createOpenAiResponseText, hasAiApiKey } from "@/lib/ai/openai-client";
import { tryParseAiJson } from "@/lib/ai/parse-ai-json";
import { logError } from "@/lib/observability/log";
import {
  COMMENT_READING_INSTRUCTIONS,
  COMMENT_READING_MAX_OUTPUT_TOKENS,
  COMMENT_READING_TEXT_FORMAT,
  COMMENT_READINGS_PER_FIRE,
  commentReadingPrompt,
  commentReadingText,
  readCommentBatches,
  storedMentions,
  type CommentReadingAsk,
  type CommentReadingVisit,
  type StoredCommentReading,
} from "@/lib/phoenix-crm/comment-reading";
import { chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { readSeatGroups, shareInFlight } from "@/lib/phoenix-crm/server/reports";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const TABLE = "phoenix_crm_visit_comment_readings";

/** The model the sample was hand-checked on, asked by name; the OpenAI model only when Claude's account is dead. */
const COMMENT_READING_CLAUDE_MODEL = "claude-haiku-5-5";
const COMMENT_READING_OPENAI_MODEL = "gpt-5.4-nano";
const COMMENT_READING_TIMEOUT_MS = 90_000;

const askTheModel: CommentReadingAsk = async (batch) => {
  const response = await createOpenAiResponseText({
    anthropicModel: COMMENT_READING_CLAUDE_MODEL,
    component: "phoenix_crm_comment_reading",
    input: commentReadingPrompt(batch),
    instructions: COMMENT_READING_INSTRUCTIONS,
    // A failed batch is split and asked again by the caller, so the door does not also retry it.
    maxRetries: 0,
    maxOutputTokens: COMMENT_READING_MAX_OUTPUT_TOKENS,
    model: COMMENT_READING_OPENAI_MODEL,
    preferProvider: "anthropic",
    purpose: "phoenix-crm-comment-reading",
    reasoning: { effort: "low" },
    text: COMMENT_READING_TEXT_FORMAT,
    timeoutMs: COMMENT_READING_TIMEOUT_MS,
  });
  return { answer: tryParseAiJson(response.outputText), model: response.model };
};

export type CommentReadingFire = { queued: number; read: number; calls: number; failedCalls: number; noKey: boolean };

/** One hourly fire: the newest unread comments, read and stored. */
export async function runCommentReadingFire(): Promise<CommentReadingFire> {
  if (!hasAiApiKey()) return { queued: 0, read: 0, calls: 0, failedCalls: 0, noKey: true };

  const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_comment_reading_queue", { p_limit: COMMENT_READINGS_PER_FIRE });
  throwIfError(error);
  const visits: CommentReadingVisit[] = ((data ?? []) as Row[]).flatMap((row) => {
    const comment = commentReadingText(row.comment, row.detail_comment);
    if (!comment) return [];
    return [
      {
        visitId: String(row.id),
        seatId: String(row.seat_id),
        visitDate: String(row.visit_date ?? "").slice(0, 10),
        comment,
        products: Array.isArray(row.products) ? row.products.map((entry) => String(entry)) : [],
      },
    ];
  });

  const run = await readCommentBatches(visits, askTheModel);
  for (const part of chunk(run.readings, 200)) {
    const { error: writeError } = await getSupabaseAdmin()
      .from(TABLE)
      .upsert(
        part.map((reading) => ({
          visit_id: reading.visitId,
          seat_id: reading.seatId,
          visit_date: reading.visitDate,
          stock: reading.stock,
          price: reading.price,
          follow_up: reading.followUp,
          model: reading.model,
        })),
        { onConflict: "visit_id" },
      );
    throwIfError(writeError);
  }
  return { queued: visits.length, read: run.readings.length, calls: run.calls, failedCalls: run.failedCalls, noKey: false };
}

/**
 * Readings that hold a stock or a price mention, for these territories and days. The missing-stock board and
 * What the field heard open together over the same territories and period, so they share one read.
 */
export function loadHeardCommentReadings(
  seatIds: ReadonlyArray<string>,
  period: { from: string; to: string },
): Promise<StoredCommentReading[] | null> {
  const key = `phoenix-crm:comment-readings|${period.from}|${period.to}|${seatIds.join(",")}`;
  return shareInFlight(key, async () => {
    try {
      const rows = await readSeatGroups([...seatIds], 200, (batch) =>
        fetchAllRowsKeyset<Row & { id?: unknown }>(
          () =>
            getSupabaseAdmin()
              .from(TABLE)
              .select("id:visit_id, seat_id, visit_date, stock, price")
              .in("seat_id", batch)
              .gte("visit_date", period.from)
              .lte("visit_date", period.to)
              .eq("heard", true),
          { cursorColumn: "visit_id", cursorOf: (row) => textOrNull(row.id) },
        ),
      );
      return rows.map((row) => ({
        visitId: String(row.id),
        seatId: String(row.seat_id),
        visitDate: String(row.visit_date ?? "").slice(0, 10),
        stock: storedMentions(row.stock),
        price: storedMentions(row.price),
        followUp: null,
      }));
    } catch (error) {
      logError("Phoenix CRM comment readings could not be read", { error, labels: { event: "phoenix_crm_comment_readings_read_failed" } });
      return null;
    }
  });
}

/** A rep's own follow-ups by visit, or null when the read failed. Only ever called for the rep's own seat. */
export async function loadSeatCommentFollowUps(seatId: string, fromDay: string): Promise<Map<string, string> | null> {
  try {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from(TABLE)
          .select("visit_id, follow_up")
          .eq("seat_id", seatId)
          .gte("visit_date", fromDay)
          .not("follow_up", "is", null),
      { cursorColumn: "visit_id", cursorOf: (row) => textOrNull(row.visit_id) },
    );
    return new Map(rows.flatMap((row) => {
      const followUp = textOrNull(row.follow_up);
      return followUp ? [[String(row.visit_id), followUp] as const] : [];
    }));
  } catch (error) {
    logError("Phoenix CRM comment follow-ups could not be read", { error, labels: { event: "phoenix_crm_comment_readings_read_failed" } });
    return null;
  }
}
