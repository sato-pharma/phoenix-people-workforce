import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const imageRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/payslips/image/route.ts", import.meta.url),
  "utf8",
);

const payslipRouteSource = readFileSync(
  new URL("../app/api/payroll/[id]/payslips/route.ts", import.meta.url),
  "utf8",
);

const adminPayslipsCenterSource = readFileSync(
  new URL("../app/(admin)/admin/payslips-center/page.tsx", import.meta.url),
  "utf8",
);

export function runAdminPayslipImageExportTests() {
  assert.match(
    imageRouteSource,
    /assertPermission\(access, "payslips", "export"\)/,
    "Payslip image export route must assert payslip export permission.",
  );

  assert.match(
    imageRouteSource,
    /access\.role !== "Super Admin"/,
    "Payslip image export must be restricted to Super Admin.",
  );

  assert.match(
    imageRouteSource,
    /import\("playwright"\)/,
    "Payslip image export must render the existing payslip HTML through Playwright.",
  );

  assert.match(
    imageRouteSource,
    /Content-Type": "image\/png"/,
    "Payslip image export must return a PNG image.",
  );

  assert.match(
    imageRouteSource,
    /single_payslip_required/,
    "Payslip image export must require one employee payslip, not a full batch image.",
  );

  assert.match(
    payslipRouteSource,
    /\.image-export \.sheet-scroll[\s\S]*max-height: none;[\s\S]*overflow: visible;/,
    "Payslip image render mode must remove the internal detail-table scroll.",
  );

  assert.match(
    adminPayslipsCenterSource,
    /canExportPayslipImage = access\.role === "Super Admin"/,
    "Admin payslips center must only show image export for Super Admin.",
  );

  assert.match(
    adminPayslipsCenterSource,
    /\/payslips\/image\?employeeHrId=/,
    "Admin payslips center must link each row to the image export endpoint.",
  );
}
