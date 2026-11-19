import { NextResponse } from "next/server";

import { approvalsApiError, approvalsWhatsAppForbidden } from "@/app/api/admin/approvals-whatsapp/_lib/http";
import { resolveAccessContext } from "@/lib/auth/server";
import { formatApprovalsPhone } from "@/lib/approvals-whatsapp/rules";
import { loadApprovalsEmployees } from "@/lib/approvals-whatsapp/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The employee master as the bulk-send picker needs it: name, number on file (or none), department, manager, area,
 * region, job title and whether the person is still employed. Filtering happens on the screen, over this one read.
 * Super Admin only.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const forbidden = approvalsWhatsAppForbidden(access);
    if (forbidden) return forbidden;
    const employees = await loadApprovalsEmployees();
    return NextResponse.json({
      employees: employees
        .map((employee) => ({
          active: employee.active,
          area: employee.areaName,
          department: employee.departmentName,
          hrId: employee.hrId,
          jobTitle: employee.jobTitle,
          managerHrId: employee.managerHrId,
          managerName: employee.managerName,
          name: employee.name,
          phone: formatApprovalsPhone(employee.waId),
          region: employee.regionName,
          waId: employee.waId,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    return approvalsApiError(error, "Failed to load the employees.");
  }
}
