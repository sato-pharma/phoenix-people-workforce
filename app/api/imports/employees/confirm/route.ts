import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type {
  EmployeeImportRecord,
  EmployeeImportValidationResult,
  OrganizationEntityToCreate,
  RawEmployeeImportRow,
  VacantPositionImportRecord,
} from "@/lib/imports/employee-import-types";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { normalizePayrollPaymentMode } from "@/lib/payroll/policy";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_EXTENSIONS = new Set([".xls", ".xlsx"]);
const SUPPORTED_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

type IdMap = Map<string, number>;
type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");

  if (dotIndex === -1) {
    return "";
  }

  return fileName.slice(dotIndex).toLowerCase();
}

function isSupportedExcelFile(file: File) {
  const extension = getFileExtension(file.name);
  const mimeType = file.type.toLowerCase();

  return (
    SUPPORTED_EXTENSIONS.has(extension) ||
    (mimeType.length > 0 && SUPPORTED_MIME_TYPES.has(mimeType))
  );
}

function truncate(value: string | null, maxLength: number) {
  return value ? value.slice(0, maxLength) : null;
}

function compactCodePart(value: string | null) {
  return value?.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") ?? null;
}

function vacancyCodeFor(record: VacantPositionImportRecord) {
  const parts = [
    "vacancy",
    compactCodePart(record.hrId) ?? String(record.rowNumber),
    compactCodePart(record.codes.departmentCode),
    compactCodePart(record.codes.lineCode),
    compactCodePart(record.codes.areaCode),
    compactCodePart(record.codes.positionCode),
  ].filter(Boolean);

  return parts.join("_").slice(0, 160);
}

async function parseExcelRows(file: File) {
  if (!isSupportedExcelFile(file)) {
    return { error: "unsupported_format" as const };
  }

  if (file.size === 0) {
    return { error: "invalid_excel_file" as const };
  }

  let workbook: XLSX.WorkBook;

  try {
    workbook = XLSX.read(await file.arrayBuffer(), {
      cellDates: true,
      type: "array",
    });
  } catch {
    return { error: "invalid_excel_file" as const };
  }

  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return { error: "empty_worksheet" as const };
  }

  const firstSheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<RawEmployeeImportRow>(firstSheet, {
    defval: null,
  });

  if (rows.length === 0) {
    return { error: "empty_worksheet" as const };
  }

  return { rows };
}

function shouldRejectImport(result: EmployeeImportValidationResult) {
  return (
    result.failedRows > 0 ||
    result.missingRequiredColumns.length > 0 ||
    result.duplicateHrIds.length > 0
  );
}

function validationRejection(result: EmployeeImportValidationResult) {
  return {
    error: "employee_import_validation_failed",
    failedRows: result.failedRows,
    missingRequiredColumns: result.missingRequiredColumns,
    duplicateHrIds: result.duplicateHrIds,
    validationErrors: result.validationErrors,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isSupabaseEnvMissing(error: unknown) {
  const message = errorMessage(error);

  return (
    message.includes("NEXT_PUBLIC_SUPABASE_URL is required") ||
    message.includes("SUPABASE_SERVICE_ROLE_KEY is required")
  );
}

function isDatabaseSchemaMissing(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("could not find the table") ||
    message.includes("relation") && message.includes("does not exist")
  );
}

function confirmFailureResponse(error: unknown) {
  if (isSupabaseEnvMissing(error)) {
    return NextResponse.json(
      {
        error: "supabase_env_missing",
        message:
          "Supabase environment variables are missing. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local.",
      },
      { status: 409 },
    );
  }

  if (isDatabaseSchemaMissing(error)) {
    return NextResponse.json(
      {
        error: "database_schema_not_ready",
        message:
          "Supabase schema is not ready. Run supabase/phoenix-schema.sql in the Supabase SQL editor.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    { error: "employee_import_confirm_failed", message: errorMessage(error) },
    { status: 500 },
  );
}

function codesFor(entities: OrganizationEntityToCreate[]) {
  return entities.map((entity) => entity.code);
}

async function existingCodeSet(
  supabase: SupabaseClient,
  table: string,
  codes: string[],
) {
  if (codes.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await supabase
    .from(table)
    .select("code")
    .in("code", codes);

  if (error) {
    throw new Error(error.message);
  }

  return new Set(
    ((data ?? []) as Array<{ code: string }>).map((row) => String(row.code)),
  );
}

async function idsForCodes(
  supabase: SupabaseClient,
  table: string,
  codes: string[],
) {
  if (codes.length === 0) {
    return new Map<string, number>();
  }

  const { data, error } = await supabase
    .from(table)
    .select("id, code")
    .in("code", codes);

  if (error) {
    throw new Error(error.message);
  }

  return new Map(
    ((data ?? []) as Array<{ code: string; id: number }>).map((row) => [
      String(row.code),
      Number(row.id),
    ]),
  );
}

async function upsertDepartments(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
) {
  if (entities.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(entities);
  const existingCodes = await existingCodeSet(supabase, "departments", codes);
  const now = new Date().toISOString();
  const { error } = await supabase.from("departments").upsert(
    entities.map((entity) => ({
      code: entity.code,
      name: truncate(entity.name, 160) ?? entity.code,
      updated_at: now,
    })),
    { onConflict: "code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: entities.filter((entity) => !existingCodes.has(entity.code))
      .length,
    ids: await idsForCodes(supabase, "departments", codes),
  };
}

async function upsertLines(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  departmentIds: IdMap,
) {
  const importable = entities.filter(
    (entity) => entity.parentCode && departmentIds.has(entity.parentCode),
  );

  if (importable.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(importable);
  const existingCodes = await existingCodeSet(supabase, "lines", codes);
  const now = new Date().toISOString();
  const { error } = await supabase.from("lines").upsert(
    importable.map((entity) => ({
      code: entity.code,
      department_id: departmentIds.get(entity.parentCode ?? ""),
      name: truncate(entity.name, 160) ?? entity.code,
      updated_at: now,
    })),
    { onConflict: "code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: importable.filter((entity) => !existingCodes.has(entity.code))
      .length,
    ids: await idsForCodes(supabase, "lines", codes),
  };
}

async function upsertAreas(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  lineIds: IdMap,
) {
  const importable = entities.filter(
    (entity) => entity.parentCode && lineIds.has(entity.parentCode),
  );

  if (importable.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(importable);
  const existingCodes = await existingCodeSet(supabase, "areas", codes);
  const now = new Date().toISOString();
  const { error } = await supabase.from("areas").upsert(
    importable.map((entity) => ({
      code: entity.code,
      line_id: lineIds.get(entity.parentCode ?? ""),
      name: truncate(entity.name, 160) ?? entity.code,
      updated_at: now,
    })),
    { onConflict: "code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: importable.filter((entity) => !existingCodes.has(entity.code))
      .length,
    ids: await idsForCodes(supabase, "areas", codes),
  };
}

function positionScopeByCode(records: EmployeeImportRecord[]) {
  const scope = new Map<
    string,
    {
      areaCode: string | null;
      departmentCode: string | null;
      lineCode: string | null;
    }
  >();

  for (const record of records) {
    const positionCode = record.codes.positionCode;

    if (!positionCode || scope.has(positionCode)) {
      continue;
    }

    scope.set(positionCode, {
      areaCode: record.codes.areaCode,
      departmentCode: record.codes.departmentCode,
      lineCode: record.codes.lineCode,
    });
  }

  return scope;
}

async function upsertPositions(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  records: EmployeeImportRecord[],
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
  },
) {
  if (entities.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(entities);
  const existingCodes = await existingCodeSet(supabase, "positions", codes);
  const now = new Date().toISOString();
  const scopes = positionScopeByCode(records);
  const { error } = await supabase.from("positions").upsert(
    entities.map((entity) => {
      const scope = scopes.get(entity.code);

      return {
        area_id: scope?.areaCode ? ids.areaIds.get(scope.areaCode) : null,
        code: entity.code,
        department_id: scope?.departmentCode
          ? ids.departmentIds.get(scope.departmentCode)
          : null,
        line_id: scope?.lineCode ? ids.lineIds.get(scope.lineCode) : null,
        title: truncate(entity.name, 160) ?? entity.code,
        updated_at: now,
      };
    }),
    { onConflict: "code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: entities.filter((entity) => !existingCodes.has(entity.code))
      .length,
    ids: await idsForCodes(supabase, "positions", codes),
  };
}

async function existingEmployeeHrIds(
  supabase: SupabaseClient,
  hrIds: string[],
) {
  if (hrIds.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await supabase
    .from("employees")
    .select("hr_id")
    .in("hr_id", hrIds);

  if (error) {
    throw new Error(error.message);
  }

  return new Set(
    ((data ?? []) as Array<{ hr_id: string }>).map((row) =>
      String(row.hr_id),
    ),
  );
}

function employeeValues(
  record: EmployeeImportRecord,
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  return {
    area_id: record.codes.areaCode
      ? ids.areaIds.get(record.codes.areaCode) ?? null
      : null,
    birth_date: record.birthDate,
    crm_id: truncate(record.crmId, 80),
    crm_username: truncate(record.crmUsername, 160),
    department_id: record.codes.departmentCode
      ? ids.departmentIds.get(record.codes.departmentCode) ?? null
      : null,
    education: truncate(record.education, 160),
    full_name: truncate(record.fullName, 220) ?? record.hrId ?? "Unknown",
    hire_date: record.hireDate,
    hr_id: record.hrId as string,
    job_title: truncate(record.jobTitle, 160),
    line_id: record.codes.lineCode
      ? ids.lineIds.get(record.codes.lineCode) ?? null
      : null,
    manager_hr_id: null,
    mobile_number: truncate(record.mobileNumber, 40),
    name_ar: truncate(record.nameAr, 220),
    position_id: record.codes.positionCode
      ? ids.positionIds.get(record.codes.positionCode) ?? null
      : null,
    region_name: truncate(record.regionName, 160),
    updated_at: new Date().toISOString(),
    work_email: truncate(record.workEmail, 255),
  };
}

function isMissingOptionalEmployeeColumn(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("birth_date") ||
    message.includes("region_name") ||
    message.includes("schema cache")
  );
}

function withoutOptionalEmployeeColumns(values: ReturnType<typeof employeeValues>) {
  const { birth_date, region_name, ...rest } = values;

  void birth_date;
  void region_name;

  return rest;
}

async function upsertEmployees(
  supabase: SupabaseClient,
  records: EmployeeImportRecord[],
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  const employeeRecords = records.filter((record) => record.hrId);
  const hrIds = employeeRecords.map((record) => record.hrId as string);
  const existingHrIds = await existingEmployeeHrIds(supabase, hrIds);

  if (employeeRecords.length > 0) {
    const values = employeeRecords.map((record) => employeeValues(record, ids));
    let { error } = await supabase.from("employees").upsert(
      values,
      { onConflict: "hr_id" },
    );

    if (error && isMissingOptionalEmployeeColumn(error)) {
      const retry = await supabase.from("employees").upsert(
        values.map(withoutOptionalEmployeeColumns),
        { onConflict: "hr_id" },
      );
      error = retry.error;
    }

    if (error) {
      throw new Error(error.message);
    }
  }

  const availableEmployees = await existingEmployeeHrIds(supabase, hrIds);

  for (const record of employeeRecords) {
    if (!record.hrId || !record.managerHrId) {
      continue;
    }

    if (!availableEmployees.has(record.managerHrId)) {
      continue;
    }

    const { error } = await supabase
      .from("employees")
      .update({
        manager_hr_id: record.managerHrId,
        updated_at: new Date().toISOString(),
      })
      .eq("hr_id", record.hrId);

    if (error) {
      throw new Error(error.message);
    }
  }

  return {
    imported: employeeRecords.filter(
      (record) => record.hrId && !existingHrIds.has(record.hrId),
    ).length,
    updated: employeeRecords.filter(
      (record) => record.hrId && existingHrIds.has(record.hrId),
    ).length,
  };
}

function hasCompensation(record: EmployeeImportRecord) {
  return Object.values(record.compensation).some((value) => value !== null);
}

function compensationValues(record: EmployeeImportRecord) {
  return {
    comprehensive_wage: record.compensation.comprehensiveWage,
    employee_hr_id: record.hrId as string,
    extra_cost_of_living: record.compensation.extraCostOfLiving,
    fuel_allowance: record.compensation.fuelAllowance,
    gross_salary: record.compensation.grossSalary,
    medical_insurance: record.compensation.medicalInsurance,
    net_salary: record.compensation.netSalary,
    ...(record.compensation.paymentMode
      ? { payment_mode: normalizePayrollPaymentMode(record.compensation.paymentMode) }
      : {}),
    social_insurance: record.compensation.socialInsurance,
    subscription_wage: record.compensation.subscriptionWage,
    taxes: record.compensation.taxes,
    updated_at: new Date().toISOString(),
  };
}

function isMissingPaymentModeColumn(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return message.includes("payment_mode") || message.includes("schema cache");
}

function withoutPaymentModeColumn(values: ReturnType<typeof compensationValues>) {
  const rest = { ...values };
  delete rest.payment_mode;

  return rest;
}

async function upsertEmployeeCompensation(
  supabase: SupabaseClient,
  records: EmployeeImportRecord[],
) {
  const compensationRecords = records.filter(
    (record) => record.hrId && hasCompensation(record),
  );

  if (compensationRecords.length === 0) {
    return { upserted: 0 };
  }

  const values = compensationRecords.map(compensationValues);
  let { error } = await supabase.from("employee_compensation").upsert(
    values,
    { onConflict: "employee_hr_id" },
  );

  if (error && isMissingPaymentModeColumn(error)) {
    const retry = await supabase.from("employee_compensation").upsert(
      values.map(withoutPaymentModeColumn),
      { onConflict: "employee_hr_id" },
    );
    error = retry.error;
  }

  if (error) {
    throw new Error(error.message);
  }

  return { upserted: compensationRecords.length };
}

async function existingVacancyCodes(
  supabase: SupabaseClient,
  vacancyCodes: string[],
) {
  if (vacancyCodes.length === 0) {
    return new Set<string>();
  }

  const { data, error } = await supabase
    .from("position_vacancies")
    .select("vacancy_code")
    .in("vacancy_code", vacancyCodes);

  if (error) {
    throw new Error(error.message);
  }

  return new Set(
    ((data ?? []) as Array<{ vacancy_code: string }>).map((row) =>
      String(row.vacancy_code),
    ),
  );
}

function vacancyValues(
  record: VacantPositionImportRecord,
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  return {
    area_id: record.codes.areaCode
      ? ids.areaIds.get(record.codes.areaCode) ?? null
      : null,
    department_id: record.codes.departmentCode
      ? ids.departmentIds.get(record.codes.departmentCode) ?? null
      : null,
    job_title: truncate(record.jobTitle ?? record.positionTitle, 160),
    line_id: record.codes.lineCode
      ? ids.lineIds.get(record.codes.lineCode) ?? null
      : null,
    manager_hr_id: truncate(record.managerHrId, 80),
    manager_name: truncate(record.managerName, 220),
    note: "Imported from employee master data row without HR_ID.",
    position_id: record.codes.positionCode
      ? ids.positionIds.get(record.codes.positionCode) ?? null
      : null,
    region_name: truncate(record.regionName, 160),
    source_row_number: record.rowNumber,
    status: "open",
    updated_at: new Date().toISOString(),
    vacancy_code: vacancyCodeFor(record),
  };
}

async function upsertVacancies(
  supabase: SupabaseClient,
  records: VacantPositionImportRecord[],
  ids: {
    areaIds: IdMap;
    departmentIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  if (records.length === 0) {
    return { created: 0, recorded: 0, updated: 0 };
  }

  const vacancyCodes = records.map(vacancyCodeFor);
  const existingCodes = await existingVacancyCodes(supabase, vacancyCodes);
  const { error } = await supabase.from("position_vacancies").upsert(
    records.map((record) => vacancyValues(record, ids)),
    { onConflict: "vacancy_code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: records.filter((record) => !existingCodes.has(vacancyCodeFor(record)))
      .length,
    recorded: records.length,
    updated: records.filter((record) => existingCodes.has(vacancyCodeFor(record)))
      .length,
  };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }

    const parsed = await parseExcelRows(file);

    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const dryRunResult = createEmployeeImportPlan(parsed.rows);

    if (shouldRejectImport(dryRunResult)) {
      return NextResponse.json(validationRejection(dryRunResult), {
        status: 400,
      });
    }

    const supabase = getSupabaseAdmin();
    const importRecords = [
      ...dryRunResult.rowsToInsert,
      ...dryRunResult.rowsToUpdate,
      ...dryRunResult.vacantPositionsToCreate,
    ];
    const departmentResult = await upsertDepartments(
      supabase,
      dryRunResult.organizationEntitiesToCreate.departments,
    );
    const lineResult = await upsertLines(
      supabase,
      dryRunResult.organizationEntitiesToCreate.lines,
      departmentResult.ids,
    );
    const areaResult = await upsertAreas(
      supabase,
      dryRunResult.organizationEntitiesToCreate.areas,
      lineResult.ids,
    );
    const positionResult = await upsertPositions(
      supabase,
      dryRunResult.organizationEntitiesToCreate.positions,
      importRecords,
      {
        areaIds: areaResult.ids,
        departmentIds: departmentResult.ids,
        lineIds: lineResult.ids,
      },
    );
    const employeeResult = await upsertEmployees(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
      {
        areaIds: areaResult.ids,
        departmentIds: departmentResult.ids,
        lineIds: lineResult.ids,
        positionIds: positionResult.ids,
      },
    );
    const compensationResult = await upsertEmployeeCompensation(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
    );
    const vacancyResult = await upsertVacancies(
      supabase,
      dryRunResult.vacantPositionsToCreate,
      {
        areaIds: areaResult.ids,
        departmentIds: departmentResult.ids,
        lineIds: lineResult.ids,
        positionIds: positionResult.ids,
      },
    );

    const response = {
      createdAreas: areaResult.created,
      createdDepartments: departmentResult.created,
      createdLines: lineResult.created,
      createdPositions: positionResult.created,
      createdVacancies: vacancyResult.created,
      importedEmployees: employeeResult.imported,
      importedCompensationRows: compensationResult.upserted,
      recordedVacancies: vacancyResult.recorded,
      skippedVacantRows: 0,
      updatedEmployees: employeeResult.updated,
      updatedVacancies: vacancyResult.updated,
      warnings: dryRunResult.validationWarnings,
    };

    await safeSendNotificationEmail({
      ctaHref: "/employees",
      ctaLabel: "Open employee directory",
      metrics: [
        { label: "Imported employees", value: response.importedEmployees },
        { label: "Updated employees", value: response.updatedEmployees },
        { label: "Recorded vacancies", value: response.recordedVacancies },
        { label: "Warnings", value: response.warnings.length },
      ],
      subject: `Phoenix employee import completed - ${file.name}`,
      summary: "An employee import was confirmed and written to the workforce directory.",
      title: "Employee Import Completed",
      tone: response.warnings.length > 0 ? "warning" : "success",
    });

    return NextResponse.json(response);
  } catch (error) {
    return confirmFailureResponse(error);
  }
}
