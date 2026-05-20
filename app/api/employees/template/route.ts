import ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { assertPermission, filterEmployeeDirectoryForAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveEmployeeMasterExportSalary } from "@/lib/employees/employee-master-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportColumn = {
  header: string;
  key: keyof ExportRow;
  section: string;
  width?: number;
};

type ExportRow = {
  employeeId: string;
  fullName: string;
  arabicName: string | null;
  nationalId: string | null;
  gender: string | null;
  birthDate: string | null;
  department: string | null;
  line: string | null;
  area: string | null;
  team: string | null;
  jobTitle: string | null;
  position: string | null;
  directManagerId: string | null;
  directManagerName: string | null;
  hireDate: string | null;
  employmentStatus: string | null;
  contractType: string | null;
  workEmail: string | null;
  mobileNumber: string | null;
  residenceAddress: string | null;
  residenceCity: string | null;
  residenceArea: string | null;
  crmId: string | null;
  crmUsername: string | null;
  education: string | null;
  hasBankAccount: string | null;
  bankName: string | null;
  bankAccount: string | null;
  socialInsuranceStatus: string | null;
  socialInsuranceNumber: string | null;
  medicalInsuranceStatus: string | null;
  medicalInsuranceNumber: string | null;
  basicSalary: number | null;
  baseSalary: number | null;
  netSalary: number | null;
  socialInsurance: number | null;
  taxes: number | null;
  medicalInsurance: number | null;
  fuelAllowance: number | null;
  extraCostOfLiving: number | null;
  grossSalary: number | null;
  paymentMode: string;
  payrollEligible: string;
  organogramVisible: string;
  region: string | null;
  lastUpdated: string;
};

const columns: ExportColumn[] = [
  { header: "Employee ID", key: "employeeId", section: "Identity", width: 16 },
  { header: "Full Name", key: "fullName", section: "Identity", width: 28 },
  { header: "Arabic Name", key: "arabicName", section: "Identity", width: 24 },
  { header: "National ID", key: "nationalId", section: "Identity", width: 20 },
  { header: "Gender", key: "gender", section: "Identity", width: 14 },
  { header: "Birth Date", key: "birthDate", section: "Identity", width: 14 },
  { header: "Department", key: "department", section: "Organization", width: 22 },
  { header: "Line", key: "line", section: "Organization", width: 20 },
  { header: "Area", key: "area", section: "Organization", width: 22 },
  { header: "Team", key: "team", section: "Organization", width: 18 },
  { header: "Title", key: "jobTitle", section: "Organization", width: 24 },
  { header: "Position", key: "position", section: "Organization", width: 24 },
  { header: "Direct Manager", key: "directManagerName", section: "Organization", width: 28 },
  { header: "Manager HR_ID", key: "directManagerId", section: "Organization", width: 18 },
  { header: "Hiring Date", key: "hireDate", section: "Organization", width: 14 },
  { header: "Employment Status", key: "employmentStatus", section: "Organization", width: 18 },
  { header: "Contract Type", key: "contractType", section: "Organization", width: 18 },
  { header: "Email", key: "workEmail", section: "Contact & Residence", width: 30 },
  { header: "Phone", key: "mobileNumber", section: "Contact & Residence", width: 18 },
  { header: "Residence Address", key: "residenceAddress", section: "Contact & Residence", width: 36 },
  { header: "Residence City", key: "residenceCity", section: "Contact & Residence", width: 18 },
  { header: "Residence Area", key: "residenceArea", section: "Contact & Residence", width: 18 },
  { header: "CRM ID", key: "crmId", section: "CRM", width: 16 },
  { header: "CRM Username", key: "crmUsername", section: "CRM", width: 20 },
  { header: "Basic Salary", key: "basicSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Base Salary", key: "baseSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Gross Salary", key: "grossSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Net Salary", key: "netSalary", section: "Payroll Reference Information", width: 16 },
  { header: "Fuel Allowance", key: "fuelAllowance", section: "Payroll Reference Information", width: 16 },
  { header: "Extra Cost Of Living", key: "extraCostOfLiving", section: "Payroll Reference Information", width: 22 },
  { header: "Medical Insurance", key: "medicalInsurance", section: "Payroll Reference Information", width: 18 },
  { header: "Social Insurance", key: "socialInsurance", section: "Payroll Reference Information", width: 18 },
  { header: "Taxes", key: "taxes", section: "Payroll Reference Information", width: 14 },
  { header: "Payment Mode", key: "paymentMode", section: "Payroll Reference Information", width: 16 },
  { header: "Has Bank Account", key: "hasBankAccount", section: "Payroll Reference Information", width: 18 },
  { header: "Bank Name", key: "bankName", section: "Payroll Reference Information", width: 20 },
  { header: "Bank Account", key: "bankAccount", section: "Payroll Reference Information", width: 22 },
  { header: "In Medical Insurance", key: "medicalInsuranceStatus", section: "Payroll Reference Information", width: 22 },
  { header: "Medical Insurance Number", key: "medicalInsuranceNumber", section: "Payroll Reference Information", width: 24 },
  { header: "In Social Insurance", key: "socialInsuranceStatus", section: "Payroll Reference Information", width: 22 },
  { header: "Social Insurance Number", key: "socialInsuranceNumber", section: "Payroll Reference Information", width: 24 },
  { header: "Payroll Eligible", key: "payrollEligible", section: "Lifecycle/System", width: 16 },
  { header: "Organogram Visible", key: "organogramVisible", section: "Lifecycle/System", width: 18 },
  { header: "Region", key: "region", section: "Lifecycle/System", width: 18 },
  { header: "Last Updated", key: "lastUpdated", section: "Lifecycle/System", width: 18 },
];

const sectionColors: Record<string, string> = {
  "Identity": "FF0F172A",
  "Organization": "FF047857",
  "Contact & Residence": "FF7C3AED",
  "CRM": "FF4338CA",
  "Payroll Reference Information": "FFC2410C",
  "Lifecycle/System": "FF475569",
};

function dateOnly(value: string | null) {
  return value ? value.slice(0, 10) : null;
}

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

function employeeToExportRow(employee: EmployeeDirectoryRow): ExportRow {
  const exportSalary = resolveEmployeeMasterExportSalary(employee);

  return {
    arabicName: employee.nameAr,
    area: employee.areaName,
    bankAccount: employee.bankAccount,
    bankName: employee.bankName,
    hasBankAccount: employee.hasBankAccount ?? (employee.bankAccount ? "yes" : null),
    baseSalary: exportSalary.baseSalary,
    basicSalary: exportSalary.basicSalary,
    birthDate: dateOnly(employee.birthDate),
    contractType: employee.contractType,
    crmId: employee.crmId,
    crmUsername: employee.crmUsername,
    department: employee.departmentName,
    directManagerId: employee.managerHrId,
    directManagerName: employee.managerName,
    education: employee.education,
    employeeId: employee.hrId,
    employmentStatus: employee.employmentStatus ?? "active",
    extraCostOfLiving: employee.extraCostOfLiving,
    fuelAllowance: employee.fuelAllowance,
    fullName: employee.fullName,
    gender: employee.gender,
    grossSalary: exportSalary.grossSalary,
    hireDate: dateOnly(employee.hireDate),
    jobTitle: employee.jobTitle,
    lastUpdated: dateOnly(employee.updatedAt) ?? employee.updatedAt,
    line: employee.lineName,
    medicalInsuranceNumber: employee.medicalInsuranceNumber,
    medicalInsurance: employee.medicalInsurance,
    medicalInsuranceStatus: employee.medicalInsuranceStatus,
    mobileNumber: employee.mobileNumber,
    nationalId: employee.nationalId,
    netSalary: exportSalary.netSalary,
    organogramVisible: yesNo(employee.organogramVisible),
    paymentMode: employee.salaryPaymentMode,
    payrollEligible: yesNo(employee.payrollEligible),
    position: employee.positionTitle,
    region: employee.regionName,
    residenceAddress: employee.residenceAddress,
    residenceArea: employee.residenceArea,
    residenceCity: employee.residenceCity,
    socialInsurance: employee.socialInsurance,
    socialInsuranceNumber: employee.socialInsuranceNumber,
    socialInsuranceStatus: employee.socialInsuranceStatus,
    taxes: employee.taxes,
    team: employee.teamName,
    workEmail: employee.workEmail,
  };
}

function inlineListFormula(values: string[]) {
  if (values.some((value) => value.includes(","))) {
    return null;
  }

  const formula = `"${values.map((value) => value.replace(/"/g, '""')).join(",")}"`;
  return formula.length <= 255 ? formula : null;
}

function styleWorksheet(
  sheet: ExcelJS.Worksheet,
  lookupValues: { departments: string[]; teams: string[] },
) {
  const titleRowNumber = 1;
  const sectionRowNumber = 2;
  const headerRowNumber = 3;
  const firstDataRowNumber = 4;

  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.autoFilter = {
    from: { column: 1, row: headerRowNumber },
    to: { column: columns.length, row: headerRowNumber },
  };
  sheet.properties.defaultRowHeight = 20;
  sheet.mergeCells(titleRowNumber, 1, titleRowNumber, columns.length);
  const titleCell = sheet.getCell(titleRowNumber, 1);
  titleCell.value = "Phoenix Workforce - Active Employee Master Data";
  titleCell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos Display", size: 16 };
  titleCell.fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };
  sheet.getRow(titleRowNumber).height = 30;

  columns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = column.width ?? 18;
    excelColumn.outlineLevel = column.section === "Lifecycle/System" ? 1 : 0;
  });

  const sectionRow = sheet.getRow(sectionRowNumber);
  sectionRow.height = 22;
  columns.forEach((column, index) => {
    const cell = sectionRow.getCell(index + 1);
    cell.value = column.section;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos", size: 9 };
    cell.fill = {
      fgColor: { argb: sectionColors[column.section] ?? "FF0F172A" },
      pattern: "solid",
      type: "pattern",
    };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  const headerRow = sheet.getRow(headerRowNumber);
  headerRow.height = 26;
  headerRow.eachCell((cell, columnNumber) => {
    const section = columns[columnNumber - 1]?.section ?? "Lifecycle/System";
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos", size: 11 };
    cell.fill = {
      fgColor: { argb: sectionColors[section] ?? "FF0F172A" },
      pattern: "solid",
      type: "pattern",
    };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFFFFFFF" } },
      right: { style: "thin", color: { argb: "FFE2E8F0" } },
    };
  });

  for (let rowNumber = firstDataRowNumber; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    row.eachCell((cell) => {
      cell.font = { color: { argb: "FF0F172A" }, name: "Aptos", size: 10 };
      cell.alignment = { vertical: "middle", wrapText: false };
      cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
      if (rowNumber % 2 === 0) {
        cell.fill = { fgColor: { argb: "FFF8FAFC" }, pattern: "solid", type: "pattern" };
      }
    });
  }

  const moneyColumns = new Set([
    "netSalary",
    "basicSalary",
    "baseSalary",
    "socialInsurance",
    "taxes",
    "medicalInsurance",
    "fuelAllowance",
    "extraCostOfLiving",
    "grossSalary",
  ]);
  columns.forEach((column, index) => {
    if (moneyColumns.has(column.key)) {
      sheet.getColumn(index + 1).numFmt = '#,##0.00';
    }
  });

  const dateColumns = new Set(["birthDate", "hireDate", "lastUpdated"]);
  columns.forEach((column, index) => {
    if (dateColumns.has(column.key)) {
      sheet.getColumn(index + 1).numFmt = "yyyy-mm-dd";
    }
  });

  const paymentModeColumn = columns.findIndex((column) => column.key === "paymentMode") + 1;
  const departmentColumn = columns.findIndex((column) => column.key === "department") + 1;
  const teamColumn = columns.findIndex((column) => column.key === "team") + 1;
  const genderColumn = columns.findIndex((column) => column.key === "gender") + 1;
  const contractColumn = columns.findIndex((column) => column.key === "contractType") + 1;
  const statusColumn = columns.findIndex((column) => column.key === "employmentStatus") + 1;
  const hasBankAccountColumn = columns.findIndex((column) => column.key === "hasBankAccount") + 1;
  const medicalInsuranceStatusColumn = columns.findIndex((column) => column.key === "medicalInsuranceStatus") + 1;
  const socialInsuranceStatusColumn = columns.findIndex((column) => column.key === "socialInsuranceStatus") + 1;
  const departmentFormula = inlineListFormula(lookupValues.departments);
  const teamFormula = inlineListFormula(lookupValues.teams);
  for (let rowNumber = firstDataRowNumber; rowNumber <= Math.max(sheet.rowCount, 1000); rowNumber += 1) {
    if (departmentFormula) {
      sheet.getCell(rowNumber, departmentColumn).dataValidation = {
        allowBlank: true,
        formulae: [departmentFormula],
        type: "list",
      };
    }
    if (teamFormula) {
      sheet.getCell(rowNumber, teamColumn).dataValidation = {
        allowBlank: true,
        formulae: [teamFormula],
        type: "list",
      };
    }
    sheet.getCell(rowNumber, paymentModeColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"two_parts,one_part"'],
      type: "list",
    };
    sheet.getCell(rowNumber, genderColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"Male,Female,Other,Not specified"'],
      type: "list",
    };
    sheet.getCell(rowNumber, contractColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"Permanent,Fixed-term,Temporary,Consultant,Internship,Not specified"'],
      type: "list",
    };
    sheet.getCell(rowNumber, statusColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"active,on_leave"'],
      type: "list",
    };
    sheet.getCell(rowNumber, hasBankAccountColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"yes,no"'],
      type: "list",
    };
    sheet.getCell(rowNumber, medicalInsuranceStatusColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"yes,no,pending"'],
      type: "list",
    };
    sheet.getCell(rowNumber, socialInsuranceStatusColumn).dataValidation = {
      allowBlank: true,
      formulae: ['"yes,no,pending"'],
      type: "list",
    };
  }

  const approvedDepartmentSet = new Set(lookupValues.departments.map((name) => name.toLowerCase()));
  for (let rowNumber = firstDataRowNumber; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cell = sheet.getCell(rowNumber, departmentColumn);
    const value = String(cell.value ?? "").trim();
    if (value && !approvedDepartmentSet.has(value.toLowerCase())) {
      cell.note = "Legacy department value. Choose an approved department before re-uploading if this employee should be remapped.";
      cell.fill = { fgColor: { argb: "FFFFF7ED" }, pattern: "solid", type: "pattern" };
    }
  }
}

function addInstructionsSheet(
  workbook: ExcelJS.Workbook,
  lookupValues: { departments: string[]; teams: string[] },
) {
  const sheet = workbook.addWorksheet("Instructions");
  sheet.columns = [
    { header: "Topic", key: "topic", width: 28 },
    { header: "Guidance", key: "guidance", width: 110 },
  ];
  sheet.addRows([
    {
      topic: "Purpose",
      guidance: "Use the Active Employee Master sheet to complete or correct fixed employee master data, then upload it from Employees.",
    },
    {
      topic: "Lifecycle protection",
      guidance: "Only active and on_leave statuses are accepted by import. Resigned, terminated, inactive, hidden, and payroll-ineligible employees are blocked from reactivation.",
    },
    {
      topic: "Upsert rule",
      guidance: "Employee ID / HR_ID is the key. Existing HR_ID rows update; new HR_ID rows create new active employee records.",
    },
    {
      topic: "Master data fields",
      guidance: "All workbook columns are fixed Employee Master fields stored on employees. Users & Access fields and retired wage fields are intentionally excluded.",
    },
    {
      topic: "Department dropdown",
      guidance: `Department uses active global lookup values: ${lookupValues.departments.join(", ")}. Inactive legacy departments are excluded from the dropdown.`,
    },
    {
      topic: "Team values",
      guidance: lookupValues.teams.length
        ? "Team exports use the global teams lookup. If the dropdown is not shown because the list is large, upload is still validated against the global team rules and can create a new team safely when Area is provided."
        : "Team is accepted as text. Upload validates Team and maps or creates global team rows safely.",
    },
    {
      topic: "Blank optional values",
      guidance: "Blank optional cells do not erase existing values during import; provide a value only when you want to create or update it.",
    },
  ]);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Aptos" };
  sheet.getRow(1).fill = { fgColor: { argb: "FF0F172A" }, pattern: "solid", type: "pattern" };
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
    });
  });
}

function fileName() {
  return `phoenix-active-employee-master-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "export");

    const directory = filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access);
    const lookupValues = {
      departments: Array.from(
        new Set(directory.lookups.departments.map((department) => department.label).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right)),
      teams: Array.from(
        new Set((directory.lookups.teams ?? []).map((team) => team.label).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right)),
    };
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Phoenix Workforce";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.subject = "Active Employee Master Data";
    workbook.title = "Phoenix Workforce Active Employee Master Data";

    const sheet = workbook.addWorksheet("Active Employee Master");
    sheet.columns = columns.map((column) => ({
      header: column.header,
      key: column.key,
      width: column.width,
    }));
    sheet.spliceRows(1, 0, [], columns.map((column) => column.section));
    sheet.addRows(directory.employees.map(employeeToExportRow));
    styleWorksheet(sheet, lookupValues);
    addInstructionsSheet(workbook, lookupValues);

    const buffer = await workbook.xlsx.writeBuffer();

    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to export employees." }, { status: 403 });
    }

    return NextResponse.json(
      {
        error: "employee_export_failed",
        message: error instanceof Error ? error.message : "Unable to export employee master data.",
      },
      { status: 500 },
    );
  }
}
