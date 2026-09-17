import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canViewHeadOfficeLine,
  isHeadOfficeLine,
  stripHeadOfficeRows,
} from "../src/lib/sales/access-scope.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The Head Office product line is confidential — only CEO / Super Admin may ever see it or its
// products. This pins the central helpers plus that every line-bearing sales surface applies the
// strip (Source of Sales engine, Weekly, Sales-Marketing Intelligence).
export function runSalesHeadOfficeLockTests() {
  // ── Role gate ───────────────────────────────────────────────────────────────
  for (const role of ["CEO", "Super Admin"] as const) {
    assert.equal(canViewHeadOfficeLine(role), true, `${role} may see Head Office`);
  }
  for (const role of [
    "SFE Manager",
    "Marketing Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "District Manager",
    "Regional Manager",
    "Medical Rep",
  ] as const) {
    assert.equal(canViewHeadOfficeLine(role), false, `${role} must NOT see Head Office`);
  }

  // ── isHeadOfficeLine variants ────────────────────────────────────────────────
  for (const name of ["Head Office", "head office", "  HEAD OFFICE ", "office", "HQ", "headoffice"]) {
    assert.equal(isHeadOfficeLine(name), true, `"${name}" is Head Office`);
  }
  for (const name of ["Pedia", "CNS", "Anti infective", "", null, undefined]) {
    assert.equal(isHeadOfficeLine(name), false, `"${String(name)}" is not Head Office`);
  }

  // ── stripHeadOfficeRows ──────────────────────────────────────────────────────
  const rows = [
    { line: "Pedia", v: 1 },
    { line: "Head Office", v: 2 },
    { line: "office", v: 3 },
    { line: null, v: 4 }, // no line → always kept
  ];
  // enabled (a non-CEO/SA viewer): Head Office rows dropped, line-less row kept.
  assert.deepEqual(
    stripHeadOfficeRows(rows, (r) => r.line, true).map((r) => r.v),
    [1, 4],
    "strips Head Office rows when enabled, keeps line-less rows",
  );
  // disabled (CEO / Super Admin): everything kept.
  assert.deepEqual(
    stripHeadOfficeRows(rows, (r) => r.line, false).map((r) => r.v),
    [1, 2, 3, 4],
    "keeps all rows when disabled",
  );

  // ── Surface source-pins ──────────────────────────────────────────────────────
  // The Sales Analytics loaders and dashboards carried their own strip and confidential-reveal pins
  // here. The owner retired that module on 2026-09-17, so the surfaces below are every one left.

  const weekly = readSource("../src/lib/sales/weekly/access.ts");
  assert.ok(
    weekly.includes("scope.canViewHeadOffice") && weekly.includes("isHeadOfficeLine(row.officialLine)"),
    "weekly applyWeeklyAccessScope strips Head Office unless allowed",
  );
  assert.ok(
    weekly.includes("canViewHeadOffice: canViewHeadOfficeLine(ctx.role)"),
    "weekly scope resolves canViewHeadOffice from the role",
  );

  // The Month vs Target tab of the weekly Summarized Report reads TARGETS, not facts — a separate
  // source that applyWeeklyAccessScope never saw, because phx_monthly_targets is SECURITY DEFINER
  // and carries no viewer bound at all. It needs its own strip, and its own pin here, because the
  // usual guard cannot catch it: isHeadOfficeLine only lowercases, so it recognises the line NAME
  // "Head Office" but not the line CODE "head_office" that the targets engine actually speaks.
  const monthTargets = readSource("../src/lib/sales/weekly/month-target-scope.ts");
  assert.ok(
    monthTargets.includes("applyWeeklyAccessScope("),
    "weekly month-vs-target runs its targets through the same access bound as the sales they divide",
  );
  assert.ok(
    monthTargets.includes("resolveTargetLineCode(row.lineCode)"),
    "weekly month-vs-target drops any target whose line is not a field line — Head Office above all",
  );

  const si = readSource("../src/lib/sales-marketing-intelligence/service.ts");
  assert.ok(
    si.includes("stripHeadOfficeFromMarketingSnapshot"),
    "SI dashboard strips Head Office from the snapshot for non-CEO/SA",
  );
}
