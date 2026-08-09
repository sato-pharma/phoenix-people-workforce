import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const templateRouteSource = readFileSync(
  new URL("../app/api/payroll/template/route.ts", import.meta.url),
  "utf8",
);
const salaryImportSource = readFileSync(
  new URL("../src/lib/payroll/salary-import.ts", import.meta.url),
  "utf8",
);
// The proration arithmetic moved out of the route so it could be tested by
// behaviour rather than by matching its source text — see
// tests/ready-payroll-proration.test.ts. These source assertions stay only to
// pin the wiring that still lives in the route.
const readyProrationSource = readFileSync(
  new URL("../src/lib/payroll/ready-proration.ts", import.meta.url),
  "utf8",
);

export function runReadyPayrollTemplateFormulaTests() {
  assert.match(
    templateRouteSource,
    /createFallbackWorkbook\(await buildReadyRows\(month, year, access(?:, batchId)?\), month, year, \{ formulas: true \}\)/,
    "Ready payroll download must create the workbook with Excel formulas enabled.",
  );

  assert.match(
    readyProrationSource,
    /export function calculateBaseProrationDeduction/,
    "Ready payroll must calculate a cached base-salary proration deduction.",
  );

  assert.match(
    templateRouteSource,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "Ready payroll must include inactive directory rows so current-month resignations can be paid.",
  );

  assert.match(
    templateRouteSource,
    /terminalPayrollStatuses = new Set\(\["resigned", "terminated", "inactive"\]\)/,
    "Ready payroll must identify terminal employees for final-month payroll inclusion.",
  );

  assert.match(
    templateRouteSource,
    /extraCostOfLiving = payrollEmployee\.isTerminalPayroll \? 0/,
    "Ready payroll resignation rows must not include extra cost of living.",
  );

  assert.match(
    templateRouteSource,
    /fuelAllowance = payrollEmployee\.isTerminalPayroll \? 0/,
    "Ready payroll resignation rows must not include fuel allowance.",
  );

  assert.match(
    readyProrationSource,
    /export function calculateBaseLifecycleProrationDeduction/,
    "Ready payroll must prorate final-month salary through the last working date.",
  );

  assert.match(
    templateRouteSource,
    /function payrollExcelDateOnly/,
    "Ready payroll must normalize date-only values before writing them to Excel.",
  );

  assert.match(
    templateRouteSource,
    /Date\.UTC\([\s\S]*?date\.getFullYear\(\)[\s\S]*?date\.getMonth\(\)[\s\S]*?date\.getDate\(\)[\s\S]*?12[\s\S]*?\)/,
    "Ready payroll must write Hire Date at UTC noon so Excel does not shift it one day earlier.",
  );

  assert.match(
    readyProrationSource,
    /daysInMonth - hireDay \+ 1/,
    "Ready payroll proration must include the hire date, counted against the real month length.",
  );

  // This assertion used to read /30 - hireDay \+ 1/ and its message asserted a
  // "fixed 30-day month" was correct. That is the defect it was meant to guard:
  // a 28-day February can never satisfy `endDay >= 30`, so a leaver dated 28 Feb
  // who worked every day was charged 2 days of salary. Pin the absence of the
  // hardcoded divisor so it cannot come back.
  assert.doesNotMatch(
    readyProrationSource,
    /\/ 30\)|\/30\)|>= 30\b|Math\.min\(30\b/,
    "Ready payroll proration must never reintroduce a hardcoded 30-day month.",
  );

  assert.doesNotMatch(
    templateRouteSource,
    /\$\{baseSalary\}\/30/,
    "The workbook's Other Deductions formula must divide by the real month length, not a literal 30 — the sheet recalculates client-side and would otherwise disagree with the stored figure.",
  );

  assert.match(
    templateRouteSource,
    /IF\(AND\(ISNUMBER\(\$\{hireDate\}\),YEAR\(\$\{hireDate\}\)=\$\{year\},MONTH\(\$\{hireDate\}\)=\$\{month\}\)/,
    "Ready payroll Other Deductions must contain the hire-month proration formula.",
  );

  assert.match(
    templateRouteSource,
    /ROUND\(\$\{baseSalary\}\+\$\{socialInsurance\}\+\$\{employmentIncomeTax\},2\)/,
    "Ready payroll Gross Salary must be an Excel formula.",
  );

  assert.match(
    templateRouteSource,
    /ROUND\(\$\{baseSalary\}\+\$\{extraCostOfLiving\}\+\$\{fuelAllowance\},2\)/,
    "Ready payroll Net Salary must be an Excel formula.",
  );

  assert.match(
    templateRouteSource,
    /IF\(\$\{paymentMode\}="One Part",MAX\(0,\$\{monthSalary\}-MIN\(MAX\(0,\$\{monthSalary\}\),MAX\(0,\$\{expenses\}\+\$\{incentive\}\)\)\),MIN\(MAX\(0,\$\{monthSalary\}-MIN\(MAX\(0,\$\{monthSalary\}\),MAX\(0,\$\{expenses\}\+\$\{incentive\}\)\)\),ROUND\(\$\{baseSalary\}\*0\.7,2\),MAX\(0,\$\{baseSalary\}-\$\{otherDeductions\}\)\)\)/,
    "Ready payroll First Part must exclude expenses and incentive before applying One Part or Two Parts caps.",
  );

  assert.match(
    templateRouteSource,
    /IF\(\$\{paymentMode\}="One Part",MIN\(MAX\(0,\$\{monthSalary\}\),MAX\(0,\$\{expenses\}\+\$\{incentive\}\)\),MAX\(0,ROUND\(\$\{monthSalary\}-\$\{firstPart\},2\)\)\)/,
    "Ready payroll Second Part must include expenses and incentive for One Part rows and never be negative.",
  );

  assert.match(
    templateRouteSource,
    /function sortReadyPayrollRows/,
    "Ready payroll must group rows into deterministic payroll blocks.",
  );

  assert.match(
    templateRouteSource,
    /function readyPayrollBlockRank/,
    "Ready payroll must have an explicit block ranking function.",
  );

  assert.match(
    templateRouteSource,
    /row\.paymentMode === "One Part"[\s\S]*?return 1/,
    "Ready payroll must keep One Part rows in the first block.",
  );

  assert.match(
    templateRouteSource,
    /payrollMonthMatches\(row\.hireDate, row\.month, row\.year\)[\s\S]*?return 3/,
    "Ready payroll must put current-month Two Parts new hires below already hired rows.",
  );

  assert.match(
    templateRouteSource,
    /payrollMonthMatches\(row\.lastWorkingDate, row\.month, row\.year\)[\s\S]*?return 4/,
    "Ready payroll must put current-month resignation rows in the final block.",
  );

  assert.match(
    templateRouteSource,
    /readyPayrollBlockDateSortValue\(left\) -\s*readyPayrollBlockDateSortValue\(right\)/,
    "Ready payroll rows inside each block must be sorted from oldest to newest.",
  );

  assert.match(
    templateRouteSource,
    /readyPayrollEditableColumnNumbers = new Set\(\[[\s\S]*?14, 15, 16, 17, 20,[\s\S]*?25, 26, 27, 28, 29, 30,[\s\S]*?\]\)/,
    "Ready payroll must leave monthly additions and deductions editable.",
  );

  assert.match(
    templateRouteSource,
    /locked: !readyPayrollEditableColumnNumbers\.has\(column\)/,
    "Ready payroll protection must lock fixed fields while allowing edits to variable fields.",
  );

  assert.match(
    templateRouteSource,
    /function writeReadyPayrollBlockHeaderRow/,
    "Ready payroll must write visible block header rows.",
  );

  assert.match(
    templateRouteSource,
    /BLOCK 1 - One Part[\s\S]*?BLOCK 2 - Two Parts Already Hired[\s\S]*?BLOCK 3 - New Hires[\s\S]*?BLOCK 4 - Resignations/,
    "Ready payroll must label the four requested blocks.",
  );

  assert.match(
    templateRouteSource,
    /blockHeaderRows\.add\(rowNumber\)/,
    "Ready payroll must track block header rows separately from employee data rows.",
  );

  assert.match(
    templateRouteSource,
    /from: \{ column: 1, row: dataStartRow - 1 \}/,
    "Ready payroll AutoFilter must keep the main workbook header as the filter header.",
  );

  assert.match(
    salaryImportSource,
    /function isReadyPayrollBlockHeaderRow/,
    "Payroll upload parsing must identify ready-payroll block separator rows.",
  );

  assert.match(
    salaryImportSource,
    /!isReadyPayrollBlockHeaderRow\(row\)/,
    "Payroll upload parsing must skip ready-payroll block separator rows.",
  );

  assert.match(
    templateRouteSource,
    /await sheet\.protect\("",/,
    "Ready payroll must protect the sheet so the One Part fixed block does not move during normal sorting.",
  );
}
