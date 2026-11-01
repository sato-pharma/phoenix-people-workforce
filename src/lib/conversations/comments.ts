// Conversation storage — the append-only thread behind a direct order or a marketing request.
//
// The owner, 2026-09-22: the conversation must be available at ANY status (even rejected), for
// everyone on the record to know the reason and have it clarified. This is the STORAGE half; the
// ADDRESSING half — who is emailed / Telegrammed / pinged for each message — lives in
// conversations/notify.ts, which every conversation type in the system already shares. Nothing here
// decides who may read or write: that is the caller's job, exactly like every other thread service
// (candidate-comments.ts, the plan thread), because the authorisation rule belongs to the record,
// not to its storage.
//
// One table, keyed by (module, record_id) — see the migration for why the two record types share it
// rather than minting a table each.

import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The 2000-char ceiling the plan and CV threads already use, pinned by the table's own CHECK. */
export const RECORD_CONVERSATION_MAX_LENGTH = 2000;

/** The record types a conversation can hang off. Matches the table's `module` CHECK constraint. */
export type ConversationModule = "direct_orders" | "marketing_requests" | "manager_plans";

export type RecordConversationComment = {
  authorHrId: string | null;
  authorName: string | null;
  authorRole: string | null;
  body: string;
  createdAt: string;
  id: string;
  module: ConversationModule;
  recordId: string;
};

const SELECT = "id,module,record_id,author_hr_id,author_name,author_role,body,created_at";

/**
 * True when the failure is the table not being there yet (deploy landed before the migration).
 *
 * A missing table answers `PGRST205` from PostgREST, NOT `42P01` — the obvious guard misses it and
 * the thread 500s a whole detail page during the deploy window. Both codes, plus the schema-cache
 * message, are treated as the one "not applied yet" fact so the thread renders empty instead.
 */
function isConversationSchemaMissing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return /record_conversation_comments|schema cache|does not exist|PGRST205|42P01|42703/i.test(text);
}

function mapRow(row: Record<string, unknown>): RecordConversationComment {
  const text = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    authorHrId: text(row.author_hr_id),
    authorName: text(row.author_name),
    authorRole: text(row.author_role),
    body: String(row.body ?? ""),
    createdAt: String(row.created_at ?? ""),
    id: String(row.id ?? ""),
    module: String(row.module ?? "") as ConversationModule,
    recordId: String(row.record_id ?? ""),
  };
}

/**
 * Every message on one record, OLDEST first — a conversation reads top to bottom.
 *
 * `schemaReady: false` rather than a throw when the table is absent, so the thread box can render
 * empty on a detail page that must keep working during the deploy-before-migration window.
 */
export async function listRecordConversation(
  module: ConversationModule,
  recordId: string,
): Promise<{ comments: RecordConversationComment[]; schemaReady: boolean }> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("record_conversation_comments")
      .select(SELECT)
      .eq("module", module)
      .eq("record_id", recordId)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw error;
    return { comments: ((data ?? []) as Array<Record<string, unknown>>).map(mapRow), schemaReady: true };
  } catch (error) {
    if (isConversationSchemaMissing(error)) return { comments: [], schemaReady: false };
    throw error;
  }
}

/**
 * The HR_IDs that have already spoken in this thread — so a running conversation keeps its audience
 * instead of resetting to the record's owner and the author on every message.
 */
export async function listRecordConversationAuthors(
  module: ConversationModule,
  recordId: string,
): Promise<Array<string | null>> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("record_conversation_comments")
      .select("author_hr_id")
      .eq("module", module)
      .eq("record_id", recordId);
    if (error) throw error;
    return ((data ?? []) as Array<{ author_hr_id?: string | null }>).map((row) => row.author_hr_id ?? null);
  } catch (error) {
    if (isConversationSchemaMissing(error)) return [];
    throw error;
  }
}

/**
 * Write one message and return it. Throws a plain, readable error when the migration has not landed,
 * so the composer can tell the writer rather than swallowing their message.
 *
 * `author_hr_id` is stored in canonical CASING (`hrIdForStorage`), not the lower-cased comparison
 * key — writing the key is what left ~37,000 lower-cased actor ids across the database.
 */
export async function insertRecordConversationComment(input: {
  authorHrId: string | null;
  authorName: string | null;
  authorRole: string | null;
  body: string;
  module: ConversationModule;
  recordId: string;
}): Promise<RecordConversationComment> {
  const body = String(input.body ?? "").trim();
  if (!body) throw new Error("A message cannot be empty.");
  if (body.length > RECORD_CONVERSATION_MAX_LENGTH) {
    throw new Error(`Keep the message under ${RECORD_CONVERSATION_MAX_LENGTH} characters.`);
  }
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("record_conversation_comments")
      .insert({
        author_hr_id: hrIdForStorage(input.authorHrId),
        author_name: input.authorName,
        author_role: input.authorRole,
        body,
        module: input.module,
        record_id: input.recordId,
      })
      .select(SELECT)
      .single();
    if (error) throw error;
    return mapRow(data as Record<string, unknown>);
  } catch (error) {
    if (isConversationSchemaMissing(error)) {
      throw new Error("The conversation is not available yet — the database migration has not been applied.");
    }
    throw error;
  }
}
