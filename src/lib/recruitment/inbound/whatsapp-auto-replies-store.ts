// Recruitment / ATS — reading and writing the owner's wording for the automatic WhatsApp replies.
//
// The DB-touching half of whatsapp-auto-replies.ts. Read by the bot on every automatic reply it
// sends and by the admin screen; written only by the admin screen, behind the same gate as the
// screening questions.
//
// READS ARE BEST-EFFORT AND NEVER THROW. A failed read returns an empty override map, which means
// every message falls back to its code default — the exact behaviour before this feature existed. A
// database hiccup, or the window between this code deploying and the migration being applied, must
// never stop an applicant getting a reply. 🔴 A MISSING TABLE ANSWERS PGRST205, not 42P01, and
// PostgREST reports it as an ordinary error on the select — which is why the catch below is the
// whole safety net rather than a code-specific branch.

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  autoReplyViolations,
  isAutoReplyKey,
  type AutoReplyKey,
} from "@/lib/recruitment/inbound/whatsapp-auto-replies";

const AUTO_REPLIES_TABLE = "ats_whatsapp_auto_replies";

/** Same TTL as the question wording: an owner who rewords a reply expects the very next applicant to
 *  read it, not one in an hour's time. */
const CACHE_TTL_MS = 30_000;
let replyCache: { at: number; byKey: Map<string, string> } | null = null;

/** Called after any write so the next send picks the new wording up immediately. */
export function invalidateAutoReplyCache(): void {
  replyCache = null;
}

/**
 * The saved wording, keyed by reply. Deliberately sparse — an absent key is "use the code default" —
 * and empty on a fresh system, before the migration, and after any read failure.
 */
export async function loadAutoReplyOverrides(): Promise<Map<string, string>> {
  if (replyCache && Date.now() - replyCache.at < CACHE_TTL_MS) return replyCache.byKey;

  const byKey = new Map<string, string>();
  try {
    const supabase = recruitmentDb();
    const { data, error } = await supabase.from(AUTO_REPLIES_TABLE).select("reply_key,body_text");
    if (error) throw error;
    for (const row of (data ?? []) as { reply_key: string; body_text: string | null }[]) {
      // An unknown key is skipped rather than served: it can only be a typo or a retired message,
      // and serving it would put text in front of an applicant that no sender claims.
      if (!isAutoReplyKey(row.reply_key)) continue;
      const body = typeof row.body_text === "string" ? row.body_text.trim() : "";
      if (!body) continue;
      // Re-validated on the way OUT as well as in. A row hand-edited in SQL, or written before a
      // later rule existed, must not be able to put a message Meta refuses in front of a real
      // applicant — and a dropped override falls back to the code default, which is always safe.
      if (autoReplyViolations({ bodyText: body, key: row.reply_key }).length > 0) {
        logError("A saved WhatsApp auto-reply is invalid and was ignored", {
          labels: { event: "whatsapp_auto_reply_invalid_row", reply: row.reply_key },
        });
        continue;
      }
      byKey.set(row.reply_key, body);
    }
  } catch (error) {
    // Deliberately not rethrown — see the file header. Every message falls back to its default.
    logError("WhatsApp auto-reply wording failed to load", {
      error,
      labels: { event: "whatsapp_auto_replies_load_failed" },
    });
    return new Map();
  }

  replyCache = { at: Date.now(), byKey };
  return byKey;
}

/**
 * Saves one reply's wording, or clears it back to the code default when the admin left the box
 * empty — or typed the default back in, which the screen sends as a blank for exactly this reason.
 *
 * Validated BEFORE the write with the same validator the client runs, so a message that would fail
 * for a real applicant cannot be persisted. A failed save THROWS, unlike a failed read: the owner
 * pressed a button and must be told it did not take.
 */
export async function saveAutoReply(input: {
  key: string;
  bodyText: string;
  actorHrId: string | null;
}): Promise<void> {
  if (!isAutoReplyKey(input.key)) {
    throw new Error(`"${input.key}" is not one of the automatic replies.`);
  }
  const key: AutoReplyKey = input.key;
  const body = input.bodyText.trim();

  if (!body) {
    await resetAutoReply({ key });
    return;
  }

  const problems = autoReplyViolations({ bodyText: body, key });
  if (problems.length > 0) throw new Error(problems.join(" "));

  const supabase = recruitmentDb();
  const { error } = await supabase.from(AUTO_REPLIES_TABLE).upsert(
    {
      body_text: body,
      reply_key: key,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: input.actorHrId,
    },
    { onConflict: "reply_key" },
  );
  if (error) throw error;
  invalidateAutoReplyCache();
}

/** Back to the code default: the row is DROPPED, never overwritten with a copy of the default text
 *  that would then silently go stale the day that default is improved. */
export async function resetAutoReply(input: { key: AutoReplyKey }): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from(AUTO_REPLIES_TABLE).delete().eq("reply_key", input.key);
  if (error) throw error;
  invalidateAutoReplyCache();
}
