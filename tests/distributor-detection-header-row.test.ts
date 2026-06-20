import assert from "node:assert/strict";

import { collectKnownHeaderAliases, pickBestHeaderRow } from "../src/lib/sales/distributor-detection.ts";
import type { DetectionProfile } from "../src/lib/sales/normalizer/detect-distributor.ts";

// Regression for the EGD Branch (EG-BR) "couldn't auto-recognize" bug: that export's real header row
// has blank columns that every data row fills, so the header row is NARROWER than the data rows. The
// old "widest row wins" rule grabbed a data row, detection saw pharmacy names / quantities instead of
// column titles, and returned best=null. pickBestHeaderRow must prefer the row with the most KNOWN
// header names, and only fall back to the widest row for unknown files.

function picksHeaderRowEvenWhenNarrowerThanDataRows() {
  const known = new Set(["item_code", "item_name_eng", "qty", "to_company_entity_code", "card_date"]);
  // header row: 7 cells, 5 known headers
  const headerRow = ["TO_COMPANY_ENTITY_NAME", "QTY", "ITEM_NAME_ENG", "TO_COMPANY_ENTITY_CODE", "CARD_DATE", "ITEM_CODE", "VALUE"];
  // data row: 9 cells (wider!), 0 known headers
  const dataRow = ["صيدلية", "7", "0", "1", "TEBOFORTIN", "60229", "branch", "866.25", "3041162"];
  assert.deepEqual(pickBestHeaderRow([headerRow, dataRow], known), headerRow);
}

function fallsBackToWidestWhenNoKnownHeaders() {
  const a = ["x", "y"];
  const b = ["p", "q", "r"];
  assert.deepEqual(pickBestHeaderRow([a, b]), b); // no known set → old "most non-empty cells" behaviour
  assert.deepEqual(pickBestHeaderRow([a, b], new Set()), b); // empty known set → same fallback
}

function tieOnKnownPrefersWiderThenEarlier() {
  const known = new Set(["a", "b"]);
  const narrow = ["a", "b"]; // 2 known, 2 cells
  const wide = ["a", "b", "zzz"]; // 2 known, 3 cells → wins on width
  assert.deepEqual(pickBestHeaderRow([narrow, wide], known), wide);
  const first = ["a", "x"];
  const second = ["a", "y"]; // equal known + equal width → earliest scanned wins
  assert.deepEqual(pickBestHeaderRow([first, second], known), first);
}

function collectKnownAliasesNormalizes() {
  const profiles: DetectionProfile[] = [
    {
      distributorCode: "EG-BR",
      distributorName: "EGD Branch",
      requiredGroups: [["ITEM_CODE", "ITEM_NAME_ENG"], ["QTY"], ["TO_COMPANY_ENTITY_CODE"]],
      optionalGroups: [["CARD_DATE"], ["Discount%"]],
    },
  ];
  const set = collectKnownHeaderAliases(profiles);
  for (const expected of ["item_code", "item_name_eng", "qty", "to_company_entity_code", "card_date", "discount%"]) {
    assert.ok(set.has(expected), `known aliases should include ${expected}`);
  }
}

export function runDistributorDetectionHeaderRowTests() {
  picksHeaderRowEvenWhenNarrowerThanDataRows();
  fallsBackToWidestWhenNoKnownHeaders();
  tieOnKnownPrefersWiderThenEarlier();
  collectKnownAliasesNormalizes();
}
