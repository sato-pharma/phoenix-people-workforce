import type { AccessContext } from "@/lib/auth/permissions";
import { normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { ilikeContainsValue, ilikeExactValue } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  return cleanText(user?.name) || cleanText(employee?.full_name) || cleanText(user?.login_id) || cleanText(user?.hr_id) || "Phoenix User";
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
    .select("hr_id,full_name,work_email")
    .eq("hr_id", normalized.toUpperCase())
    .maybeSingle();

  if (error) throw error;
  return (data as EmployeeContactRow | null) ?? null;
}

async function loadEmployeeByEmail(email: string) {
  if (!isEmail(email)) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,full_name,work_email")
    .ilike("work_email", email)
    .maybeSingle();

  if (error) throw error;
  return (data as EmployeeContactRow | null) ?? null;
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
  };
}

async function resolveRecipient(value: string): Promise<InternalRecipientView> {
  const query = cleanText(value);
  if (!query) throw new Error("Recipient is required.");

  const supabase = getSupabaseAdmin();
  const normalizedHrId = normalizeHrId(query);
  const email = lower(query);

  // Every value below is quoted, as in searchInternalMessageRecipients (audit F-02).
  const quotedEmail = ilikeExactValue(email);
  if (isEmail(email) && quotedEmail) {
    const [{ data: userData, error: userError }, employee] = await Promise.all([
      supabase
        .from("app_auth_users")
        .select("login_id,hr_id,name,email,auth_email,role,is_active")
        .or(`email.ilike.${quotedEmail},auth_email.ilike.${quotedEmail}`)
        .limit(1)
        .maybeSingle(),
      loadEmployeeByEmail(email),
    ]);

    if (userError) throw userError;
    const recipient = mapRecipient((userData as AuthUserRow | null) ?? null, employee);
    if (recipient) return recipient;
  }

  const quotedLogin = ilikeExactValue(query);
  const quotedHrId = ilikeExactValue(normalizedHrId || query);
  if (!quotedLogin || !quotedHrId) {
    throw new Error("Recipient was not found. Use a Phoenix login ID, HR ID, or work email.");
  }
  const { data: userData, error: userError } = await supabase
    .from("app_auth_users")
    .select("login_id,hr_id,name,email,auth_email,role,is_active")
    .or(`login_id.ilike.${quotedLogin},hr_id.ilike.${quotedHrId}`)
    .limit(1)
    .maybeSingle();

  if (userError) throw userError;

  const user = (userData as AuthUserRow | null) ?? null;
  const employee = await loadEmployeeByHrId(user?.hr_id ?? normalizedHrId);
  const recipient = mapRecipient(user, employee);

  if (!recipient) {
    throw new Error("Recipient was not found. Use a Phoenix login ID, HR ID, or work email.");
  }

  return recipient;
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
      .select("hr_id,full_name,work_email")
      .or(`hr_id.ilike.${normalized},full_name.ilike.${pattern},work_email.ilike.${pattern}`)
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

  for (const user of (users ?? []) as AuthUserRow[]) {
    const recipient = mapRecipient(user, employeesByHrId.get(normalizeHrId(user.hr_id)) ?? null);
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

export async function listInternalMessagesForViewer(access: AccessContext, limit = 20) {
  const sender = await resolveSender(access);
  const filters = [
    sender.hrId ? `recipient_hr_id.eq.${sender.hrId}` : null,
    sender.loginId ? `recipient_login_id.eq.${sender.loginId}` : null,
    sender.hrId ? `sender_hr_id.eq.${sender.hrId}` : null,
    sender.loginId ? `sender_login_id.eq.${sender.loginId}` : null,
  ].filter((filter): filter is string => Boolean(filter));

  if (filters.length === 0) return { messages: [], unreadCount: 0 };

  try {
    const { data, error } = await getSupabaseAdmin()
      .from(internalMessagesTable)
      .select("id,sender_login_id,sender_hr_id,sender_name,recipient_login_id,recipient_hr_id,recipient_name,recipient_email,subject,body,email_status,email_provider_id,email_error,read_at,created_at")
      .or(filters.join(","))
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 50)));

    if (error) throw error;

    const messages = ((data ?? []) as InternalMessageRow[]).map((row) => mapMessage(row, sender));
    return {
      messages,
      unreadCount: messages.filter((message) => message.direction === "inbox" && !message.readAt).length,
    };
  } catch (error) {
    if (schemaMissing(error)) return { messages: [], unreadCount: 0 };
    throw error;
  }
}

export async function sendInternalMessage(access: AccessContext, input: SendInternalMessageInput) {
  const sender = await resolveSender(access);
  const recipient = await resolveRecipient(input.recipient);
  const subject = cleanText(input.subject);
  const body = cleanText(input.body);

  if (!subject) throw new Error("Subject is required.");
  if (!body) throw new Error("Message is required.");
  if (body.length > 5000) throw new Error("Message is too long. Keep it under 5000 characters.");

  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(internalMessagesTable)
    .insert({
      body,
      email_status: input.sendEmail ? "pending" : "not_requested",
      recipient_email: recipient.email,
      recipient_hr_id: recipient.hrId,
      recipient_login_id: recipient.loginId,
      recipient_name: recipient.name,
      sender_hr_id: sender.hrId,
      sender_login_id: sender.loginId,
      sender_name: sender.name,
      source: "topbar",
      subject,
      updated_at: now,
    })
    .select("id,sender_login_id,sender_hr_id,sender_name,recipient_login_id,recipient_hr_id,recipient_name,recipient_email,subject,body,email_status,email_provider_id,email_error,read_at,created_at")
    .single();

  if (error) throw error;

  const row = data as InternalMessageRow;

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
      }, sender),
      direction: "sent" as const,
    },
  };
}

export async function markInternalMessageRead(access: AccessContext, messageId: string) {
  const sender = await resolveSender(access);
  const filters = [
    sender.hrId ? `recipient_hr_id.eq.${sender.hrId}` : null,
    sender.loginId ? `recipient_login_id.eq.${sender.loginId}` : null,
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
