import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  mergeMasterMapCustomers,
  mergeMasterMapCustomersYielding,
  type MasterMapCustomerInput,
} from "../src/lib/sales/master-map/customer-merge.ts";
import { normalizeCustomerName } from "../src/lib/sales/customer-channel.ts";
import { buildMasterMapTree, buildMasterMapTreeYielding } from "../src/lib/sales/master-map/tree.ts";
import { stripComments } from "./support/comment-strip.ts";

// 🔴 A NEW SERVER'S FIRST MASTER MAP CHECK FROZE THE WHOLE SITE (14 Nov 2026). With no cached tree, the
// sheet's first hourly plan merged ~105,000 distributor rows into ~98,500 shops in ONE block — 1.6–2.6 s on
// production at 03:04, 04:10 and 05:14 Cairo, each the only heavy request in its minute, with every page on
// the site waiting. The merge now pauses every 2,000 rows inside the web server, and folds each name once.
// Measured on that morning's production rows: the cold plan's longest block 2,953 → 369 ms on the laptop,
// the same 98,503 shops in the same order, and every tab hash unchanged (a moved hash repaints the sheet).

function read(path: string) {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

/** Rows shaped like the real ones: shared names across distributors, blank names, untidy whitespace. */
function rows(count: number): MasterMapCustomerInput[] {
  const spellings = [
    "صيدلية النور",
    "صيدليه  النور",
    "\tAl Nour Pharmacy ",
    "AL NOUR PHARMACY",
    "",
    " ",
    "مخزن الشفاء",
    "Hospital El Salam  - ص مستشفى",
  ];
  const addresses = ["12 Corniche", " 12  Corniche\n", "", "Corniche, Minia"];
  return Array.from({ length: count }, (_, index) => ({
    address: addresses[index % addresses.length],
    brickId: `B-${index % 37}`,
    customerCode: String(1000 + (index % 911)),
    customerName: spellings[index % spellings.length] || null,
    distributorCode: ["A", "B", "C"][index % 3],
    source: index % 5 === 0 ? " admin-import " : "admin-import",
  }));
}

export async function runMasterMapColdBuildYieldsTests() {
  const input = rows(6_500);

  // 1. Same shops, in the same order, whichever way the merge runs.
  const straight = mergeMasterMapCustomers(input);
  let pauses = 0;
  const yielded = await mergeMasterMapCustomersYielding(input, async () => {
    pauses += 1;
  });
  assert.deepEqual(yielded, straight, "the yielding merge must hand back exactly the shops the straight merge does, in order");
  assert.ok(pauses >= 3 * Math.floor(6_500 / 2_000), `the merge must pause between slices of rows — got ${pauses} pauses for 6,500 rows`);

  // 2. The whitespace shortcut changes no text: every kept name, address and source reads exactly as the
  //    old one-regex tidy made it.
  const tidy = (value: string | null) => String(value ?? "").replace(/\s+/g, " ").trim();
  const names = new Set(input.map((row) => tidy(row.customerName)).filter(Boolean));
  for (const shop of straight) {
    if (shop.name) assert.ok(names.has(shop.name), `"${shop.name}" is not a tidied spelling of any row's name`);
    assert.equal(shop.name, tidy(shop.name), "a name must come out tidied");
    assert.equal(shop.address, tidy(shop.address), "an address must come out tidied");
    for (const source of shop.sources) assert.equal(source, tidy(source), "a source must come out tidied");
  }
  assert.ok(straight.some((shop) => shop.address === "12 Corniche"), "an address with stray whitespace is tidied, not dropped");

  // 3. Names that fold alike still merge, and a nameless row still never does.
  const nour = straight.filter((shop) => normalizeCustomerName(shop.name) === normalizeCustomerName("صيدلية النور"));
  assert.ok(nour.length > 0, "the fixture holds the shared name");
  assert.ok(straight.every((shop) => shop.hasName || shop.codes.length === 1), "a nameless row is never merged with another");

  // 4. The tree: the yielding build is the straight build.
  const source = {
    areas: [{ areaCode: "UE1", areaName: "Minia 1", regionCode: "UE" }],
    bricks: Array.from({ length: 37 }, (_, index) => ({ areaCode: "UE1", brickId: `B-${index}`, brickName: `Brick ${index}` })),
    customers: input,
    regions: [{ regionCode: "UE", regionName: "Upper Egypt" }],
  };
  let treePauses = 0;
  const tree = await buildMasterMapTreeYielding(source, async () => {
    treePauses += 1;
  });
  assert.deepEqual(tree, buildMasterMapTree(source), "the yielding tree must equal the straight tree");
  assert.ok(treePauses > pauses / 2, "the yielding tree must pause through its merge");

  // 5. The web server takes the yielding build, and awaits it with the payload's own pause.
  const payload = read("src/lib/sales/master-map/payload.ts");
  assert.match(payload, /buildTree: buildMasterMapTreeYielding,/, "the server's Master Map payload must build its tree with the yielding build");
  assert.match(payload, /const tree = await deps\.buildTree\(source, deps\.pause\);/, "the payload must hand the build its pause and await it");
  assert.doesNotMatch(payload, /buildTree: buildMasterMapTree,/, "the one-block build must never be the server's again");
}
