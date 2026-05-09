import { getSupabaseAdmin } from "@/lib/supabase/server";

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
    failed24h: number;
    pending24h: number;
    sent24h: number;
    totalLogs: number;
    totalQueuedEvents: number;
  };
  recentEvents: Array<{
    actor: string;
    createdAt: string | null;
    entityType: string;
    summary: string;
  }>;
};

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
    dataHealth,
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
    supabase.from("employee_linkage_health").select("*", { count: "exact", head: true }).neq("health_status", "ok"),
    supabase.from("position_vacancies").select("*", { count: "exact", head: true }),
    supabase.from("job_offers").select("*", { count: "exact", head: true }),
    supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(10)
  ]);

  return {
    totalEmployees: employees.count ?? 0,
    activeEmployees: active.count ?? 0,
    payrollEligible: payrollEligible.count ?? 0,
    salaryRecords: salaryRecords.count ?? 0,
    salesRecords: salesRecords.count ?? 0,
    expensesCount: expenses.count ?? 0,
    salaryFlags: salaryFlags.count ?? 0,
    dataHealthIssues: dataHealth.count ?? 0,
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

export async function getAdminMonitoringStats(): Promise<AdminMonitoringStats> {
  const supabase = getSupabaseAdmin();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    bridgeRows,
    lockedAccounts,
    forcedPasswordResets,
    failedAttempts,
    authAuditCount,
    recentAuthEvents,
    notificationLogCount,
    notificationLogs24h,
    notificationEvents24h,
    authUsersWithUid,
    accessProfileUids,
  ] = await Promise.all([
    supabase.from("app_auth_users").select("login_id,auth_user_id,auth_email"),
    supabase.from("app_auth_users").select("*", { count: "exact", head: true }).gt("locked_until", new Date().toISOString()),
    supabase.from("app_auth_users").select("*", { count: "exact", head: true }).eq("force_password_reset", true),
    supabase.from("auth_login_attempts").select("ip,success,attempted_at").eq("success", false).gte("attempted_at", since24h),
    supabase.from("audit_logs").select("*", { count: "exact", head: true }).eq("entity_type", "auth_session").gte("created_at", since24h),
    supabase
      .from("audit_logs")
      .select("actor_login_id,entity_type,summary,created_at")
      .or("entity_type.eq.auth_session,entity_type.eq.user")
      .order("created_at", { ascending: false })
      .limit(12),
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
      failed24h: notificationLogRows.filter((row) => String(row.status ?? "").toLowerCase() === "failed").length,
      pending24h: notificationEventRows.filter((row) => String(row.status ?? "").toLowerCase() === "pending").length,
      sent24h: notificationLogRows.filter((row) => String(row.status ?? "").toLowerCase() === "sent").length,
      totalLogs: notificationLogCount.count ?? 0,
      totalQueuedEvents: notificationEventRows.length,
    },
    recentEvents: (recentAuthEvents.data ?? []).map((row) => ({
      actor: row.actor_login_id ?? "System",
      createdAt: row.created_at ?? null,
      entityType: row.entity_type ?? "unknown",
      summary: row.summary ?? "No summary",
    })),
  };
}

export type DataHealthStats = {
  summary: {
    totalEmployees: number;
    healthyEmployees: number;
    issuesCount: number;
    healthRate: number;
  };
  employeeIssues: Array<{
    hr_id: string;
    full_name: string;
    job_title: string;
    manager_hr_id: string | null;
    health_status: string;
  }>;
  salesIssues: Array<{
    employee_hr_id: string;
    manager_hr_id: string | null;
    product: string;
    linkage_health_status: string;
  }>;
  orphanAudit: Array<{
    source: string;
    hr_id: string;
    rows_count: number;
    sample_name: string | null;
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

export async function getDataHealthStats(): Promise<DataHealthStats> {
  const supabase = getSupabaseAdmin();

  const [
    linkageHealth,
    salesHealth,
    orphanAudit,
    totalCount
  ] = await Promise.all([
    supabase.from("employee_linkage_health").select("*"),
    supabase.from("sales_employee_linkage_health").select("*"),
    supabase.from("v_hr_id_orphan_audit").select("*"),
    supabase.from("employees").select("*", { count: "exact", head: true })
  ]);

  const employeeIssues = (linkageHealth.data ?? []);
  const salesIssues = (salesHealth.data ?? []);
  const orphans = (orphanAudit.data ?? []);
  
  const totalEmployees = totalCount.count ?? 0;
  const issuesCount = employeeIssues.filter(e => e.health_status !== "ok").length;
  const healthyEmployees = totalEmployees - issuesCount;
  const healthRate = totalEmployees > 0 ? (healthyEmployees / totalEmployees) * 100 : 100;

  return {
    summary: {
      totalEmployees,
      healthyEmployees,
      issuesCount,
      healthRate
    },
    employeeIssues,
    salesIssues,
    orphanAudit: orphans
  };
}
