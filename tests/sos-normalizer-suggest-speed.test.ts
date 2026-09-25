import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { keysetRanges } from "../src/lib/supabase/paginated.ts";
import { stripComments } from "./support/comment-strip.ts";

// AI suggest and Auto-map send a distributor file's customers in groups (20 a request in #3862; since
// 2026-09-18, 100 a request for the free pass and 60 pharmacies for the AI pass), so everything the
// customer pipeline loads is paid once per group — 26 times for a file of 520 customers at 20. On
// 2026-09-15 two loads were more than half of each 14-second request:
//
//   3.5 s  loadSalesReferenceData() paged its customer→brick crosswalk, 70 offset pages over the
//          customer map, for a pipeline that reads only the brick master from it;
//   4.0 s  the customer map itself, walked 1,000 rows at a time on ONE cursor.
//
// The map is now read by concurrent walks over contiguous id ranges. That split is exactly where a
// silent row loss would come from — a row between two ranges is never read, and nothing fails — so
// the ranges are checked id by id, at and around every cut.

/** Strip comments before asserting on code — the explanations name the calls they replaced. */
function code(source: string): string {
  return stripComments(source);
}

function rangesHolding(ranges: ReturnType<typeof keysetRanges>, id: number): number {
  return ranges.filter((range) => (range.from === null || id >= range.from) && (range.below === null || id < range.below)).length;
}

export function runSosNormalizerSuggestSpeedTests() {
  // ── 1. The concurrent walks leave no gap and read no row twice ─────────────
  {
    // Production's quartile ids on 2026-09-15, handed over out of order, repeated, and with the NaN a
    // probe returns when the map shrank under it.
    const ranges = keysetRanges([483698, 403729, Number.NaN, 735449, 483698]);
    for (const id of [1, 384661, 403728, 403729, 403730, 483697, 483698, 483699, 735448, 735449, 735450, 755400, 9_000_000]) {
      assert.equal(rangesHolding(ranges, id), 1, `id ${id} must be read by exactly one walk`);
    }
    // ...and the NaN and the repeated cut open no range of their own.
    assert.deepEqual(ranges, [
      { below: 403729, from: null },
      { below: 483698, from: 403729 },
      { below: 735449, from: 483698 },
      { below: null, from: 735449 },
    ]);
    assert.deepEqual(keysetRanges([]), [{ below: null, from: null }], "a map read by one walk must not be bounded at all");
  }

  // ── 2. The customer pipeline never pays for the crosswalk it does not read ──
  {
    const files = [
      "src/lib/sales/normalizer/customer-suggest.ts",
      "app/api/sales/normalizer/mappings/ai-suggest/route.ts",
    ];
    for (const file of files) {
      const calls = code(readFileSync(join(process.cwd(), file), "utf8")).match(/loadSalesReferenceData\([^)]*\)/g) ?? [];
      assert.ok(calls.length > 0, `${file} no longer loads the reference data — update this guard`);
      for (const call of calls) {
        assert.match(call, /includeCustomerBricks: false/, `${file} pages the whole customer→brick crosswalk on every request: ${call}`);
      }
    }
  }

  // ── 3. The map is split by keysetRanges, not by hand-built bounds ───────────
  {
    const suggest = code(readFileSync(join(process.cwd(), "src/lib/sales/normalizer/customer-suggest.ts"), "utf8"));
    assert.match(suggest, /keysetRanges\(/, "the customer map must be split into ranges by keysetRanges, which is checked above");
  }

  console.log("sos normalizer suggest speed guard passed (contiguous customer-map ranges, no crosswalk per group)");
}
