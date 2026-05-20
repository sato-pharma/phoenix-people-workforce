import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const templateRouteSource = readFileSync(
  new URL("../app/api/payroll/template/route.ts", import.meta.url),
  "utf8",
);

export function runReadyPayrollTemplateFormulaTests() {
  assert.match(
    templateRouteSource,
    /createFallbackWorkbook\(await buildReadyRows\(month, year, access\), month, year, \{ formulas: true \}\)/,
    "Ready payroll download must create the workbook with Excel formulas enabled.",
  );

  assert.match(
    templateRouteSource,
    /function calculateBaseProrationDeduction/,
    "Ready payroll must calculate a cached base-salary proration deduction.",
  );

  assert.match(
    templateRouteSource,
    /30 - hireDay \+ 1/,
    "Ready payroll proration must include the hire date using a fixed 30-day month.",
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
    /IF\(\$\{paymentMode\}="One Part",\$\{monthSalary\},MIN\(ROUND\(\$\{baseSalary\}\*0\.7,2\),MAX\(0,\$\{baseSalary\}-\$\{otherDeductions\}\)\)\)/,
    "Ready payroll First Part must use One Part full-month-salary logic and prorated Two Parts logic.",
  );

  assert.match(
    templateRouteSource,
    /IF\(\$\{paymentMode\}="One Part",0,ROUND\(\$\{monthSalary\}-\$\{firstPart\},2\)\)/,
    "Ready payroll Second Part must be zero for One Part and the remainder for Two Parts.",
  );

  assert.match(
    templateRouteSource,
    /function sortReadyPayrollRows/,
    "Ready payroll must group One Part employees before Two Parts employees.",
  );

  assert.match(
    templateRouteSource,
    /left\.paymentMode === "One Part"/,
    "Ready payroll grouping must identify One Part rows by payment mode.",
  );

  assert.match(
    templateRouteSource,
    /writeSortableTwoPartsHeaderRow/,
    "Ready payroll must create a separate sortable header for the Two Parts range.",
  );

  assert.match(
    templateRouteSource,
    /from: \{ column: 1, row: twoPartHeaderRow \?\? dataStartRow - 1 \}/,
    "Ready payroll AutoFilter must target the Two Parts range when the One Part fixed block exists.",
  );

  assert.match(
    templateRouteSource,
    /await sheet\.protect\("",/,
    "Ready payroll must protect the sheet so the One Part fixed block does not move during normal sorting.",
  );
}
