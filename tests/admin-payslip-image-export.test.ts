import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canExportPayslipDocument } from "../src/lib/payroll/payslip-center.ts";

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

  // Both the route and the admin page used to carry the literal `access.role === "Super Admin"`,
  // one in each file. On 2026-08-10 the owner added the Finance Manager to the payslip document
  // export, and a duplicated literal across that boundary is exactly how a button and its route
  // drift apart — so both now derive from one exported predicate.
  assert.match(
    imageRouteSource,
    /if \(!canExportPayslipDocument\(access\)\)/,
    "Payslip image export must gate on the shared canExportPayslipDocument predicate, never a role literal.",
  );
  assert.match(
    imageRouteSource,
    /from "@\/lib\/payroll\/payslip-center"/,
    "…imported from the payslip-center domain module that owns it.",
  );

  // Behavioural, not textual: who the predicate actually admits. The CEO row is the important one —
  // he passes the Payslips Center's own page guard and reads every figure, and must still not be
  // able to carry the rendered document out. This assertion is what fires if the predicate is ever
  // widened to "anyone who can open the page".
  assert.equal(canExportPayslipDocument({ role: "Super Admin" }), true, "Super Admin keeps the export.");
  assert.equal(canExportPayslipDocument({ role: "Finance Manager" }), true, "Owner decision, 2026-08-10.");
  assert.equal(
    canExportPayslipDocument({ role: "CEO" }),
    false,
    "The CEO reads the Payslips Center but must NOT export the payslip document.",
  );
  for (const role of ["Financial Advisor", "HR Advisory", "HR Operations", "SFE Manager", "Employee", "Medical Rep"] as const) {
    assert.equal(canExportPayslipDocument({ role }), false, `${role} must not export payslip documents.`);
  }

  assert.match(
    imageRouteSource,
    /pdf-lib/,
    "Payslip export must use pdf-lib to render the PDF (Playwright replaced).",
  );

  assert.match(
    imageRouteSource,
    /Content-Type.*application\/pdf/,
    "Payslip export must return a PDF (not a PNG image).",
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
    /canExportPayslipImage = canExportPayslipDocument\(access\)/,
    "Admin payslips center must derive the export button from the SAME predicate the route enforces — " +
      "a second role literal here is how the button and its guard drift apart.",
  );

  assert.match(
    adminPayslipsCenterSource,
    /\/payslips\/image\?employeeHrId=/,
    "Admin payslips center must link each row to the image export endpoint.",
  );
}
