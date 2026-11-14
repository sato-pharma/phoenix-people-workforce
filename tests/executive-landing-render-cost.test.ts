import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getMergedAreaName, hasClosingAreaMerges } from "../src/lib/sales/closing-area-merges.ts";

/**
 * The SFE Manager overview cannot freeze the server on the canonical sales rows.
 *
 * 🔴 THE INCIDENT (13 Nov 2026, 12:33 Cairo, read from production's logs on 14 Nov): the SFE Manager
 * opened his overview; the page took 29 s, then 11 s, and the server froze for 1.0 s with no
 * background job running. Profiled on the laptop against production: one build froze it for
 * 1,380–1,494 ms, and 1.3 s of that was `currentClosingPeriod` building a NEW Intl.DateTimeFormat
 * for each of the ~9,000 canonical sales rows, because the dashboard names each row's territory
 * through getMergedAreaName with no period. The sales dashboard's `aggregate` also copied a whole
 * group for every row it added. After both fixes the longest freeze was 460–551 ms over three
 * builds, and all seven results compared byte for byte (the canonical rows, the sales dashboard
 * for SFE Manager, CEO, Super Admin and Finance Manager, and both halves of the SFE overview).
 *
 * Pinned here: asking for "today's month" builds no formatter, its answer is unchanged, and the
 * grouping appends in place.
 */
export async function runExecutiveLandingRenderCostTests() {
  // ---- 1. thousands of period-less lookups build NO date formatter ----
  {
    const Original = Intl.DateTimeFormat;
    let built = 0;
    const Counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built += 1;
      return new Original(...args);
    } as unknown as typeof Intl.DateTimeFormat;
    Object.assign(Counting, Original);
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Counting;
    try {
      for (let i = 0; i < 2_000; i += 1) {
        getMergedAreaName("cns", "UE7");
        hasClosingAreaMerges("pedia");
      }
    } finally {
      (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Original;
    }
    assert.equal(built, 0, "today's Cairo month is read with ONE formatter, never a new one per row — the 13 Nov freeze");
  }

  // ---- 2. and the answer is still today's month in Cairo, read live ----
  {
    // Qena's CNS fold runs from 2026-01 with no end, so "now" always keeps it.
    assert.equal(getMergedAreaName("cns", "UE7"), "Qena", "a period-less lookup still answers for today");
    assert.equal(getMergedAreaName("cns", "UE7", "2025-12"), null, "a month before the rule still sees no fold");
    // Pedia's Fayoum fold ended with 2026-08: no merge for today, the merge for August itself.
    assert.equal(hasClosingAreaMerges("pedia"), false, "today is past Pedia's last folded month");
    assert.equal(hasClosingAreaMerges("pedia", "2026-08"), true, "and August itself still folds");
  }

  // ---- 3. the sales dashboard groups by appending in place ----
  {
    const service = readFileSync(path.join(process.cwd(), "src/lib/sales/service.ts"), "utf8");
    const body = service.match(/function aggregate<T>\([\s\S]*?\n}\n/)?.[0] ?? "";
    assert.ok(body.length > 0, "the dashboard's aggregate() is where this test expects it");
    assert.match(body, /group\.push\(item\)/, "a row joins its group in place");
    assert.doesNotMatch(body, /\[\.\.\.\(map\.get\(key\)/, "never a copy of the whole group per row");
  }
}
