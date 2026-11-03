import { NextResponse } from "next/server";

import { canonicalHrIdForDisplay } from "@/lib/hr-id";

import { contractRenewalReminderDaysAhead, getContractRenewalReminderCandidates } from "@/lib/contracts/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { runScheduledNotificationProcessing } from "@/lib/notifications/scheduled-processing";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmployeeDirectoryRow = Awaited<ReturnType<typeof getEmployeeDirectoryRows>>[number];

// The HR seats that OWN a contract renewal, resolved by role rather than by name so the reminder
// follows the seat when the person in it changes. HR Operations is the seat that maintains
// contracts (`contracts: read/create/update/export` in the HR function catalogue) and was added on
// the owner's instruction, 2026-09-29, so the HR Generalist running renewals is told at the same
// time as the manager chain. HR Advisory is deliberately NOT here: her contracts grant is READ_ONLY
// — she advises on a renewal and cannot change one — so a "pending recommendation" reminder is not
// hers to act on.
//
// HR Administration — the HR Operations Specialist seat — joined on 2026-10-20: she tracks the
// renewals and prepares their papers (owner: "track and prepare papers"; `contracts: read/update`
// in her people_master function, every salary withheld). Renewing or not renewing stays his. The
// HR Generalist seat (HR Operations) is empty until a hire, and the Super Admin is already on this
// list, so its reminder still reaches the owner without a stand-in.
const contractRenewalHrApproverRoles = ["Super Admin", "HR Operations", "HR Administration"];

// The last rung of `contractRenewalReminderDaysAhead` is the one that escalates. It moved with the
// ladder: while the rungs were 60/30/7/0 this was 7, and leaving it there after the ladder became
// 75/60/30/15 would have made EVERY reminder a "warning" and none of them critical — the final
// notice would have arrived quieter than the one before it.
const contractRenewalEscalationDays = Math.min(...contractRenewalReminderDaysAhead);

async function resolveActiveHrApproverHrIds(): Promise<string[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("role", contractRenewalHrApproverRoles)
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

function cleanHrId(value: string | null | undefined) {
  return canonicalHrIdForDisplay(value) ?? "";
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
  const denied = assertCronAuthorized(request, "notifications/contract-renewals", {
    message: "Contract renewal notification run is not authorized.",
  });
  if (denied) return denied;

  const runDate = cairoDate();
  const candidates = await getContractRenewalReminderCandidates(contractRenewalReminderDaysAhead);
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
          tone: row.daysUntil <= contractRenewalEscalationDays ? "danger" : "warning",
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
        priority: row.daysUntil <= contractRenewalEscalationDays ? "critical" : "high",
        subjectHrId: row.hr_id,
        title: "Contract Renewal Reminder - Pending Manager Recommendation",
      });

      results.push({ daysUntil: row.daysUntil, employeeHrId: row.hr_id, result });
    } catch (error) {
      console.error(error, { tags: { cron: "contract-renewals", employeeHrId: row.hr_id } });
      results.push({
        daysUntil: row.daysUntil,
        employeeHrId: row.hr_id,
        result: { error: clientSafeErrorMessage(error, "Contract renewal notification failed."), sent: false },
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
  const denied = assertCronAuthorized(request, "notifications/contract-renewals", {
    message: "Contract renewal notification run is not authorized.",
  });
  if (denied) return denied;
  try {
    return await runContractRenewalNotifications(request);
  } catch (error) {
    console.error(error, { tags: { cron: "contract-renewals" } });
    const message = clientSafeErrorMessage(error, "Contract renewal notification run failed.");
    return NextResponse.json({ error: "contract_renewal_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
