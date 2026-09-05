import { NextResponse } from "next/server";

import { assertPermission, filterEmployeeDirectoryForAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  buildEmployeeMasterWorkbook,
  employeeMasterFileName,
  type MasterLookups,
} from "@/lib/employees/employee-master-workbook";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Employee Master export — the same file that serves as the import template.
 *
 * The workbook itself lives in `src/lib/employees/employee-master-workbook.ts`, together with the
 * four constraints the importer places on its shape. This route does the three things a route
 * should do: check permission, resolve the directory to the caller's scope, stream the bytes.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "export");

    const directory = filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access);

    const lines = Array.from(
      new Map(
        (directory.lookups.lines ?? [])
          .filter((line) => line.label)
          .map((line) => [line.label, { id: line.id ?? null, label: line.label }]),
      ).values(),
    ).sort((left, right) => left.label.localeCompare(right.label));

    const lookups: MasterLookups = {
      areas: (directory.lookups.areas ?? [])
        .filter((area) => area.label)
        .map((area) => ({ label: area.label, value: area.value })),
      departments: Array.from(
        new Set(directory.lookups.departments.map((department) => department.label).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right)),
      lines,
      // The managers offered are the ones the upload will accept: active and on_leave only. A
      // resigned manager here would resolve a name in the sheet that the server then refuses.
      managerDirectory: directory.employees
        .filter(
          (employee) =>
            employee.employmentStatus === "active" ||
            employee.employmentStatus === "on_leave" ||
            !employee.employmentStatus,
        )
        .map((employee) => ({ fullName: employee.fullName, hrId: employee.hrId })),
      positions: Array.from(
        new Set((directory.lookups.positions ?? []).map((position) => position.label).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right)),
      teams: (directory.lookups.teams ?? [])
        .filter((team) => team.label)
        .map((team) => ({ areaId: team.areaId ?? null, label: team.label })),
    };

    const workbook = await buildEmployeeMasterWorkbook({
      employees: directory.employees,
      lookups,
      scopeNote: "Scoped to your access",
    });

    const buffer = await workbook.xlsx.writeBuffer();

    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${employeeMasterFileName()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to export employees." },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        error: "employee_export_failed",
        message: clientSafeErrorMessage(error, "Unable to export employee master data."),
      },
      { status: 500 },
    );
  }
}
