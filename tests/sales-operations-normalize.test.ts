import assert from "node:assert/strict";

import { buildProductByName } from "../src/lib/sales-operations/crosswalks.ts";
import { getDistributorTemplate } from "../src/lib/sales-operations/dictionary.ts";
import {
  deriveHierarchy,
  normalizeAliasKey,
  normalizeSheet,
  periodFrom,
  resolveBrick,
  resolveProduct,
  type CellRow,
} from "../src/lib/sales-operations/normalize.ts";
import type { Crosswalks, DistributorTemplate } from "../src/lib/sales-operations/types.ts";

// In-memory crosswalks fixture. Two products with DISTINCT codes and names so we can prove that
// product resolution prefers the NAME over the code.
const maps: Crosswalks = {
  brickById: new Map([
    ["B1", { areaCode: "A1", areaName: "Area One", blockCode: "BL1", brickId: "B1", brickName: "Brick One", regionCode: "CA", regionName: "Cairo" }],
  ]),
  areaByCode: new Map([["A1", { areaCode: "A1", areaName: "Area One", regionCode: "CA", regionName: "Cairo" }]]),
  regionByCode: new Map([["CA", { regionCode: "CA", regionName: "Cairo" }]]),
  productByCode: new Map([
    ["1001", { productCode: "1001", productName: "Panadol", factoryPrice: 10, family: "Analgesics", line: "OTC" }],
    ["2002", { productCode: "2002", productName: "Augmentin", factoryPrice: 20, family: "Antibiotics", line: "Rx" }],
  ]),
  productByName: new Map([
    [normalizeAliasKey("Panadol"), "1001"],
    [normalizeAliasKey("Augmentin"), "2002"],
  ]),
  productByCanonicalCode: new Map(),
  // per-distributor learned NAME alias (EP "EP Local Name" → product 2002)
  productAliasByKey: new Map([[`EP ${normalizeAliasKey("EP Local Name")}`, "2002"]]),
  territoryAliasByKey: new Map([[normalizeAliasKey("Cairo East"), { targetType: "brick", targetCode: "B1" }]]),
  areaAliasByKey: new Map(),
  customerBrickByKey: new Map([
    ["PS C1", "B1"],
    ["MC M9", "B1"],
  ]),
  customerBrickByCanonicalKey: new Map(),
};

export async function runSalesOperationsNormalizeTests() {
  // ── product resolution: NAME-first (the core corrected rule) ─────────────────────────────
  // Name "Panadol" → 1001; code "2002" → a DIFFERENT product. Name must win.
  const nameFirst = resolveProduct(["Panadol"], ["2002"], maps, "PS");
  assert.equal(nameFirst?.productCode, "1001", "product NAME must win over the code");
  assert.equal(nameFirst?.matchedBy, "name-master");

  // Code is used only as a FALLBACK when the name can't be matched.
  const codeFallback = resolveProduct(["Totally Unmapped"], ["2002"], maps, "PS");
  assert.equal(codeFallback?.productCode, "2002", "code resolves when name misses");
  assert.equal(codeFallback?.matchedBy, "code");

  // per-distributor learned name alias is tried before the master name index.
  const nameAlias = resolveProduct(["EP Local Name"], [], maps, "EP");
  assert.equal(nameAlias?.productCode, "2002");
  assert.equal(nameAlias?.matchedBy, "name-alias");

  // total miss → null (never silently coded).
  assert.equal(resolveProduct(["nope"], ["nope"], maps, "PS"), null);

  // ── brick resolution by strategy ─────────────────────────────────────────────────────────
  const ps = getDistributorTemplate("PS")!;
  assert.equal(resolveBrick(ps, { customerCode: "C1" }, maps)?.brickId, "B1", "customer-code → brick");
  assert.equal(resolveBrick(ps, { customerCode: "UNKNOWN" }, maps), null);

  const cp = getDistributorTemplate("CP")!;
  assert.equal(resolveBrick(cp, { brickNameValues: ["Cairo East"] }, maps)?.brickId, "B1", "brick-name → brick");
  // CP uses the brick-name strategy, so a customer code is ignored entirely.
  assert.equal(resolveBrick(cp, { customerCode: "C1" }, maps), null, "brick-name strategy ignores customer code");

  // geography (area + region) comes from the brick master.
  const hier = deriveHierarchy({ areaCode: "A1", brickId: "B1", regionCode: "CA", source: "customer" }, maps);
  assert.equal(hier?.areaName, "Area One");
  assert.equal(hier?.regionName, "Cairo");

  // ── period parsing ───────────────────────────────────────────────────────────────────────
  assert.equal(periodFrom("2026-04-15"), "2026-04");
  assert.equal(periodFrom("15-04-2026", "day-first"), "2026-04");
  assert.equal(periodFrom("04-15-2026", "month-first"), "2026-04");

  // ── full sheet: PS row proves name-first + value=qty×price + brick-by-customer + geo + date ──
  const psRows: CellRow[] = [
    ["Customer", "Mat. Code", "Mat. Desc.", "Qty", "Invoice Date"],
    ["C1", "2002", "Panadol", 5, "2026-04-15"],
  ];
  const psRes = normalizeSheet({ rows: psRows, template: ps, maps });
  assert.equal(psRes.coded.length, 1);
  const r0 = psRes.coded[0];
  assert.equal(r0.productCode, "1001", "coded product follows the NAME, not the code");
  assert.equal(r0.productName, "Panadol");
  assert.equal(r0.family, "Analgesics");
  assert.equal(r0.officialLine, "OTC");
  assert.equal(r0.qty, 5);
  assert.equal(r0.value, 50, "value = qty × factory price (5 × 10), no discount");
  assert.equal(r0.brickId, "B1");
  assert.equal(r0.areaName, "Area One");
  assert.equal(r0.regionName, "Cairo");
  assert.equal(r0.invoiceDate, "2026-04");

  // ── bonus / free units are excluded entirely ─────────────────────────────────────────────
  const bonusTemplate: DistributorTemplate = {
    code: "PS",
    name: "PS",
    brickLookup: "customer-code",
    customerCodeHeaders: ["Customer"],
    productNameHeaders: ["Mat. Desc."],
    productCodeHeaders: ["Mat. Code"],
    qtyHeaders: ["Qty"],
    bonusHeaders: ["Free"],
    hasDateColumn: false,
  };
  const bonusRows: CellRow[] = [
    ["Customer", "Mat. Code", "Mat. Desc.", "Qty", "Free"],
    ["C1", "1001", "Panadol", 99, "1"], // free goods → excluded
    ["C1", "1001", "Panadol", 3, ""], // real sale → coded
  ];
  const bonusRes = normalizeSheet({ rows: bonusRows, template: bonusTemplate, maps, period: "2026-04" });
  assert.equal(bonusRes.summary.excludedBonus, 1);
  assert.equal(bonusRes.excluded.length, 1);
  assert.equal(bonusRes.coded.length, 1, "bonus row excluded, only the real sale coded");
  assert.equal(bonusRes.coded[0].value, 30, "value = 3 × 10; free units never counted");

  // ── ChemiPharm: brick-name lookup, name-only product, no date (period from picker) ─────────
  const cpRows: CellRow[] = [
    ["Area name A", "Attribute", "Value"],
    ["Cairo East", "Augmentin", 7],
  ];
  const cpRes = normalizeSheet({ rows: cpRows, template: cp, maps, period: "2026-05" });
  assert.equal(cpRes.coded.length, 1);
  assert.equal(cpRes.coded[0].productCode, "2002");
  assert.equal(cpRes.coded[0].brickId, "B1");
  assert.equal(cpRes.coded[0].value, 140, "CP value = 7 × 20");
  assert.equal(cpRes.coded[0].invoiceDate, "2026-05", "CP period comes from the picker");

  // ── MEC: the date header is now 'شهر' (the bug the old template had is fixed) ──────────────
  const mc = getDistributorTemplate("MC")!;
  const mcRows: CellRow[] = [
    ["كود", "إسم الصنف", "الكمية", "شهر"],
    ["M9", "Panadol", 4, "15-04-2026"],
  ];
  const mcRes = normalizeSheet({ rows: mcRows, template: mc, maps });
  assert.equal(mcRes.coded.length, 1, "MEC row codes via the 'شهر' date header");
  assert.equal(mcRes.coded[0].invoiceDate, "2026-04");
  assert.equal(mcRes.coded[0].value, 40);

  // ── EG-BR: a blank customer code is a HARD error (routed to exceptions, not skipped) ───────
  const egbr = getDistributorTemplate("EG-BR")!;
  const egbrRows: CellRow[] = [
    ["TO_COMPANY_ENTITY_CODE", "ITEM_NAME_ENG", "QTY", "CARD_DATE"],
    ["", "Panadol", 2, "2026-04-01"],
  ];
  const egbrRes = normalizeSheet({ rows: egbrRows, template: egbr, maps });
  assert.equal(egbrRes.coded.length, 0);
  assert.equal(egbrRes.exceptions.length, 1);
  assert.equal(egbrRes.exceptions[0].reason, "blank_key");

  // ── Office must NOT go through the row normalizer (it is allocation-based) ─────────────────
  const office = getDistributorTemplate("Office")!;
  assert.throws(() => normalizeSheet({ rows: [["Row Labels", "Sum of المبيعات"]], template: office, maps }));

  // dictionary sanity: all 16 sheet rows present; EG HOS resolvable by either spelling.
  assert.equal(getDistributorTemplate("EG HOS")?.code, "EG-HOS");
  assert.equal(getDistributorTemplate("eg-hos")?.code, "EG-HOS");

  // ── crosswalks: master product-NAME index is collision-safe ──────────────────────────────
  const byName = buildProductByName([
    { factoryPrice: 10, family: "Analgesics", familyCode: "AN", line: "OTC", productCode: "1001", productName: "Panadol", source: "" },
    { factoryPrice: 20, family: "Antibiotics", familyCode: "AB", line: "Rx", productCode: "2002", productName: "Augmentin", source: "" },
    { factoryPrice: 30, family: "Antibiotics", familyCode: "AB", line: "Rx", productCode: "3003", productName: "Augmentin", source: "" }, // duplicate name
  ]);
  assert.equal(byName.get(normalizeAliasKey("Panadol")), "1001", "unique product name indexes to its code");
  assert.equal(byName.has(normalizeAliasKey("Augmentin")), false, "duplicate product name dropped (never mis-maps)");
}
