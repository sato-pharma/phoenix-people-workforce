import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { getContractRenewalReminderCandidates } from "@/lib/contracts/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { lifecycleRiskWindows } from "@/lib/lifecycle-risk/metrics";
import { runScheduledNotificationProcessing } from "@/lib/notifications/scheduled-processing";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmployeeDirectoryRow = Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number];

async function resolveActiveHrApproverHrIds(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", ["HR Manager", "Super Admin"])
    .eq("is_active", true);
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id?: string | null }>)
    .map((row) => cleanHrId(row.hr_id ?? ""))
    .filter(Boolean);
}

function cairoDate() {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function cleanHrId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function employeeDirectoryByHrId(rows: EmployeeDirectoryRow[]) {
  const entries: Array<[string, EmployeeDirectoryRow]> = [];
  for (const row of rows) {
    const hrId = cleanHrId(row.hrId);
    if (hrId) entries.push([hrId, row]);
  }
  return new Map(entries);
}

function managerOf(employee: EmployeeDirectoryRow | null | undefined, employeesByHrId: Map<string, EmployeeDirectoryRow>) {
  const managerHrId = cleanHrId(employee?.managerHrId);
  return managerHrId ? employeesByHrId.get(managerHrId) ?? null : null;
}

function workflowApproverHrIdsForEmployee(employee: EmployeeDirectoryRow, employeesByHrId: Map<string, EmployeeDirectoryRow>, hrApproverHrIds: string[]) {
  const directManager = managerOf(employee, employeesByHrId);
  const managerOfManager = managerOf(directManager, employeesByHrId);
  return Array.from(new Set([
    cleanHrId(managerOfManager?.hrId),
    ...hrApproverHrIds,
  ].filter(Boolean)));
}

export async function runContractRenewalNotifications(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Contract renewal notification run is not authorized." }, { status: 401 });
  }

  const runDate = cairoDate();
  const candidates = await getContractRenewalReminderCandidates([
    lifecycleRiskWindows.contractUpcomingDays,
    lifecycleRiskWindows.contractRiskDays,
    lifecycleRiskWindows.contractCriticalDays,
    0,
  ]);
  const results = [];
  const [directory, hrApproverHrIds] = await Promise.all([
    getEmployeeDirectoryRows(),
    resolveActiveHrApproverHrIds(),
  ]);
  const employeesByHrId = employeeDirectoryByHrId(directory);

  for (const row of candidates) {
    const employee = employeesByHrId.get(cleanHrId(row.hr_id));
    if (!employee) {
      results.push({
        daysUntil: row.daysUntil,
        employeeHrId: row.hr_id,
        result: {
          skipped: true,
          warning: "Contract renewal reminder skipped because the employee could not be resolved in the employee directory.",
        },
      });
      continue;
    }

    const directManager = managerOf(employee, employeesByHrId);
    const managerOfManager = managerOf(directManager, employeesByHrId);
    const workflowApproverHrIds = workflowApproverHrIdsForEmployee(employee, employeesByHrId, hrApproverHrIds);
    const dueText = row.daysUntil === 0 ? "due today" : `due in ${row.daysUntil} days`;
    const actionUrl = "/contracts/renewals";
    const result = await createSystemNotification({
      actionUrl,
      actorId: "system",
      email: {
        employeeHrId: row.hr_id,
        metrics: [
          { label: "Employee", value: `${row.full_name} (${row.hr_id})` },
          { label: "Renewal date", value: row.contract_renewal_date },
          { label: "Reminder", value: dueText },
          { label: "Run date", value: runDate },
        ],
        notificationType: "contract_renewal",
        subject: `Contract Renewal Reminder - ${row.full_name} - ${row.contract_renewal_date}`,
        summary: `Contract renewal for ${row.full_name} is ${dueText}. Pending manager recommendation is required.`,
        // The admin-edited contract_renewal template shows Area/Line/Position; this reminder
        // only sent those values in `metadata`, so the cells rendered blank. Supply them.
        templateContext: {
          area: employee.areaName ?? "—",
          jobTitle: employee.jobTitle ?? "—",
          line: employee.lineName ?? row.line ?? "—",
        },
        title: "Contract Renewal Reminder - Pending Manager Recommendation",
        tone: row.daysUntil <= 7 ? "danger" : "warning",
      },
      eventType: "renewal_reminder",
      message: `Contract renewal for ${row.full_name} is ${dueText}. Pending manager recommendation is required.`,
      metadata: {
        actionUrl,
        area: employee.areaName ?? null,
        department: employee.departmentName ?? null,
        directManagerHrId: cleanHrId(directManager?.hrId) || null,
        employeeName: row.full_name,
        employeeHrId: row.hr_id,
        eventDate: runDate,
        idempotencyKey: `contract-renewal-reminder:${row.hr_id}:${row.contract_renewal_date}:${runDate}`,
        line: employee.lineName ?? row.line ?? null,
        managerName: employee.managerName ?? directManager?.fullName ?? null,
        managerOfManagerHrId: cleanHrId(managerOfManager?.hrId) || null,
        renewalDate: row.contract_renewal_date,
        requestUrl: actionUrl,
        status: "Pending manager recommendation",
        team: employee.teamName ?? null,
        workflowApproverHrIds,
      },
      module: "contract_renewal",
      priority: row.daysUntil <= 7 ? "critical" : "high",
      subjectHrId: row.hr_id,
      title: "Contract Renewal Reminder - Pending Manager Recommendation",
    });

    results.push({ daysUntil: row.daysUntil, employeeHrId: row.hr_id, result });
  }

  const processing = await runScheduledNotificationProcessing(10);

  return NextResponse.json({
    matched: candidates.length,
    processing,
    results,
    runDate,
  });
}

export async function GET(request: Request) {
  // Only authorized cron runs are monitored, so unrelated pings don't record check-ins.
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Contract renewal notification run is not authorized." }, { status: 401 });
  }
  try {
    // NOTE: no Sentry cron monitor here. This sub-route runs in-process from the single
    // daily dispatcher (/api/notifications/daily), which calls
    // runContractRenewalNotifications() directly — never this GET handler — so a per-route
    // monitor would never check in and would raise false missed-run alerts (its "15 4"
    // schedule never matched reality). The dispatcher owns the cron monitor.
    return await runContractRenewalNotifications(request);
  } catch (error) {
    Sentry.captureException(error, { tags: { cron: "contract-renewals" } });
    const message = error instanceof Error ? error.message : "Contract renewal notification run failed.";
    return NextResponse.json({ error: "contract_renewal_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
