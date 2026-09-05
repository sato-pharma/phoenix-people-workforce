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

// The rows moved out of the page into a client component on 2026-09-01, when the Payslips Center
// was linked into the HR sidebar and its ten-column table had to become cards on a phone. The page
// still owns the PREDICATE; the component owns the LINKS. Reading both, and pinning the handoff
// between them below, is what stops the split from quietly unpinning the export button.
const adminPayslipsCenterRowsSource = readFileSync(
  new URL("../src/components/payroll/payslips-center-rows.tsx", import.meta.url),
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

  // ── ONE DOCUMENT, TWO TRANSPORTS (2026-09-05) ────────────────────────────────────────────────
  // This route drew its own pdf-lib payslip until the house-identity redesign — a second rendering
  // of the same document, with its own palette and its own field order, which had already drifted
  // from the HTML sheet. Both routes now render `@/lib/payroll/payslip-document`, and these two
  // assertions are what stops a future change re-introducing a private drawing in either file.
  //
  // The old assertion here required the literal `pdf-lib`, which is exactly the shape AGENTS.md
  // warns about: a pinning test that pins the ANTI-pattern and has to be found by grepping the
  // tests for the old string before the source can be changed at all.
  assert.match(
    imageRouteSource,
    /from "@\/lib\/payroll\/payslip-document"/,
    "The PDF export must render the SHARED payslip document, never a second drawing of its own.",
  );
  assert.match(
    imageRouteSource,
    /withChromiumPage/,
    "…printed by Chromium, which is the only thing in this stack that shapes Arabic correctly.",
  );
  // The IMPORT, not the word. This route's header explains at length why pdf-lib was removed, and
  // an assertion that forbids the mere mention forbids the explanation with it — which is how a
  // comment ends up deleted to make a test pass.
  assert.doesNotMatch(
    imageRouteSource,
    /^import .*from "pdf-lib"/m,
    "A PDF library cannot draw this document: WinAnsi has no Arabic, and the amount in words is Arabic.",
  );
  assert.match(
    imageRouteSource,
    /printBackground:\s*true/,
    "The 6% zebra row is a CSS background — without this the detail tables print as unruled text.",
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
    /buildPayslipDocument\(records, exportData\.batch\.month/,
    "The HTML route must serve the same shared document the PDF route prints.",
  );

  assert.match(
    adminPayslipsCenterSource,
    /canExportPayslipImage = canExportPayslipDocument\(access\)/,
    "Admin payslips center must derive the export button from the SAME predicate the route enforces — " +
      "a second role literal here is how the button and its guard drift apart.",
  );

  // The handoff. The page computes the predicate and must PASS it to the component; the component
  // must gate the button on that prop. Either half alone is satisfiable while the button is wrong —
  // a component that ignores the prop and renders the link unconditionally would pass the link
  // assertion below, and a page that stops passing it would leave the component gating on
  // `undefined` and hiding the button from Finance. Both are pinned.
  assert.match(
    adminPayslipsCenterSource,
    /<PayslipsCenterRows[\s\S]{0,200}?canExportPayslipImage=\{canExportPayslipImage\}/,
    "Admin payslips center must hand the export predicate to the rows component it renders.",
  );
  assert.match(
    adminPayslipsCenterRowsSource,
    /canExportPayslipImage \? \(/,
    "The payslips rows component must gate the export link on the predicate the page passes in.",
  );

  // Both halves of the responsive list carry the link — cards below `md`, table from `md` up — so
  // this counts rather than merely matching. A single hit means one half lost its export button,
  // which on a phone is invisible to anyone testing on a desktop.
  assert.equal(
    adminPayslipsCenterRowsSource.match(/\/payslips\/image\?employeeHrId=/g)?.length,
    2,
    "Admin payslips center must link BOTH the card and the table row to the image export endpoint.",
  );
}
