// HR Reminders — the database half.
//
// Every rule is decided in ./logic.ts; this file only reads and writes the two tables and applies
// those rules to what comes back. Both tables are service-role only (no browser grants), so THIS is
// the access boundary: visibility is computed in TypeScript over the rows and a request for an item
// the viewer cannot see is answered 404, never 403, so the existence of a private note is not
// something a guess can confirm.
//
// A deploy that lands before its migration must not take the page down, so a missing table answers
// `schemaReady: false` and an empty board rather than a 500 (PostgREST reports it as PGRST205).

import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import type { AccessContext } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import {
  REMINDER_OVERSEER_ROLE,
  REMINDER_TEAM_ROLES,
  reminderAudienceFor,
} from "@/lib/hr-reminders/access";
import {
  addDays,
  canChangeReminder,
  canSeeReminder,
  clockFromDatabase,
  commentAudience,
  dedupeHrIds,
  isReminderColor,
  normaliseSharing,
  parseCommentBody,
  parseReminderDraft,
  type ReminderAudience,
} from "@/lib/hr-reminders/logic";
import { notifyReminderComment } from "@/lib/hr-reminders/notify";
import type {
  ReminderBoardData,
  ReminderCommentView,
  ReminderDraft,
  ReminderRecord,
  ReminderView,
  TeamMember,
} from "@/lib/hr-reminders/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** A finished item stays on the board this long before it drops out of the lists. */
export const DONE_ITEM_KEEP_DAYS = 120;
/** One read never returns more than this many items; the oldest finished ones are what falls off. */
export const BOARD_ROW_CAP = 2000;
const COMMENT_ID_CHUNK = 80;
const COMMENT_THREAD_CAP = 500;

export class ReminderServiceError extends Error {
  readonly status: 400 | 403 | 404 | 503;

  constructor(message: string, status: 400 | 403 | 404 | 503) {
    super(message);
    this.name = "ReminderServiceError";
    this.status = status;
  }
}

export function isReminderServiceError(error: unknown): error is ReminderServiceError {
  return error instanceof ReminderServiceError;
}

const REMINDER_COLUMNS =
  "id, owner_hr_id, title, body, remind_on, starts_at, ends_at, color, status, done_at, done_by_hr_id, share_with_team, shared_with_hr_ids, created_at, updated_at";
const COMMENT_COLUMNS = "id, reminder_id, reply_to_id, author_hr_id, body, created_at";

type ReminderRow = {
  body: string | null;
  color: string | null;
  created_at: string;
  done_at: string | null;
  done_by_hr_id: string | null;
  ends_at: string | null;
  id: string;
  owner_hr_id: string;
  remind_on: string | null;
  share_with_team: boolean | null;
  shared_with_hr_ids: string[] | null;
  starts_at: string | null;
  status: string | null;
  title: string;
  updated_at: string;
};

type CommentRow = {
  author_hr_id: string;
  body: string;
  created_at: string;
  id: string;
  reminder_id: string;
  reply_to_id: string | null;
};

/** PostgREST answers a table it has never heard of with PGRST205; Postgres itself with 42P01. */
export function isMissingTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: string; message?: string };
  if (code === "PGRST205" || code === "42P01") return true;
  const text = String(message ?? "").toLowerCase();
  return text.includes("hr_reminder") && (text.includes("schema cache") || text.includes("does not exist"));
}

function recordOf(row: ReminderRow): ReminderRecord {
  return {
    body: row.body ?? "",
    color: isReminderColor(row.color) ? row.color : "orange",
    createdAt: row.created_at,
    doneAt: row.done_at,
    doneByHrId: row.done_by_hr_id,
    endsAt: clockFromDatabase(row.ends_at),
    id: row.id,
    ownerHrId: row.owner_hr_id,
    remindOn: row.remind_on,
    shareWithTeam: Boolean(row.share_with_team),
    sharedWithHrIds: Array.isArray(row.shared_with_hr_ids) ? row.shared_with_hr_ids : [],
    startsAt: clockFromDatabase(row.starts_at),
    status: row.status === "done" ? "done" : "open",
    title: row.title,
    updatedAt: row.updated_at,
  };
}

function audienceOrThrow(access: Pick<AccessContext, "hrId" | "role">): ReminderAudience {
  const audience = reminderAudienceFor(access);
  if (!audience) throw new ReminderServiceError("Sign in again to use HR Reminders.", 403);
  return audience;
}

// ── The team ───────────────────────────────────────────────────────────────────────────────────

/**
 * The people a note can be shared with: every active holder of an HR team seat, one entry per
 * PERSON (the HR Manager's two logins are one), named as the company names them. A test account is
 * a mirror of someone else and is never a teammate.
 */
export async function loadReminderTeam(): Promise<TeamMember[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("app_auth_users")
    .select("hr_id, role, is_active, is_test_persona")
    .in("role", [...REMINDER_TEAM_ROLES])
    .eq("is_active", true);
  if (error) throw new ReminderServiceError("The HR team could not be read right now.", 503);

  const people = new Map<string, { hrId: string; isOverseer: boolean }>();
  for (const row of (data ?? []) as Array<{ hr_id: string | null; is_test_persona: boolean | null; role: string }>) {
    if (row.is_test_persona) continue;
    const hrId = canonicalPersonHrId(row.hr_id);
    const key = canonicalHrIdKey(hrId);
    if (!hrId || !key) continue;
    const existing = people.get(key);
    const isOverseer = row.role === REMINDER_OVERSEER_ROLE;
    if (existing) existing.isOverseer = existing.isOverseer || isOverseer;
    else people.set(key, { hrId, isOverseer });
  }

  const names = await namesByHrId([...people.values()].map((person) => person.hrId));
  return [...people.values()]
    .map((person) => ({ hrId: person.hrId, isOverseer: person.isOverseer, name: names.get(person.hrId) ?? person.hrId }))
    .sort((left, right) => Number(right.isOverseer) - Number(left.isOverseer) || left.name.localeCompare(right.name));
}

function teamHrIds(team: readonly TeamMember[]): string[] {
  return team.map((member) => member.hrId);
}

// ── Hydrating rows into what the board draws ───────────────────────────────────────────────────

type CommentStat = { count: number; lastAt: string | null };

async function commentStats(reminderIds: readonly string[]): Promise<Map<string, CommentStat>> {
  const stats = new Map<string, CommentStat>();
  if (reminderIds.length === 0) return stats;
  const db = getSupabaseAdmin();
  for (let start = 0; start < reminderIds.length; start += COMMENT_ID_CHUNK) {
    const { data, error } = await db
      .from("hr_reminder_comments")
      .select("reminder_id, created_at")
      .in("reminder_id", reminderIds.slice(start, start + COMMENT_ID_CHUNK));
    if (error) continue;
    for (const row of (data ?? []) as Array<{ created_at: string; reminder_id: string }>) {
      const stat = stats.get(row.reminder_id) ?? { count: 0, lastAt: null };
      stat.count += 1;
      if (!stat.lastAt || row.created_at > stat.lastAt) stat.lastAt = row.created_at;
      stats.set(row.reminder_id, stat);
    }
  }
  return stats;
}

async function hydrate(rows: readonly ReminderRow[], viewer: ReminderAudience): Promise<ReminderView[]> {
  const records = rows.map(recordOf);
  const [stats, names] = await Promise.all([
    commentStats(records.map((record) => record.id)),
    namesByHrId(records.map((record) => record.ownerHrId)),
  ]);
  return records.map((record) => ({
    ...record,
    canChange: canChangeReminder(viewer, record),
    commentCount: stats.get(record.id)?.count ?? 0,
    lastCommentAt: stats.get(record.id)?.lastAt ?? null,
    ownerName: names.get(record.ownerHrId) ?? record.ownerHrId,
  }));
}

// ── The board ──────────────────────────────────────────────────────────────────────────────────

export async function loadReminderBoard(access: Pick<AccessContext, "hrId" | "role">): Promise<ReminderBoardData> {
  const viewer = audienceOrThrow(access);
  const today = todayInCairo();
  const db = getSupabaseAdmin();

  let team: TeamMember[] = [];
  try {
    team = await loadReminderTeam();
  } catch {
    // The board still opens: only the "share with" picker is thinner until the roster reads again.
    team = [];
  }
  const self = team.find((member) => canonicalHrIdKey(member.hrId) === canonicalHrIdKey(viewer.hrId));
  const viewerName = self?.name ?? (await namesByHrId([viewer.hrId])).get(viewer.hrId) ?? viewer.hrId;
  const viewerInfo = { hrId: viewer.hrId, isOverseer: viewer.isOverseer, name: viewerName };

  const keepSince = new Date(Date.parse(`${addDays(today, -DONE_ITEM_KEEP_DAYS)}T00:00:00Z`)).toISOString();
  const { data, error } = await db
    .from("hr_reminders")
    .select(REMINDER_COLUMNS)
    .is("deleted_at", null)
    .or(`status.eq.open,done_at.gte.${keepSince}`)
    .order("remind_on", { ascending: true, nullsFirst: false })
    .range(0, BOARD_ROW_CAP - 1);

  if (error) {
    if (isMissingTable(error)) return { reminders: [], schemaReady: false, team, today, viewer: viewerInfo };
    throw new ReminderServiceError("Reminders could not be read right now.", 503);
  }

  const visible = ((data ?? []) as ReminderRow[]).filter((row) => canSeeReminder(viewer, recordOf(row)));
  return { reminders: await hydrate(visible, viewer), schemaReady: true, team, today, viewer: viewerInfo };
}

// ── One item ───────────────────────────────────────────────────────────────────────────────────

async function readReminder(id: string, viewer: ReminderAudience): Promise<ReminderRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ReminderServiceError("That reminder does not exist.", 404);
  const { data, error } = await getSupabaseAdmin()
    .from("hr_reminders")
    .select(REMINDER_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw new ReminderServiceError("HR Reminders is not switched on yet.", 503);
    throw new ReminderServiceError("That reminder could not be read right now.", 503);
  }
  const row = data as ReminderRow | null;
  // 404, never 403: an item the viewer may not see simply is not there for them.
  if (!row || !canSeeReminder(viewer, recordOf(row))) throw new ReminderServiceError("That reminder does not exist.", 404);
  return row;
}

async function oneView(row: ReminderRow, viewer: ReminderAudience): Promise<ReminderView> {
  const [view] = await hydrate([row], viewer);
  return view as ReminderView;
}

export async function createReminder(
  access: Pick<AccessContext, "hrId" | "role">,
  input: unknown,
): Promise<ReminderView> {
  const viewer = audienceOrThrow(access);
  const parsed = parseReminderDraft(input);
  if (!parsed.ok) throw new ReminderServiceError(parsed.message, 400);

  const team = await loadReminderTeam();
  const sharing = normaliseSharing(parsed.value, viewer.hrId, teamHrIds(team));
  const draft: ReminderDraft = { ...parsed.value, ...sharing };

  const { data, error } = await getSupabaseAdmin()
    .from("hr_reminders")
    .insert({ ...fieldsFromDraft(draft), owner_hr_id: hrIdForStorage(viewer.hrId) })
    .select(REMINDER_COLUMNS)
    .single();
  if (error || !data) {
    if (isMissingTable(error)) throw new ReminderServiceError("HR Reminders is not switched on yet.", 503);
    throw new ReminderServiceError("The reminder could not be saved.", 503);
  }
  return oneView(data as ReminderRow, viewer);
}

/** The columns an author controls. The owner is never among them: it is set once, on insert. */
function fieldsFromDraft(draft: ReminderDraft) {
  return {
    body: draft.body,
    color: draft.color,
    ends_at: draft.endsAt,
    remind_on: draft.remindOn,
    share_with_team: draft.shareWithTeam,
    shared_with_hr_ids: draft.sharedWithHrIds,
    starts_at: draft.startsAt,
    title: draft.title,
  };
}

/**
 * Edit an item, or tick it off and back. A body carrying `title` is a full edit (the board sends the
 * whole form); a body carrying only `status` is the checkbox. Only the author may do either.
 */
export async function updateReminder(
  access: Pick<AccessContext, "hrId" | "role">,
  id: string,
  input: unknown,
): Promise<ReminderView> {
  const viewer = audienceOrThrow(access);
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const status = raw.status === "open" || raw.status === "done" ? raw.status : null;
  const isEdit = "title" in raw;
  if (!isEdit && !status) throw new ReminderServiceError("Send either the reminder's fields or its status.", 400);

  const row = await readReminder(id, viewer);
  if (!canChangeReminder(viewer, recordOf(row))) {
    throw new ReminderServiceError("Only the person who wrote a reminder can change it. Add a comment instead.", 403);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (isEdit) {
    const parsed = parseReminderDraft(raw);
    if (!parsed.ok) throw new ReminderServiceError(parsed.message, 400);
    const team = await loadReminderTeam();
    const draft: ReminderDraft = { ...parsed.value, ...normaliseSharing(parsed.value, viewer.hrId, teamHrIds(team)) };
    Object.assign(patch, fieldsFromDraft(draft));
  }
  if (status === "done") {
    patch.status = "done";
    patch.done_at = new Date().toISOString();
    patch.done_by_hr_id = hrIdForStorage(viewer.hrId);
  } else if (status === "open") {
    patch.status = "open";
    patch.done_at = null;
    patch.done_by_hr_id = null;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("hr_reminders")
    .update(patch)
    .eq("id", id)
    .is("deleted_at", null)
    .select(REMINDER_COLUMNS)
    .single();
  if (error || !data) throw new ReminderServiceError("The reminder could not be saved.", 503);
  return oneView(data as ReminderRow, viewer);
}

/** Remove an item from every list. Soft: the row and its conversation stay for the record. */
export async function deleteReminder(access: Pick<AccessContext, "hrId" | "role">, id: string): Promise<void> {
  const viewer = audienceOrThrow(access);
  const row = await readReminder(id, viewer);
  if (!canChangeReminder(viewer, recordOf(row))) {
    throw new ReminderServiceError("Only the person who wrote a reminder can remove it.", 403);
  }
  const { error } = await getSupabaseAdmin()
    .from("hr_reminders")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by_hr_id: hrIdForStorage(viewer.hrId),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) throw new ReminderServiceError("The reminder could not be removed.", 503);
}

// ── The conversation ───────────────────────────────────────────────────────────────────────────

async function readComments(reminderId: string): Promise<CommentRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("hr_reminder_comments")
    .select(COMMENT_COLUMNS)
    .eq("reminder_id", reminderId)
    .order("created_at", { ascending: true })
    .range(0, COMMENT_THREAD_CAP - 1);
  if (error) throw new ReminderServiceError("The conversation could not be read right now.", 503);
  return (data ?? []) as CommentRow[];
}

async function commentViews(rows: readonly CommentRow[], viewer: ReminderAudience): Promise<ReminderCommentView[]> {
  const names = await namesByHrId(rows.map((row) => row.author_hr_id));
  const me = canonicalHrIdKey(viewer.hrId);
  return rows.map((row) => ({
    authorHrId: row.author_hr_id,
    authorName: names.get(row.author_hr_id) ?? row.author_hr_id,
    body: row.body,
    createdAt: row.created_at,
    id: row.id,
    mine: canonicalHrIdKey(row.author_hr_id) === me,
    reminderId: row.reminder_id,
    replyToId: row.reply_to_id,
  }));
}

export async function listReminderComments(
  access: Pick<AccessContext, "hrId" | "role">,
  reminderId: string,
): Promise<ReminderCommentView[]> {
  const viewer = audienceOrThrow(access);
  await readReminder(reminderId, viewer);
  return commentViews(await readComments(reminderId), viewer);
}

export async function addReminderComment(
  access: Pick<AccessContext, "hrId" | "role">,
  reminderId: string,
  input: unknown,
): Promise<ReminderCommentView> {
  const viewer = audienceOrThrow(access);
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const parsed = parseCommentBody(raw.body);
  if (!parsed.ok) throw new ReminderServiceError(parsed.message, 400);

  const reminder = recordOf(await readReminder(reminderId, viewer));
  const thread = await readComments(reminderId);

  let replyToId: string | null = null;
  if (raw.replyToId !== undefined && raw.replyToId !== null && raw.replyToId !== "") {
    const target = thread.find((comment) => comment.id === raw.replyToId);
    if (!target) throw new ReminderServiceError("The comment you are answering is no longer there.", 400);
    replyToId = target.id;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("hr_reminder_comments")
    .insert({
      author_hr_id: hrIdForStorage(viewer.hrId),
      body: parsed.body,
      reminder_id: reminderId,
      reply_to_id: replyToId,
    })
    .select(COMMENT_COLUMNS)
    .single();
  if (error || !data) throw new ReminderServiceError("The comment could not be sent.", 503);

  const [view] = await commentViews([data as CommentRow], viewer);
  await tellTheThread({ comment: view as ReminderCommentView, priorCommenters: thread, reminder, viewer });
  return view as ReminderCommentView;
}

/** Ring the bell for the people in the conversation. Never lets a failure undo the comment. */
async function tellTheThread(input: {
  comment: ReminderCommentView;
  priorCommenters: readonly CommentRow[];
  reminder: ReminderRecord;
  viewer: ReminderAudience;
}): Promise<void> {
  try {
    const team = await loadReminderTeam();
    const audience = commentAudience({
      authorHrId: input.viewer.hrId,
      ownerHrId: input.reminder.ownerHrId,
      priorCommenterHrIds: input.priorCommenters.map((comment) => comment.author_hr_id),
      sharedWithHrIds: input.reminder.sharedWithHrIds,
    });
    // Only teammates who can still open the item are told about it.
    const recipients = dedupeHrIds(audience).filter((hrId) => {
      const member = team.find((candidate) => canonicalHrIdKey(candidate.hrId) === canonicalHrIdKey(hrId));
      return Boolean(member) && canSeeReminder({ hrId, isOverseer: Boolean(member?.isOverseer) }, input.reminder);
    });
    await notifyReminderComment({
      authorHrId: input.viewer.hrId,
      authorName: input.comment.authorName,
      comment: input.comment,
      recipientHrIds: recipients,
      reminder: input.reminder,
      team,
    });
  } catch (error) {
    console.warn("[hr-reminders] the comment notice step failed", error);
  }
}
