import { NextResponse } from "next/server";

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import { assertPermission, canAccess, filterEmployeeDirectoryForAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  buildEmployeeMasterWorkbook,
  employeeMasterFileName,
  type EmployeeMasterHiringDocuments,
  type MasterHiringDocumentCell,
  type MasterLookups,
} from "@/lib/employees/employee-master-workbook";
import { getHiringDocumentsDashboard } from "@/lib/hiring-documents/service";
import { loadSocialInsuranceJobTitles } from "@/lib/hiring-pack/social-insurance-job-title";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The hiring-document checklist, keyed by the HR ids the directory itself uses.
 *
 * NEITHER THIS NOR THE TITLE LOOKUP MAY FAIL THE DOWNLOAD. Both read tables this export does not
 * otherwise touch, and a sheet that 500s because a satellite table is unavailable is strictly worse
 * than one missing a reference block. So each resolves to nothing on error and the workbook renders
 * exactly as it did before these columns existed.
 */
async function loadHiringDocumentColumns(
  employees: EmployeeDirectoryRow[],
): Promise<EmployeeMasterHiringDocuments | undefined> {
  try {
    const dashboard = await getHiringDocumentsDashboard();
    if (dashboard.documents.length === 0) return undefined;

    // Matched on the CANONICAL key, not the raw id: the checklist normalizes its HR ids and the
    // directory does not, so a case difference would silently empty every document column.
    const byKey = new Map<string, Map<string, MasterHiringDocumentCell>>();
    for (const employee of dashboard.employees) {
      const key = canonicalHrIdKey(employee.hrId);
      if (!key) continue;
      const cells = new Map<string, MasterHiringDocumentCell>();
      for (const [documentId, entry] of Object.entries(employee.documents)) {
        cells.set(documentId, { fileCount: entry.fileCount, status: entry.status });
      }
      byKey.set(key, cells);
    }

    const byHrId = new Map<string, Map<string, MasterHiringDocumentCell>>();
    for (const employee of employees) {
      const cells = byKey.get(canonicalHrIdKey(employee.hrId) ?? "");
      if (cells) byHrId.set(employee.hrId, cells);
    }

    return {
      byHrId,
      // The group travels with the definition: the sheet draws one section band per group, and a
      // definition arriving without one would split its band in two.
      definitions: dashboard.documents.map((document) => ({
        group: document.documentGroup,
        id: document.id,
        name: document.name,
        sheetHeader: document.sheetHeader,
      })),
    };
  } catch (error) {
    console.log("Employee Master export could not read the hiring-document checklist", {
      level: "warning",
      tags: { action: "loadHiringDocumentColumns", component: "employee-master-export" },
      extra: { message: clientSafeErrorMessage(error, "unknown") },
    });
    return undefined;
  }
}

async function loadInsuranceJobTitles(employees: EmployeeDirectoryRow[]) {
  try {
    return await loadSocialInsuranceJobTitles(employees.map((employee) => employee.hrId));
  } catch (error) {
    console.log("Employee Master export could not read the social insurance job titles", {
      level: "warning",
      tags: { action: "loadInsuranceJobTitles", component: "employee-master-export" },
      extra: { message: clientSafeErrorMessage(error, "unknown") },
    });
    return undefined;
  }
}

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

    const [hiringDocuments, socialInsuranceJobTitles] = await Promise.all([
      loadHiringDocumentColumns(directory.employees),
      loadInsuranceJobTitles(directory.employees),
    ]);

    // The seat that never sees a salary exports the master "with no salary" (owner, 2026-10-20):
    // every money column stays in place — hidden, locked and empty — so the column letters the
    // importer reads never move, and nothing in the file, its guidance or its row check names a
    // figure. Its Start Here and Upload Rules also stop offering to add people when the seat
    // cannot create one. Both decided here, from the server's access context.
    const omitMoney = isSalaryBlindRole(access.role);
    const canCreate = await canAccess(access, "employees", "create");

    const workbook = await buildEmployeeMasterWorkbook({
      canCreate,
      employees: directory.employees,
      hiringDocuments,
      lookups,
      omitMoney,
      scopeNote: "Scoped to your access",
      socialInsuranceJobTitles,
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
