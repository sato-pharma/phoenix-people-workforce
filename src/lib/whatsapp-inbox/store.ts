// The WhatsApp Inbox — reading conversations, linking them to people, and keeping attachments.
//
// SUPER ADMIN ONLY, and that is enforced by every route in front of this module, not here: these
// functions use the service-role client and trust their caller. Nothing in this file may be imported
// by a page or route that has not already checked `canUseWhatsAppInbox`.

import crypto from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { hrIdForStorage } from "@/lib/hr-id";
import { logError, logInfo } from "@/lib/observability/log";
import { normalizePhone } from "@/lib/recruitment/candidate-matching";
import { candidateRoleFamilyLabels, candidateRoleFamilyOrNull, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { mirrorCandidateCvsToDrive } from "@/lib/recruitment/drive-cv-mirror";
import { getFileForDownload, uploadCandidateFile } from "@/lib/recruitment/files";
import { downloadWhatsAppMedia, WhatsAppMediaTooLargeError } from "@/lib/recruitment/inbound/whatsapp-media";
import { REPLY_WINDOW_MS } from "@/lib/recruitment/inbound/whatsapp-conversation";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { WHATSAPP_VIDEOS_BUCKET } from "@/lib/whatsapp-videos/inbox";
import { pickInboxCvs, type InboxDocumentMessage } from "@/lib/whatsapp-inbox/cv-pick";
import { findWhatsAppInboxLine, whatsAppInboxLineLabel } from "@/lib/whatsapp-inbox/lines";
import { isPhoneMatchLink } from "@/lib/whatsapp-inbox/phone-link";
import type { InboxReadState } from "@/lib/whatsapp-inbox/read-state";
import {
  addInboxPositionRecord,
  inboxAreaOptions,
  inboxPositionRecord,
  isInboxRoleFamily,
  matchesInboxPlaceFilter,
  parseInboxPlaceFilter,
  type InboxPositionRecord,
} from "@/lib/whatsapp-inbox/position-filter";
import { WHATSAPP_INBOX_CONVERSATIONS_TABLE, WHATSAPP_INBOX_MESSAGES_TABLE } from "@/lib/whatsapp-inbox/record";
import { fenceApplies, inboxConversationsHiddenFrom } from "@/lib/recruitment/workspace/fence";
import { ilikeContainsValue, ilikeExactValue } from "@/lib/supabase/search-filter";

export const WHATSAPP_INBOX_MEDIA_BUCKET = "whatsapp-inbox-media";

/** The largest attachment copied into Phoenix automatically, and served through the inbox. */
export const INBOX_MEDIA_CACHE_MAX_BYTES = 25 * 1024 * 1024;
export const INBOX_MEDIA_MAX_FETCH_ATTEMPTS = 5;

export class WhatsAppInboxNotFoundError extends Error {
  constructor(message = "That conversation no longer exists.") {
    super(message);
    this.name = "WhatsAppInboxNotFoundError";
  }
}

export class WhatsAppInboxInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppInboxInputError";
  }
}

// ── Shapes that cross to the browser ─────────────────────────────────────────────────────────────

export type InboxConversationSummary = {
  id: string;
  lineLabel: string;
  phoneNumberId: string;
  contactName: string | null;
  contactPhone: string | null;
  contactUsername: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastMessagePreview: string | null;
  lastDirection: "inbound" | "outbound" | null;
  unreadCount: number;
  replyWindowOpen: boolean;
  candidate: { id: string; name: string } | null;
  employee: { hrId: string; name: string } | null;
  /** Phoenix linked this chat itself, because the number can only mean this candidate. */
  linkedByPhone: boolean;
  /** When the oldest message nobody has answered arrived; null when nobody is waiting or it is not read here. */
  waitingSince: string | null;
  /** The job(s) this person applied for and where, newest first; empty when nothing says. */
  positions: Array<{ family: CandidateRoleFamily; label: string; regionLabel: string | null; areaName: string | null }>;
  /** The newest file this person sent in the chat (their CV), so it opens from the list; null when none. */
  cv: { messageId: string; fileName: string | null; count: number } | null;
};

export type InboxMessageView = {
  id: string;
  wamid: string | null;
  direction: "inbound" | "outbound";
  origin: "contact" | "phoenix" | "handset";
  messageType: string;
  body: string | null;
  hasMedia: boolean;
  mediaReady: boolean;
  mediaProblem: string | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  mediaByteSize: number | null;
  templateName: string | null;
  replyToWamid: string | null;
  historical: boolean;
  sentAt: string;
  status: string;
  failureDetail: string | null;
  sentByName: string | null;
  automated: boolean;
  savedToCandidate: { id: string; name: string } | null;
};

export type InboxThread = {
  conversation: InboxConversationSummary;
  messages: InboxMessageView[];
  replyWindowClosesAt: string | null;
  canSend: boolean;
  cannotSendReason: string | null;
};

type ConversationRow = {
  id: string;
  phone_number_id: string;
  contact_key: string;
  contact_wa_id: string | null;
  contact_user_id: string | null;
  contact_name: string | null;
  contact_username: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_message_preview: string | null;
  last_direction: "inbound" | "outbound" | null;
  unread_count: number;
  candidate_id: string | null;
  employee_hr_id: string | null;
  linked_by_hr_id: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  wamid: string | null;
  direction: "inbound" | "outbound";
  origin: "contact" | "phoenix" | "handset";
  phone_number_id: string;
  message_type: string;
  body: string | null;
  media_id: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_storage_path: string | null;
  media_byte_size: number | null;
  media_fetch_attempts: number;
  media_fetch_error: string | null;
  template_name: string | null;
  reply_to_wamid: string | null;
  historical: boolean;
  sent_at: string;
  status: string;
  failure_detail: string | null;
  event: string | null;
  sent_by_hr_id: string | null;
  saved_to_candidate_id: string | null;
  saved_file_id: string | null;
};

const CONVERSATION_COLUMNS =
  "id, phone_number_id, contact_key, contact_wa_id, contact_user_id, contact_name, contact_username, last_message_at, last_inbound_at, last_message_preview, last_direction, unread_count, candidate_id, employee_hr_id, linked_by_hr_id";

const MESSAGE_COLUMNS =
  "id, conversation_id, wamid, direction, origin, phone_number_id, message_type, body, media_id, media_mime_type, media_file_name, media_storage_path, media_byte_size, media_fetch_attempts, media_fetch_error, template_name, reply_to_wamid, historical, sent_at, status, failure_detail, event, sent_by_hr_id, saved_to_candidate_id, saved_file_id";

export function isReplyWindowOpen(lastInboundAt: string | null, now = Date.now()): boolean {
  if (!lastInboundAt) return false;
  const at = Date.parse(lastInboundAt);
  return Number.isFinite(at) && now - at < REPLY_WINDOW_MS;
}

/** `+20 10 1234 5678`-ish, for reading. Meta's digits are kept as they are when the shape is unknown. */
export function formatWhatsAppPhone(waId: string | null): string | null {
  if (!waId) return null;
  const digits = waId.replace(/\D+/g, "");
  if (/^20\d{10}$/.test(digits)) return `+20 ${digits.slice(2, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
  return digits ? `+${digits}` : null;
}

async function namesFor(candidateIds: string[], hrIds: string[]) {
  const supabase = getSupabaseAdmin();
  const candidates = new Map<string, string>();
  const uniqueCandidates = Array.from(new Set(candidateIds.filter(Boolean)));
  for (let index = 0; index < uniqueCandidates.length; index += 50) {
    const { data } = await supabase
      .from("ats_candidates")
      .select("id, full_name")
      .in("id", uniqueCandidates.slice(index, index + 50));
    for (const row of (data ?? []) as Array<{ id: string; full_name: string | null }>) {
      candidates.set(row.id, row.full_name?.trim() || "Unnamed candidate");
    }
  }
  const employees = await namesByHrId(hrIds);
  return { candidates, employees };
}

type Names = Awaited<ReturnType<typeof namesFor>>;

/** The name an employee row prints in the link picker: the nickname the company uses, else the full name. */
function linkOptionEmployeeName(employee: { hr_id: string; full_name: string | null; nickname: string | null }): string {
  const fullName = employee.full_name?.trim();
  return fullName ? resolveEmployeeDisplayName(fullName, employee.nickname, employee.hr_id) : "Unnamed employee";
}

type PositionRecord = InboxPositionRecord;

/**
 * Which job each chat's person applied for, and the region and area they chose for it.
 *
 * FIRST the applicant's own answers: the role, region and area they chose in the WhatsApp menu on
 * THAT number, every application they made there, newest first (four people applied for two
 * different roles). The three stay together per application, so a District Manager for Upper Egypt
 * who is also a Medical Representative for Cairo is found under neither "District Manager · Cairo"
 * nor "Medical Representative · Upper Egypt". ONLY when they never chose a role — a CV that arrived
 * before the menu existed — the linked candidate's applied-for title, sorted into the same families
 * the candidate pool filters on, with the region and area the candidate record prefers. The title is
 * a fallback and not an addition because it is free text: "regarding this ad" sits in that column,
 * and adding its "Other" beside a real menu answer would put the person in a filter they never chose.
 */
async function positionsFor(rows: ConversationRow[]): Promise<Map<string, PositionRecord[]>> {
  const supabase = getSupabaseAdmin();
  const byContact = new Map<string, PositionRecord[]>();
  const waIds = Array.from(new Set(rows.map((row) => row.contact_wa_id).filter((id): id is string => Boolean(id))));
  for (let index = 0; index < waIds.length; index += 100) {
    const { data, error } = await supabase
      .from("ats_whatsapp_classification_sessions")
      .select("wa_id, phone_number_id, job_title_family, region_code, region_other_text, area_name, area_other_text, started_at")
      .in("wa_id", waIds.slice(index, index + 100))
      .not("job_title_family", "is", null)
      .order("started_at", { ascending: false });
    if (error) throw error;
    for (const session of (data ?? []) as Array<{
      wa_id: string;
      phone_number_id: string | null;
      job_title_family: string | null;
      region_code: string | null;
      region_other_text: string | null;
      area_name: string | null;
      area_other_text: string | null;
    }>) {
      if (!isInboxRoleFamily(session.job_title_family)) continue;
      const record = inboxPositionRecord(
        session.job_title_family,
        session.region_code,
        session.region_other_text,
        session.area_name ?? session.area_other_text,
      );
      const key = `${session.phone_number_id ?? ""}|${session.wa_id}`;
      byContact.set(key, addInboxPositionRecord(byContact.get(key) ?? [], record));
    }
  }
  const result = new Map<string, PositionRecord[]>();
  const needTitle: ConversationRow[] = [];
  for (const row of rows) {
    const chosen = row.contact_wa_id ? byContact.get(`${row.phone_number_id}|${row.contact_wa_id}`) : undefined;
    if (chosen?.length) result.set(row.id, chosen);
    else if (row.candidate_id) needTitle.push(row);
    else result.set(row.id, []);
  }

  type CandidatePlace = { applied_for_job_title: string | null; preferred_region_code: string | null; preferred_area_name: string | null };
  const candidates = new Map<string, CandidatePlace>();
  const candidateIds = Array.from(new Set(needTitle.map((row) => row.candidate_id as string)));
  for (let index = 0; index < candidateIds.length; index += 50) {
    const { data, error } = await supabase
      .from("ats_candidates")
      .select("id, applied_for_job_title, preferred_region_code, preferred_area_name")
      .in("id", candidateIds.slice(index, index + 50));
    if (error) throw error;
    for (const candidate of (data ?? []) as Array<CandidatePlace & { id: string }>) {
      candidates.set(candidate.id, candidate);
    }
  }
  for (const row of needTitle) {
    const candidate = candidates.get(row.candidate_id as string);
    const family = candidateRoleFamilyOrNull(candidate?.applied_for_job_title);
    result.set(
      row.id,
      family ? [inboxPositionRecord(family,candidate?.preferred_region_code ?? null, null, candidate?.preferred_area_name ?? null)] : [],
    );
  }
  return result;
}

type CvSummary = NonNullable<InboxConversationSummary["cv"]>;

/** The CV each chat can open from the list: the documents the person sent, chosen by `pickInboxCvs`. */
async function cvsFor(rows: ConversationRow[]): Promise<Map<string, CvSummary>> {
  const supabase = getSupabaseAdmin();
  const documents: InboxDocumentMessage[] = [];
  const ids = rows.map((row) => row.id);
  for (let index = 0; index < ids.length; index += 50) {
    const { data, error } = await supabase
      .from(WHATSAPP_INBOX_MESSAGES_TABLE)
      .select("id, conversation_id, media_file_name, sent_at")
      .in("conversation_id", ids.slice(index, index + 50))
      .eq("direction", "inbound")
      .eq("message_type", "document")
      .order("sent_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    documents.push(...((data ?? []) as InboxDocumentMessage[]));
  }
  return pickInboxCvs(documents);
}

function summarize(
  row: ConversationRow,
  names: Names,
  now: number,
  positions: Map<string, PositionRecord[]>,
  cvs: Map<string, CvSummary>,
  waitingSince?: ReadonlyMap<string, string>,
): InboxConversationSummary {
  return {
    cv: cvs.get(row.id) ?? null,
    linkedByPhone: Boolean(row.candidate_id) && isPhoneMatchLink(row.linked_by_hr_id),
    waitingSince: waitingSince?.get(row.id) ?? null,
    positions: (positions.get(row.id) ?? []).map((record) => ({
      areaName: record.areaName,
      family: record.family,
      label: candidateRoleFamilyLabels[record.family],
      regionLabel: record.regionLabel,
    })),
    candidate: row.candidate_id ? { id: row.candidate_id, name: names.candidates.get(row.candidate_id) ?? "Candidate" } : null,
    contactName: row.contact_name,
    contactPhone: formatWhatsAppPhone(row.contact_wa_id),
    contactUsername: row.contact_username,
    employee: row.employee_hr_id ? { hrId: row.employee_hr_id, name: names.employees.get(row.employee_hr_id) ?? "Employee" } : null,
    id: row.id,
    lastDirection: row.last_direction,
    lastInboundAt: row.last_inbound_at,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lineLabel: whatsAppInboxLineLabel(row.phone_number_id),
    phoneNumberId: row.phone_number_id,
    replyWindowOpen: isReplyWindowOpen(row.last_inbound_at, now),
    unreadCount: row.unread_count,
  };
}

/** The typed text, whitespace collapsed and capped at 60 characters — nothing stripped.
 *
 * It used to blank `,` `(` `)` `\` `:` `"` `'` as well, because the searches below splice it into a
 * PostgREST `or(...)` expression where those are structural. A WhatsApp contact saves himself as
 * `Dr Ahmed (Tanta)` or `O'Brien`, and the strip meant the inbox could not find either. The values
 * are double-quoted now, so the characters reach the database as text; `%` and `*` are still
 * neutralised inside the shared helper, being wildcards rather than text. */
export function sanitizeInboxSearch(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export const INBOX_LIST_PAGE_SIZE = 150;
const INBOX_LIST_MAX = 1500;

/** How many chats one list request returns: a page by default, never more than the ceiling. */
export function clampInboxListLimit(value: number | null | undefined): number {
  const wanted = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : INBOX_LIST_PAGE_SIZE;
  return Math.max(1, Math.min(INBOX_LIST_MAX, wanted));
}

/** How far back "Waiting for us" looks. A chat older than this has gone cold, and the pile says how far it reaches. */
export const INBOX_WAITING_WINDOW_DAYS = 30;

type WaitingChatRow = {
  conversation_id: string;
  waiting_since: string;
  phone_number_id: string;
  candidate_id: string | null;
  contact_wa_id: string | null;
};

async function readWaitingChats(now: number): Promise<WaitingChatRow[]> {
  const since = new Date(now - INBOX_WAITING_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await getSupabaseAdmin().rpc("whatsapp_inbox_waiting_chats", { p_since: since });
  if (error) throw error;
  return (data ?? []) as WaitingChatRow[];
}

export async function listInboxConversations(input: {
  /** Who is reading: the Talent Acquisition seat never sees a chat with an HR applicant (owner, 2026-10-20). */
  access: Pick<AccessContext, "role" | "scope">;
  phoneNumberId?: string | null;
  search?: string | null;
  /** "unread" keeps the chats with something unread, "read" the chats with nothing unread, "waiting" the chats nobody has answered. */
  readState?: InboxReadState | null;
  position?: string | null;
  region?: string | null;
  area?: string | null;
  limit?: number;
}): Promise<{
  conversations: InboxConversationSummary[];
  totalCount: number;
  totalUnread: number;
  /** How many chats are waiting for a reply; null when that could not be read, which is not zero. */
  totalWaiting: number | null;
  areaOptions: string[];
}> {
  const supabase = getSupabaseAdmin();
  const limit = clampInboxListLimit(input.limit);
  const waitingOnly = input.readState === "waiting";
  // The pile is the one thing asked for when it is the filter, so there a failed read is an error
  // shown on the list. Beside any other filter the chats still load and the tile says it is unknown.
  const nowForWaiting = Date.now();
  let waitingRead: WaitingChatRow[] | null = null;
  try {
    waitingRead = await readWaitingChats(nowForWaiting);
  } catch (error) {
    if (waitingOnly) throw error;
    logError("Could not read which WhatsApp chats are waiting for a reply", { error, labels: { event: "whatsapp_inbox_waiting_read_failed" } });
  }
  // The position lives in the recruitment tables, not on the chat, so a position filter reads every
  // chat the other filters allow (up to the list ceiling) and narrows them here; the page is cut
  // after. Without one, the database cuts the page as before. Region and area ride on the position.
  const place = parseInboxPlaceFilter(input);
  const position = place.position;
  // THE TALENT ACQUISITION FENCE. Her list reads every chat the filters allow (up to the ceiling, the
  // same way a position filter does), drops the HR applicants' chats, and cuts the page after — so a
  // page is never short and no count includes a chat she cannot open. Everyone else pays nothing.
  const fenced = fenceApplies(input.access);
  // The list shows the newest chats first and grows on request. `totalCount` is every chat matching
  // the filters, so the screen can say how many there are and offer the rest, rather than letting
  // the page size pass for the whole inbox.
  let query = supabase
    .from(WHATSAPP_INBOX_CONVERSATIONS_TABLE)
    .select(CONVERSATION_COLUMNS, { count: "exact" })
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(position || fenced || waitingOnly ? INBOX_LIST_MAX : limit);
  if (input.phoneNumberId) query = query.eq("phone_number_id", input.phoneNumberId);
  if (input.readState === "unread") query = query.gt("unread_count", 0);
  if (input.readState === "read") query = query.eq("unread_count", 0);
  if (waitingOnly) query = query.gte("last_inbound_at", new Date(nowForWaiting - INBOX_WAITING_WINDOW_DAYS * 86_400_000).toISOString());
  const search = sanitizeInboxSearch(input.search);
  if (search) {
    const value = ilikeContainsValue(search);
    const digits = search.replace(/\D+/g, "");
    const clauses = value ? [`contact_name.ilike.${value}`, `contact_username.ilike.${value}`] : [];
    if (digits.length >= 4) {
      const digitsValue = ilikeContainsValue(digits.replace(/^0+/, ""));
      if (digitsValue) clauses.push(`contact_wa_id.ilike.${digitsValue}`);
    }
    // A term that left nothing searchable applies NO filter rather than `.or("")`, which is a 400.
    if (clauses.length > 0) query = query.or(clauses.join(","));
  }
  const { count, data, error } = await query;
  if (error) throw error;
  const read = (data ?? []) as ConversationRow[];
  const hiddenChats = fenced ? await inboxConversationsHiddenFrom(input.access, read.map(fenceRowOf)) : new Set<string>();
  const matched = hiddenChats.size > 0 ? read.filter((row) => !hiddenChats.has(row.id)) : read;

  let unreadQuery = supabase
    .from(WHATSAPP_INBOX_CONVERSATIONS_TABLE)
    .select("id, candidate_id, contact_wa_id, unread_count")
    .gt("unread_count", 0)
    .limit(1000);
  if (input.phoneNumberId) unreadQuery = unreadQuery.eq("phone_number_id", input.phoneNumberId);
  const { data: unreadRead } = await unreadQuery;
  const unreadAll = (unreadRead ?? []) as Array<Pick<ConversationRow, "id" | "candidate_id" | "contact_wa_id" | "unread_count">>;
  const hiddenUnread = fenced ? await inboxConversationsHiddenFrom(input.access, unreadAll.map(fenceRowOf)) : new Set<string>();
  const totalUnread = unreadAll.filter((row) => !hiddenUnread.has(row.id)).reduce((sum, row) => sum + row.unread_count, 0);

  // Waiting is counted like Unread: on the number chosen, past the fence, whatever else is filtered.
  const waitingOnLine = (waitingRead ?? []).filter((row) => !input.phoneNumberId || row.phone_number_id === input.phoneNumberId);
  const hiddenWaiting = fenced
    ? await inboxConversationsHiddenFrom(
        input.access,
        waitingOnLine.map((row) => fenceRowOf({ candidate_id: row.candidate_id, contact_wa_id: row.contact_wa_id, id: row.conversation_id })),
      )
    : new Set<string>();
  const waitingSince = new Map(
    waitingOnLine.filter((row) => !hiddenWaiting.has(row.conversation_id)).map((row) => [row.conversation_id, row.waiting_since]),
  );
  // Oldest first in the pile, so a chat that has waited longest is not the one that sinks.
  const considered = waitingOnly
    ? matched
        .filter((row) => waitingSince.has(row.id))
        .sort((left, right) => String(waitingSince.get(left.id)).localeCompare(String(waitingSince.get(right.id))))
    : matched;

  // Without a position filter only the page's own chats are placed, as before the fence.
  const positions = await positionsFor(position ? considered : considered.slice(0, limit));
  const narrowed = position ? considered.filter((row) => matchesInboxPlaceFilter(positions.get(row.id) ?? [], place)) : considered;
  // The Area menu lists the areas people chose for this position and region, whatever area is picked now.
  const areaOptions = inboxAreaOptions(positions.values(), place);
  const rows = narrowed.slice(0, limit);

  const [names, cvs] = await Promise.all([
    namesFor(
      rows.map((row) => row.candidate_id ?? ""),
      rows.map((row) => row.employee_hr_id ?? ""),
    ),
    cvsFor(rows),
  ]);
  const now = Date.now();
  return {
    areaOptions,
    conversations: rows.map((row) => summarize(row, names, now, positions, cvs, waitingSince)),
    // Fenced and unfiltered by position: every chat was read when the count fits the ceiling, so the
    // fenced length is exact; past it, the database count less the chats this read hid.
    totalCount: position || waitingOnly
      ? narrowed.length
      : fenced
        ? (count ?? 0) <= read.length
          ? narrowed.length
          : Math.max((count ?? 0) - hiddenChats.size, rows.length)
        : Math.max(count ?? 0, rows.length),
    totalUnread,
    totalWaiting: waitingRead ? waitingSince.size : null,
  };
}

function fenceRowOf(row: Pick<ConversationRow, "id" | "candidate_id" | "contact_wa_id">) {
  return { candidateId: row.candidate_id, contactWaId: row.contact_wa_id, id: row.id };
}

/**
 * The Talent Acquisition fence for one chat (owner, 2026-10-20): a chat with an HR applicant answers
 * exactly as a chat that does not exist. Free for every viewer the fence does not apply to.
 */
export async function assertInboxConversationVisibleTo(
  access: Pick<AccessContext, "role" | "scope">,
  conversationId: string,
): Promise<void> {
  if (!fenceApplies(access)) return;
  const row = await loadConversationRow(conversationId);
  const hidden = await inboxConversationsHiddenFrom(access, [fenceRowOf(row)]);
  if (hidden.has(row.id)) throw new WhatsAppInboxNotFoundError();
}

/** The same fence for one message, by the chat it belongs to. */
export async function assertInboxMessageVisibleTo(
  access: Pick<AccessContext, "role" | "scope">,
  messageId: string,
): Promise<void> {
  if (!fenceApplies(access)) return;
  const message = await loadMessageRow(messageId);
  try {
    await assertInboxConversationVisibleTo(access, message.conversation_id);
  } catch (error) {
    if (error instanceof WhatsAppInboxNotFoundError) throw new WhatsAppInboxNotFoundError("That message no longer exists.");
    throw error;
  }
}

async function loadConversationRow(conversationId: string): Promise<ConversationRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(WHATSAPP_INBOX_CONVERSATIONS_TABLE)
    .select(CONVERSATION_COLUMNS)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new WhatsAppInboxNotFoundError();
  return data as ConversationRow;
}

/** Why this conversation cannot be written to from Phoenix at all, or null when it can. */
export function cannotSendReason(row: Pick<ConversationRow, "contact_wa_id" | "phone_number_id">): string | null {
  if (!row.contact_wa_id) {
    return "This person uses a WhatsApp username and did not share a phone number, so WhatsApp does not let Phoenix message them.";
  }
  if (!findWhatsAppInboxLine(row.phone_number_id)) {
    return "This chat is on a WhatsApp number Phoenix does not send from.";
  }
  return null;
}

export async function loadInboxThread(conversationId: string, options?: { limit?: number }): Promise<InboxThread> {
  const row = await loadConversationRow(conversationId);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(WHATSAPP_INBOX_MESSAGES_TABLE)
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: false })
    .limit(Math.max(1, Math.min(500, options?.limit ?? 300)));
  if (error) throw error;
  const messages = ((data ?? []) as MessageRow[]).reverse();

  const senderIds = Array.from(new Set(messages.map((m) => m.sent_by_hr_id).filter((id): id is string => Boolean(id))));
  const names = await namesFor(
    [row.candidate_id ?? "", ...messages.map((m) => m.saved_to_candidate_id ?? "")],
    [row.employee_hr_id ?? "", ...senderIds],
  );
  const now = Date.now();
  const [positions, cvs] = await Promise.all([positionsFor([row]), cvsFor([row])]);
  const conversation = summarize(row, names, now, positions, cvs);
  const lastInbound = row.last_inbound_at ? Date.parse(row.last_inbound_at) : NaN;
  const reason = cannotSendReason(row);

  return {
    canSend: reason === null,
    cannotSendReason: reason,
    conversation,
    messages: messages.map((message) => ({
      automated: message.origin === "phoenix" && !message.sent_by_hr_id,
      body: message.body,
      direction: message.direction,
      failureDetail: message.failure_detail,
      // A CV that reached a candidate's record before the inbox existed has no WhatsApp media id —
      // only the candidate file it became. That file is the attachment.
      hasMedia: Boolean(message.media_id || message.media_storage_path || message.saved_file_id),
      historical: message.historical,
      id: message.id,
      mediaByteSize: message.media_byte_size,
      mediaFileName: message.media_file_name,
      mediaMimeType: message.media_mime_type,
      mediaProblem:
        !message.media_storage_path && !message.saved_file_id && message.media_fetch_attempts >= INBOX_MEDIA_MAX_FETCH_ATTEMPTS
          ? "This attachment could not be copied from WhatsApp."
          : null,
      mediaReady: Boolean(message.media_storage_path),
      messageType: message.message_type,
      origin: message.origin,
      replyToWamid: message.reply_to_wamid,
      savedToCandidate: message.saved_to_candidate_id
        ? { id: message.saved_to_candidate_id, name: names.candidates.get(message.saved_to_candidate_id) ?? "Candidate" }
        : null,
      sentAt: message.sent_at,
      sentByName: message.sent_by_hr_id ? (names.employees.get(message.sent_by_hr_id) ?? null) : null,
      status: message.status,
      templateName: message.template_name,
      wamid: message.wamid,
    })),
    replyWindowClosesAt: Number.isFinite(lastInbound) ? new Date(lastInbound + REPLY_WINDOW_MS).toISOString() : null,
  };
}

export async function loadInboxConversationForSend(conversationId: string) {
  const row = await loadConversationRow(conversationId);
  return {
    contactWaId: row.contact_wa_id,
    id: row.id,
    lastInboundAt: row.last_inbound_at,
    line: findWhatsAppInboxLine(row.phone_number_id),
    phoneNumberId: row.phone_number_id,
    problem: cannotSendReason(row),
  };
}

export async function markInboxConversationRead(conversationId: string): Promise<{ previousUnread: number }> {
  const row = await loadConversationRow(conversationId);
  if (row.unread_count === 0) return { previousUnread: 0 };
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from(WHATSAPP_INBOX_CONVERSATIONS_TABLE)
    .update({ unread_count: 0, updated_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (error) throw error;
  return { previousUnread: row.unread_count };
}

/**
 * Puts a chat back in the Unread pile by hand, as WhatsApp's own "Mark as unread" does: a chat with
 * nothing unread gets a count of one; a chat that already has unread messages keeps its count.
 * Phoenix only — nothing is sent to WhatsApp either way.
 */
export async function markInboxConversationUnread(conversationId: string): Promise<{ unreadCount: number }> {
  const row = await loadConversationRow(conversationId);
  if (row.unread_count > 0) return { unreadCount: row.unread_count };
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from(WHATSAPP_INBOX_CONVERSATIONS_TABLE)
    .update({ unread_count: 1, updated_at: new Date().toISOString() })
    .eq("id", conversationId);
  if (error) throw error;
  return { unreadCount: 1 };
}

// ── Linking a chat to a person ───────────────────────────────────────────────────────────────────

export type InboxPersonOption =
  | { kind: "candidate"; id: string; name: string; detail: string | null; phoneMatch: boolean }
  | { kind: "employee"; id: string; name: string; detail: string | null; phoneMatch: boolean };

function phoneTail(value: string | null | undefined): string | null {
  const normalized = normalizePhone(value);
  return normalized && normalized.length >= 9 ? normalized.slice(-9) : null;
}

/**
 * People this chat might belong to: candidates and employees whose phone matches, then name matches
 * for `search`. Only ever SUGGESTS — a shared phone is not the same person, so a human links. Phoenix
 * links by itself only where the number leaves one answer: `linkInboxChatsByPhone`.
 */
export async function findInboxPeople(input: { conversationId?: string | null; search?: string | null }): Promise<InboxPersonOption[]> {
  const supabase = getSupabaseAdmin();
  const options: InboxPersonOption[] = [];
  const seen = new Set<string>();
  const add = (option: InboxPersonOption) => {
    const key = `${option.kind}:${option.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push(option);
  };

  if (input.conversationId) {
    const row = await loadConversationRow(input.conversationId);
    const waId = normalizePhone(row.contact_wa_id);
    const tail = phoneTail(row.contact_wa_id);
    if (waId && tail) {
      const { data: candidates } = await supabase
        .from("ats_candidates")
        .select("id, full_name, phone, email")
        .or(`phone_norm.eq.${waId},phone.ilike.*${tail},whatsapp.ilike.*${tail}`)
        .limit(10);
      for (const candidate of (candidates ?? []) as Array<{ id: string; full_name: string | null; phone: string | null; email: string | null }>) {
        add({ detail: candidate.email ?? candidate.phone, id: candidate.id, kind: "candidate", name: candidate.full_name?.trim() || "Unnamed candidate", phoneMatch: true });
      }
      const { data: employees } = await supabase
        .from("employees")
        .select("hr_id, full_name, nickname, job_title, mobile_number")
        .ilike("mobile_number", `%${tail}`)
        .limit(10);
      for (const employee of (employees ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null; job_title: string | null; mobile_number: string | null }>) {
        if (phoneTail(employee.mobile_number) !== tail) continue;
        add({ detail: employee.job_title, id: employee.hr_id, kind: "employee", name: linkOptionEmployeeName(employee), phoneMatch: true });
      }
    }
  }

  const search = sanitizeInboxSearch(input.search);
  const searchValue = ilikeContainsValue(search);
  const searchExact = ilikeExactValue(search);
  if (search.length >= 2 && searchValue && searchExact) {
    const digits = search.replace(/\D+/g, "");
    const digitsValue = digits.length >= 6 ? ilikeContainsValue(digits.replace(/^0+/, "")) : null;
    const candidateClauses = [`full_name.ilike.${searchValue}`, `email.ilike.${searchValue}`];
    if (digitsValue) candidateClauses.push(`phone.ilike.${digitsValue}`);
    const { data: candidates } = await supabase
      .from("ats_candidates")
      .select("id, full_name, phone, email")
      .or(candidateClauses.join(","))
      .order("created_at", { ascending: false })
      .limit(10);
    for (const candidate of (candidates ?? []) as Array<{ id: string; full_name: string | null; phone: string | null; email: string | null }>) {
      add({ detail: candidate.email ?? candidate.phone, id: candidate.id, kind: "candidate", name: candidate.full_name?.trim() || "Unnamed candidate", phoneMatch: false });
    }
    // `hr_id` matches the term EXACTLY, not as a substring — the one arm here that is not a
    // contains — and it was the only value in this file spliced in with no delimiters of its own
    // at all, so a comma in it split the filter rather than failing to match.
    const employeeClauses = [`full_name.ilike.${searchValue}`, `nickname.ilike.${searchValue}`, `name_ar.ilike.${searchValue}`, `hr_id.ilike.${searchExact}`];
    if (digitsValue) employeeClauses.push(`mobile_number.ilike.${digitsValue}`);
    const { data: employees } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname, job_title")
      .or(employeeClauses.join(","))
      .limit(10);
    for (const employee of (employees ?? []) as Array<{ hr_id: string; full_name: string | null; nickname: string | null; job_title: string | null }>) {
      add({ detail: employee.job_title, id: employee.hr_id, kind: "employee", name: linkOptionEmployeeName(employee), phoneMatch: false });
    }
  }

  return options;
}

export async function linkInboxConversation(input: {
  conversationId: string;
  candidateId: string | null;
  employeeHrId: string | null;
  access: AccessContext;
}): Promise<{ before: { candidateId: string | null; employeeHrId: string | null }; after: { candidateId: string | null; employeeHrId: string | null } }> {
  const row = await loadConversationRow(input.conversationId);
  const supabase = getSupabaseAdmin();

  if (input.candidateId) {
    const { data } = await supabase.from("ats_candidates").select("id").eq("id", input.candidateId).maybeSingle();
    if (!data) throw new WhatsAppInboxInputError("That candidate no longer exists.");
  }
  let employeeHrId: string | null = null;
  if (input.employeeHrId) {
    const { data } = await supabase.from("employees").select("hr_id").eq("hr_id", input.employeeHrId).maybeSingle();
    if (!data) throw new WhatsAppInboxInputError("That employee was not found.");
    employeeHrId = (data as { hr_id: string }).hr_id;
  }

  // Who decided is kept on an Unlink too: it is what stops the phone match linking the chat again.
  const { error } = await supabase
    .from(WHATSAPP_INBOX_CONVERSATIONS_TABLE)
    .update({
      candidate_id: input.candidateId,
      employee_hr_id: employeeHrId,
      linked_at: new Date().toISOString(),
      linked_by_hr_id: hrIdForStorage(input.access.hrId) ?? input.access.loginId ?? "unknown",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.conversationId);
  if (error) throw error;

  return {
    after: { candidateId: input.candidateId, employeeHrId },
    before: { candidateId: row.candidate_id, employeeHrId: row.employee_hr_id },
  };
}

/**
 * Links the chats whose number can only mean one candidate. The rules are in the database function,
 * and a person's own link or Unlink is never touched. Runs on the inbound-intake cron tick, so a chat
 * links within a tick of the candidate's record appearing. One audit row per pass that linked anything.
 */
export async function linkInboxChatsByPhone(maxChats = 500): Promise<{ linked: number }> {
  const { data, error } = await getSupabaseAdmin().rpc("whatsapp_inbox_link_chats_by_phone", { p_limit: maxChats });
  if (error) throw error;
  const links = (data ?? []) as Array<{ conversation_id: string; candidate_id: string }>;
  if (links.length > 0) {
    await writeAuditLog({
      actorLoginId: "system",
      entityType: "whatsapp_inbox_conversation",
      newValues: { links },
      summary: `Linked ${links.length} WhatsApp ${links.length === 1 ? "chat" : "chats"} to candidates by phone number.`,
    });
    logInfo("WhatsApp chats linked to candidates by phone", {
      labels: { event: "whatsapp_inbox_phone_links", linked: links.length },
    });
  }
  return { linked: links.length };
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────────

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/3gpp": "3gp",
  "video/mp4": "mp4",
};

/** A name a person can save, for an attachment that arrived without one. */
export function inboxAttachmentFileName(input: { fileName: string | null; mimeType: string | null; messageType: string; sentAt: string }): string {
  if (input.fileName?.trim()) return input.fileName.trim();
  const mime = (input.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const extension = EXTENSIONS[mime] ?? mime.split("/")[1]?.replace(/[^a-z0-9]+/g, "") ?? "bin";
  const words = { audio: "voice-note", document: "file", image: "photo", sticker: "sticker", video: "video" } as Record<string, string>;
  const stamp = input.sentAt.slice(0, 10);
  return `whatsapp-${words[input.messageType] ?? "attachment"}-${stamp}.${extension || "bin"}`;
}

function storagePathFor(messageId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
  const digest = crypto.createHash("sha256").update(messageId).digest("hex").slice(0, 24);
  return `messages/${digest}/${safe}`;
}

export function inboxOutboundStoragePath(fileName: string): string {
  return storagePathFor(crypto.randomUUID(), fileName);
}

async function loadMessageRow(messageId: string): Promise<MessageRow> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(WHATSAPP_INBOX_MESSAGES_TABLE).select(MESSAGE_COLUMNS).eq("id", messageId).maybeSingle();
  if (error) throw error;
  if (!data) throw new WhatsAppInboxNotFoundError("That message no longer exists.");
  return data as MessageRow;
}

export type InboxAttachment = { bytes: Buffer; mimeType: string; fileName: string };

async function copyFromMeta(row: MessageRow): Promise<InboxAttachment> {
  if (!row.media_id) throw new WhatsAppInboxNotFoundError("This message has no attachment.");
  const { bytes, mimeType } = await downloadWhatsAppMedia(row.media_id, { maxBytes: INBOX_MEDIA_CACHE_MAX_BYTES });
  const resolvedMime = row.media_mime_type || mimeType || "application/octet-stream";
  const fileName = inboxAttachmentFileName({ fileName: row.media_file_name, messageType: row.message_type, mimeType: resolvedMime, sentAt: row.sent_at });
  const path = storagePathFor(row.id, fileName);
  const supabase = getSupabaseAdmin();
  const { error: uploadError } = await supabase.storage
    .from(WHATSAPP_INBOX_MEDIA_BUCKET)
    .upload(path, bytes, { cacheControl: "31536000", contentType: resolvedMime, upsert: true });
  if (uploadError) throw new Error(`storage upload failed: ${uploadError.message}`);
  const { error: updateError } = await supabase
    .from(WHATSAPP_INBOX_MESSAGES_TABLE)
    .update({
      media_byte_size: bytes.length,
      media_fetch_attempts: row.media_fetch_attempts + 1,
      media_fetch_error: null,
      media_fetched_at: new Date().toISOString(),
      media_mime_type: resolvedMime,
      media_storage_path: path,
    })
    .eq("id", row.id);
  if (updateError) throw new Error(`row update failed: ${updateError.message}`);
  return { bytes, fileName, mimeType: resolvedMime };
}

/**
 * The bytes of one message's attachment. From Phoenix's own copy when there is one; else from the
 * video holding area (the same video may already be there); else straight from WhatsApp, keeping a
 * copy on the way through.
 */
export async function getInboxAttachment(messageId: string): Promise<InboxAttachment> {
  const row = await loadMessageRow(messageId);
  const supabase = getSupabaseAdmin();
  const fallbackMime = row.media_mime_type || "application/octet-stream";
  const fileName = inboxAttachmentFileName({ fileName: row.media_file_name, messageType: row.message_type, mimeType: fallbackMime, sentAt: row.sent_at });

  if (row.media_storage_path) {
    const { data, error } = await supabase.storage.from(WHATSAPP_INBOX_MEDIA_BUCKET).download(row.media_storage_path);
    if (!error && data) return { bytes: Buffer.from(await data.arrayBuffer()), fileName, mimeType: fallbackMime };
  }

  if (row.saved_file_id) {
    const file = await getFileForDownload(row.saved_file_id).catch(() => null);
    if (file?.kind === "binary") {
      return { bytes: file.bytes, fileName: file.fileName || fileName, mimeType: file.mimeType || fallbackMime };
    }
  }

  const held = await readFromVideoHoldingArea(row);
  if (held) return { bytes: held.bytes, fileName, mimeType: held.mimeType || fallbackMime };

  if (!row.media_id) throw new WhatsAppInboxNotFoundError("This attachment is no longer available.");
  try {
    return await copyFromMeta(row);
  } catch (error) {
    if (error instanceof WhatsAppMediaTooLargeError) {
      throw new WhatsAppInboxInputError("This attachment is over 25 MB. Open it on the phone instead.");
    }
    throw new WhatsAppInboxNotFoundError("WhatsApp no longer holds this attachment, and Phoenix had not kept a copy.");
  }
}

/** The same video, if the FTP video pipeline already copied it out of WhatsApp into its own bucket. */
async function readFromVideoHoldingArea(row: MessageRow): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!row.wamid || row.direction !== "inbound") return null;
  const supabase = getSupabaseAdmin();
  const { data: video } = await supabase
    .from("whatsapp_inbound_video")
    .select("storage_path, mime_type")
    .eq("wamid", row.wamid)
    .not("storage_path", "is", null)
    .maybeSingle();
  const videoRow = video as { storage_path: string; mime_type: string } | null;
  if (!videoRow?.storage_path) return null;
  const { data, error } = await supabase.storage.from(WHATSAPP_VIDEOS_BUCKET).download(videoRow.storage_path);
  if (error || !data) return null;
  return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: videoRow.mime_type };
}

/**
 * Keeps the inbox's own copy of an attachment. From the video holding area when the file is already
 * there — no WhatsApp download, and it still works after WhatsApp's media id has expired — else from
 * WhatsApp.
 */
async function keepInboxCopy(row: MessageRow): Promise<void> {
  const held = await readFromVideoHoldingArea(row);
  if (!held) {
    await copyFromMeta(row);
    return;
  }
  const mimeType = row.media_mime_type || held.mimeType || "application/octet-stream";
  const fileName = inboxAttachmentFileName({ fileName: row.media_file_name, messageType: row.message_type, mimeType, sentAt: row.sent_at });
  const path = storagePathFor(row.id, fileName);
  const supabase = getSupabaseAdmin();
  const { error: uploadError } = await supabase.storage
    .from(WHATSAPP_INBOX_MEDIA_BUCKET)
    .upload(path, held.bytes, { cacheControl: "31536000", contentType: mimeType, upsert: true });
  if (uploadError) throw new Error(`storage upload failed: ${uploadError.message}`);
  const { error: updateError } = await supabase
    .from(WHATSAPP_INBOX_MESSAGES_TABLE)
    .update({
      media_byte_size: held.bytes.length,
      media_fetch_attempts: row.media_fetch_attempts + 1,
      media_fetch_error: null,
      media_fetched_at: new Date().toISOString(),
      media_mime_type: mimeType,
      media_storage_path: path,
    })
    .eq("id", row.id);
  if (updateError) throw new Error(`row update failed: ${updateError.message}`);
}

export type InboxMediaCacheResult = { considered: number; copied: number; failed: number };

/**
 * Copies attachments out of WhatsApp while their media ids still work. Runs on the inbound-intake
 * cron tick. Sequential and small on purpose — each file is held in memory on a shared container.
 */
export async function cacheInboxMedia(maxItems = 10): Promise<InboxMediaCacheResult> {
  const result: InboxMediaCacheResult = { considered: 0, copied: 0, failed: 0 };
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(WHATSAPP_INBOX_MESSAGES_TABLE)
    .select(MESSAGE_COLUMNS)
    .not("media_id", "is", null)
    .is("media_storage_path", null)
    .lt("media_fetch_attempts", INBOX_MEDIA_MAX_FETCH_ATTEMPTS)
    .order("received_at", { ascending: true })
    .limit(Math.max(1, Math.min(25, Math.floor(maxItems))));
  if (error) {
    if (error.code !== "PGRST205" && error.code !== "42P01") {
      logError("Could not list WhatsApp inbox attachments to copy", { error, labels: { event: "whatsapp_inbox_media_list_failed" } });
    }
    return result;
  }

  for (const row of (data ?? []) as MessageRow[]) {
    result.considered += 1;
    try {
      await keepInboxCopy(row);
      result.copied += 1;
    } catch (copyError) {
      result.failed += 1;
      // Too large never gets smaller: spend the whole retry budget at once.
      const attempts = copyError instanceof WhatsAppMediaTooLargeError ? INBOX_MEDIA_MAX_FETCH_ATTEMPTS : row.media_fetch_attempts + 1;
      const message = copyError instanceof Error ? copyError.message : String(copyError);
      await supabase
        .from(WHATSAPP_INBOX_MESSAGES_TABLE)
        .update({ media_fetch_attempts: attempts, media_fetch_error: message.slice(0, 500) })
        .eq("id", row.id)
        .then(undefined, () => undefined);
    }
  }

  if (result.considered > 0) {
    logInfo("WhatsApp inbox attachment copy pass finished", {
      labels: { copied: result.copied, event: "whatsapp_inbox_media_pass", failed: result.failed },
    });
  }
  return result;
}

export async function saveInboxAttachmentToCandidate(input: {
  access: AccessContext;
  messageId: string;
  candidateId: string;
  kind: "cv" | "other";
}): Promise<{ fileId: string; fileName: string; candidateName: string; previousCandidateId: string | null }> {
  const row = await loadMessageRow(input.messageId);
  if (!row.media_id && !row.media_storage_path && !row.saved_file_id) {
    throw new WhatsAppInboxInputError("This message has no attachment to save.");
  }

  const supabase = getSupabaseAdmin();
  const { data: candidate } = await supabase.from("ats_candidates").select("id, full_name").eq("id", input.candidateId).maybeSingle();
  if (!candidate) throw new WhatsAppInboxInputError("That candidate no longer exists.");

  const attachment = await getInboxAttachment(input.messageId);
  const uploaded = await uploadCandidateFile(input.access, {
    bytes: attachment.bytes,
    candidateId: input.candidateId,
    fileName: attachment.fileName,
    kind: input.kind,
    mimeType: attachment.mimeType,
    origin: "whatsapp_inbox",
    sizeBytes: attachment.bytes.length,
  });

  const { error } = await supabase
    .from(WHATSAPP_INBOX_MESSAGES_TABLE)
    .update({
      saved_at: new Date().toISOString(),
      saved_by_hr_id: hrIdForStorage(input.access.hrId) ?? input.access.loginId ?? null,
      saved_file_id: uploaded.id,
      saved_to_candidate_id: input.candidateId,
    })
    .eq("id", input.messageId);
  if (error) throw error;

  // Mirrored from HERE. Lifting an attachment out of the inbox onto a candidate creates no intake
  // record, so no inbound worker ever revisits it: the CV saved this way on 2026-08-18 reached the
  // cabinet only because a backfill happened to run weeks later. Best-effort and swallowed — the file
  // is already on the candidate and the inbox row already updated.
  await mirrorCandidateCvsToDrive(input.candidateId).catch(() => {});

  return {
    candidateName: (candidate as { full_name: string | null }).full_name?.trim() || "Unnamed candidate",
    fileId: uploaded.id,
    fileName: attachment.fileName,
    previousCandidateId: row.saved_to_candidate_id,
  };
}

/** Keeps a file Phoenix is about to send, so the sent message can be opened later like any other. */
export async function storeInboxOutboundFile(input: { bytes: Buffer; mimeType: string; fileName: string }): Promise<string> {
  const path = inboxOutboundStoragePath(input.fileName);
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(WHATSAPP_INBOX_MEDIA_BUCKET)
    .upload(path, input.bytes, { cacheControl: "31536000", contentType: input.mimeType, upsert: false });
  if (error) throw new Error(`Phoenix could not keep a copy of the file: ${error.message}`);
  return path;
}
