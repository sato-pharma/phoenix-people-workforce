import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildSalesOwnershipContext,
  classifyEmployeeNode,
  classifySalesOwnership,
  salesOwnershipLabel,
  shouldFlagMissingAccessForEmployeeNode,
  type EmployeeNodeInput,
  type EmployeeNodeType,
  type SalesOwnershipClassification,
  type SalesOwnershipRecord,
  type SalesOwnershipVacancySignal,
} from "@/lib/workforce-classification";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { isManagerOptionalHrId } from "@/lib/employees/hierarchy-governance";
import { calculateWorkforceStructureSummary } from "@/lib/workforce/seat-lifecycle";

export type PhoenixAdminStats = {
  totalEmployees: number;
  activeEmployees: number;
  payrollEligible: number;
  salaryRecords: number;
  salesRecords: number;
  expensesCount: number;
  salaryFlags: number;
  dataHealthIssues: number;
  vacancies: number;
  offers: number;
  auditLogs: Array<{
    action: string;
    entity_name: string;
    user_email: string;
    created_at: string | null;
  }>;
};

export type MonitoringEventSort = "newest" | "oldest";

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
  page?: number;
  pageSize?: number;
  search?: string;
  sort?: MonitoringEventSort;
  fetchAll?: boolean;
  maxPageSize?: number;
};

export type AdminMonitoringSecurityEvents = {
  entityType: string;
  entityTypes: string[];
  page: number;
  pageSize: number;
  search: string;
  sort: MonitoringEventSort;
  total: number;
  totalPages: number;
  rows: AdminMonitoringSecurityEvent[];
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
  recentEvents: AdminMonitoringSecurityEvents;
};

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
  const escaped = values.map((value) => `"${value.replace(/"/g, "\"\"")}"`);
  return escaped.join(",");
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

export async function getPhoenixAdminStats(): Promise<PhoenixAdminStats> {
  const supabase = getSupabaseAdmin();

  const [
    employees,
    active,
    payrollEligible,
    salaryRecords,
    salesRecords,
    expenses,
    salaryFlags,
    vacancies,
    offers,
    auditLogs
  ] = await Promise.all([
    supabase.from("employees").select("*", { count: "exact", head: true }),
    supabase.from("v_active_organogram").select("*", { count: "exact", head: true }),
    supabase.from("v_payroll_eligible_employees").select("*", { count: "exact", head: true }),
    supabase.from("salary_records").select("*", { count: "exact", head: true }),
    supabase.from("sales_records").select("*", { count: "exact", head: true }),
    supabase.from("payroll_expenses").select("*", { count: "exact", head: true }),
    supabase.from("salary_flags").select("*", { count: "exact", head: true }),
    supabase.from("position_vacancies").select("*", { count: "exact", head: true }),
    supabase.from("job_offers").select("*", { count: "exact", head: true }),
    supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(10)
  ]);
  const dataHealthStats = await getDataHealthStats().catch(() => null);

  return {
    totalEmployees: dataHealthStats?.summary.totalEmployees ?? employees.count ?? 0,
    activeEmployees: dataHealthStats?.summary.activeEmployees ?? active.count ?? 0,
    payrollEligible: payrollEligible.count ?? 0,
    salaryRecords: salaryRecords.count ?? 0,
    salesRecords: salesRecords.count ?? 0,
    expensesCount: expenses.count ?? 0,
    salaryFlags: salaryFlags.count ?? 0,
    dataHealthIssues: dataHealthStats?.summary.issuesCount ?? 0,
    vacancies: vacancies.count ?? 0,
    offers: offers.count ?? 0,
    auditLogs: (auditLogs.data ?? []).map((log) => ({
      action: log.summary ?? log.entity_type ?? "System activity",
      entity_name: log.entity_type
        ? `${log.entity_type}${log.entity_id ? ` #${log.entity_id}` : ""}`
        : "System",
      user_email: log.actor_login_id ?? "System",
      created_at: log.created_at ?? null,
    }))
  };
}

export async function getAdminMonitoringStats(
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
      actualDelivery24h: emailDeliveryMonitoring.counts,
      failed24h: notificationLogRows.filter((row) => String(row.status ?? "").toLowerCase() === "failed").length,
      pending24h: notificationEventRows.filter((row) => String(row.status ?? "").toLowerCase() === "pending").length,
      recentDeliveryEvents: emailDeliveryMonitoring.rows,
      sent24h: notificationLogRows.filter((row) => String(row.status ?? "").toLowerCase() === "sent").length,
      totalLogs: notificationLogCount.count ?? 0,
      totalQueuedEvents: notificationEventRows.length,
    },
    recentEvents: {
      entityType: safeEntityType,
      entityTypes: Array.from(new Set(["auth_session", "user", ...allActorTypes])),
      page: safePage,
      pageSize: safePageSize,
      search: normalizedSearch,
      sort: requestedSort,
      rows: mappedRecentEvents,
      total: totalRecentAuthEvents ?? 0,
      totalPages: Math.max(1, Math.ceil((totalRecentAuthEvents ?? 0) / safePageSize)),
    },
  };
}

export type DataHealthStats = {
  summary: {
    totalEmployees: number;
    structureNodes: number;
    activeEmployees: number;
    healthyEmployees: number;
    issuesCount: number;
    healthRate: number;
    activeEmployeesMissingAuthAccess: number;
    nonLoginAggregationNodes: number;
    historicalRecords: number;
    vacancyNodes: number;
    vacantPositions: number;
    employeeLinkageWarnings: number;
    unresolvedSalesExceptions: number;
  };
  salesClassification: Record<SalesOwnershipClassification, {
    label: string;
    records: number;
    salesValue: number;
  }>;
  employeeIssues: Array<{
    hr_id: string;
    full_name: string;
    job_title: string;
    manager_hr_id: string | null;
    node_type: EmployeeNodeType;
    has_auth_user: boolean;
    has_access_profile: boolean;
    health_status: string;
    reason: string;
  }>;
  salesIssues: Array<{
    batch_id: string | null;
    row_number: number | null;
    employee_hr_id: string | null;
    manager_hr_id: string | null;
    line: string | null;
    territory: string | null;
    product: string;
    sales_value: number;
    classification: SalesOwnershipClassification;
    linkage_health_status: string;
    reason: string;
  }>;
  orphanAudit: Array<{
    source: string;
    hr_id: string;
    rows_count: number;
    sample_name: string | null;
  }>;
  vacancyAudit: Array<{
    vacancy_id: string | null;
    vacancy_code: string | null;
    area_name: string | null;
    line_name: string | null;
    manager_hr_id: string | null;
    status: string | null;
  }>;
};

export type SalaryFlag = {
  id: string;
  hrId: string | null;
  flagType: string | null;
  severity: string | null;
  message: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
};

export type SalaryFlagsResult = {
  flags: SalaryFlag[];
  total: number;
  unresolvedCount: number;
};

export async function getSalaryFlags(showResolved = false): Promise<SalaryFlagsResult> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("salary_flags")
    .select("id, hr_id, flag_type, severity, message, resolved_at, resolved_by, created_at", { count: "exact" })
    .order("created_at", { ascending: false });

  if (!showResolved) {
    query = query.is("resolved_at", null);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const unresolvedResult = showResolved
    ? await supabase.from("salary_flags").select("*", { count: "exact", head: true }).is("resolved_at", null)
    : null;

  const flags: SalaryFlag[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    hrId: (row.hr_id as string | null) ?? null,
    flagType: (row.flag_type as string | null) ?? null,
    severity: (row.severity as string | null) ?? null,
    message: (row.message as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    createdAt: row.created_at as string,
  }));

  return {
    flags,
    total: count ?? 0,
    unresolvedCount: showResolved ? (unresolvedResult?.count ?? 0) : (count ?? 0),
  };
}

export async function resolveSalaryFlag(id: string, resolvedBy: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("salary_flags")
    .update({ resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
    .eq("id", id);
  if (error) throw error;
}

const salesOwnershipClassifications: SalesOwnershipClassification[] = [
  "assigned_employee_sales",
  "vacant_territory_sales",
  "non_assignable_territory_sales",
  "line_level_sales",
  "others_unassigned_sales",
  "unresolved_sales_exception",
];

function normalizeHealthKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function rowText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function rowNumber(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function relationName(value: unknown, key: string) {
  const source = Array.isArray(value) ? value[0] : value;
  if (!source || typeof source !== "object") return null;
  return rowText(source as Record<string, unknown>, key);
}

async function fetchAllDataHealthRows<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const pageRows = (Array.isArray(data) ? data : []) as T[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

function emptySalesClassificationSummary(): DataHealthStats["salesClassification"] {
  return Object.fromEntries(
    salesOwnershipClassifications.map((classification) => [
      classification,
      {
        label: salesOwnershipLabel(classification),
        records: 0,
        salesValue: 0,
      },
    ]),
  ) as DataHealthStats["salesClassification"];
}

function addLineLookup(map: Map<string, number>, name: string | null | undefined, id: number | null | undefined) {
  if (!name || typeof id !== "number") return;
  map.set(normalizeHealthKey(name), id);
}

function employeeToNodeInput(employee: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"][number]): EmployeeNodeInput {
  return {
    areaId: employee.areaId,
    areaName: employee.areaName,
    crmId: employee.crmId,
    crmUsername: employee.crmUsername,
    employmentStatus: employee.employmentStatus,
    fullName: employee.fullName,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineId: employee.lineId,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    positionTitle: employee.positionTitle,
    workEmail: employee.workEmail,
  };
}

function vacancySignalFromRow(row: Record<string, unknown>): SalesOwnershipVacancySignal {
  return {
    areaId: rowNumber(row, "area_id"),
    areaName: relationName(row.areas, "name"),
    lineId: rowNumber(row, "line_id"),
    lineName: relationName(row.lines, "name"),
    managerHrId: rowText(row, "manager_hr_id"),
    status: rowText(row, "status"),
    vacancyCode: rowText(row, "vacancy_code"),
    vacancyId: rowText(row, "id"),
  };
}

function salesOwnershipRecordFromRow(row: Record<string, unknown>): SalesOwnershipRecord {
  return {
    employeeCrmId: rowText(row, "employee_crm_id"),
    employeeHrId: rowText(row, "employee_hr_id"),
    employeeLookupKey: rowText(row, "employee_lookup_key"),
    employeeName: rowText(row, "employee_name"),
    line: rowText(row, "line"),
    managerHrId: rowText(row, "manager_hr_id"),
    territory: rowText(row, "territory"),
  };
}

export async function getDataHealthStats(): Promise<DataHealthStats> {
  const supabase = getSupabaseAdmin();

  const [
    directory,
    appAuthUsers,
    accessProfiles,
    salesRows,
    vacancyRows,
    orphanAudit,
  ] = await Promise.all([
    getEmployeeDirectory(),
    fetchAllDataHealthRows<Record<string, unknown>>(() =>
      supabase.from("app_auth_users").select("hr_id,is_active,login_id"),
    ),
    fetchAllDataHealthRows<Record<string, unknown>>(() =>
      supabase.from("user_access_profiles").select("hr_id,is_active,auth_user_id,login_id"),
    ),
    fetchAllDataHealthRows<Record<string, unknown>>(() =>
      supabase
        .from("sales_records")
        .select("batch_id,row_number,employee_hr_id,employee_crm_id,employee_lookup_key,employee_name,manager_hr_id,line,territory,product,sales_value,validation_state"),
    ),
    fetchAllDataHealthRows<Record<string, unknown>>(() =>
      supabase
        .from("position_vacancies")
        .select("id,vacancy_code,area_id,line_id,manager_hr_id,status,areas(name),lines(name)"),
    ),
    supabase.from("v_hr_id_orphan_audit").select("*"),
  ]);

  const employeeNodes = directory.employees.map(employeeToNodeInput);
  const authHrIds = new Set(
    appAuthUsers
      .filter((row) => row.is_active !== false)
      .map((row) => normalizeHealthKey(row.hr_id))
      .filter(Boolean),
  );
  const accessProfileHrIds = new Set(
    accessProfiles
      .filter((row) => row.is_active !== false)
      .map((row) => normalizeHealthKey(row.hr_id))
      .filter(Boolean),
  );
  const employeeByHrId = new Map(employeeNodes.map((employee) => [normalizeHealthKey(employee.hrId), employee]));
  const lineIdByName = new Map<string, number>();
  const areaIdByName = new Map<string, number>();
  const lineIdByAreaId = new Map<number, number>();

  for (const line of directory.lookups.lines) {
    const id = Number(line.value);
    if (Number.isFinite(id)) addLineLookup(lineIdByName, line.label, id);
  }
  for (const area of directory.lookups.areas) {
    const areaId = Number(area.value);
    if (Number.isFinite(areaId)) {
      areaIdByName.set(normalizeHealthKey(area.label), areaId);
      if (typeof area.lineId === "number") lineIdByAreaId.set(areaId, area.lineId);
    }
  }
  for (const employee of directory.employees) {
    addLineLookup(lineIdByName, employee.lineName, employee.lineId);
    if (employee.areaName && typeof employee.areaId === "number") areaIdByName.set(normalizeHealthKey(employee.areaName), employee.areaId);
    if (typeof employee.areaId === "number" && typeof employee.lineId === "number") lineIdByAreaId.set(employee.areaId, employee.lineId);
  }

  const ownershipContext = buildSalesOwnershipContext({
    areaIdByName,
    employees: employeeNodes,
    lineIdByAreaId,
    lineIdByName,
    vacancies: vacancyRows.map(vacancySignalFromRow),
  });

  const employeeIssues: DataHealthStats["employeeIssues"] = [];
  let activeEmployees = 0;
  let structureNodes = 0;
  let historicalRecords = 0;
  let vacancyNodes = 0;
  let nonLoginAggregationNodes = 0;

  for (const employee of employeeNodes) {
    const node = classifyEmployeeNode(employee);
    if (node.node_type === "active_employee") activeEmployees += 1;
    if (node.eligible_for_organogram) structureNodes += 1;
    if (node.node_type === "historical_record") historicalRecords += 1;
    if (node.node_type === "vacancy_node") vacancyNodes += 1;
    if (
      node.node_type === "system_placeholder" ||
      node.node_type === "others_unassigned_node" ||
      node.node_type === "non_login_aggregation_node"
    ) {
      nonLoginAggregationNodes += 1;
    }

    if (!node.eligible_for_login) continue;

    const hrId = rowText(employee, "hrId") ?? rowText(employee, "hr_id") ?? "";
    const normalizedHrId = normalizeHealthKey(hrId);
    const hasAuthUser = authHrIds.has(normalizedHrId);
    const hasAccessProfile = accessProfileHrIds.has(normalizedHrId);
    const managerHrId = rowText(employee, "managerHrId") ?? rowText(employee, "manager_hr_id");
    const normalizedManagerHrId = normalizeHealthKey(managerHrId);

    let healthStatus = "ok";
    let reason = "Active employee access and linkage are classified.";

    if (shouldFlagMissingAccessForEmployeeNode(employee, { hasAccessProfile, hasAuthUser })) {
      if (!hasAuthUser && !hasAccessProfile) healthStatus = "missing_auth_access";
      else if (!hasAuthUser) healthStatus = "missing_auth_user";
      else healthStatus = "missing_access_profile";
      reason = "Active employee is eligible for login but is missing auth and/or access profile coverage.";
    } else if (!managerHrId && !isManagerOptionalHrId(hrId)) {
      healthStatus = "missing_manager";
      reason = "Active employee is missing manager_hr_id.";
    } else if (normalizedManagerHrId && !employeeByHrId.has(normalizedManagerHrId)) {
      healthStatus = "manager_not_found";
      reason = "Active employee references a manager HR ID that was not found.";
    } else if (!rowText(employee, "jobTitle") && !rowText(employee, "job_title") && !rowText(employee, "positionTitle")) {
      healthStatus = "missing_job_title";
      reason = "Active employee is missing job title or position title.";
    } else if (rowNumber(employee, "lineId") === null && rowNumber(employee, "line_id") === null) {
      healthStatus = "missing_line";
      reason = "Active employee is missing line ownership.";
    } else if (rowNumber(employee, "areaId") === null && rowNumber(employee, "area_id") === null) {
      healthStatus = "missing_area";
      reason = "Active employee is missing area ownership.";
    }

    if (healthStatus !== "ok") {
      employeeIssues.push({
        full_name: rowText(employee, "fullName") ?? rowText(employee, "full_name") ?? "Unknown employee",
        has_access_profile: hasAccessProfile,
        has_auth_user: hasAuthUser,
        health_status: healthStatus,
        hr_id: hrId,
        job_title: rowText(employee, "jobTitle") ?? rowText(employee, "job_title") ?? rowText(employee, "positionTitle") ?? "",
        manager_hr_id: managerHrId,
        node_type: node.node_type,
        reason,
      });
    }
  }

  const salesClassification = emptySalesClassificationSummary();
  const salesIssues: DataHealthStats["salesIssues"] = [];

  for (const row of salesRows) {
    const ownership = classifySalesOwnership(salesOwnershipRecordFromRow(row), ownershipContext);
    const salesValue = rowNumber(row, "sales_value") ?? 0;
    salesClassification[ownership.classification].records += 1;
    salesClassification[ownership.classification].salesValue += salesValue;

    if (ownership.classification === "unresolved_sales_exception") {
      salesIssues.push({
        batch_id: rowText(row, "batch_id"),
        classification: ownership.classification,
        employee_hr_id: rowText(row, "employee_hr_id"),
        line: rowText(row, "line"),
        linkage_health_status: ownership.classification,
        manager_hr_id: rowText(row, "manager_hr_id"),
        product: rowText(row, "product") ?? "Unknown",
        reason: ownership.reason,
        row_number: rowNumber(row, "row_number"),
        sales_value: salesValue,
        territory: rowText(row, "territory"),
      });
    }
  }

  const activeEmployeesMissingAuthAccess = employeeIssues.filter((issue) =>
    ["missing_auth_access", "missing_auth_user", "missing_access_profile"].includes(issue.health_status),
  ).length;
  const employeeLinkageWarnings = employeeIssues.length - activeEmployeesMissingAuthAccess;
  const issuesCount = employeeIssues.length + salesIssues.length;
  const healthyEmployees = Math.max(0, activeEmployees - employeeIssues.length);
  const healthRate = activeEmployees > 0 ? (healthyEmployees / activeEmployees) * 100 : 100;
  const orphans = Array.isArray(orphanAudit.data) ? orphanAudit.data : [];
  const vacancyAudit = vacancyRows.map((row) => ({
    area_name: relationName(row.areas, "name"),
    line_name: relationName(row.lines, "name"),
    manager_hr_id: rowText(row, "manager_hr_id"),
    status: rowText(row, "status"),
    vacancy_code: rowText(row, "vacancy_code"),
    vacancy_id: rowText(row, "id"),
  }));
  const workforceStructure = calculateWorkforceStructureSummary({
    activeEmployees: structureNodes,
    openVacancies: vacancyAudit.length,
  });

  return {
    summary: {
      activeEmployees,
      activeEmployeesMissingAuthAccess,
      employeeLinkageWarnings,
      healthRate,
      healthyEmployees,
      historicalRecords,
      issuesCount,
      nonLoginAggregationNodes,
      structureNodes: workforceStructure.totalStructure,
      totalEmployees: employeeNodes.length,
      unresolvedSalesExceptions: salesIssues.length,
      vacantPositions: vacancyAudit.length,
      vacancyNodes,
    },
    employeeIssues,
    salesClassification,
    salesIssues,
    orphanAudit: orphans,
    vacancyAudit,
  };
}
