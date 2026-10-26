import assert from "node:assert/strict";

import { suggestProduct } from "../src/lib/sales/normalizer/mapping.ts";
import { suggestProducts, type CatalogProduct, type KnownProductAlias, type ProductSuggestContext } from "../src/lib/sales/normalizer/product-suggest.ts";

// The live catalog's Tebofortin, Conviban and Rispadex products, names exactly as production holds them.
const catalog: CatalogProduct[] = [
  { code: "TE001", family: "Tebofortin", line: "CNS", name: "Tebofotin drops" },
  { code: "TE002", family: "Tebofortin", line: "CNS", name: "Tebofortine Forte 80" },
  { code: "TE003", family: "Tebofortin", line: "CNS", name: "Tebofortine 40 mg" },
  { code: "TE004", family: "Tebofortin", line: "CNS", name: "Tebofortin 240 mg max" },
  { code: "TE005", family: "Tebofortin", line: "CNS", name: "Tebofortin 120 mg Intens" },
  { code: "CO001", family: "Conviban", line: "CNS", name: "Conviban 50 mg" },
  { code: "CO002", family: "Conviban", line: "CNS", name: "Conviban 25mg/ml Syp" },
  { code: "CO003", family: "Conviban", line: "CNS", name: "Conviban 25 mg" },
  { code: "CO004", family: "Conviban", line: "CNS", name: "Conviban 100 mg" },
  { code: "RI001", family: "Rispadex", line: "CNS", name: "Rispadex 3 mg UPA" },
  { code: "RI002", family: "Rispadex", line: "CNS", name: "Rispadex 3 mg" },
  { code: "RI003", family: "Rispadex", line: "CNS", name: "Rispadex 1mg Syp" },
];

const distributorNames = new Map([
  ["IS", "Ibn Sina"],
  ["IS-T", "Ibn Sina Tender"],
  ["CP", "Chemipharm"],
  ["UP", "United Pharma"],
  ["EP", "Egydrug"],
]);

function ctx(distributorCode: string, aliases: KnownProductAlias[]): ProductSuggestContext {
  return { aliases, catalog, distributorCode, distributorNames };
}

export async function runProductSuggestTests() {
  // 1. A sister distributor's item code settles it: Ibn Sina Tender's 624044 is Ibn Sina's 624044.
  {
    const aliases = [{ alias: "624044", distributorCode: "IS", productCode: "TE003" }];
    const [s] = await suggestProducts([{ raw: "624044" }], ctx("IS-T", aliases), null);
    assert.equal(s?.code, "TE003");
    assert.equal(s?.source, "sister_code");
    assert.equal(s?.confidence, 97);
    assert.match(s?.reason ?? "", /Ibn Sina already maps item 624044 to Tebofortine 40 mg/);
  }

  // 2. A sister's IGNORE travels too — the answer is "keep as ignored".
  {
    const aliases = [{ alias: "583450", distributorCode: "IS", productCode: "IGNORE" }];
    const [s] = await suggestProducts([{ raw: "583450" }], ctx("IS-T", aliases), null);
    assert.equal(s?.code, "IGNORE");
    assert.equal(s?.source, "sister_code");
  }

  // 3. The same item code at an UNRELATED distributor is not evidence.
  {
    const aliases = [{ alias: "624044", distributorCode: "UP", productCode: "TE003" }];
    const [s] = await suggestProducts([{ raw: "624044" }], ctx("IS-T", aliases), null);
    assert.equal(s?.code, null);
  }

  // 4. A wrong mapping elsewhere is held to the item's own strength: Chemipharm's "TEBOFORTIN 40MG/30TAB"
  //    points at the 120 mg Intens; the 40 mg mapping at United Pharma wins.
  {
    const aliases = [
      { alias: "TEBOFORTIN 40MG/30TAB", distributorCode: "CP", productCode: "TE005" },
      { alias: "TEBOFORTIN 40MG/30TAB", distributorCode: "UP", productCode: "TE003" },
    ];
    const [s] = await suggestProducts([{ raw: "TEBOFORTIN 40MG/30TAB" }], ctx("EP", aliases), null);
    assert.equal(s?.code, "TE003");
    assert.equal(s?.source, "known_name");
  }

  // 5. With only the wrong mapping known, the strength still picks the 40 mg — never the drops, never 120 mg.
  {
    const aliases = [{ alias: "TEBOFORTIN 40MG/30TAB", distributorCode: "CP", productCode: "TE005" }];
    const [s] = await suggestProducts([{ raw: "TEBOFORTIN 40MG/30TAB" }], ctx("EP", aliases), null);
    assert.equal(s?.code, "TE003");
    assert.equal(s?.source, "same_strength");
    assert.equal(suggestProduct("TEBOFORTIN 40MG/30TAB", catalog)?.code, "TE003");
  }

  // 6. A strength Phoenix does not sell gets no code and says why — no guess at 1 mg or 3 mg.
  {
    const [s] = await suggestProducts([{ raw: "RISPADEX 2MG" }], ctx("EP", []), null);
    assert.equal(s?.code, null);
    assert.equal(s?.confidence, 0);
    assert.match(s?.reason ?? "", /none has this item's strength or form/);
    assert.equal(suggestProduct("RISPADEX 2MG", catalog), null);
  }

  // 7. An AI answer that contradicts the item's strength is dropped; a sound AI answer is kept.
  {
    let asked: string[] = [];
    const askAi = async (unknowns: { raw: string }[]) => {
      asked = unknowns.map((u) => u.raw);
      return [
        { code: "CO001", confidence: 90, raw: "CONVIBAN 75MG" },
        { code: "IGNORE", confidence: 95, raw: "PANADOL EXTRA", reason: "Another company's painkiller." },
      ];
    };
    const out = await suggestProducts([{ raw: "CONVIBAN 75MG" }, { raw: "PANADOL EXTRA" }, { raw: "624044" }], ctx("EP", []), askAi);
    assert.deepEqual(asked, ["CONVIBAN 75MG", "PANADOL EXTRA"], "a bare item code is never sent to the AI");
    assert.equal(out.length, 3, "every item comes back");
    assert.equal(out[0]?.code, null, "Conviban 50 mg is not a 75 mg item");
    assert.equal(out[1]?.code, "IGNORE");
    assert.equal(out[1]?.source, "ai");
    assert.equal(out[1]?.reason, "Another company's painkiller.");
    assert.equal(out[2]?.code, null);
  }

  // 8. The free steps run before the AI, and the AI is never asked about an item they settled.
  {
    let calls = 0;
    const askAi = async () => { calls += 1; return []; };
    const aliases = [{ alias: "639536", distributorCode: "IS", productCode: "TE002" }];
    const [s] = await suggestProducts([{ raw: "639536" }], ctx("IS-T", aliases), askAi);
    assert.equal(s?.code, "TE002");
    assert.equal(calls, 0);
  }

  // 9. The first guess on the page matches form and strength inside a family: the tablet and the syrup.
  assert.equal(suggestProduct("CONVIBAN 100MG TAB", catalog)?.code, "CO004");
  assert.equal(suggestProduct("CONVIBAN SYRUP 25MG/ML", catalog)?.code, "CO002");
}
