// Approvals WhatsApp — reading the approvals line's chats, its broadcast lists and its bulk-send reports.
//
// SUPER ADMIN ONLY, enforced by every route and the page in front of this module (canUseApprovalsWhatsApp), never here:
// these functions use the service-role client and trust their caller. The tables are separate from the recruitment
// WhatsApp Inbox on purpose (migration 20261119141357), so nothing HR Resourcing reads can show these chats.

import { resolveEmployeeDisplayName, tidyAllCapitalsName } from "@/lib/employees/display-name";
import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import { downloadWhatsAppMedia, WhatsAppMediaTooLargeError } from "@/lib/recruitment/inbound/whatsapp-media";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { storedContentType, WHATSAPP_INBOX_MEDIA_TYPES } from "@/lib/uploads/stored-content-type";
import {
  approvalsReplyWindow,
  formatApprovalsPhone,
  normaliseApprovalsPhone,
  type ApprovalsRecipient,
  type RecipientProfile,
} from "@/lib/approvals-whatsapp/rules";
import { approvalsLinePhoneNumberId, whatsAppApprovalsLine } from "@/lib/whatsapp-inbox/lines";
import { APPROVALS_WHATSAPP_STORE } from "@/lib/whatsapp-inbox/record";
import {
  inboxAttachmentFileName,
  inboxOutboundStoragePath,
  type InboxAttachment,
  type InboxConversationSummary,
  type InboxMessageView,
  type InboxThread,
} from "@/lib/whatsapp-inbox/store";

export const APPROVALS_WHATSAPP_MEDIA_BUCKET = "approvals-whatsapp-media";
export const APPROVALS_LISTS_TABLE = "approvals_whatsapp_lists";
export const APPROVALS_LIST_MEMBERS_TABLE = "approvals_whatsapp_list_members";
export const APPROVALS_BROADCASTS_TABLE = "approvals_whatsapp_broadcasts";
export const APPROVALS_BROADCAST_RECIPIENTS_TABLE = "approvals_whatsapp_broadcast_recipients";
export const APPROVALS_LINE_LABEL = "Approvals line";
export const APPROVALS_LINE_DISPLAY_NUMBER = "+20 10 40631155";

const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_MAX_ATTEMPTS = 5;

export class ApprovalsWhatsAppNotFoundError extends Error {
  constructor(message = "That chat no longer exists.") {
    super(message);
    this.name = "ApprovalsWhatsAppNotFoundError";
  }
}

export class ApprovalsWhatsAppInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalsWhatsAppInputError";
  }
}

/** The state before the migration is applied: a missing table answers PGRST205 through PostgREST, 42P01 through SQL. */
export class ApprovalsWhatsAppNotInstalledError extends Error {
  constructor() {
    super("The Approvals WhatsApp tables are not installed on this database yet.");
    this.name = "ApprovalsWhatsAppNotInstalledError";
  }
}

type DbError = { code?: string; message?: string } | null;

export function isMissingApprovalsTable(error: DbError): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01" || error?.code === "PGRST202";
}

function check(error: DbError): void {
  if (!error) return;
  if (isMissingApprovalsTable(error)) throw new ApprovalsWhatsAppNotInstalledError();
  throw error;
}

/** Every row, paged (no row cap), with a missing table answered as "not installed yet". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function allRows<T>(buildQuery: () => any, tiebreakColumn: string): Promise<T[]> {
  try {
    return await fetchAllRows<T>(buildQuery, tiebreakColumn);
  } catch (error) {
    check(error as DbError);
    throw error;
  }
}

// ── The employee master, by WhatsApp number ──

export type ApprovalsEmployee = RecipientProfile & {
  hrId: string;
  name: string;
  waId: string | null;
  managerHrId: string | null;
  managerName: string | null;
  departmentId: number | null;
  areaId: number | null;
  active: boolean;
};

type EmployeeRow = {
  hr_id: string;
  full_name: string | null;
  nickname: string | null;
  name_ar: string | null;
  mobile_number: string | null;
  job_title: string | null;
  employment_status: string | null;
  manager_hr_id: string | null;
  department_id: number | null;
  area_id: number | null;
  region_name: string | null;
  gender: string | null;
  qualification: string | null;
};

/** Every employee with what a recipient filter or a template field needs. One read of each table, no row cap. */
export async function loadApprovalsEmployees(): Promise<ApprovalsEmployee[]> {
  const supabase = getSupabaseAdmin();
  const [employees, departments, areas] = await Promise.all([
    allRows<EmployeeRow>(
      () =>
        supabase
          .from("employees")
          .select("hr_id, full_name, nickname, name_ar, mobile_number, job_title, employment_status, manager_hr_id, department_id, area_id, region_name, gender, qualification")
          .order("hr_id", { ascending: true }),
      "hr_id",
    ),
    allRows<{ id: number; name: string }>(() => supabase.from("departments").select("id, name").order("id", { ascending: true }), "id"),
    allRows<{ id: number; name: string }>(() => supabase.from("areas").select("id, name").order("id", { ascending: true }), "id"),
  ]);
  const departmentNames = new Map(departments.map((row) => [Number(row.id), row.name]));
  const areaNames = new Map(areas.map((row) => [Number(row.id), row.name]));
  const names = new Map(
    employees.map((row) => [row.hr_id.trim().toUpperCase(), tidyAllCapitalsName(resolveEmployeeDisplayName(row.full_name ?? row.hr_id, row.nickname, row.hr_id))]),
  );
  return employees.map((row) => {
    const name = names.get(row.hr_id.trim().toUpperCase()) ?? row.hr_id;
    return {
      active: !hasDepartedEmployment(row.employment_status),
      areaId: row.area_id === null ? null : Number(row.area_id),
      areaName: row.area_id === null ? null : (areaNames.get(Number(row.area_id)) ?? null),
      departmentId: row.department_id === null ? null : Number(row.department_id),
      departmentName: row.department_id === null ? null : (departmentNames.get(Number(row.department_id)) ?? null),
      displayName: name,
      gender: row.gender,
      hrId: row.hr_id,
      jobTitle: row.job_title,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_hr_id ? (names.get(row.manager_hr_id.trim().toUpperCase()) ?? null) : null,
      name,
      nameAr: row.name_ar,
      qualification: row.qualification,
      regionName: row.region_name,
      waId: normaliseApprovalsPhone(row.mobile_number),
    };
  });
}

/** Number → employee. Where two records share a number, an active one wins. */
export function employeesByWaId(employees: readonly ApprovalsEmployee[]): Map<string, ApprovalsEmployee> {
  const index = new Map<string, ApprovalsEmployee>();
  for (const employee of employees) {
    if (!employee.waId) continue;
    const current = index.get(employee.waId);
    if (!current || (!current.active && employee.active)) index.set(employee.waId, employee);
  }
  return index;
}

// ── Chats ──

type ConversationRow = {
  id: string;
  phone_number_id: string;
  contact_wa_id: string | null;
  contact_user_id: string | null;
  contact_name: string | null;
  contact_username: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  last_message_preview: string | null;
  last_direction: "inbound" | "outbound" | null;
  unread_count: number;
  employee_hr_id: string | null;
};

const CONVERSATION_COLUMNS =
  "id, phone_number_id, contact_wa_id, contact_user_id, contact_name, contact_username, last_message_at, last_inbound_at, last_message_preview, last_direction, unread_count, employee_hr_id";

type MessageRow = {
  id: string;
  conversation_id: string;
  wamid: string | null;
  direction: "inbound" | "outbound";
  origin: "contact" | "phoenix" | "handset";
  message_type: string;
  body: string | null;
  media_id: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_storage_path: string | null;
  media_byte_size: number | null;
  media_fetch_attempts: number;
  template_name: string | null;
  reply_to_wamid: string | null;
  historical: boolean;
  sent_at: string;
  status: string;
  failure_detail: string | null;
  sent_by_hr_id: string | null;
};

const MESSAGE_COLUMNS =
  "id, conversation_id, wamid, direction, origin, message_type, body, media_id, media_mime_type, media_file_name, media_storage_path, media_byte_size, media_fetch_attempts, template_name, reply_to_wamid, historical, sent_at, status, failure_detail, sent_by_hr_id";

function summarize(row: ConversationRow, people: Map<string, ApprovalsEmployee>, now: number): InboxConversationSummary {
  const employee = row.contact_wa_id ? (people.get(row.contact_wa_id) ?? null) : null;
  return {
    candidate: null,
    contactName: employee?.name ?? row.contact_name,
    contactPhone: formatApprovalsPhone(row.contact_wa_id),
    contactUsername: row.contact_username,
    cv: null,
    employee: employee ? { hrId: employee.hrId, name: employee.name } : null,
    id: row.id,
    lastDirection: row.last_direction,
    lastInboundAt: row.last_inbound_at,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lineLabel: APPROVALS_LINE_LABEL,
    linkedByPhone: Boolean(employee),
    phoneNumberId: row.phone_number_id,
    positions: [],
    replyWindowOpen: approvalsReplyWindow(row.last_inbound_at, now).open,
    unreadCount: row.unread_count,
    waitingSince: row.last_direction === "inbound" && row.unread_count > 0 ? row.last_inbound_at : null,
  };
}

export type ApprovalsReadState = "all" | "unread";

export async function listApprovalsConversations(input: { search?: string | null; state?: ApprovalsReadState }) {
  const supabase = getSupabaseAdmin();
  const [rows, employees] = await Promise.all([
    allRows<ConversationRow>(
      () =>
        supabase
          .from(APPROVALS_WHATSAPP_STORE.conversationsTable)
          .select(CONVERSATION_COLUMNS)
          .order("last_message_at", { ascending: false, nullsFirst: false }),
      "id",
    ),
    loadApprovalsEmployees(),
  ]);
  const people = employeesByWaId(employees);
  const now = Date.now();
  let conversations = rows.map((row) => summarize(row, people, now));
  const totalUnread = conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0);
  if (input.state === "unread") conversations = conversations.filter((conversation) => conversation.unreadCount > 0);
  const term = input.search?.trim().toLowerCase();
  if (term) {
    const digits = term.replace(/\D+/g, "");
    conversations = conversations.filter(
      (conversation) =>
        (conversation.contactName ?? "").toLowerCase().includes(term) ||
        (digits.length >= 3 && (conversation.contactPhone ?? "").replace(/\D+/g, "").includes(digits)),
    );
  }
  return { conversations, lineConfigured: Boolean(whatsAppApprovalsLine()), totalUnread };
}

async function loadConversationRow(conversationId: string): Promise<ConversationRow> {
  const { data, error } = await getSupabaseAdmin()
    .from(APPROVALS_WHATSAPP_STORE.conversationsTable)
    .select(CONVERSATION_COLUMNS)
    .eq("id", conversationId)
    .maybeSingle();
  check(error);
  if (!data) throw new ApprovalsWhatsAppNotFoundError();
  return data as ConversationRow;
}

/** Why Phoenix cannot write to this chat at all, or null when it can. The 24-hour window is a separate, later question. */
export function approvalsCannotSendReason(row: Pick<ConversationRow, "contact_wa_id" | "phone_number_id">): string | null {
  if (!row.contact_wa_id) return "This person uses a WhatsApp username and did not share a phone number, so WhatsApp does not let Phoenix message them.";
  if (!whatsAppApprovalsLine()) return "The approvals line is not set up on this server.";
  if (row.phone_number_id !== approvalsLinePhoneNumberId()) return "This chat is on a WhatsApp number Phoenix no longer sends from.";
  return null;
}

export async function loadApprovalsThread(conversationId: string): Promise<InboxThread> {
  const row = await loadConversationRow(conversationId);
  const supabase = getSupabaseAdmin();
  const [messages, employees] = await Promise.all([
    allRows<MessageRow>(
      () => supabase.from(APPROVALS_WHATSAPP_STORE.messagesTable).select(MESSAGE_COLUMNS).eq("conversation_id", conversationId).order("sent_at", { ascending: true }),
      "id",
    ),
    loadApprovalsEmployees(),
  ]);
  const people = employeesByWaId(employees);
  const namesByHrId = new Map(employees.map((employee) => [employee.hrId.trim().toUpperCase(), employee.name]));
  const now = Date.now();
  const reason = approvalsCannotSendReason(row);
  return {
    canSend: reason === null,
    cannotSendReason: reason,
    conversation: summarize(row, people, now),
    messages: messages.map(
      (message): InboxMessageView => ({
        automated: message.origin === "phoenix" && !message.sent_by_hr_id,
        body: message.body,
        direction: message.direction,
        failureDetail: message.failure_detail,
        hasMedia: Boolean(message.media_id || message.media_storage_path),
        historical: message.historical,
        id: message.id,
        mediaByteSize: message.media_byte_size,
        mediaFileName: message.media_file_name,
        mediaMimeType: message.media_mime_type,
        mediaProblem: !message.media_storage_path && message.media_fetch_attempts >= MEDIA_MAX_ATTEMPTS ? "This attachment could not be copied from WhatsApp." : null,
        mediaReady: Boolean(message.media_storage_path),
        messageType: message.message_type,
        origin: message.origin,
        replyToWamid: message.reply_to_wamid,
        savedToCandidate: null,
        sentAt: message.sent_at,
        sentByName: message.sent_by_hr_id ? (namesByHrId.get(message.sent_by_hr_id.trim().toUpperCase()) ?? null) : null,
        status: message.status,
        templateName: message.template_name,
        wamid: message.wamid,
      }),
    ),
    replyWindowClosesAt: approvalsReplyWindow(row.last_inbound_at, now).closesAt,
  };
}

export async function loadApprovalsConversationForSend(conversationId: string) {
  const row = await loadConversationRow(conversationId);
  return { contactWaId: row.contact_wa_id, id: row.id, lastInboundAt: row.last_inbound_at, problem: approvalsCannotSendReason(row) };
}

export async function findApprovalsConversationId(waId: string): Promise<string | null> {
  const line = approvalsLinePhoneNumberId();
  if (!line) return null;
  const { data, error } = await getSupabaseAdmin()
    .from(APPROVALS_WHATSAPP_STORE.conversationsTable)
    .select("id")
    .eq("phone_number_id", line)
    .eq("contact_key", waId)
    .maybeSingle();
  check(error);
  return (data as { id: string } | null)?.id ?? null;
}

/** Phoenix only: sends NO read receipt, so the person never sees blue ticks because the owner opened the chat. */
export async function setApprovalsConversationRead(conversationId: string, unread: boolean): Promise<{ unreadCount: number }> {
  const row = await loadConversationRow(conversationId);
  const unreadCount = unread ? Math.max(1, row.unread_count) : 0;
  if (unreadCount === row.unread_count) return { unreadCount };
  const { error } = await getSupabaseAdmin()
    .from(APPROVALS_WHATSAPP_STORE.conversationsTable)
    .update({ unread_count: unreadCount, updated_at: new Date().toISOString() })
    .eq("id", conversationId);
  check(error);
  return { unreadCount };
}

// ── Attachments ──

async function loadMessageRow(messageId: string): Promise<MessageRow> {
  const { data, error } = await getSupabaseAdmin().from(APPROVALS_WHATSAPP_STORE.messagesTable).select(MESSAGE_COLUMNS).eq("id", messageId).maybeSingle();
  check(error);
  if (!data) throw new ApprovalsWhatsAppNotFoundError("That message no longer exists.");
  return data as MessageRow;
}

/** One message's attachment: Phoenix's own copy when there is one, else from WhatsApp, keeping a copy on the way. */
export async function getApprovalsAttachment(messageId: string): Promise<InboxAttachment> {
  const row = await loadMessageRow(messageId);
  const supabase = getSupabaseAdmin();
  const fallbackMime = row.media_mime_type || "application/octet-stream";
  const fileName = inboxAttachmentFileName({ fileName: row.media_file_name, messageType: row.message_type, mimeType: fallbackMime, sentAt: row.sent_at });
  if (row.media_storage_path) {
    const { data, error } = await supabase.storage.from(APPROVALS_WHATSAPP_MEDIA_BUCKET).download(row.media_storage_path);
    if (!error && data) return { bytes: Buffer.from(await data.arrayBuffer()), fileName, mimeType: fallbackMime };
  }
  if (!row.media_id) throw new ApprovalsWhatsAppNotFoundError("This attachment is no longer available.");
  try {
    const { bytes, mimeType } = await downloadWhatsAppMedia(row.media_id, { maxBytes: MEDIA_MAX_BYTES });
    const resolvedMime = row.media_mime_type || mimeType || "application/octet-stream";
    const path = inboxOutboundStoragePath(fileName);
    const { error: uploadError } = await supabase.storage
      .from(APPROVALS_WHATSAPP_MEDIA_BUCKET)
      .upload(path, bytes, { cacheControl: "31536000", contentType: storedContentType(resolvedMime, WHATSAPP_INBOX_MEDIA_TYPES), upsert: true });
    if (!uploadError) {
      await supabase
        .from(APPROVALS_WHATSAPP_STORE.messagesTable)
        .update({ media_byte_size: bytes.length, media_fetched_at: new Date().toISOString(), media_mime_type: resolvedMime, media_storage_path: path })
        .eq("id", row.id)
        .then(undefined, () => undefined);
    }
    return { bytes, fileName, mimeType: resolvedMime };
  } catch (error) {
    await supabase
      .from(APPROVALS_WHATSAPP_STORE.messagesTable)
      .update({ media_fetch_attempts: row.media_fetch_attempts + 1, media_fetch_error: error instanceof Error ? error.message.slice(0, 500) : "copy failed" })
      .eq("id", row.id)
      .then(undefined, () => undefined);
    if (error instanceof WhatsAppMediaTooLargeError) throw new ApprovalsWhatsAppInputError("This attachment is over 25 MB.");
    throw new ApprovalsWhatsAppNotFoundError("WhatsApp no longer holds this attachment, and Phoenix had not kept a copy.");
  }
}

export async function storeApprovalsOutboundFile(input: { bytes: Buffer; mimeType: string; fileName: string }): Promise<string> {
  const path = inboxOutboundStoragePath(input.fileName);
  const { error } = await getSupabaseAdmin()
    .storage.from(APPROVALS_WHATSAPP_MEDIA_BUCKET)
    .upload(path, input.bytes, { cacheControl: "31536000", contentType: storedContentType(input.mimeType, WHATSAPP_INBOX_MEDIA_TYPES), upsert: false });
  if (error) throw new Error(`Phoenix could not keep a copy of the file: ${error.message}`);
  return path;
}

// ── Meta's daily limit ──

/** Unique numbers sent a template on this line in the last 24 hours, failed sends excluded. */
export async function approvalsContactedToday(now = Date.now()): Promise<Set<string>> {
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabaseAdmin().rpc("approvals_whatsapp_template_contacts_since", { p_since: since });
  check(error);
  const rows = (data ?? []) as Array<string | { approvals_whatsapp_template_contacts_since?: string }>;
  return new Set(rows.map((row) => (typeof row === "string" ? row : (row.approvals_whatsapp_template_contacts_since ?? ""))).filter(Boolean));
}

// ── Broadcast lists ──

export type ApprovalsListSummary = { id: string; name: string; description: string | null; memberCount: number; updatedAt: string };
export type ApprovalsListMember = ApprovalsRecipient & { id: string };

export async function listApprovalsLists(): Promise<ApprovalsListSummary[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(APPROVALS_LISTS_TABLE).select("id, name, description, updated_at").order("name", { ascending: true });
  check(error);
  const members = await allRows<{ list_id: string }>(() => supabase.from(APPROVALS_LIST_MEMBERS_TABLE).select("id, list_id").order("id", { ascending: true }), "id");
  const counts = new Map<string, number>();
  for (const member of members) counts.set(member.list_id, (counts.get(member.list_id) ?? 0) + 1);
  return ((data ?? []) as Array<{ id: string; name: string; description: string | null; updated_at: string }>).map((row) => ({
    description: row.description,
    id: row.id,
    memberCount: counts.get(row.id) ?? 0,
    name: row.name,
    updatedAt: row.updated_at,
  }));
}

export async function loadApprovalsListMembers(listId: string): Promise<ApprovalsListMember[]> {
  const supabase = getSupabaseAdmin();
  const rows = await allRows<{ id: string; wa_id: string; employee_hr_id: string | null; display_name: string | null }>(
    () => supabase.from(APPROVALS_LIST_MEMBERS_TABLE).select("id, wa_id, employee_hr_id, display_name").eq("list_id", listId).order("added_at", { ascending: true }),
    "id",
  );
  return rows.map((row) => ({ displayName: row.display_name, employeeHrId: row.employee_hr_id, id: row.id, waId: row.wa_id }));
}

/** Creates a list, or replaces an existing list's name and members. Members are already normalised and de-duplicated. */
export async function saveApprovalsList(input: {
  id?: string | null;
  name: string;
  description?: string | null;
  members: readonly ApprovalsRecipient[];
  actorHrId: string | null;
}): Promise<{ id: string }> {
  const name = input.name.trim();
  if (!name) throw new ApprovalsWhatsAppInputError("Give the list a name.");
  if (name.length > 120) throw new ApprovalsWhatsAppInputError("A list name can be at most 120 characters.");
  if (input.members.length === 0) throw new ApprovalsWhatsAppInputError("Add at least one person to the list.");
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  let id = input.id ?? null;
  if (id) {
    const { error } = await supabase.from(APPROVALS_LISTS_TABLE).update({ description: input.description ?? null, name, updated_at: now }).eq("id", id);
    if (error?.code === "23505") throw new ApprovalsWhatsAppInputError("Another list already has that name.");
    check(error);
    const { error: clearError } = await supabase.from(APPROVALS_LIST_MEMBERS_TABLE).delete().eq("list_id", id);
    check(clearError);
  } else {
    const { data, error } = await supabase
      .from(APPROVALS_LISTS_TABLE)
      .insert({ created_by_hr_id: input.actorHrId, description: input.description ?? null, name })
      .select("id")
      .single();
    if (error?.code === "23505") throw new ApprovalsWhatsAppInputError("Another list already has that name.");
    check(error);
    id = (data as { id: string }).id;
  }
  const rows = input.members.map((member) => ({
    added_by_hr_id: input.actorHrId,
    display_name: member.displayName,
    employee_hr_id: member.employeeHrId,
    list_id: id,
    wa_id: member.waId,
  }));
  for (let start = 0; start < rows.length; start += 500) {
    const { error } = await supabase.from(APPROVALS_LIST_MEMBERS_TABLE).insert(rows.slice(start, start + 500));
    check(error);
  }
  return { id: id! };
}

export async function deleteApprovalsList(listId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from(APPROVALS_LISTS_TABLE).delete().eq("id", listId);
  check(error);
}

// ── Bulk sends and their reports ──

export type ApprovalsBroadcastSummary = {
  id: string;
  templateName: string;
  templateLanguage: string;
  status: string;
  listName: string | null;
  recipientCount: number;
  acceptedCount: number;
  failedCount: number;
  pendingCount: number;
  createdAt: string;
  createdByName: string | null;
};

type BroadcastRow = {
  id: string;
  template_name: string;
  template_language: string;
  body_preview: string | null;
  status: string;
  list_id: string | null;
  recipient_count: number;
  accepted_count: number;
  failed_count: number;
  created_by_hr_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const BROADCAST_COLUMNS =
  "id, template_name, template_language, body_preview, status, list_id, recipient_count, accepted_count, failed_count, created_by_hr_id, created_at, started_at, finished_at";

export async function listApprovalsBroadcasts(): Promise<ApprovalsBroadcastSummary[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(APPROVALS_BROADCASTS_TABLE).select(BROADCAST_COLUMNS).order("created_at", { ascending: false }).limit(200);
  check(error);
  const rows = (data ?? []) as BroadcastRow[];
  const [lists, employees] = await Promise.all([listApprovalsLists(), rows.length > 0 ? loadApprovalsEmployees() : Promise.resolve([])]);
  const listNames = new Map(lists.map((list) => [list.id, list.name]));
  const names = new Map(employees.map((employee) => [employee.hrId.trim().toUpperCase(), employee.name]));
  return rows.map((row) => ({
    acceptedCount: row.accepted_count,
    createdAt: row.created_at,
    createdByName: row.created_by_hr_id ? (names.get(row.created_by_hr_id.trim().toUpperCase()) ?? null) : null,
    failedCount: row.failed_count,
    id: row.id,
    listName: row.list_id ? (listNames.get(row.list_id) ?? null) : null,
    pendingCount: Math.max(0, row.recipient_count - row.accepted_count - row.failed_count),
    recipientCount: row.recipient_count,
    status: row.status,
    templateLanguage: row.template_language,
    templateName: row.template_name,
  }));
}

export type ApprovalsReportOutcome = "pending" | "failed" | "sent" | "delivered" | "read" | "replied";

export type ApprovalsReportRow = {
  waId: string;
  phone: string | null;
  name: string;
  outcome: ApprovalsReportOutcome;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  repliedAt: string | null;
  failureDetail: string | null;
  conversationId: string | null;
};

/**
 * One recipient's furthest outcome. A reply beats a read (someone who answered read it), a failure is shown as a failure
 * whatever came before it, and a row Meta never took is still pending.
 */
export function reportOutcome(input: {
  recipientStatus: string;
  messageStatus: string | null;
  repliedAt: string | null;
}): ApprovalsReportOutcome {
  if (input.recipientStatus === "failed" || input.messageStatus === "failed") return "failed";
  if (input.recipientStatus === "pending") return "pending";
  if (input.repliedAt) return "replied";
  if (input.messageStatus === "read") return "read";
  if (input.messageStatus === "delivered") return "delivered";
  return "sent";
}

export async function loadApprovalsBroadcastReport(broadcastId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(APPROVALS_BROADCASTS_TABLE).select(BROADCAST_COLUMNS).eq("id", broadcastId).maybeSingle();
  check(error);
  if (!data) throw new ApprovalsWhatsAppNotFoundError("That bulk send no longer exists.");
  const broadcast = data as BroadcastRow;

  const recipients = await allRows<{
    id: string;
    wa_id: string;
    employee_hr_id: string | null;
    display_name: string | null;
    status: string;
    wamid: string | null;
    failure_detail: string | null;
    sent_at: string | null;
    rendered_body: string | null;
  }>(
    () =>
      supabase
        .from(APPROVALS_BROADCAST_RECIPIENTS_TABLE)
        .select("id, wa_id, employee_hr_id, display_name, status, wamid, failure_detail, sent_at, rendered_body")
        .eq("broadcast_id", broadcastId)
        .order("id", { ascending: true }),
    "id",
  );

  // The ticks live on the message, found by wamid; a reply is any message from that number after the send.
  const messages = await allRows<{
    wamid: string | null;
    status: string;
    delivered_at: string | null;
    read_at: string | null;
    failed_at: string | null;
    failure_detail: string | null;
    conversation_id: string | null;
  }>(
    () =>
      supabase
        .from(APPROVALS_WHATSAPP_STORE.messagesTable)
        .select("id, wamid, status, delivered_at, read_at, failed_at, failure_detail, conversation_id")
        .eq("broadcast_id", broadcastId)
        .order("id", { ascending: true }),
    "id",
  );
  const byWamid = new Map(messages.filter((message) => message.wamid).map((message) => [message.wamid!, message]));
  const firstSend = recipients.reduce<string | null>((earliest, row) => (row.sent_at && (!earliest || row.sent_at < earliest) ? row.sent_at : earliest), null);
  const replies = firstSend
    ? await allRows<{ contact_wa_id: string | null; sent_at: string }>(
        () =>
          supabase
            .from(APPROVALS_WHATSAPP_STORE.messagesTable)
            .select("id, contact_wa_id, sent_at")
            .eq("direction", "inbound")
            .gte("sent_at", firstSend)
            .order("id", { ascending: true }),
        "id",
      )
    : [];
  const employees = await loadApprovalsEmployees();
  const people = employeesByWaId(employees);

  const rows: ApprovalsReportRow[] = recipients.map((recipient) => {
    const message = recipient.wamid ? (byWamid.get(recipient.wamid) ?? null) : null;
    const repliedAt =
      recipient.sent_at && recipient.status === "accepted"
        ? (replies
            .filter((reply) => reply.contact_wa_id === recipient.wa_id && reply.sent_at >= recipient.sent_at!)
            .map((reply) => reply.sent_at)
            .sort()[0] ?? null)
        : null;
    return {
      conversationId: message?.conversation_id ?? null,
      deliveredAt: message?.delivered_at ?? null,
      failedAt: message?.failed_at ?? null,
      failureDetail: recipient.failure_detail ?? message?.failure_detail ?? null,
      name: people.get(recipient.wa_id)?.name ?? recipient.display_name ?? formatApprovalsPhone(recipient.wa_id) ?? recipient.wa_id,
      outcome: reportOutcome({ messageStatus: message?.status ?? null, recipientStatus: recipient.status, repliedAt }),
      phone: formatApprovalsPhone(recipient.wa_id),
      readAt: message?.read_at ?? null,
      repliedAt,
      sentAt: recipient.sent_at,
      waId: recipient.wa_id,
    };
  });

  const totals: Record<ApprovalsReportOutcome, number> = { delivered: 0, failed: 0, pending: 0, read: 0, replied: 0, sent: 0 };
  for (const row of rows) totals[row.outcome] += 1;
  // Totals count everyone who reached a stage, so "read" includes those who then replied.
  const reached = {
    delivered: totals.delivered + totals.read + totals.replied,
    failed: totals.failed,
    pending: totals.pending,
    read: totals.read + totals.replied,
    replied: totals.replied,
    sent: totals.sent + totals.delivered + totals.read + totals.replied,
  };

  return {
    broadcast: {
      bodyPreview: broadcast.body_preview,
      createdAt: broadcast.created_at,
      finishedAt: broadcast.finished_at,
      id: broadcast.id,
      recipientCount: broadcast.recipient_count,
      startedAt: broadcast.started_at,
      status: broadcast.status,
      templateLanguage: broadcast.template_language,
      templateName: broadcast.template_name,
    },
    rows,
    totals: reached,
  };
}
