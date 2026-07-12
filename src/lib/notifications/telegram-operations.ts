import { writeAuditLog } from "@/lib/admin/audit";
import { createSystemNotification, type SystemNotificationResult } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";


type DigestRecipient = {
  hrId: string;
  userId: string | null;
};

type CountResult = {
  errors: string[];
  value: number;
};

type TelegramDeliveryCounts = {
  failed: number;
  pending: number;
  retrying: number;
  sent: number;
  skipped: number;
};

type CountQuery = PromiseLike<{ count?: number | null; error?: unknown }> & {
  eq(column: string, value: unknown): CountQuery;
  gte(column: string, value: string): CountQuery;
  in(column: string, values: readonly string[]): CountQuery;
};

type CountClient = {
  from(table: string): {
    select(columns: string, options: { count: "exact"; head: true }): CountQuery;
  };
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanHrId(value: unknown) {
  return cleanText(value).toUpperCase();
}

function schemaMissing(error: unknown, table: string) {
  const text = (error instanceof Error ? error.message : `${String(error)} ${JSON.stringify(error)}`).toLowerCase();
  return (
    text.includes(table.toLowerCase()) ||
    text.includes("schema cache") ||
    text.includes("does not exist") ||
    text.includes("could not find the table")
  );
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Digest source unavailable.")
    .replace(/[<>]/g, "")
    .slice(0, 160);
}

function todayDisplay() {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Cairo",
  }).format(new Date());
}

async function resolveDigestRecipients() {
  const warnings: string[] = [];
  const recipients: DigestRecipient[] = [];
  const supabase = getSupabaseAdmin();

  try {
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("login_id,hr_id,is_active")
      .in("role", ["HR Manager", "Super Admin"])
      .eq("is_active", true);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>) {
      const hrId = cleanHrId(row.hr_id ?? "");
      if (!hrId) continue;
      recipients.push({ hrId, userId: cleanText(row.login_id) || null });
    }
  } catch (error) {
    if (schemaMissing(error, "app_auth_users")) {
      warnings.push("Digest recipients could not be resolved because auth users are unavailable.");
    } else {
      throw error;
    }
  }

  return { recipients, warnings };
}

async function countRows(table: string, build: (query: CountQuery) => PromiseLike<{ count?: number | null; error?: unknown }> | { count?: number | null; error?: unknown }): Promise<CountResult> {
  try {
    const supabase = getSupabaseAdmin() as unknown as CountClient;
    const query = supabase
      .from(table)
      .select("id", { count: "exact", head: true });
    const result = await build(query) as { count?: number | null; error?: unknown };
    if (result.error) throw result.error;
    return { errors: [], value: Number(result.count ?? 0) };
  } catch (error) {
    if (schemaMissing(error, table)) return { errors: [`${table} is unavailable.`], value: 0 };
    return { errors: [safeError(error)], value: 0 };
  }
}

async function countVacationPending() {
  return countRows("v2_vacation_requests", (query) =>
    query.in("status", ["pending_manager", "pending_hr"])
  );
}

async function countVacationOverdueEvents() {
  return countRows("v2_vacation_request_events", (query) =>
    query.in("event_type", ["sla_reminder", "sla_escalation"])
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  );
}

async function countContractRenewalReminders() {
  return countRows("notification_events", (query) =>
    query.eq("module", "contract_renewal")
      .eq("event_type", "renewal_reminder")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  );
}

async function countProbationReminders() {
  return countRows("notification_events", (query) =>
    query.eq("module", "probation")
      .eq("event_type", "reminder_due")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  );
}

async function countTelegramDeliveries(): Promise<{ counts: TelegramDeliveryCounts; errors: string[] }> {
  const statuses = ["sent", "skipped", "failed", "pending", "retrying"] as const;
  const counts: TelegramDeliveryCounts = { failed: 0, pending: 0, retrying: 0, sent: 0, skipped: 0 };
  const errors: string[] = [];
  for (const status of statuses) {
    const result = await countRows("notification_deliveries", (query) =>
      query.eq("channel", "telegram")
        .eq("status", status)
        .gte("updated_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    );
    counts[status] = result.value;
    errors.push(...result.errors);
  }
  return { counts, errors: Array.from(new Set(errors)) };
}

function digestMessage(input: {
  contractRenewals: number;
  date: string;
  deliveryCounts: TelegramDeliveryCounts;
  probationReminders: number;
  sourceWarnings: string[];
  vacationOverdue: number;
  vacationPending: number;
}) {
  const warnings = input.sourceWarnings.length > 0
    ? `\nSource warnings: ${input.sourceWarnings.length} unavailable source(s).`
    : "";
  return [
    `Date: ${input.date}`,
    `Pending vacation requests: ${input.vacationPending}`,
    `Vacation SLA reminders/escalations today: ${input.vacationOverdue}`,
    `Contract renewal reminders today: ${input.contractRenewals}`,
    `Probation reminders today: ${input.probationReminders}`,
    `Telegram deliveries: sent ${input.deliveryCounts.sent}, skipped ${input.deliveryCounts.skipped}, failed ${input.deliveryCounts.failed}, pending ${input.deliveryCounts.pending}, retrying ${input.deliveryCounts.retrying}.${warnings}`,
  ].join("\n");
}

export async function runTelegramDailyHrDigest() {
  const date = todayDisplay();
  const [{ recipients, warnings }, vacationPending, vacationOverdue, contractRenewals, probationReminders, telegramDeliveries] = await Promise.all([
    resolveDigestRecipients(),
    countVacationPending(),
    countVacationOverdueEvents(),
    countContractRenewalReminders(),
    countProbationReminders(),
    countTelegramDeliveries(),
  ]);
  const sourceWarnings = Array.from(new Set([
    ...warnings,
    ...vacationPending.errors,
    ...vacationOverdue.errors,
    ...contractRenewals.errors,
    ...probationReminders.errors,
    ...telegramDeliveries.errors,
  ]));
  const message = digestMessage({
    contractRenewals: contractRenewals.value,
    date,
    deliveryCounts: telegramDeliveries.counts,
    probationReminders: probationReminders.value,
    sourceWarnings,
    vacationOverdue: vacationOverdue.value,
    vacationPending: vacationPending.value,
  });
  const deliveries: Array<{ hrId: string; result: SystemNotificationResult }> = [];

  if (recipients.length === 0) {
    await writeAuditLog({
      actorLoginId: "daily-dispatcher",
      entityId: "telegram.daily_hr_digest",
      entityType: "notification",
      newValues: { failClosed: true, warnings: sourceWarnings },
      summary: "Telegram daily HR digest skipped because no exact pilot recipient was resolved.",
    });
    return { delivered: 0, deliveries, skipped: true, sourceWarnings };
  }

  await Promise.all(
    recipients.map(async (recipient) => {
      const result = await createSystemNotification({
        actionUrl: "/admin/notifications/telegram",
        actorId: "daily-dispatcher",
        channels: ["in_app", "telegram"],
        eventType: "daily_hr_digest",
        message,
        metadata: {
          contractRenewalReminderCount: contractRenewals.value,
          deliveryCounts: telegramDeliveries.counts,
          digestDate: date,
          idempotencyKey: `telegram-daily-hr-digest:${recipient.hrId}:${new Date().toISOString().slice(0, 10)}`,
          probationReminderCount: probationReminders.value,
          safeSummaryOnly: true,
          sourceWarnings,
          vacationOverdueCount: vacationOverdue.value,
          vacationPendingCount: vacationPending.value,
          workflowApproverHrIds: recipients.map((r) => r.hrId),
        },
        module: "system",
        priority: telegramDeliveries.counts.failed > 0 ? "high" : "normal",
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        title: "Daily HR Telegram Digest",
      });
      deliveries.push({ hrId: recipient.hrId, result });
    }),
  );

  await writeAuditLog({
    actorLoginId: "daily-dispatcher",
    entityId: "telegram.daily_hr_digest",
    entityType: "notification",
    newValues: {
      delivered: deliveries.length,
      sourceWarnings,
      telegramDeliveryCounts: telegramDeliveries.counts,
    },
    summary: "Telegram daily HR digest processed.",
  });

  return { delivered: deliveries.length, deliveries, skipped: false, sourceWarnings };
}
