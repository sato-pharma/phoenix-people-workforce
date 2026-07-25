import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text regression guard (this file's functions do live DB writes via
// createResignation/resignEmployeeAndOpenVacancy, which the Node unit-test harness can't easily
// exercise end-to-end without a Supabase fixture layer — matching this repo's own idiom for
// pinning fixes to DB-touching functions via source inspection instead).
//
// resignations/service.ts's todayDate() used to resolve "today" via a naive UTC slice
// (new Date().toISOString().slice(0, 10)) — wrong for the ~1-3h/night Cairo has already rolled
// to the next calendar day but the UTC instant hasn't. It is the shared default for
// normalizeSubmittedDate/normalizeLastWorkingDate (the creation-time defaults feeding
// createResignation -> resignEmployeeAndOpenVacancy, which final-pay proration and the legal
// exit date derive from) and for mapResignation/mapLegacyResignationEmployee's output-side
// last-resort fallback.

export function runResignationsCairoTodayTests() {
  const service = readFileSync("src/lib/resignations/service.ts", "utf8");

  assert.match(
    service,
    /function todayDate\(\) \{\s*return currentCairoDateOnlyIso\(\);\s*\}/,
    "todayDate() must delegate to the canonical Cairo-aware currentCairoDateOnlyIso helper",
  );
  assert.doesNotMatch(
    service,
    /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
    "todayDate() must not resolve \"today\" via a naive UTC slice of the server clock",
  );

  // All four call sites must still route through the one (now-fixed) todayDate() rather than
  // any of them regaining an independent, unfixed "today" computation of their own.
  assert.match(
    service,
    /function normalizeSubmittedDate\(input: CreateResignationInput\) \{[\s\S]{0,200}todayDate\(\)/,
    "normalizeSubmittedDate must still fall back to todayDate()",
  );
  assert.match(
    service,
    /function normalizeLastWorkingDate\(input: CreateResignationInput\) \{[\s\S]{0,300}todayDate\(\)/,
    "normalizeLastWorkingDate must still fall back to todayDate()",
  );
  assert.match(
    service,
    /function mapResignation\(row: ResignationRow\): ResignationRecord \{[\s\S]{0,300}todayDate\(\)/,
    "mapResignation's output-side fallback must still route through todayDate()",
  );
  assert.match(
    service,
    /function mapLegacyResignationEmployee\(row: HistoricalResignedEmployeeRow\): ResignationRecord \{[\s\S]{0,300}todayDate\(\)/,
    "mapLegacyResignationEmployee's output-side fallback must still route through todayDate()",
  );
}
