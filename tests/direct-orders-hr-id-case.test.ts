import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hrIdLookupKeys } from "../src/lib/hr-id.ts";

/**
 * A rep must see ALL of their own direct orders, whatever case their HR_ID was stored in.
 *
 * `access.hrId` is lower-cased on the way in (`normalizeHrId` -> `canonicalHrIdKey` -> toLowerCase),
 * but `direct_order_requests.requester_hr_id` and `direct_order_pharmacies.created_by_hr_id` keep
 * whatever case the submitting session happened to have. Production on 2026-08-23: 36 of 50 request
 * rows and 40 of 41 pharmacy rows lower-case, the rest upper — and the SAME person appears both
 * ways (B-154, B-12, B-94, AI-0007).
 *
 * So `.eq("requester_hr_id", access.hrId)` silently hid 14 of 50 orders (EGP 522,282.50) from the
 * reps who submitted them. B-74 saw NONE of his two, worth EGP 266,112 — his "My direct orders"
 * page was simply empty. Nothing errored; the list just came back short, which is the failure mode
 * nobody reports as a bug.
 *
 * Every hr-id filter in this module must therefore expand through `hrIdLookupKeys`.
 */

const HR_ID_COLUMNS = ["requester_hr_id", "created_by_hr_id"];
const DIRECT_ORDERS_DIR = "src/lib/direct-orders";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

export async function runDirectOrdersHrIdCaseTests() {
  // The helper is what makes the fix work: it must yield BOTH cases, or the .in() filters below
  // are no better than the .eq() they replaced.
  for (const [input, expected] of [["b-74", "B-74"], ["B-74", "b-74"], ["ai-0007", "AI-0007"]] as const) {
    const keys = hrIdLookupKeys(input);
    assert.ok(
      keys.includes(expected),
      `hrIdLookupKeys(${JSON.stringify(input)}) must include ${JSON.stringify(expected)} — ` +
        "a rep's orders are stored in both cases and all of them are theirs",
    );
  }

  // Case is the ONLY thing that may differ: a lookup must never widen to a different person.
  assert.ok(!hrIdLookupKeys("b-74").includes("B-7"), "hrIdLookupKeys must not produce a prefix of another HR_ID");
  assert.equal(hrIdLookupKeys("").length, 0, "an empty HR_ID must produce no keys — never an unfiltered query");

  // No hr-id filter in the module may compare exactly. Covers both the query-builder form
  // (`.eq("requester_hr_id", …)`) and the PostgREST `.or()` string form (`created_by_hr_id.eq.…`).
  const offenders: string[] = [];
  for (const file of sourceFiles(DIRECT_ORDERS_DIR)) {
    if (file.endsWith(".test.ts")) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const column of HR_ID_COLUMNS) {
        if (line.includes(`.eq("${column}"`) || line.includes(`${column}.eq.`)) {
          offenders.push(`${file}:${index + 1}  ${line.trim()}`);
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "direct-orders must filter hr-id columns with .in(hrIdLookupKeys(...)), never an exact match — " +
      `an exact match hides the rows stored in the other case:\n${offenders.join("\n")}`,
  );
}
