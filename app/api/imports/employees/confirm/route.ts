import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { provisionNewHireAccess } from "@/lib/employees/access-provisioning";
import { invalidateEmployeeDirectoryCache } from "@/lib/employees/employee-directory";
import { loadEmployeeImportExistingState } from "@/lib/imports/employee-import-existing-state";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type {
  EmployeeImportRecord,
  EmployeeImportValidationResult,
  OrganizationEntityToCreate,
  RawEmployeeImportRow,
  VacantPositionImportRecord,
} from "@/lib/imports/employee-import-types";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { closeVacancyForOffer } from "@/lib/offers/service";
import { normalizePayrollPaymentMode } from "@/lib/payroll/policy";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  excelCellText,
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { generateVacancySeatCode } from "@/lib/workforce/vacancy-code";
import { shouldCloseVacancyForHire } from "@/lib/workforce/seat-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IdMap = Map<string, number>;
type SupabaseClient = ReturnType<typeof getSupabaseAdmin>;

function truncate(value: string | null, maxLength: number) {
  return value ? value.slice(0, maxLength) : null;
}

function compactCodePart(value: string | null) {
  return value?.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") ?? null;
}

function vacancyCodeFor(record: VacantPositionImportRecord) {
  return generateVacancySeatCode({
    areaCode: compactCodePart(record.codes.areaCode),
    departmentCode: compactCodePart(record.codes.departmentCode),
    lineCode: compactCodePart(record.codes.lineCode),
    managerHrId: record.managerHrId,
    positionCode: compactCodePart(record.codes.positionCode),
    positionTitle: record.positionTitle ?? record.jobTitle,
    teamCode: compactCodePart(record.codes.teamCode),
  });
}

async function parseExcelRows(file: File) {
  try {
    const workbook = await loadExcelWorkbook(await file.arrayBuffer());
    const firstSheet = firstExcelWorksheet(workbook);

    if (!firstSheet) {
      return { error: "empty_worksheet" as const };
    }

    let headerRowNumber = 1;
    for (let rowNumber = 1; rowNumber <= Math.min(firstSheet.rowCount, 10); rowNumber += 1) {
      const row = firstSheet.getRow(rowNumber);
      const values = Array.from({ length: firstSheet.columnCount }, (_, index) =>
        excelCellText(row.getCell(index + 1).value).toLowerCase(),
      );

      if (
        values.some((value) => ["employee id", "hr_id", "hr id", "employee code"].includes(value)) &&
        values.some((value) => value === "full name")
      ) {
        headerRowNumber = rowNumber;
        break;
      }
    }

    const rows = excelWorksheetToJsonRows(firstSheet, headerRowNumber, {
      defaultValue: null,
    }) as RawEmployeeImportRow[];

    if (rows.length === 0) {
      return { error: "empty_worksheet" as const };
    }

    return { firstDataRowNumber: headerRowNumber + 1, rows };
  } catch {
    return { error: "invalid_excel_file" as const };
  }
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

async function upsertTeams(
  supabase: SupabaseClient,
  entities: OrganizationEntityToCreate[],
  areaIds: IdMap,
) {
  if (entities.length === 0) {
    return { created: 0, ids: new Map<string, number>() };
  }

  const codes = codesFor(entities);
  const existingCodes = await existingCodeSet(supabase, "teams", codes);
  const existingIds = await idsForCodes(supabase, "teams", codes);
  const now = new Date().toISOString();
  let created = 0;

  for (const entity of entities) {
    const areaId = entity.parentCode ? areaIds.get(entity.parentCode) ?? null : null;
    const payload = {
      area_id: areaId,
      code: entity.code,
      is_active: true,
      name: truncate(entity.name, 160) ?? entity.code,
      updated_at: now,
    };
    const existingId = existingIds.get(entity.code);

    if (existingId) {
      const { error } = await supabase
        .from("teams")
        .update(payload)
        .eq("id", existingId);

      if (error) {
        throw new Error(error.message);
      }

      continue;
    }

    const { error } = await supabase.from("teams").insert(payload);

    if (error) {
      throw new Error(error.message);
    }

    created += existingCodes.has(entity.code) ? 0 : 1;
  }

  return {
    created,
    ids: await idsForCodes(supabase, "teams", codes),
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
    teamIds: IdMap;
  },
) {
  const values = {
    full_name: truncate(record.fullName, 220) ?? record.hrId ?? "Unknown",
    hr_id: record.hrId as string,
    organogram_visible: true,
    payroll_eligible: true,
    updated_at: new Date().toISOString(),
    ...(record.birthDate ? { birth_date: record.birthDate } : {}),
    ...(record.codes.areaCode && ids.areaIds.has(record.codes.areaCode)
      ? { area_id: ids.areaIds.get(record.codes.areaCode) }
      : {}),
    ...(record.codes.departmentCode && ids.departmentIds.has(record.codes.departmentCode)
      ? { department_id: ids.departmentIds.get(record.codes.departmentCode) }
      : {}),
    ...(record.codes.lineCode && ids.lineIds.has(record.codes.lineCode)
      ? { line_id: ids.lineIds.get(record.codes.lineCode) }
      : {}),
    ...(record.codes.positionCode && ids.positionIds.has(record.codes.positionCode)
      ? { position_id: ids.positionIds.get(record.codes.positionCode) }
      : {}),
    ...(record.codes.teamCode && ids.teamIds.has(record.codes.teamCode)
      ? { team_id: ids.teamIds.get(record.codes.teamCode) }
      : {}),
    ...(record.crmId ? { crm_id: truncate(record.crmId, 80) } : {}),
    ...(record.crmUsername ? { crm_username: truncate(record.crmUsername, 160) } : {}),
    ...(record.education ? { education: truncate(record.education, 160) } : {}),
    ...(record.employmentStatus ? { employment_status: record.employmentStatus } : {}),
    ...(record.hireDate ? { hire_date: record.hireDate } : {}),
    ...(record.jobTitle ? { job_title: truncate(record.jobTitle, 160) } : {}),
    ...(record.mobileNumber ? { mobile_number: truncate(record.mobileNumber, 40) } : {}),
    ...(record.nameAr ? { name_ar: truncate(record.nameAr, 220) } : {}),
    ...(record.regionName ? { region_name: truncate(record.regionName, 160) } : {}),
    ...(record.workEmail ? { work_email: truncate(record.workEmail, 255) } : {}),
  };

  return {
    ...values,
    ...(record.hasBankAccount ? { has_bank_account: record.hasBankAccount } : {}),
    ...(record.bankName ? { bank_name: truncate(record.bankName, 120) } : {}),
    ...(record.bankAccount ? { bank_account: truncate(record.bankAccount, 120) } : {}),
    ...(record.compensation.baseSalary !== null ? { base_salary: record.compensation.baseSalary } : {}),
    ...(record.compensation.basicSalary !== null ? { basic_salary: record.compensation.basicSalary } : {}),
    ...(record.compensation.extraCostOfLiving !== null
      ? { extra_cost_of_living: record.compensation.extraCostOfLiving }
      : {}),
    ...(record.compensation.fuelAllowance !== null ? { fuel_allowance: record.compensation.fuelAllowance } : {}),
    ...(record.compensation.grossSalary !== null ? { gross_salary: record.compensation.grossSalary } : {}),
    ...(record.compensation.medicalInsurance !== null
      ? { medical_insurance: record.compensation.medicalInsurance }
      : {}),
    ...(record.compensation.netSalary !== null ? { net_salary: record.compensation.netSalary } : {}),
    ...(record.compensation.paymentMode ? { payment_mode: normalizePayrollPaymentMode(record.compensation.paymentMode) } : {}),
    ...(record.compensation.socialInsurance !== null
      ? { social_insurance: record.compensation.socialInsurance }
      : {}),
    ...(record.compensation.taxes !== null ? { taxes: record.compensation.taxes } : {}),
    ...(record.contractType ? { contract_type: truncate(record.contractType, 80) } : {}),
    ...(record.gender ? { gender: truncate(record.gender, 40) } : {}),
    ...(record.medicalInsuranceStatus ? { medical_insurance_status: record.medicalInsuranceStatus } : {}),
    ...(record.medicalInsuranceNumber
      ? { medical_insurance_number: truncate(record.medicalInsuranceNumber, 120) }
      : {}),
    ...(record.nationalId ? { national_id: truncate(record.nationalId, 120) } : {}),
    ...(record.residenceAddress ? { residence_address: truncate(record.residenceAddress, 500) } : {}),
    ...(record.residenceArea ? { residence_area: truncate(record.residenceArea, 160) } : {}),
    ...(record.residenceCity ? { residence_city: truncate(record.residenceCity, 160) } : {}),
    ...(record.socialInsuranceStatus ? { social_insurance_status: record.socialInsuranceStatus } : {}),
    ...(record.socialInsuranceNumber
      ? { social_insurance_number: truncate(record.socialInsuranceNumber, 120) }
      : {}),
  };
}

function departmentCodesForRecords(records: EmployeeImportRecord[]) {
  return Array.from(
    new Set(
      records.flatMap((record) =>
        record.codes.departmentCode ? [record.codes.departmentCode] : [],
      ),
    ),
  );
}

function recordCodesFor(
  records: EmployeeImportRecord[],
  key: keyof EmployeeImportRecord["codes"],
) {
  return Array.from(
    new Set(
      records.flatMap((record) => {
        const code = record.codes[key];
        return code ? [code] : [];
      }),
    ),
  );
}

function hasResidence(record: EmployeeImportRecord) {
  return Boolean(record.residenceAddress || record.residenceCity || record.residenceArea);
}

function residenceValues(record: EmployeeImportRecord) {
  return {
    employee_hr_id: record.hrId as string,
    geocode_status: record.residenceAddress ? "pending_import_review" : "missing_address",
    residence_address: truncate(record.residenceAddress, 500),
    residence_area: truncate(record.residenceArea, 160),
    residence_city: truncate(record.residenceCity, 160),
    updated_at: new Date().toISOString(),
  };
}

function isMissingOptionalEmployeeColumn(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("birth_date") ||
    message.includes("bank_account") ||
    message.includes("bank_name") ||
    message.includes("base_salary") ||
    message.includes("basic_salary") ||
    message.includes("contract_type") ||
    message.includes("employment_status") ||
    message.includes("extra_cost_of_living") ||
    message.includes("fuel_allowance") ||
    message.includes("gender") ||
    message.includes("gross_salary") ||
    message.includes("medical_insurance_number") ||
    message.includes("medical_insurance") ||
    message.includes("national_id") ||
    message.includes("net_salary") ||
    message.includes("organogram_visible") ||
    message.includes("payment_mode") ||
    message.includes("payroll_eligible") ||
    message.includes("region_name") ||
    message.includes("residence_address") ||
    message.includes("residence_area") ||
    message.includes("residence_city") ||
    message.includes("social_insurance") ||
    message.includes("social_insurance_number") ||
    message.includes("taxes") ||
    message.includes("team_id") ||
    message.includes("schema cache")
  );
}

function withoutOptionalEmployeeColumns(values: ReturnType<typeof employeeValues>) {
  const {
    bank_account,
    bank_name,
    base_salary,
    basic_salary,
    birth_date,
    contract_type,
    employment_status,
    extra_cost_of_living,
    fuel_allowance,
    gender,
    gross_salary,
    medical_insurance,
    medical_insurance_number,
    national_id,
    net_salary,
    organogram_visible,
    payment_mode,
    payroll_eligible,
    region_name,
    residence_address,
    residence_area,
    residence_city,
    social_insurance,
    social_insurance_number,
    taxes,
    team_id,
    ...rest
  } = values;

  void bank_account;
  void bank_name;
  void base_salary;
  void basic_salary;
  void birth_date;
  void contract_type;
  void employment_status;
  void extra_cost_of_living;
  void fuel_allowance;
  void gender;
  void gross_salary;
  void medical_insurance;
  void medical_insurance_number;
  void national_id;
  void net_salary;
  void organogram_visible;
  void payment_mode;
  void payroll_eligible;
  void region_name;
  void residence_address;
  void residence_area;
  void residence_city;
  void social_insurance;
  void social_insurance_number;
  void taxes;
  void team_id;

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
    teamIds: IdMap;
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
    employee_hr_id: record.hrId as string,
    updated_at: new Date().toISOString(),
    ...(record.compensation.extraCostOfLiving !== null
      ? { extra_cost_of_living: record.compensation.extraCostOfLiving }
      : {}),
    ...(record.compensation.fuelAllowance !== null ? { fuel_allowance: record.compensation.fuelAllowance } : {}),
    ...(record.compensation.grossSalary !== null ? { gross_salary: record.compensation.grossSalary } : {}),
    ...(record.compensation.medicalInsurance !== null
      ? { medical_insurance: record.compensation.medicalInsurance }
      : {}),
    ...(record.compensation.netSalary !== null ? { net_salary: record.compensation.netSalary } : {}),
    ...(record.compensation.paymentMode ? { payment_mode: normalizePayrollPaymentMode(record.compensation.paymentMode) } : {}),
    ...(record.compensation.socialInsurance !== null
      ? { social_insurance: record.compensation.socialInsurance }
      : {}),
    ...(record.compensation.taxes !== null ? { taxes: record.compensation.taxes } : {}),
  };
}

function isMissingPaymentModeColumn(error: unknown) {
  const message = errorMessage(error).toLowerCase();

  return (
    message.includes("payment_mode") ||
    message.includes("schema cache")
  );
}

function withoutPaymentModeColumn(values: ReturnType<typeof compensationValues>) {
  const { payment_mode, ...rest } = values;

  void payment_mode;

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

async function upsertEmployeeResidenceLocations(
  supabase: SupabaseClient,
  records: EmployeeImportRecord[],
) {
  const residenceRecords = records.filter(
    (record) => record.hrId && hasResidence(record),
  );

  if (residenceRecords.length === 0) {
    return { upserted: 0 };
  }

  const { error } = await supabase.from("employee_locations").upsert(
    residenceRecords.map(residenceValues),
    { onConflict: "employee_hr_id" },
  );

  if (error) {
    if (isDatabaseSchemaMissing(error)) {
      return { upserted: 0 };
    }

    throw new Error(error.message);
  }

  return { upserted: residenceRecords.length };
}

async function closeVacanciesForImportedEmployees(
  records: EmployeeImportRecord[],
  ids: {
    areaIds: IdMap;
    lineIds: IdMap;
    positionIds: IdMap;
  },
) {
  let closed = 0;

  for (const record of records) {
    const areaId = record.codes.areaCode ? ids.areaIds.get(record.codes.areaCode) ?? null : null;
    const lineId = record.codes.lineCode ? ids.lineIds.get(record.codes.lineCode) ?? null : null;
    const positionId = record.codes.positionCode ? ids.positionIds.get(record.codes.positionCode) ?? null : null;

    if (
      !record.hrId ||
      !shouldCloseVacancyForHire({
        areaId,
        employmentStatus: record.employmentStatus,
        lineId,
        managerHrId: record.managerHrId,
        positionId,
      })
    ) {
      continue;
    }

    const closedVacancy = await closeVacancyForOffer({
      area_id: areaId,
      filled_by_hr_id: record.hrId,
      line_id: lineId,
      manager_hr_id: record.managerHrId,
      position_id: positionId,
    });

    if (closedVacancy) {
      closed += 1;
    }
  }

  return { closed };
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

  const uniqueRecords = Array.from(
    new Map(records.map((record) => [vacancyCodeFor(record), record])).values(),
  );
  const vacancyCodes = uniqueRecords.map(vacancyCodeFor);
  const existingCodes = await existingVacancyCodes(supabase, vacancyCodes);
  const { error } = await supabase.from("position_vacancies").upsert(
    uniqueRecords.map((record) => vacancyValues(record, ids)),
    { onConflict: "vacancy_code" },
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    created: uniqueRecords.filter((record) => !existingCodes.has(vacancyCodeFor(record)))
      .length,
    recorded: records.length,
    updated: uniqueRecords.filter((record) => existingCodes.has(vacancyCodeFor(record)))
      .length,
  };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "imports", "import");

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_excel_file",
      emptyMessage: "Employee import file is empty.",
      tooLargeError: "employee_import_file_too_large",
      tooLargeMessage: "Employee import file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload an employee import Excel file in .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ error: fileValidation.error, message: fileValidation.message }, { status: fileValidation.status });
    }

    const parsed = await parseExcelRows(file);

    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const existingState = await loadEmployeeImportExistingState(supabase);
    const dryRunResult = createEmployeeImportPlan(parsed.rows, {
      existingState,
      firstDataRowNumber: parsed.firstDataRowNumber,
    });

    if (shouldRejectImport(dryRunResult)) {
      return NextResponse.json(validationRejection(dryRunResult), {
        status: 400,
      });
    }

    const importRecords = [
      ...dryRunResult.rowsToInsert,
      ...dryRunResult.rowsToUpdate,
      ...dryRunResult.vacantPositionsToCreate,
    ];
    const departmentResult = await upsertDepartments(
      supabase,
      dryRunResult.organizationEntitiesToCreate.departments,
    );
    const departmentIds = await idsForCodes(
      supabase,
      "departments",
      departmentCodesForRecords(importRecords),
    );
    const lineResult = await upsertLines(
      supabase,
      dryRunResult.organizationEntitiesToCreate.lines,
      departmentIds,
    );
    const lineIds = await idsForCodes(
      supabase,
      "lines",
      recordCodesFor(importRecords, "lineCode"),
    );
    const areaResult = await upsertAreas(
      supabase,
      dryRunResult.organizationEntitiesToCreate.areas,
      lineIds,
    );
    const areaIds = await idsForCodes(
      supabase,
      "areas",
      recordCodesFor(importRecords, "areaCode"),
    );
    const teamResult = await upsertTeams(
      supabase,
      dryRunResult.organizationEntitiesToCreate.teams,
      areaIds,
    );
    const teamIds = await idsForCodes(
      supabase,
      "teams",
      recordCodesFor(importRecords, "teamCode"),
    );
    const positionResult = await upsertPositions(
      supabase,
      dryRunResult.organizationEntitiesToCreate.positions,
      importRecords,
      {
        areaIds,
        departmentIds,
        lineIds,
      },
    );
    const positionIds = await idsForCodes(
      supabase,
      "positions",
      recordCodesFor(importRecords, "positionCode"),
    );
    const employeeResult = await upsertEmployees(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
      {
        areaIds,
        departmentIds,
        lineIds,
        positionIds,
        teamIds,
      },
    );
    const compensationResult = await upsertEmployeeCompensation(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
    );
    const residenceResult = await upsertEmployeeResidenceLocations(
      supabase,
      [...dryRunResult.rowsToInsert, ...dryRunResult.rowsToUpdate],
    );
    const closedVacancyResult = await closeVacanciesForImportedEmployees(
      dryRunResult.rowsToInsert,
      {
        areaIds,
        lineIds,
        positionIds,
      },
    );
    const accessProvisioning = await provisionNewHireAccess({
      actor: { loginId: access.loginId ?? null, role: access.role },
      hrIds: dryRunResult.rowsToInsert.map((record) => record.hrId),
      source: "bulk employee import",
    });
    const vacancyResult = await upsertVacancies(
      supabase,
      dryRunResult.vacantPositionsToCreate,
      {
        areaIds,
        departmentIds,
        lineIds,
        positionIds,
      },
    );

    const response = {
      accessUsersCreated: accessProvisioning.created,
      accessUsersFailed: accessProvisioning.failed,
      accessUsersSkipped: accessProvisioning.skipped,
      createdAreas: areaResult.created,
      createdDepartments: departmentResult.created,
      createdLines: lineResult.created,
      createdPositions: positionResult.created,
      createdTeams: teamResult.created,
      createdVacancies: vacancyResult.created,
      closedVacancies: closedVacancyResult.closed,
      importedEmployees: employeeResult.imported,
      importedCompensationRows: compensationResult.upserted,
      importedResidenceRows: residenceResult.upserted,
      recordedVacancies: vacancyResult.recorded,
      skippedVacantRows: 0,
      updatedEmployees: employeeResult.updated,
      updatedVacancies: vacancyResult.updated,
      userAccessProvisioning: accessProvisioning.results,
      warnings: dryRunResult.validationWarnings,
    };

    await safeSendNotificationEmail({
      ctaHref: "/employees",
      ctaLabel: "Open employee directory",
      metrics: [
        { label: "Imported employees", value: response.importedEmployees },
        { label: "Access users created", value: response.accessUsersCreated },
        { label: "Updated employees", value: response.updatedEmployees },
        { label: "Recorded vacancies", value: response.recordedVacancies },
        { label: "Closed vacancies", value: response.closedVacancies },
        { label: "Warnings", value: response.warnings.length },
      ],
      notificationType: "general",
      subject: `Phoenix employee import completed - ${file.name}`,
      summary: "An employee import was confirmed and written to the workforce directory.",
      title: "Employee Import Completed",
      tone: response.warnings.length > 0 ? "warning" : "success",
    });

    invalidateEmployeeDirectoryCache();

    return NextResponse.json(response);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to import employees." }, { status: 403 });
    }

    return confirmFailureResponse(error);
  }
}
