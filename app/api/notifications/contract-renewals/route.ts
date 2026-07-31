import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/config/system-settings";

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
    .in("role", ["Super Admin"])
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
  // Every Vercel environment (production, preview, `vercel dev`) sets VERCEL — only a
  // real local machine without it may bypass an unset CRON_SECRET during development.
  if (!secret) return !isProductionRuntime();
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
    // "/contracts" is the real Contract Renewal page (app/(admin)/contracts/page.tsx); the
    // page itself redirects any viewer lacking the "contracts" permission to /employee-portals
    // instead of erroring. "/contracts/renewals" never existed as a route and 404'd for everyone.
    const actionUrl = "/contracts";
    // Isolated per employee: one bad send (e.g. a transient email/network error) must not abort
    // the loop and skip every remaining employee's contract-renewal reminder for today.
    try {
      const result = await createSystemNotification({
        actionUrl,
        actorId: "system",
        email: {
          employeeHrId: row.hr_id,
          metrics: [
            { label: "Employee", value: `${employee.displayName} (${row.hr_id})` },
            { label: "Job Title", value: employee.jobTitle ?? "" },
            { label: "Area", value: employee.areaName ?? "" },
            { label: "Line", value: employee.lineName ?? row.line ?? "" },
            { label: "Renewal date", value: row.contract_renewal_date },
            { label: "Reminder", value: dueText },
            { label: "Run date", value: runDate },
          ],
          notificationType: "contract_renewal",
          subject: `Contract Renewal Reminder - ${employee.displayName} - ${row.contract_renewal_date}`,
          summary: `Contract renewal for ${employee.displayName} is ${dueText}. Pending manager recommendation is required.`,
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
        message: `Contract renewal for ${employee.displayName} is ${dueText}. Pending manager recommendation is required.`,
        metadata: {
          actionUrl,
          area: employee.areaName ?? null,
          department: employee.departmentName ?? null,
          directManagerHrId: cleanHrId(directManager?.hrId) || null,
          employeeName: employee.displayName,
          employeeHrId: row.hr_id,
          eventDate: runDate,
          idempotencyKey: `contract-renewal-reminder:${row.hr_id}:${row.contract_renewal_date}:${runDate}`,
          line: employee.lineName ?? row.line ?? null,
          managerName: employee.managerName ?? directManager?.displayName ?? null,
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
    } catch (error) {
      console.error(error, { tags: { cron: "contract-renewals", employeeHrId: row.hr_id } });
      results.push({
        daysUntil: row.daysUntil,
        employeeHrId: row.hr_id,
        result: { error: error instanceof Error ? error.message : String(error), sent: false },
      });
    }
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
    return await runContractRenewalNotifications(request);
  } catch (error) {
    console.error(error, { tags: { cron: "contract-renewals" } });
    const message = error instanceof Error ? error.message : "Contract renewal notification run failed.";
    return NextResponse.json({ error: "contract_renewal_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
