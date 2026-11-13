import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission, normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { ilikeContainsValue, ilikeExactValue, quotedOrClause, searchableTerm } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertApiRateLimit } from "@/lib/security/api-rate-limit";

type AuthUserRow = {
  auth_email?: string | null;
  email?: string | null;
  hr_id?: string | null;
  is_active?: boolean | null;
  login_id?: string | null;
  name?: string | null;
  role?: string | null;
};

type EmployeeContactRow = {
  full_name?: string | null;
  hr_id?: string | null;
  nickname?: string | null;
  work_email?: string | null;
};

type InternalMessageRow = {
  body: string;
  created_at: string;
  email_error: string | null;
  email_provider_id: string | null;
  email_status: InternalEmailStatus;
  id: string;
  read_at: string | null;
  recipient_email: string | null;
  recipient_hr_id: string | null;
  recipient_login_id: string | null;
  recipient_name: string;
  sender_hr_id: string | null;
  sender_login_id: string | null;
  sender_name: string;
  subject: string;
};

export type InternalEmailStatus = "failed" | "not_requested" | "pending" | "sent" | "skipped";

export type InternalRecipientView = {
  email: string | null;
  hrId: string | null;
  id: string;
  label: string;
  loginId: string | null;
  name: string;
  role: string | null;
};

export type InternalMessageView = {
  body: string;
  createdAt: string;
  direction: "inbox" | "sent";
  emailError: string | null;
  emailProviderId: string | null;
  emailStatus: InternalEmailStatus;
  id: string;
  readAt: string | null;
  recipient: {
    email: string | null;
    hrId: string | null;
    loginId: string | null;
    name: string;
  };
  sender: {
    hrId: string | null;
    loginId: string | null;
    name: string;
  };
  subject: string;
};

export type SendInternalMessageInput = {
  body: string;
  recipient: string;
  sendEmail?: boolean;
  subject: string;
};

const internalMessagesTable = "internal_messages";

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function lower(value: string | null | undefined) {
  return cleanText(value).toLowerCase();
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim().toLowerCase());
}

function schemaMissing(error: unknown) {
  const message = (
    error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`
  ).toLowerCase();

  return (
    message.includes(internalMessagesTable) ||
    message.includes("could not find the table") ||
    message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"))
  );
}

function displayNameForUser(user: AuthUserRow | null, employee?: EmployeeContactRow | null) {
  const fullName = cleanText(employee?.full_name);
  return (
    (fullName && resolveEmployeeDisplayName(fullName, employee?.nickname, employee?.hr_id)) ||
    cleanText(user?.name) ||
    cleanText(user?.login_id) ||
    cleanText(user?.hr_id) ||
    "Phoenix User"
  );
}

// What `internal_messages` stores in sender_name and recipient_name: the full name where there is one.
// A reader gets the display name at read (`withCurrentDisplayNames`); the stored row is never rewritten.
function storedNameForUser(user: AuthUserRow | null, employee?: EmployeeContactRow | null) {
  return cleanText(employee?.full_name) || cleanText(user?.name) || cleanText(user?.login_id) || cleanText(user?.hr_id) || "Phoenix User";
}

function emailForUser(user: AuthUserRow | null, employee?: EmployeeContactRow | null) {
  return lower(user?.email) || lower(user?.auth_email) || lower(employee?.work_email) || null;
}

function recipientIdFor(user: AuthUserRow | null, employee?: EmployeeContactRow | null) {
  return cleanText(user?.login_id) || normalizeHrId(user?.hr_id) || normalizeHrId(employee?.hr_id) || emailForUser(user, employee) || "";
}

function mapRecipient(user: AuthUserRow | null, employee?: EmployeeContactRow | null): InternalRecipientView | null {
  const id = recipientIdFor(user, employee);
  if (!id) return null;

  const hrId = normalizeHrId(user?.hr_id ?? employee?.hr_id);
  const loginId = cleanText(user?.login_id) || null;
  const name = displayNameForUser(user, employee);
  const email = emailForUser(user, employee);
  const role = cleanText(user?.role) || null;
  const identityParts = [hrId, loginId && loginId !== hrId ? loginId : null, email].filter(Boolean);

  return {
    email,
    hrId,
    id,
    label: identityParts.length > 0 ? `${name} (${identityParts.join(" / ")})` : name,
    loginId,
    name,
    role,
  };
}

async function loadEmployeeByHrId(hrId: string | null | undefined) {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,nickname,work_email")
    .eq("hr_id", normalized.toUpperCase())
    .maybeSingle();

  if (error) throw error;
  return (data as EmployeeContactRow | null) ?? null;
}

/**
 * The ONE employee a typed work email names, or why there is none. Exact (case-insensitive) match
 * only — `_` is still a one-character wildcard inside `ilike`, so the rows are filtered again here.
 * Two current employees sharing one work email is answered "ambiguous", never a coin toss.
 */
export function pickWorkEmailEmployee(
  rows: ReadonlyArray<EmployeeContactRow>,
  email: string,
): { kind: "one"; employee: EmployeeContactRow } | { kind: "ambiguous" } | { kind: "none" } {
  const wanted = lower(email);
  const byHrId = new Map<string, EmployeeContactRow>();
  for (const row of rows) {
    const hrId = normalizeHrId(row.hr_id);
    if (hrId && lower(row.work_email) === wanted && !byHrId.has(hrId)) byHrId.set(hrId, row);
  }
  if (byHrId.size === 0) return { kind: "none" };
  if (byHrId.size > 1) return { kind: "ambiguous" };
  return { kind: "one", employee: [...byHrId.values()][0] };
}

/**
 * The ONE sign-in a recipient value names, the same one on every call (audit point 3, 2026-10-26).
 * An exact login id wins outright; otherwise the rows holding the HR id, an active login first,
 * then the lowest login id. It replaces `.limit(1)` with no order, which let Postgres choose.
 */
export function pickInternalRecipientUser(
  rows: ReadonlyArray<AuthUserRow>,
  match: { hrId?: string | null; loginId?: string | null },
): AuthUserRow | null {
  const wantedLogin = lower(match.loginId);
  if (wantedLogin) {
    const exact = rows.find((row) => lower(row.login_id) === wantedLogin);
    if (exact) return exact;
  }
  const wantedHrId = normalizeHrId(match.hrId);
  if (!wantedHrId) return null;
  const holders = rows
    .filter((row) => normalizeHrId(row.hr_id) === wantedHrId)
    .sort((a, b) => {
      const active = Number(b.is_active === true) - Number(a.is_active === true);
      return active !== 0 ? active : lower(a.login_id).localeCompare(lower(b.login_id), "en");
    });
  return holders[0] ?? null;
}

/**
 * A recipient typed as an email is found by the employee record's WORK email and nothing else.
 * `app_auth_users.email` / `auth_email` are never matched: until 2026-10-26 anyone could set their
 * own `auth_email` to a colleague's address on the profile screen, and a message typed to that
 * colleague then landed in the impostor's inbox (`limit(1)` over `email` OR `auth_email`).
 */
async function loadEmployeeByWorkEmail(email: string) {
  const term = isEmail(email) ? searchableTerm(email) : null;
  if (!term) return { kind: "none" } as const;

  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,nickname,work_email")
    .ilike("work_email", term)
    // Current employees only, as in searchInternalMessageRecipients below.
    .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
    .order("hr_id", { ascending: true })
    .limit(10);

  if (error) throw error;
  return pickWorkEmailEmployee((data ?? []) as EmployeeContactRow[], email);
}

async function loadAuthUsersForHrId(hrId: string | null | undefined) {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id,hr_id,name,email,auth_email,role,is_active")
    .eq("hr_id", normalized.toUpperCase())
    .order("login_id", { ascending: true })
    .limit(20);

  if (error) throw error;
  return pickInternalRecipientUser((data ?? []) as AuthUserRow[], { hrId: normalized });
}

async function loadAuthUserByAccess(access: AccessContext) {
  const supabase = getSupabaseAdmin();

  if (access.loginId) {
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("login_id,hr_id,name,email,auth_email,role,is_active")
      .eq("login_id", access.loginId)
      .maybeSingle();

    if (error) throw error;
    if (data) return data as AuthUserRow;
  }

  const hrId = normalizeHrId(access.hrId);
  if (!hrId) return null;

  const { data, error } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,name,email,auth_email,role,is_active")
    .eq("hr_id", hrId.toUpperCase())
    .maybeSingle();

  if (error) throw error;
  return (data as AuthUserRow | null) ?? null;
}

async function resolveSender(access: AccessContext) {
  if (!access.loginId && !access.hrId) {
    throw new Error("Authentication is required.");
  }

  const [user, employee] = await Promise.all([
    loadAuthUserByAccess(access),
    loadEmployeeByHrId(resolveEmployeeIdentityId(access)),
  ]);
  const hrId = normalizeHrId(user?.hr_id ?? employee?.hr_id ?? access.hrId);
  const loginId = cleanText(user?.login_id ?? access.loginId) || null;

  return {
    email: emailForUser(user, employee),
    hrId,
    loginId,
    name: displayNameForUser(user, employee),
    storedName: storedNameForUser(user, employee),
  };
}

async function resolveRecipient(value: string): Promise<InternalRecipientView & { storedName: string }> {
  const query = cleanText(value);
  if (!query) throw new Error("Recipient is required.");

  const supabase = getSupabaseAdmin();
  const normalizedHrId = normalizeHrId(query);
  const email = lower(query);

  // A typed email is the employee's WORK email — never a sign-in's own email or auth_email.
  if (isEmail(email)) {
    const byWorkEmail = await loadEmployeeByWorkEmail(email);
    if (byWorkEmail.kind === "ambiguous") {
      throw new Error("That work email belongs to more than one employee. Use their HR ID instead.");
    }
    if (byWorkEmail.kind === "one") {
      const holder = await loadAuthUsersForHrId(byWorkEmail.employee.hr_id);
      const recipient = mapRecipient(holder, byWorkEmail.employee);
      if (recipient) return { ...recipient, storedName: storedNameForUser(holder, byWorkEmail.employee) };
    }
  }

  // Every value below is quoted, as in searchInternalMessageRecipients (audit F-02).
  const quotedLogin = ilikeExactValue(query);
  const quotedHrId = ilikeExactValue(normalizedHrId || query);
  if (!quotedLogin || !quotedHrId) {
    throw new Error("Recipient was not found. Use a Phoenix login ID, HR ID, or work email.");
  }
  const { data: userRows, error: userError } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,name,email,auth_email,role,is_active")
    .or(`login_id.ilike.${quotedLogin},hr_id.ilike.${quotedHrId}`)
    .order("login_id", { ascending: true })
    .limit(20);

  if (userError) throw userError;

  const user = pickInternalRecipientUser((userRows ?? []) as AuthUserRow[], { hrId: normalizedHrId, loginId: query });
  const employee = await loadEmployeeByHrId(user?.hr_id ?? normalizedHrId);
  const recipient = mapRecipient(user, employee);

  if (!recipient) {
    throw new Error("Recipient was not found. Use a Phoenix login ID, HR ID, or work email.");
  }

  return { ...recipient, storedName: storedNameForUser(user, employee) };
}

function mapMessage(row: InternalMessageRow, viewer: { hrId: string | null; loginId: string | null }): InternalMessageView {
  const viewerHrId = normalizeHrId(viewer.hrId);
  const viewerLoginId = lower(viewer.loginId);
  const recipientHrId = normalizeHrId(row.recipient_hr_id);
  const recipientLoginId = lower(row.recipient_login_id);
  const direction =
    (viewerHrId && recipientHrId === viewerHrId) || (viewerLoginId && recipientLoginId === viewerLoginId)
      ? "inbox"
      : "sent";

  return {
    body: row.body,
    createdAt: row.created_at,
    direction,
    emailError: row.email_error,
    emailProviderId: row.email_provider_id,
    emailStatus: row.email_status,
    id: row.id,
    readAt: row.read_at,
    recipient: {
      email: row.recipient_email,
      hrId: row.recipient_hr_id,
      loginId: row.recipient_login_id,
      name: row.recipient_name,
    },
    sender: {
      hrId: row.sender_hr_id,
      loginId: row.sender_login_id,
      name: row.sender_name,
    },
    subject: row.subject,
  };
}

export async function searchInternalMessageRecipients(query: string, access: AccessContext, limit = 8) {
  if (!access.loginId && !access.hrId) return [];
  await assertPermission(access, "internal_messages", "create");

  const search = cleanText(query);
  if (search.length < 2) return [];

  const supabase = getSupabaseAdmin();
  // QUOTED, never spliced (technical audit, 2026-10-23, F-02). Any signed-in user reaches this
  // search, and it filters app_auth_users: raw text with a comma could append a condition of its
  // own — a password_hash prefix, say — and turn the endpoint into a yes/no oracle.
  const pattern = ilikeContainsValue(search);
  const normalized = ilikeExactValue(normalizeHrId(search) || search);
  if (!pattern || !normalized) return [];

  const [{ data: users, error: usersError }, { data: employees, error: employeesError }] = await Promise.all([
    supabase
      .from("app_auth_users")
      .select("login_id,hr_id,name,email,auth_email,role,is_active")
      .eq("is_active", true)
      .or(`login_id.ilike.${pattern},hr_id.ilike.${normalized},name.ilike.${pattern},email.ilike.${pattern},auth_email.ilike.${pattern}`)
      .limit(limit),
    supabase
      .from("employees")
      .select("hr_id,full_name,nickname,work_email")
      .or(`hr_id.ilike.${normalized},full_name.ilike.${pattern},nickname.ilike.${pattern},work_email.ilike.${pattern}`)
      // The app_auth_users half above is already restricted to is_active accounts; without the
      // same restriction here a resigned employee stayed searchable and addressable purely
      // because their employees row still carries a work_email.
      .or(`employment_status.is.null,employment_status.in.${ACTIVE_EMPLOYMENT_STATUSES_IN_LIST}`)
      .limit(limit),
  ]);

  if (usersError) throw usersError;
  if (employeesError) throw employeesError;

  const employeesByHrId = new Map(
    ((employees ?? []) as EmployeeContactRow[])
      .map((employee) => [normalizeHrId(employee.hr_id), employee] as const)
      .filter(([hrId]) => Boolean(hrId)),
  );
  const results = new Map<string, InternalRecipientView>();
  // A login found by its login id has no employee row in the search's own results.
  const names = await namesByHrId(((users ?? []) as AuthUserRow[]).map((user) => user.hr_id));

  for (const user of (users ?? []) as AuthUserRow[]) {
    const recipient = mapRecipient(
      { ...user, name: names.get(user.hr_id) ?? user.name },
      employeesByHrId.get(normalizeHrId(user.hr_id)) ?? null,
    );
    if (recipient) results.set(recipient.id.toLowerCase(), recipient);
  }

  for (const employee of (employees ?? []) as EmployeeContactRow[]) {
    const recipient = mapRecipient(null, employee);
    if (recipient) results.set(recipient.id.toLowerCase(), recipient);
  }

  const senderIdentity = normalizeHrId(resolveEmployeeIdentityId(access)) || lower(access.loginId);
  return Array.from(results.values())
    .filter((recipient) => {
      const recipientIdentity = normalizeHrId(recipient.hrId) || lower(recipient.loginId);
      return recipientIdentity !== senderIdentity;
    })
    .slice(0, limit);
}

/** A stored sender_name / recipient_name is what was written then; the reader sees today's display name. */
async function withCurrentDisplayNames(messages: InternalMessageView[]): Promise<InternalMessageView[]> {
  const names = await namesByHrId(messages.flatMap((message) => [message.recipient.hrId, message.sender.hrId]));
  return messages.map((message) => ({
    ...message,
    recipient: { ...message.recipient, name: names.get(message.recipient.hrId) ?? message.recipient.name },
    sender: { ...message.sender, name: names.get(message.sender.hrId) ?? message.sender.name },
  }));
}

export async function listInternalMessagesForViewer(access: AccessContext, limit = 20) {
  // Each identity value is QUOTED: an HR id or a login id is normalised, never validated, and a `,`
  // in one would end its arm early and leave this inbox reading rows that are not the viewer's
  // (AGENTS.md MR-B04).
  const viewerFilters = (sender: { hrId: string | null; loginId: string | null }) => [
    sender.hrId ? quotedOrClause("recipient_hr_id", "eq", sender.hrId) : null,
    sender.loginId ? quotedOrClause("recipient_login_id", "eq", sender.loginId) : null,
    sender.hrId ? quotedOrClause("sender_hr_id", "eq", sender.hrId) : null,
    sender.loginId ? quotedOrClause("sender_login_id", "eq", sender.loginId) : null,
  ].filter((filter): filter is string => Boolean(filter));
  const readMessageRows = async (filters: string[]) => {
    const { data, error } = await getSupabaseAdmin()
      .from(internalMessagesTable)
      .select("id,sender_login_id,sender_hr_id,sender_name,recipient_login_id,recipient_hr_id,recipient_name,recipient_email,subject,body,email_status,email_provider_id,email_error,read_at,created_at")
      .or(filters.join(","))
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 50)));

    if (error) throw error;
    return (data ?? []) as InternalMessageRow[];
  };

  // ONE WAVE, NOT TWO (2026-10-23, every page change under 1 second). The messages list waited for the
  // sender lookup before it asked for a single message, though the sender almost always resolves to the
  // very login id and HR id the session already carries. So the list now asks with the session's own
  // ids BESIDE the lookup, and its rows are used only when the filters the lookup resolves to are the
  // SAME strings — the same rows the old second wave would have read, mapped with the resolved sender.
  // When they differ (an HR id only the employee record knows), that early read is thrown away and the
  // list is read again with the resolved filters, exactly as before. Its failure is held as a value,
  // never dropped: it is raised only if its rows are the ones used, and the lookup's own failure, or
  // "Authentication is required.", still surfaces first.
  const sessionFilters = viewerFilters({ hrId: normalizeHrId(access.hrId), loginId: cleanText(access.loginId) || null });
  const senderLookup = resolveSender(access);
  const earlyRows = sessionFilters.length > 0
    ? readMessageRows(sessionFilters).then(
        (rows) => ({ rows, error: null as unknown }),
        (error: unknown) => ({ rows: null, error }),
      )
    : null;
  const sender = await senderLookup;
  const filters = viewerFilters(sender);

  if (filters.length === 0) return { messages: [], unreadCount: 0 };

  try {
    const early = earlyRows && sessionFilters.join(",") === filters.join(",") ? await earlyRows : null;
    if (early && early.rows === null) throw early.error;
    const rows = early?.rows ?? (await readMessageRows(filters));

    const messages = await withCurrentDisplayNames(rows.map((row) => mapMessage(row, sender)));
    return {
      messages,
      unreadCount: messages.filter((message) => message.direction === "inbox" && !message.readAt).length,
    };
  } catch (error) {
    if (schemaMissing(error)) return { messages: [], unreadCount: 0 };
    throw error;
  }
}

/** Messages one person may send in a minute — a conversation never needs more (owner, 2026-11-13). */
export const INTERNAL_MESSAGE_SENDS_PER_MINUTE = 10;
/** Messages one person may ALSO send by company email in a day (owner, 2026-11-13). */
export const INTERNAL_MESSAGE_EMAILS_PER_DAY = 20;

export async function sendInternalMessage(access: AccessContext, input: SendInternalMessageInput) {
  await assertPermission(access, "internal_messages", "create");
  const sender = await resolveSender(access);
  const subject = cleanText(input.subject);
  const body = cleanText(input.body);

  if (!subject) throw new Error("Subject is required.");
  if (!body) throw new Error("Message is required.");
  if (body.length > 5000) throw new Error("Message is too long. Keep it under 5000 characters.");

  // Counted per sender before anything is stored, so a refused message leaves no row and no email.
  // The email limit is its own bucket: it caps what goes out under the company's sender, and a
  // refused email refuses the message, rather than quietly sending it without the email it asked for.
  const senderKey = sender.hrId || sender.loginId || "";
  await assertApiRateLimit({
    identifier: senderKey,
    limit: INTERNAL_MESSAGE_SENDS_PER_MINUTE,
    scope: "internal-message-send",
    windowMs: 60_000,
  });
  if (input.sendEmail) {
    await assertApiRateLimit({
      identifier: senderKey,
      limit: INTERNAL_MESSAGE_EMAILS_PER_DAY,
      scope: "internal-message-email",
      windowMs: 24 * 60 * 60_000,
    });
  }

  const recipient = await resolveRecipient(input.recipient);

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(internalMessagesTable)
    .insert({
      body,
      email_status: input.sendEmail ? "pending" : "not_requested",
      recipient_email: recipient.email,
      recipient_hr_id: recipient.hrId,
      recipient_login_id: recipient.loginId,
      recipient_name: recipient.storedName,
      sender_hr_id: sender.hrId,
      sender_login_id: sender.loginId,
      sender_name: sender.storedName,
      source: "topbar",
      subject,
      updated_at: now,
    })
    .select("id,sender_login_id,sender_hr_id,sender_name,recipient_login_id,recipient_hr_id,recipient_name,recipient_email,subject,body,email_status,email_provider_id,email_error,read_at,created_at")
    .single();

  if (error) throw error;

  const row = data as InternalMessageRow;

  // One audit row per send: who, to whom, and whether email was asked for — never the words.
  await writeAuditLog({
    actorLoginId: sender.loginId,
    entityId: row.id,
    entityType: "internal_message",
    newValues: {
      emailRequested: input.sendEmail === true,
      recipientHrId: recipient.hrId,
      recipientLoginId: recipient.loginId,
      senderHrId: sender.hrId,
    },
    summary: input.sendEmail ? "Internal message sent, with an email copy" : "Internal message sent",
  });

  if (recipient.hrId) {
    await createSystemNotification({
      category: "internal_message",
      channels: ["in_app", "push"],
      eventType: "internal_message_sent",
      message: `${sender.name}: ${body.slice(0, 180)}`,
      metadata: {
        idempotencyKey: `internal-message:${row.id}`,
        message: `${sender.name}: ${body.slice(0, 180)}`,
        messageId: row.id,
        sender: sender.name,
        title: subject,
      },
      module: "internal_messages",
      priority: "normal",
      recipientHrId: recipient.hrId,
      recipientUserId: recipient.loginId,
      title: subject,
    }).catch((error) => logNotificationSendFailure("internalMessages.sendInternalMessage", error));
  }

  let emailStatus: InternalEmailStatus = row.email_status;
  let emailProviderId: string | null = null;
  let emailError: string | null = null;

  if (input.sendEmail) {
    if (!recipient.email) {
      emailStatus = "skipped";
      emailError = "Recipient has no email address.";
    } else {
      try {
        const result = await createSystemNotification({
          category: "internal_message",
          channels: ["email", "push"],
          email: {
            notificationType: "general",
            recipients: [recipient.email],
            subject,
            summary: `${sender.name}: ${body.slice(0, 500)}`,
            title: subject,
          },
          eventType: "internal_message_email_requested",
          message: `${sender.name}: ${body.slice(0, 180)}`,
          metadata: {
            idempotencyKey: `internal-message-email:${row.id}`,
            messageId: row.id,
            sender: sender.name,
          },
          module: "internal_messages",
          priority: "normal",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.loginId,
          title: subject,
        });
        const emailDelivery = result.deliveries.find((delivery) => delivery.channel === "email");
        if (emailDelivery?.status === "sent") {
          emailStatus = "sent";
          emailProviderId = emailDelivery.idempotencyKey;
        } else {
          emailStatus = emailDelivery?.status === "skipped" ? "skipped" : "failed";
          emailError = emailDelivery?.reason ?? emailDelivery?.error ?? "Email delivery did not complete.";
        }
      } catch (sendError) {
        emailStatus = "failed";
        emailError = sendError instanceof Error ? sendError.message : "Email send failed.";
      }
    }

    await getSupabaseAdmin()
      .from(internalMessagesTable)
      .update({
        email_error: emailError,
        email_provider_id: emailProviderId,
        email_status: emailStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  }

  return {
    message: {
      ...mapMessage({
        ...row,
        email_error: emailError,
        email_provider_id: emailProviderId,
        email_status: emailStatus,
        recipient_name: recipient.name,
        sender_name: sender.name,
      }, sender),
      direction: "sent" as const,
    },
  };
}

export async function markInternalMessageRead(access: AccessContext, messageId: string) {
  await assertPermission(access, "internal_messages", "read");
  const sender = await resolveSender(access);
  // QUOTED, and here the filter guards an UPDATE: it is the only thing stopping "mark read" from
  // settling a message addressed to somebody else (AGENTS.md MR-B04).
  const filters = [
    sender.hrId ? quotedOrClause("recipient_hr_id", "eq", sender.hrId) : null,
    sender.loginId ? quotedOrClause("recipient_login_id", "eq", sender.loginId) : null,
  ].filter((filter): filter is string => Boolean(filter));

  if (filters.length === 0) throw new Error("Authentication is required.");

  const { data, error } = await getSupabaseAdmin()
    .from(internalMessagesTable)
    .update({ read_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", messageId)
    .or(filters.join(","))
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error("Message was not found.");
  return { success: true };
}
