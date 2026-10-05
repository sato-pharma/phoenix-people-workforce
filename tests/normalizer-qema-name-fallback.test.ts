import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRows } from "@/lib/sales/normalizer/engine";
import { rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";

// EL QEMA — "map by id if not available fall back to name" (owner, 2026-10-05).
//
// El Qema's distributor stopped filling the customer-code column (`ACCOUNT_ID`) and the product-code
// column (`رقم الصنف`) in some monthly exports. The September file `exclusive - El Qema9.xlsx` carried
// both HEADERS but left every data cell blank — only the customer NAME (`الاسم`) and product NAME
// (`الصنف`) were populated. El Qema has no area/governorate column, so the account code was the SOLE
// key to a brick; with it blank, all 70 real sales rows had no location at all and were silently
// skipped as footer/summary rows. Nothing imported.
//
// The fix: the QM profile sets `customerKeyNameFallback`. When the code cell is blank, the engine uses
// the NAME as the customer key — so the row resolves through the SAME customer→brick crosswalk, and an
// unmapped name surfaces as a mappable customer unknown instead of being dropped. The code still wins
// when it is present, and a row with neither a code nor a name stays a footer. Other distributors,
// which do NOT set the flag, are unchanged: a blank code is still a footer row for them.

const BRICK_ID = "DK101";
const PRODUCT = "LA001";
const FACTORY_PRICE = 330;
const PRODUCT_NAME = "Lacto 2 Advance";
// A real El Qema product string: name only, with the distributor's own pack/price suffix.
const RAW_PRODUCT = "لاكتو لبن 2 ادفانس*** باكو 12 س330ج";
// A customer the owner has already mapped by name (the September file carries the name, no code).
const MAPPED_NAME = "فارم بيور شبين جمله";

function crosswalks(): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([[BRICK_ID, {
      areaCode: "DK1", areaName: "Delta 1", blockCode: "DK1-1", brickId: BRICK_ID, brickName: "Shebin",
      regionCode: "DK", regionName: "Delta",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    // El Qema has no territory column: every row places through the customer→brick map. Here the key is
    // the NAME, not a code — exactly the row the fallback produces. The engine looks it up by
    // `${distributor} ${normalizeCodeKey(name)}`, so this is keyed the same way.
    customerBrickByKey: new Map([
      [`${normalizeCodeKey("QM")} ${normalizeCodeKey(MAPPED_NAME)}`, BRICK_ID],
      // A code-keyed row too, to prove the code still wins when it is present.
      [`${normalizeCodeKey("QM")} ${normalizeCodeKey("1001")}`, BRICK_ID],
    ]),
    // Product resolves by NAME (رقم الصنف is blank in these files). Alias keyed under QM.
    productAliasByKey: new Map([
      [`${normalizeCodeKey("QM")} ${normalizeAliasKey(RAW_PRODUCT)}`, PRODUCT],
    ]),
    productByCanonicalCode: new Map(),
    productByCode: new Map([[PRODUCT, { productCode: PRODUCT, productName: PRODUCT_NAME, factoryPrice: FACTORY_PRICE, line: "Pedia" }]]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map(),
  };
}

function sheetOf(headers: string[], rows: unknown[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("1 ادفانس");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

function qemaProfile(): DistributorProfile {
  const p = rawProfileForDistributor("QM");
  assert.ok(p, "the QM profile must exist — this test reads the real one");
  return p;
}

const bySheetRow = (rows: CodedRow[], rowNumber: number) => rows.find((r) => r.rawRowNumber === rowNumber);

// The September El Qema columns, in the file's own order. ACCOUNT_ID / رقم الصنف present but blank.
const QEMA_HEADERS = ["الاسم", "الكمية", "الصنف", "رقم الفاتورة", "التاريخ", "الاجمالى", "اجمالى جمهور", "رقم الصنف", "ACCOUNT_ID"];
//                      name       qty       product   invoice        date        total        public         code(blank)  account(blank)

export function runNormalizerQemaNameFallbackTests() {
  const result = normalizeRows(
    sheetOf(QEMA_HEADERS, [
      // 2: blank ACCOUNT_ID, a MAPPED name → must resolve to the brick via the name key.
      [MAPPED_NAME, 96, RAW_PRODUCT, "29761", "27/09/2026", 25977.6, 25977.6, "", ""],
      // 3: blank ACCOUNT_ID, an UNMAPPED name → must surface as a mappable customer unknown.
      ["صيدلية لم تربط بعد", 12, RAW_PRODUCT, "29415", "24/09/2026", 3286.8, 3286.8, "", ""],
      // 4: a real footer — no code AND no name → still skipped as a blank-customer row.
      ["", 999, RAW_PRODUCT, "29999", "24/09/2026", 0, 0, "", ""],
      // 5: ACCOUNT_ID PRESENT (and a name too) → the CODE wins; fallback never consulted.
      [MAPPED_NAME, 50, RAW_PRODUCT, "29400", "23/09/2026", 13200, 13200, "", "1001"],
    ]),
    qemaProfile(),
    crosswalks(),
  );

  // HEADLINE: a blank-ACCOUNT_ID row with a mapped NAME imports onto the mapped brick at its paid units.
  const mapped = bySheetRow(result.coded, 2);
  assert.ok(mapped, "an El Qema row with a blank ACCOUNT_ID but a mapped customer NAME must import, not be skipped as a footer");
  assert.equal(mapped.qty, 96, "the mapped-name row imports its 96 packs");
  assert.equal(mapped.brickId, BRICK_ID, "the name resolves through the customer→brick crosswalk to the right brick");
  assert.equal(mapped.value, 96 * FACTORY_PRICE, "value is paid units × factory price");

  // The code still wins when it is present: row 5 places via ACCOUNT_ID 1001, not the name.
  const byCode = bySheetRow(result.coded, 5);
  assert.ok(byCode, "a row WITH an ACCOUNT_ID still imports via the code");
  assert.equal(byCode.clientCode, "1001", "the code is used as the key when present — the fallback is for a BLANK code only");
  assert.equal(byCode.qty, 50);

  // An UNMAPPED name is a mappable customer unknown — keyed by the name — NOT a silently-dropped footer.
  const unmapped = result.exceptions.find((e) => e.rawRowNumber === 3);
  assert.ok(unmapped, "a blank-ACCOUNT_ID row with an unmapped name must reach the exceptions list, not be dropped");
  assert.equal(unmapped.rawCustomerCode, "صيدلية لم تربط بعد", "the customer NAME is the raw key the operator maps — so it appears as a customer unknown");
  assert.equal(unmapped.reason, "brick", "product resolves by name; only the brick is missing");
  assert.ok(
    !result.blankCustomerRows.some((r) => r.rawRowNumber === 3),
    "the unmapped-name row must NOT be counted as a blank-customer footer — that is the silent drop this fixes",
  );

  // A genuine footer (no code AND no name) is still a blank-customer row — the fallback rescues only
  // rows that actually carry a name.
  assert.ok(
    result.blankCustomerRows.some((r) => r.rawRowNumber === 4),
    "a row with neither a code nor a name stays a blank-customer footer",
  );
  assert.ok(!bySheetRow(result.coded, 4), "the nameless footer is never coded");

  // SCOPING: the SAME file through a profile WITHOUT the flag skips the named-but-codeless rows as
  // footers — proving the behaviour is El Qema's alone and no other distributor is affected.
  const noFallback: DistributorProfile = { ...qemaProfile(), customerKeyNameFallback: false };
  const strict = normalizeRows(
    sheetOf(QEMA_HEADERS, [
      [MAPPED_NAME, 96, RAW_PRODUCT, "29761", "27/09/2026", 25977.6, 25977.6, "", ""],
    ]),
    noFallback,
    crosswalks(),
  );
  assert.equal(strict.coded.length, 0, "without the flag, a blank-code row is NOT rescued by its name");
  assert.ok(
    strict.blankCustomerRows.some((r) => r.rawRowNumber === 2),
    "without the flag, the named-but-codeless row stays a blank-customer footer — other distributors are unchanged",
  );
}
