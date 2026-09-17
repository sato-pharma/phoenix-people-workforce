import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

// loadSalesReferenceData() pages the whole customer→brick crosswalk by default — every active row of
// source_of_sales_customer_map, 1,000 at a time on OFFSET pages. On 2026-09-15 that was 69,217 rows:
// 70 round trips and about 3.5 s per call, and that OFFSET page was the busiest read on the table
// (30,994 calls between 9 and 15 September, 23.6 ms mean). The crosswalk is read in exactly one
// place, buildReferenceMaps, for the Source-of-Sales import's brick auto-fill.
//
// Both halves are pinned:
//   1. callers that read only the name masters skip the crosswalk and never reach it — loaded without
//      it, customerBricks is an EMPTY list, and nothing says so;
//   2. the import loaders keep it — without it a blank Brick ID stops filling from the customer map,
//      and nothing fails.

/** Code only — the comment beside each call names the crosswalk it skips. */
function read(file: string): string {
  return stripComments(readFileSync(join(process.cwd(), file), "utf8"));
}

function referenceDataCalls(source: string): string[] {
  return source.match(/loadSalesReferenceData\([^)]*\)/g) ?? [];
}

// Each reads the brick, area, region, product or distributor master and nothing else.
const SKIPS_THE_CROSSWALK = [
  "src/lib/sales/monthly-closing-comparison.ts",
  "src/lib/sales/normalizer/brick-centroids.ts",
  "src/lib/sales/normalizer/crosswalks.ts",
  "src/lib/sales/normalizer/customer-map.ts",
  "src/lib/sales/normalizer/service.ts",
  "src/lib/sales/recognize.ts",
];

// buildReferenceMaps and parseDistributorSalesWorkbookBuffer are private to the importer, so handing
// reference data to validateDistributorSalesWorkbookBuffer is the one way another file reaches the auto-fill.
const AUTO_FILL_ENTRY = /\b(?:validateDistributorSalesWorkbookBuffer|parseDistributorSalesWorkbookBuffer|buildReferenceMaps)\s*\(/;

// Each hands its references to parseDistributorSalesWorkbookBuffer, which builds the auto-fill index.
const KEEPS_THE_CROSSWALK = [
  "createSourceOfSalesUpload",
  "createSourceOfSalesUploadFromBuffer",
  "validateDistributorSalesFile",
];

export function runSalesReferenceCrosswalkCallersTests() {
  // ── 1. Name-master callers never page the crosswalk, and never reach it ─────
  for (const file of SKIPS_THE_CROSSWALK) {
    const source = read(file);
    const calls = referenceDataCalls(source);
    assert.ok(calls.length > 0, `${file} no longer loads the reference data — update this guard`);
    for (const call of calls) {
      assert.match(call, /includeCustomerBricks:\s*false/, `${file} pages the whole customer→brick crosswalk and never reads it: ${call}`);
    }
    assert.doesNotMatch(
      source,
      /\bcustomerBricks\b/,
      `${file} reads customerBricks from reference data loaded without it — that list is always empty there`,
    );
    assert.doesNotMatch(
      source,
      AUTO_FILL_ENTRY,
      `${file} hands reference data loaded without the crosswalk to the import parser — its brick auto-fill would find nothing`,
    );
  }

  // ── 2. The import's brick auto-fill keeps the crosswalk ─────────────────────
  {
    const importer = read("src/lib/sales/monthly-distributor-import.ts");
    assert.match(
      importer,
      /references\.customerBricks\b/,
      "the import no longer reads customerBricks — re-trace which callers still need the crosswalk",
    );
    for (const loader of KEEPS_THE_CROSSWALK) {
      const start = importer.indexOf(`export async function ${loader}(`);
      assert.ok(start >= 0, `${loader} is gone — update this guard`);
      const end = importer.indexOf("\nexport ", start + 1);
      const body = importer.slice(start, end === -1 ? undefined : end);
      assert.match(
        body,
        /(parse|validate)DistributorSalesWorkbookBuffer\(/,
        `${loader} no longer feeds the import parser — re-trace whether it still needs the crosswalk`,
      );
      const calls = referenceDataCalls(body);
      assert.equal(calls.length, 1, `${loader} must load the reference data exactly once`);
      assert.doesNotMatch(
        calls[0],
        /includeCustomerBricks:\s*false/,
        `${loader} feeds the import brick auto-fill and must keep the customer→brick crosswalk: ${calls[0]}`,
      );
    }
  }

  console.log("sales reference crosswalk callers guard passed (name-master callers skip the crosswalk; the import auto-fill keeps it)");
}
