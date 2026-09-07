import assert from "node:assert/strict";

import {
  isStoreCustomerForPeriod,
  matchedStoreKeywords,
  matchedStorePrefixes,
  STORE_NAME_PREFIXES,
} from "../src/lib/sales/customer-channel.ts";

/**
 * «م - » IS EPDA'S NOTATION FOR مخزن — and it must be matched as a PREFIX, never as a substring.
 *
 * Owner, 2026-09-07, on a list of 19 EPDA customers: "all those warhouse and should be splitted".
 * Four of them start «م - », and three were reading as pharmacies because the keyword list only knows
 * the full word مخزن.
 *
 * 🔴 THE MEASUREMENT THAT DECIDES THE SHAPE OF THIS RULE. Live on production the same day:
 *
 *     «م - » SOMEWHERE in the name  →  623 distinct names
 *     «م - » at the START           →   29 distinct names (30 client codes, 5,995,985 EGP)
 *
 * The 594-name gap (592 client codes, 5,103,941 EGP) is ordinary pharmacies whose preceding word ends in م — «السلام -
 * المنيا», «همام - المطار», «هدي الاسلام - بنى سويف», «فرندز فارم - شبين الكوم». Adding «م - » to
 * STORE_NAME_KEYWORDS, which is the obvious one-line fix and matches by `includes`, would have turned
 * all 594 into warehouses and scattered their sales across their cities.
 *
 * NOTHING DOWNSTREAM WOULD HAVE CAUGHT IT. The split preserves each line's unit total while moving
 * units between areas, so the publication drift check — which compares UNITS — reports nothing. The
 * first sign would have been a rep asking why his month collapsed.
 *
 * So this file's real job is the negative half: the traps below must STAY pharmacies. If someone ever
 * "simplifies" the prefix list into the keyword list, those assertions are what fail.
 */

// Anti Infective deliberately: it carries the LATEST cutover (2026-09), so a rule that is live for
// it is live for every line. See warehouseRuleFromPeriod in customer-channel.ts.
const asStore = (name: string) =>
  isStoreCustomerForPeriod(name, null, "EP-PHS", "2026-09", "Anti Infective");

export function runStoreNamePrefixesTests() {
  assert.ok(STORE_NAME_PREFIXES.length > 0, "the prefix list exists");

  // ── The four the owner named, plus their siblings ─────────────────────────────────────────────
  const prefixed = [
    "م - دار الادوية - المنصورة",
    "م - الهادى - المنصورة",
    "م - الوطنية - شبين الكوم",
    "م - بيرفكت فارم - شبين",
    "م - جراند فارم - شبين الكوم",
    "م - سمارت - الزقازيق",
    "م - ايه ام جروب - كفر الشيخ",
    "م - الاتحاد - بنى سويف",
    "م - عمر بن الخطاب - الزقازيق",
    "م - د احمد عبدالله - المنصورة",
  ];
  for (const name of prefixed) {
    assert.ok(matchedStorePrefixes(name).length > 0, `${name} starts with the EPDA warehouse prefix`);
    assert.equal(asStore(name), true, `${name} is a warehouse`);
  }

  // ── THE NEGATIVE HALF — real production names that must NOT be caught ─────────────────────────
  //
  // Every one of these contains "م - " somewhere. None starts with it. If any becomes a warehouse,
  // the prefix rule has been turned back into a substring rule and 594 pharmacies have moved.
  const traps = [
    "السلام - المنيا",
    "همام - المطار",
    "هدي الاسلام - بنى سويف",
    "السلام - ساقلته -ن",
    "عبير جمال ن.م - الحواتم",
    "الرحمه فارم - المنصوره - رزق جمعه رزق",
  ];
  for (const name of traps) {
    assert.deepEqual(
      matchedStorePrefixes(name),
      [],
      `${name} contains "م - " but does not START with it — the prefix must not fire`,
    );
  }
  // Checked separately: two of the traps carry فارم and are warehouses on that word alone, which is
  // correct and unrelated. The ones with NO store word must stay pharmacies.
  for (const name of ["السلام - المنيا", "همام - المطار", "هدي الاسلام - بنى سويف", "عبير جمال ن.م - الحواتم"]) {
    assert.equal(matchedStoreKeywords(name).length, 0, `${name} carries no store keyword either`);
    assert.equal(asStore(name), false, `${name} stays a pharmacy — this is the 594-name assertion`);
  }

  // ── The three EPDA customers no pattern reaches, named individually ───────────────────────────
  for (const name of [
    "التعاون المصرى الخليجى - المنصوره",
    "الرواد للادوية - كفر الدوار",
    "فاروق 14 - محمد جمال",
  ]) {
    assert.equal(asStore(name), true, `${name} — owner ruled it a warehouse on 2026-09-07`);
  }

  // «التعاون» is deliberately NOT a keyword: it would newly catch 20 customers he has not seen, on
  // top of the 28 already classified through الجمعيه. Only the one he named is named.
  assert.equal(
    asStore("التعاون الزراعى - طنطا"),
    false,
    "an unrelated التعاون customer is untouched — the ruling was about one company, not the word",
  );

  // ── A prefix never overrules a "never a store" word ───────────────────────────────────────────
  assert.equal(
    asStore("م - مستشفى الصدر - المنصورة"),
    false,
    "a hospital does not become a warehouse by carrying the prefix",
  );
  assert.equal(asStore("م - صيدلية النور"), false, "nor does a صيدلية");
}
