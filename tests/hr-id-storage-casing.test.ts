import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { hrIdForStorage } from "../src/lib/hr-id.ts";

// Built for a real production repair. AccessContext.hrId is the LOWERCASE comparison key produced
// by canonicalHrIdKey — correct for matching, wrong for storage. Persisting it verbatim left 541
// lowercase actor ids across the weekly-plan tables (repaired 2026-09-02) and, on the audit that
// followed, ~37,000 more across 52 columns in 46 other tables.
//
// Nothing looks broken when it happens: the app's own lookups mostly canonicalise both sides, so a
// naive .eq is the only thing that feels it — and it then returns NOTHING rather than something
// wrong. That is the dangerous shape. In production it hid one approver's entire decision history
// (10 of 223 rows), and the same class of bug once hid 28% of reps' own orders.
//
// hrIdForStorage is exercised for real (hr-id.ts is pure, no Supabase client). The call sites are
// source-pinned across the whole repo, because reaching them needs a database — and because the
// regression being guarded is a NEW write site added later, which no behavioural test of today's
// sites would ever catch.

// A column that DELIBERATELY stores the lowercase comparison key (au.occupancy_history's
// occupant_canonical_hr_id is the only one in production, and no code path writes it from a
// session) would belong here, with the reason. Empty on purpose: there is currently no such write.
const DELIBERATE_COMPARISON_KEY_WRITES: string[] = [];

const RAW_WRITE = /\b\w*_hr_id:\s*(?:input\.)?(?:access|ctx)\.hrId/;

function sourceFilesUnder(root: string) {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith("_wt-")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  walk(root);
  return found;
}

export async function runHrIdStorageCasingTests() {
  // --- the converter itself, run for real ---
  assert.equal(hrIdForStorage("a-9"), "A-9", "the lowercase comparison key must convert back to the casing employees.hr_id stores");
  assert.equal(hrIdForStorage("A-9"), "A-9", "an already-canonical id must pass through unchanged");
  assert.equal(hrIdForStorage("  a-12  "), "A-12", "surrounding whitespace must never reach storage");
  assert.equal(hrIdForStorage("aaa"), "AA", "the legacy aaa alias must resolve to the live employee id, not be stored as AAA");
  assert.equal(hrIdForStorage(null), null, "a null actor must stay null - never the string NULL");
  // A blank passes through unchanged rather than becoming null. That is deliberate: it is exactly
  // what shipped in the weekly-plan fix, and tightening it here would quietly change what a NOT NULL
  // actor column receives. The helper's job is CASING, not blank-handling.
  assert.equal(hrIdForStorage(""), "", "a blank must pass through untouched - changing it to null would alter what NOT NULL columns receive");

  // --- the single funnel exists, in the module that owns the casing contract ---
  const hrId = readFileSync("src/lib/hr-id.ts", "utf8");
  assert.ok(
    hrId.includes("export function hrIdForStorage(value: string | null | undefined) {")
      && hrId.includes("return canonicalHrIdForDisplay(value) ?? value ?? null;"),
    "hrIdForStorage must exist in hr-id.ts and convert through canonicalHrIdForDisplay - it is the one place that turns a comparison key back into a stored id",
  );

  // --- NO file may persist a raw session hr id, anywhere ---
  const offenders: string[] = [];
  for (const file of [...sourceFilesUnder("src"), ...sourceFilesUnder("app")]) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      if (!RAW_WRITE.test(line)) return;
      const site = `${file.split(sep).join("/")}:${index + 1}`;
      if (DELIBERATE_COMPARISON_KEY_WRITES.includes(site)) return;
      offenders.push(`${site}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `these sites write the raw lowercase session key into an _hr_id column - wrap the value in hrIdForStorage(...) so the database keeps the canonical casing:\n${offenders.join("\n")}`,
  );

  // --- and the read that this drift already broke stays casing-blind ---
  const directOrders = readFileSync("src/lib/direct-orders/service.ts", "utf8");
  assert.ok(
    directOrders.includes(`.in("decided_by_hr_id", hrIdLookupKeys(access.hrId));`),
    "the approver's own decision history must match decided_by_hr_id in BOTH casings - a bare .eq on the session key returned an empty history for the one approver whose rows were stored uppercase",
  );
  assert.equal(
    directOrders.includes(`.eq("decided_by_hr_id", access.hrId`),
    false,
    "the single-casing .eq on decided_by_hr_id is back - it silently hides an approver's entire history rather than erroring",
  );
}
