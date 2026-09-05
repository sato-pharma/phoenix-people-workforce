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

// ── KNOWN, UNREPAIRED, AND DELIBERATELY NOT SILENT ──────────────────────────────────────────────
//
// Widening the sweep to follow a local binding (see TAINTED_BINDING) surfaced 29 writes that had
// been invisible to it. One — the recruitment audit trail — is fixed in the same change. These 28
// are real and are NOT fixed here, for a reason worth stating rather than hiding in an empty list:
//
//   SOME OF THEM HAVE A PAIRED READ THAT MUST CHANGE IN THE SAME BREATH. marketing-requests/
//   report-share-links.ts reads the very column it writes with a plain lowercase equality
//   (`.eq("created_by_hr_id", access.hrId ?? "")`). Today writes and reads are both lowercase, so it
//   works by accident. Fixing the write alone would stop a non-admin seeing their own share links —
//   and it would fail SILENTLY, returning nothing rather than erroring, which is the exact shape
//   this module's header describes hiding an approver's entire decision history in production.
//
// So each of these needs its read side checked before its write is wrapped. That is a cross-domain
// repair spanning marketing requests, direct orders and territory management, and it does not
// belong inside a recruitment change.
//
// COUNTED BY FILE, NOT PINNED BY LINE. Line numbers in these files move constantly and a pinned
// line would false-fail on an unrelated edit. A count cannot: fix one and the test tells you to
// lower the number, add one and it fails. The debt can shrink or hold, never grow unnoticed.
const KNOWN_UNREPAIRED_INDIRECT_WRITES: Record<string, number> = {
  "src/lib/direct-orders/report-share-links.ts": 2,
  "src/lib/marketing-requests/pharmacy-license-verdict.ts": 1,
  "src/lib/marketing-requests/report-share-links.ts": 2,
  "src/lib/marketing-requests/service.ts": 17,
  "src/lib/marketing-requests/validated-customer-transfer.ts": 5,
  "src/lib/territory-management/preview-links.ts": 1,
};

const RAW_WRITE = /\b\w*_hr_id:\s*(?:input\.)?(?:access|ctx)\.hrId/;

// AND THE SAME WRITE ONE VARIABLE AWAY.
//
// The pattern above only sees `access.hrId` sitting INLINE beside the column. Assign it to a local
// first and the sweep goes quiet:
//
//     const actorHrId = access.hrId ?? null;
//     ...
//     status_changed_by_hr_id: actorHrId,
//
// That is not hypothetical. It is exactly how `updateCandidateStatus` wrote 125 lowercase rows into
// `ats_candidates.status_changed_by_hr_id` and 255 into `ats_candidate_status_events.actor_hr_id`
// while this file stayed green — three spellings for two people, so any per-person report splits
// one screener in two. Measured on production 2026-09-05, after the sweep had been passing for days.
//
// So the binding is followed: a `const` whose initialiser reads a session hr id and does NOT pass it
// through hrIdForStorage taints that name for the rest of the file, and writing the tainted name
// into an `_hr_id` column is the same offence as writing the expression.
const TAINTED_BINDING = /\bconst\s+(\w+)\s*=\s*(?:input\.)?(?:access|ctx)\.hrId\b/;

/** Names in this file that hold the raw comparison key. */
function taintedNames(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    // A line that already funnels through hrIdForStorage is the CORRECT shape, not an offence.
    if (line.includes("hrIdForStorage")) continue;
    const hit = TAINTED_BINDING.exec(line);
    if (hit) names.add(hit[1]);
  }
  return names;
}

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
    const lines = text.split("\n");
    const tainted = taintedNames(lines);
    // Built once per file rather than per line: a binding declared near the top taints writes
    // hundreds of lines below it, which is precisely the distance that hid the status-event bug.
    const INDIRECT_WRITE = tainted.size
      ? new RegExp(`\\b\\w*_hr_id:\\s*(?:${[...tainted].join("|")})\\s*[,\n]`)
      : null;
    lines.forEach((line, index) => {
      const raw = RAW_WRITE.test(line);
      const indirect = INDIRECT_WRITE ? INDIRECT_WRITE.test(line) : false;
      if (!raw && !indirect) return;
      if (line.includes("hrIdForStorage")) return;
      const site = `${file.split(sep).join("/")}:${index + 1}`;
      if (DELIBERATE_COMPARISON_KEY_WRITES.includes(site)) return;
      offenders.push(`${site}  ${line.trim()}${indirect && !raw ? "   <- via a local binding" : ""}`);
    });
  }
  // Split the offenders into "already known and counted" and "new".
  const byFile = new Map<string, number>();
  const unexpected: string[] = [];
  for (const entry of offenders) {
    const file = entry.split(":")[0];
    if (file in KNOWN_UNREPAIRED_INDIRECT_WRITES) {
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
      continue;
    }
    unexpected.push(entry);
  }

  assert.deepEqual(
    unexpected,
    [],
    `these sites write the raw lowercase session key into an _hr_id column - wrap the value in hrIdForStorage(...) so the database keeps the canonical casing:\n${unexpected.join("\n")}`,
  );

  // The recorded debt may SHRINK or hold. It may never grow, and a file whose count has dropped must
  // have its number lowered here so the next reader is not told there is more left than there is.
  for (const [file, expected] of Object.entries(KNOWN_UNREPAIRED_INDIRECT_WRITES)) {
    const actual = byFile.get(file) ?? 0;
    assert.equal(
      actual,
      expected,
      actual > expected
        ? `${file} gained a raw hr-id write (${actual} now, ${expected} recorded) - wrap it in hrIdForStorage(...), and check the column's READ side in the same change`
        : `${file} now has ${actual} raw hr-id writes, fewer than the ${expected} recorded - lower the number in KNOWN_UNREPAIRED_INDIRECT_WRITES so the remaining debt is stated honestly`,
    );
  }

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
