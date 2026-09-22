import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The owner reads every timestamp in Cairo local, never raw UTC (house rule). Beyond the export
// COVER stamps already pinned in crm-portal-scope.test.ts and sales-export-generated-stamp-cairo.
// test.ts, a sweep on 2026-09-22 found seven more human-facing stamps that formatted an instant
// with no timeZone — so they rendered in the server's UTC clock. They now read Cairo: the free-text
// "exported/Exported" stamps via cairoDateTimeSortable (matching the covers), and the data-value
// datetime cells via an explicit `timeZone: "Africa/Cairo"`. These build workbooks/emails behind a
// DB read and can't be unit-tested without infra, so — as the CRM and sales guards do — we pin the
// stamp's shape in the source.

type StampGuard = { file: string; mustInclude: string[]; mustNotInclude: string[] };

const EXPORT_EMAIL_STAMP_GUARDS: StampGuard[] = [
  {
    // Shared XLSX helper — the default "exported" subtitle and the outstation footer stamp.
    file: "src/lib/export/table-workbook.ts",
    mustInclude: ["cairoDateTimeSortable(new Date().toISOString())} Cairo"],
    mustNotInclude: ['new Date().toLocaleString("en-GB")'],
  },
  {
    // Activity Control export — the "exported" subtitle and each user's Last-seen cell.
    file: "app/api/admin/activity/export/route.ts",
    mustInclude: [
      "cairoDateTimeSortable(new Date().toISOString())} Cairo",
      'new Date(user.lastSeenAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })',
    ],
    mustNotInclude: ['new Date().toLocaleString("en-GB")}', 'toLocaleString("en-GB") : "—"'],
  },
  {
    file: "app/api/admin/outstation/expense-command/export/route.ts",
    mustInclude: ["cairoDateTimeSortable(new Date().toISOString())} Cairo"],
    mustNotInclude: ['new Date().toLocaleString("en-GB")'],
  },
  {
    file: "src/lib/outstation/expense-approval-export.ts",
    mustInclude: ["cairoDateTimeSortable(new Date().toISOString())} Cairo"],
    mustNotInclude: ['new Date().toLocaleString("en-GB")'],
  },
  {
    // Outstation expenses export — the Approved-At datetime column.
    file: "app/api/admin/outstation/expenses/export/route.ts",
    mustInclude: ['parsed.toLocaleString("en-GB", { timeZone: "Africa/Cairo" })'],
    mustNotInclude: ['parsed.toLocaleString("en-GB");'],
  },
  {
    file: "src/lib/sales/master-data/export-workbook.ts",
    mustInclude: ["cairoDateTimeSortable(new Date().toISOString())} Cairo."],
    mustNotInclude: ['new Date().toLocaleString("en-GB")'],
  },
  {
    // Account-setup / password-reset email — the "Expires" line the recipient reads.
    file: "src/lib/auth/password-setup.ts",
    mustInclude: ['new Date(expiresAt).toLocaleString("en-US", { timeZone: "Africa/Cairo" })'],
    mustNotInclude: ['toLocaleString("en-US") }'],
  },
];

export function runExportEmailGeneratedStampCairoTests() {
  for (const guard of EXPORT_EMAIL_STAMP_GUARDS) {
    const source = readFileSync(guard.file, "utf8");
    for (const needle of guard.mustInclude) {
      assert.ok(
        source.includes(needle),
        `${guard.file}: the timestamp must be Cairo-zoned — expected to find \`${needle}\``,
      );
    }
    for (const forbidden of guard.mustNotInclude) {
      assert.ok(
        !source.includes(forbidden),
        `${guard.file}: a raw-UTC timestamp remains — found \`${forbidden}\``,
      );
    }
  }
}
