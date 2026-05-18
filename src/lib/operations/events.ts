import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { summarizeNotificationMonitoring } from "@/lib/communication/metrics";
import {
  isDisposableFixtureText,
  isDisposablePayrollBatchRow,
  isDisposableSalesBatchRow,
} from "@/lib/fixture-hygiene";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type MonitoringEventSort = "newest" | "oldest";

export type OperationalActivityEvent = {
  description: string;
  module: string;
  status: string;
  timestamp: string;
  userName: string;
};

export type OperationalActivitySummary = {
  failureCount24h: number;
  lastEventAt: string | null;
  recent: OperationalActivityEvent[];
  staleSources: string[];
  totalEvents24h: number;
};

export type AdminMonitoringSecurityEvent = {
  actor: string;
  actorHrId: string | null;
  actorLoginId: string | null;
  actorName: string | null;
  createdAt: string | null;
  entityType: string;
  id: string;
  summary: string;
};

export type MonitoringSecurityEventsRequest = {
  entityType?: string;
  fetchAll?: boolean;
  maxPageSize?: number;
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: MonitoringEventSort;
};

export type AdminMonitoringSecurityEvents = {
  entityType: string;
  entityTypes: string[];
  page: number;
  pageSize: number;
  rows: AdminMonitoringSecurityEvent[];
  search: string;
  sort: MonitoringEventSort;
  total: number;
  totalPages: number;
};

export type AdminMonitoringStats = {
  auth: {
    authBridgeCoverageRate: number;
    brokenAccounts: string[];
    failedAttempts24h: number;
    forcedPasswordResets: number;
    lockedAccounts: number;
    recentAuthEvents: number;
    uniqueFailedIps24h: number;
  };
  notifications: {
    actualDelivery24h: {
      bounced: number;
      complained: number;
      delivered: number;
      failed: number;
      sent: number;
      suppressed: number;
      unknown: number;
    };
    failed24h: number;
    pending24h: number;
    recentDeliveryEvents: Array<{
      failureReason: string | null;
      id: string;
      occurredAt: string | null;
      recipients: string[];
      status: string;
      subject: string | null;
    }>;
    sent24h: number;
    totalLogs: number;
    totalQueuedEvents: number;
  };
  operations: OperationalActivitySummary;
  recentEvents: AdminMonitoringSecurityEvents;
};

export type AuditLogFilter = {
  actor?: string | null;
  action?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  entityType?: string | null;
  page?: number;
  pageSize?: number;
};

export type FullAuditLogRow = {
  actorHrId: string | null;
  actorLoginId: string;
  actorRole: string | null;
  createdAt: string;
  entityId: string | null;
  entityType: string | null;
  id: string;
  requestIp: string | null;
  summary: string | null;
};

export type AuditLogPage = {
  logs: FullAuditLogRow[];
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
};

type SalaryBatchActivityRow = {
  approved_at?: string | null;
  approved_by?: string | null;
  created_at?: string | null;
  month?: number | null;
  status?: string | null;
  updated_at?: string | null;
  uploaded_by?: string | null;
  year?: number | null;
};

type SalesAuditActivityRow = {
  action?: string | null;
  actor_display_name?: string | null;
  actor_username?: string | null;
  created_at?: string | null;
  line?: string | null;
  period?: string | null;
};

type OfferAuditActivityRow = {
  action?: string | null;
  actor_reference?: string | null;
  actor_type?: string | null;
  created_at?: string | null;
};

function asString(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function coerceMonitoringSort(value: string | undefined): MonitoringEventSort {
  return value === "oldest" ? "oldest" : "newest";
}

function normalizeMonitoringSearch(value?: string) {
  return typeof value === "string" ? value.trim() : "";
}

function coerceMonitoringPage(value: number | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value > 0 ? Math.floor(value) : fallback;
}

function coerceMonitoringPageSize(value: number | undefined, fallback: number, maxPageSize = 500) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const safeValue = Math.floor(value);
  if (safeValue <= 0) return fallback;
  return Math.min(maxPageSize, safeValue);
}

function toMonitoringEventRows(
  rows: Array<{
    actor_login_id?: unknown;
    created_at?: string | null;
    entity_type?: string | null;
    id?: unknown;
    summary?: string | null;
  }>,
  authUserByLoginId: Map<string, { hrId: string | null; name: string | null }>,
) {
  return rows.map((row) => {
    const actorLoginId = typeof row.actor_login_id === "string" && row.actor_login_id.trim()
      ? row.actor_login_id.trim()
      : null;
    const actorProfile = actorLoginId ? authUserByLoginId.get(actorLoginId.toLowerCase()) : undefined;

    return {
      actor: actorLoginId ?? "System",
      actorHrId: actorProfile?.hrId ?? null,
      actorLoginId,
      actorName: actorProfile?.name ?? null,
      createdAt: row.created_at ?? null,
      entityType: row.entity_type ?? "unknown",
      id: String(row.id),
      summary: row.summary ?? "No summary",
    };
  });
}

function buildAuditLoginIdClause(values: string[]) {
  if (values.length === 0) return "";
  return values.map((value) => `"${value.replace(/"/g, "\"\"")}"`).join(",");
}

function buildMonitoringSecurityEventsQuery(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  params: {
    authFilter: string;
    entityType: string;
    matchedActorLoginIds: string[];
    sortAscending: boolean;
  },
) {
  let query = supabase
    .from("audit_logs")
    .select("id,actor_login_id,entity_type,summary,created_at", { count: "exact" })
    .or("entity_type.eq.auth_session,entity_type.eq.user")
    .order("created_at", { ascending: params.sortAscending })
    .order("id", { ascending: params.sortAscending });

  if (params.entityType !== "all") {
    query = query.eq("entity_type", params.entityType);
  }

  if (params.authFilter) {
    const searchClauses = [
      `actor_login_id.ilike.%${params.authFilter}%`,
      `summary.ilike.%${params.authFilter}%`,
      `entity_type.ilike.%${params.authFilter}%`,
    ];
    if (params.matchedActorLoginIds.length > 0) {
      searchClauses.push(`actor_login_id.in.(${buildAuditLoginIdClause(params.matchedActorLoginIds)})`);
    }
    query = query.or(searchClauses.join(","));
  }

  return query;
}

function isMissingEmailDeliveryEventsTable(error: unknown) {
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code ?? "").toLowerCase()
    : "";
  const message = typeof error === "object" && error && "message" in error
    ? String((error as { message?: unknown }).message ?? "").toLowerCase()
    : String(error).toLowerCase();

  return code === "42p01" || message.includes("email_delivery_events");
}

async function getEmailDeliveryMonitoring(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  sinceIso: string,
) {
  const emptyCounts = {
    bounced: 0,
    complained: 0,
    delivered: 0,
    failed: 0,
    sent: 0,
    suppressed: 0,
    unknown: 0,
  };

  const [recent, recent24h] = await Promise.all([
    supabase
      .from("email_delivery_events")
      .select("id,status,subject,recipients,failure_reason,occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(20),
    supabase
      .from("email_delivery_events")
      .select("status,occurred_at")
      .gte("occurred_at", sinceIso),
  ]);

  if (recent.error) throw recent.error;
  if (recent24h.error) throw recent24h.error;

  const counts = { ...emptyCounts };
  for (const row of recent24h.data ?? []) {
    const status = String(row.status ?? "unknown").toLowerCase() as keyof typeof counts;
    if (status in counts) counts[status] += 1;
    else counts.unknown += 1;
  }

  return {
    counts,
    rows: (recent.data ?? []).map((row) => ({
      failureReason: typeof row.failure_reason === "string" ? row.failure_reason : null,
      id: String(row.id),
      occurredAt: typeof row.occurred_at === "string" ? row.occurred_at : null,
      recipients: Array.isArray(row.recipients) ? row.recipients.map(String) : [],
      status: String(row.status ?? "unknown"),
      subject: typeof row.subject === "string" ? row.subject : null,
    })),
  };
}

function payrollActivityDescription(row: SalaryBatchActivityRow) {
  const period = row.month && row.year ? `${row.month}/${row.year}` : "the selected period";
  if (row.status === "part1_ready") return `Payroll Part 1 ready for ${period}`;
  if (row.status === "part1_paid") return `Payroll Part 1 paid for ${period}`;
  if (row.status === "adjustments_open") return `Payroll adjustments open for ${period}`;
  if (row.status === "part2_ready") return `Payroll Part 2 ready for ${period}`;
  if (row.status === "under_review") return `Payroll under review for ${period}`;
  if (row.status === "approved") return `Payroll approved for ${period}`;
  if (row.status === "locked") return `Payroll locked for ${period}`;
  if (row.status === "rejected") return `Payroll rejected for ${period}`;
  return `Payroll uploaded for ${period}`;
}

function salesActivityDescription(row: SalesAuditActivityRow) {
  switch (row.action) {
    case "import.approved":
      return `Sales batch approved for ${row.period ?? "the selected period"}`;
    case "import.rejected":
      return `Sales batch rejected for ${row.period ?? "the selected period"}`;
    case "import.replaced":
      return `Sales batch replaced for ${row.period ?? "the selected period"}`;
    case "import.deleted":
      return `Sales batch deleted for ${row.period ?? "the selected period"}`;
    default:
      return `Sales activity recorded for ${row.period ?? row.line ?? "the selected scope"}`;
  }
}

function offerActivityDescription(row: OfferAuditActivityRow) {
  switch (row.action) {
    case "offer_sent":
      return "Job offer sent";
    case "offer_accepted":
      return "Job offer accepted";
    case "offer_rejected":
      return "Job offer rejected";
    case "offer_expired":
    case "offer_expired_on_click":
      return "Job offer expired";
    default:
      return "Offer activity recorded";
  }
}

function isFailureStatus(value: string | null | undefined) {
  const normalized = String(value ?? "").toLowerCase();
  return (
    normalized.includes("failed") ||
    normalized.includes("rejected") ||
    normalized.includes("error") ||
    normalized.includes("bounced") ||
    normalized.includes("complained")
  );
}

function isDisposablePayrollFixture(row: SalaryBatchActivityRow) {
  return isDisposablePayrollBatchRow(row as Record<string, unknown>);
}

function isDisposableSalesFixture(row: SalesAuditActivityRow) {
  return (
    isDisposableSalesBatchRow(row as Record<string, unknown>) ||
    isDisposableFixtureText(row.actor_username) ||
    isDisposableFixtureText(row.actor_display_name) ||
    /20(?:9\d)|2100/i.test(String(row.period ?? ""))
  );
}

function isDisposableOfferFixture(row: OfferAuditActivityRow) {
  return (
    isDisposableFixtureText(row.actor_reference) ||
    isDisposableFixtureText(row.actor_type)
  );
}

export async function getOperationalRecentActivity(
  accessContext: AccessContext,
  options: { limit?: number } = {},
): Promise<OperationalActivitySummary> {
  const supabase = getSupabaseAdmin();
  const limit = Math.max(1, Math.min(50, options.limit ?? 5));
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [canReadPayroll, canReadSales, canReadOffers] = await Promise.all([
    canAccess(accessContext, "payroll", "read"),
    canAccess(accessContext, "sales", "read"),
    canAccess(accessContext, "offers", "read"),
  ]);

  const [salaryBatchActivity, salesAuditActivity, offerAuditActivity] = await Promise.all([
    canReadPayroll
      ? supabase
          .from("salary_batches")
          .select("month,year,status,uploaded_by,approved_by,approved_at,created_at,updated_at")
          .order("updated_at", { ascending: false })
          .limit(limit)
          .then((result) => result.error ? [] : (result.data ?? []) as SalaryBatchActivityRow[])
      : Promise.resolve([]),
    canReadSales
      ? supabase
          .from("sales_audit_logs")
          .select("action,actor_username,actor_display_name,line,period,created_at")
          .order("created_at", { ascending: false })
          .limit(limit)
          .then((result) => result.error ? [] : (result.data ?? []) as SalesAuditActivityRow[])
      : Promise.resolve([]),
    canReadOffers
      ? supabase
          .from("job_offer_audit_logs")
          .select("action,actor_type,actor_reference,created_at")
          .order("created_at", { ascending: false })
          .limit(limit)
          .then((result) => result.error ? [] : (result.data ?? []) as OfferAuditActivityRow[])
      : Promise.resolve([]),
  ]);

  const businessSalaryBatchActivity = salaryBatchActivity.filter((row) => !isDisposablePayrollFixture(row));
  const businessSalesAuditActivity = salesAuditActivity.filter((row) => !isDisposableSalesFixture(row));
  const businessOfferAuditActivity = offerAuditActivity.filter((row) => !isDisposableOfferFixture(row));

  const recent = [
    ...businessSalaryBatchActivity.map((row) => ({
      description: payrollActivityDescription(row),
      module: "Payroll",
      status: asString(row.status ?? "uploaded"),
      timestamp: asString(row.updated_at ?? row.created_at ?? new Date().toISOString()),
      userName: asString(row.approved_by ?? row.uploaded_by ?? "system"),
    })),
    ...businessSalesAuditActivity.map((row) => ({
      description: salesActivityDescription(row),
      module: "Sales",
      status: asString(row.action ?? "recorded").replace(/^import\./, ""),
      timestamp: asString(row.created_at ?? new Date().toISOString()),
      userName: asString(row.actor_display_name ?? row.actor_username ?? "system"),
    })),
    ...businessOfferAuditActivity.map((row) => ({
      description: offerActivityDescription(row),
      module: "Recruitment",
      status: asString(row.action ?? "recorded").replace(/^offer_/, ""),
      timestamp: asString(row.created_at ?? new Date().toISOString()),
      userName: asString(row.actor_reference ?? row.actor_type ?? "system"),
    })),
  ]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, limit);

  const allEvents = [...businessSalaryBatchActivity, ...businessSalesAuditActivity, ...businessOfferAuditActivity];
  const totalEvents24h = allEvents.filter((row) => {
    const timestamp = "updated_at" in row
      ? row.updated_at ?? row.created_at
      : row.created_at;
    return Boolean(timestamp && timestamp >= since24h);
  }).length;
  const failureCount24h = allEvents.filter((row) => {
    const timestamp = "updated_at" in row
      ? row.updated_at ?? row.created_at
      : row.created_at;
    if (!timestamp || timestamp < since24h) return false;
    const status = "status" in row
      ? row.status
      : "action" in row
        ? row.action
        : null;
    return isFailureStatus(status);
  }).length;

  return {
    failureCount24h,
    lastEventAt: recent[0]?.timestamp ?? null,
    recent,
    staleSources: [],
    totalEvents24h,
  };
}

export async function getOperationalMonitoringStats(
  eventRequest: MonitoringSecurityEventsRequest = {},
): Promise<AdminMonitoringStats> {
  const supabase = getSupabaseAdmin();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const normalizedSearch = normalizeMonitoringSearch(eventRequest.search);
  const requestedSort = coerceMonitoringSort(eventRequest.sort);
  const safePage = coerceMonitoringPage(eventRequest.page, 1);
  const safePageSize = coerceMonitoringPageSize(eventRequest.pageSize, 20, eventRequest.maxPageSize ?? 500);
  const safeEntityType = normalizeMonitoringSearch(eventRequest.entityType) || "all";
  const safeFetchAll = eventRequest.fetchAll ?? false;

  const [
    bridgeRows,
    lockedAccounts,
    forcedPasswordResets,
    failedAttempts,
    authAuditCount,
    notificationLogCount,
    notificationLogs24h,
    notificationEvents24h,
    authUsersWithUid,
    accessProfileUids,
    operations,
  ] = await Promise.all([
    supabase.from("app_auth_users").select("login_id,hr_id,name,auth_user_id,auth_email"),
    supabase.from("app_auth_users").select("*", { count: "exact", head: true }).gt("locked_until", new Date().toISOString()),
    supabase.from("app_auth_users").select("*", { count: "exact", head: true }).eq("force_password_reset", true),
    supabase.from("auth_login_attempts").select("ip,success,attempted_at").eq("success", false).gte("attempted_at", since24h),
    supabase.from("audit_logs").select("*", { count: "exact", head: true }).eq("entity_type", "auth_session").gte("created_at", since24h),
    supabase.from("notification_delivery_logs").select("*", { count: "exact", head: true }),
    supabase
      .from("notification_delivery_logs")
      .select("status,sent_at")
      .gte("sent_at", since24h),
    supabase
      .from("notification_events")
      .select("status,created_at")
      .gte("created_at", since24h),
    supabase.from("app_auth_users").select("login_id,auth_user_id").not("auth_user_id", "is", null),
    supabase.from("user_access_profiles").select("auth_user_id"),
    getOperationalRecentActivity({ scope: "system", role: "Super Admin", loginId: "system" } as AccessContext, { limit: 10 }),
  ]);

  const bridgeData = bridgeRows.data ?? [];
  const authUserByLoginId = new Map(
    bridgeData
      .filter((row) => typeof row.login_id === "string" && row.login_id.length > 0)
      .map((row) => [
        String(row.login_id).toLowerCase(),
        {
          hrId: typeof row.hr_id === "string" && row.hr_id.trim() ? row.hr_id.trim() : null,
          name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
        },
      ]),
  );
  const bridgedUsers = bridgeData.filter((row) => row.auth_user_id && row.auth_email).length;
  const authBridgeCoverageRate = bridgeData.length > 0 ? bridgedUsers / bridgeData.length : 1;

  const profileUidSet = new Set(
    (accessProfileUids.data ?? [])
      .map((row) => row.auth_user_id)
      .filter((uid): uid is string => typeof uid === "string" && uid.length > 0),
  );
  const brokenAccounts = (authUsersWithUid.data ?? [])
    .filter((row) => typeof row.auth_user_id === "string" && !profileUidSet.has(row.auth_user_id))
    .map((row) => row.login_id as string)
    .filter(Boolean);

  const failedAttemptsData = failedAttempts.data ?? [];
  const uniqueFailedIps24h = new Set(
    failedAttemptsData
      .map((row) => row.ip)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  ).size;

  const notificationLogRows = notificationLogs24h.data ?? [];
  const notificationEventRows = notificationEvents24h.data ?? [];
  const emailDeliveryMonitoring = await getEmailDeliveryMonitoring(supabase, since24h).catch((error) => {
    if (!isMissingEmailDeliveryEventsTable(error)) throw error;
    return {
      counts: {
        bounced: 0,
        complained: 0,
        delivered: 0,
        failed: 0,
        sent: 0,
        suppressed: 0,
        unknown: 0,
      },
      rows: [],
    };
  });
  const notificationMonitoring = summarizeNotificationMonitoring({
    deliveryEvents: emailDeliveryMonitoring.rows.map((row) => ({
      failureReason: row.failureReason,
      id: row.id,
      occurredAt: row.occurredAt,
      recipients: row.recipients,
      status: row.status,
      subject: row.subject,
    })),
    deliveryLogs: notificationLogRows.map((row) => ({
      sentAt: typeof row.sent_at === "string" ? row.sent_at : null,
      status: typeof row.status === "string" ? row.status : null,
    })),
    notificationEvents: notificationEventRows.map((row) => ({
      createdAt: typeof row.created_at === "string" ? row.created_at : null,
      status: typeof row.status === "string" ? row.status : null,
    })),
    sinceIso: since24h,
  });
  const authFilter = normalizedSearch.toLowerCase();
  const allActorTypes = new Set<string>();
  const matchedActorLogins = bridgeData
    .filter((row) => {
      const loginId = typeof row.login_id === "string" ? row.login_id : "";
      const hrId = typeof row.hr_id === "string" ? row.hr_id : "";
      const name = typeof row.name === "string" ? row.name : "";
      const normalizedLoginId = loginId.toLowerCase();
      const normalizedHrId = hrId.toLowerCase();
      const normalizedName = name.toLowerCase();

      return authFilter
        ? (
          normalizedLoginId.includes(authFilter)
          || normalizedHrId.includes(authFilter)
          || normalizedName.includes(authFilter)
        )
        : false;
    })
    .map((row) => String(row.login_id))
    .filter((loginId): loginId is string => typeof loginId === "string" && loginId.length > 0);

  const matchedActorLoginIds = Array.from(new Set(matchedActorLogins)).filter((loginId) => loginId.length > 0).slice(0, 500);
  const eventSortAscending = requestedSort === "oldest";
  const buildEventsQuery = () => buildMonitoringSecurityEventsQuery(supabase, {
    authFilter: normalizedSearch,
    entityType: safeEntityType,
    matchedActorLoginIds,
    sortAscending: eventSortAscending,
  });
  let mappedRecentEvents: AdminMonitoringSecurityEvent[] = [];
  let totalRecentAuthEvents = 0;

  if (safeFetchAll) {
    const fetchPageSize = coerceMonitoringPageSize(
      eventRequest.pageSize,
      safePageSize,
      eventRequest.maxPageSize ?? 5000,
    );
    let eventStart = 0;

    while (true) {
      const { data: eventRows, count: total, error: eventsError } = await buildEventsQuery().range(
        eventStart,
        eventStart + fetchPageSize - 1,
      );
      if (eventsError) {
        throw eventsError;
      }
      const mappedRows = toMonitoringEventRows(eventRows ?? [], authUserByLoginId);
      mappedRecentEvents.push(...mappedRows);
      if (typeof total === "number") {
        totalRecentAuthEvents = total;
      }
      if (mappedRows.length < fetchPageSize) {
        break;
      }
      eventStart += fetchPageSize;
    }
    if (totalRecentAuthEvents === 0) {
      totalRecentAuthEvents = mappedRecentEvents.length;
    }
  } else {
    const eventStart = (safePage - 1) * safePageSize;
    const eventEnd = eventStart + safePageSize - 1;
    const { data: recentAuthEventRows, count: total, error: eventsError } = await buildEventsQuery().range(eventStart, eventEnd);
    if (eventsError) {
      throw eventsError;
    }
    mappedRecentEvents = toMonitoringEventRows(recentAuthEventRows ?? [], authUserByLoginId);
    totalRecentAuthEvents = total ?? 0;
  }
  mappedRecentEvents.forEach((event) => {
    if (event.entityType) allActorTypes.add(event.entityType);
  });

  return {
    auth: {
      authBridgeCoverageRate,
      brokenAccounts,
      failedAttempts24h: failedAttemptsData.length,
      forcedPasswordResets: forcedPasswordResets.count ?? 0,
      lockedAccounts: lockedAccounts.count ?? 0,
      recentAuthEvents: authAuditCount.count ?? 0,
      uniqueFailedIps24h,
    },
    notifications: {
      actualDelivery24h: notificationMonitoring.actualDelivery24h,
      failed24h: notificationMonitoring.failed24h,
      pending24h: notificationMonitoring.pending24h,
      recentDeliveryEvents: notificationMonitoring.recentDeliveryEvents,
      sent24h: notificationMonitoring.sent24h,
      totalLogs: notificationLogCount.count ?? 0,
      totalQueuedEvents: notificationMonitoring.totalQueuedEvents,
    },
    operations,
    recentEvents: {
      entityType: safeEntityType,
      entityTypes: Array.from(new Set(["auth_session", "user", ...allActorTypes])),
      page: safePage,
      pageSize: safePageSize,
      rows: mappedRecentEvents,
      search: normalizedSearch,
      sort: requestedSort,
      total: totalRecentAuthEvents ?? 0,
      totalPages: Math.max(1, Math.ceil((totalRecentAuthEvents ?? 0) / safePageSize)),
    },
  };
}

export async function getOperationalAuditLogs(filter: AuditLogFilter = {}): Promise<AuditLogPage> {
  const supabase = getSupabaseAdmin();
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("audit_logs")
    .select("id, actor_login_id, entity_id, entity_type, summary, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (filter.actor) query = query.ilike("actor_login_id", `%${filter.actor}%`);
  if (filter.action) query = query.ilike("summary", `%${filter.action}%`);
  if (filter.entityType) query = query.eq("entity_type", filter.entityType);
  if (filter.dateFrom) query = query.gte("created_at", filter.dateFrom);
  if (filter.dateTo) query = query.lte("created_at", `${filter.dateTo}T23:59:59Z`);

  const { data, error, count } = await query;
  if (error) throw error;

  const total = count ?? 0;
  const logs: FullAuditLogRow[] = (data ?? []).map((row: Record<string, unknown>) => ({
    actorHrId: null,
    actorLoginId: (row.actor_login_id as string) ?? "system",
    actorRole: null,
    createdAt: row.created_at as string,
    entityId: (row.entity_id as string | null) ?? null,
    entityType: (row.entity_type as string | null) ?? null,
    id: String(row.id),
    requestIp: null,
    summary: (row.summary as string | null) ?? null,
  }));

  return { logs, page, pageCount: Math.max(1, Math.ceil(total / pageSize)), pageSize, total };
}
