import assert from "node:assert/strict";

import {
  STORE_OVERRIDE_NAMES,
  classifyCustomerChannel,
  isStoreCustomerForPeriod,
  legacyIsStoreCustomer,
  matchedStoreKeywords,
  nameMatchesAnyKeyword,
} from "../src/lib/sales/customer-channel.ts";

/**
 * 2026-10-09. The owner was sent the whole customer list — all 10,420 names — in two columns: the
 * 119 the warehouse rule splits today and the 10,301 it leaves whole, plus a third column naming
 * the ones that read as organisations supplying the trade and reach no keyword, prefix, trade
 * phrase or override. He ruled «split the 11 in column C», then «do a deeper audit and remember the
 * keywords that we split based on them … of course more than this should be split», and the deeper
 * audit found four more. Twelve stems went in; the twenty customer names below are everything they
 * reach on production.
 *
 * This file exists for the NEIGHBOURS. `STORE_OVERRIDE_NAMES` is the one list that can CREATE a
 * warehouse from a name — `PHARMACY_OVERRIDE_CHAINS` can only ever refuse one — so an over-wide
 * stem does not merely mislabel a customer: it deals that customer's sales out across a city and
 * moves money between reps, with nothing downstream reporting it (the split preserves each line's
 * unit total, and the publication drift check compares units).
 *
 * Measured on production (`ozucdzovmcqvepbozvqf`) before the stems were written, all-time over
 * `source_of_sales_import_rows` where `validation_state = 'valid'`:
 *
 *   ALL twelve stems                                20 names · 26 accounts · 374 rows · 435,133.42
 *   already warehouses on «مخزن»                     2 names ·  9 rows ·   7,132.05  (no change)
 *   DIRECT — carries no area either way              1 name  ·  4 rows ·  16,772.40  (no change)
 *   official_line = Head Office — never splits       3 names ·  7 rows ·  42,890.78  (no change)
 *   WHAT ACTUALLY CHANGES HANDS                     15 names · 58 rows ·  51,022.72
 *
 * The last line is the point: the override list is read from the cutover only
 * (`WAREHOUSE_RULE_FROM_PERIOD_BY_LINE` — 2026-09, Pedia 2026-08), so every published month is
 * untouched. These names carry no Pedia row at all; 347 of the 361 tracked-line rows are CNS.
 */

/** The twelve he ruled, as written. A stem broadened later fails here before it reaches a closing. */
const RULED_STEMS: ReadonlyArray<readonly [string, string]> = [
  ["شركة مخازن كومباس فارما للادوية", "كومباس فارما"],
  ["دار الدواء", "دار الدواء"],
  ["شركة فاروس للادوية والمستحضرات الطبي", "فاروس للادويه"],
  ["الشرق للادوية", "الشرق للادويه"],
  ["الفجر للادوية", "الفجر للادويه"],
  ["مركز الخليل للادوية واللقاحات والامصال", "الخليل للادويه"],
  ["لاستثمارات الدوائية والكيماويات", "لاستثمارات الدوائيه"],
  ["اورينت للاستيراد والتصدير والتوكيلات", "اورينت للاستيراد"],
  ["شركه لابروكس", "لابروكس"],
  ["صيادلة البحيرة", "صيادله البحيره"],
  ["جمعية العاملين بشركة مصر حلوان", "جمعيه العاملين بشركه مصر حلوان"],
  ["الحمعيه التعاونيه يشركه كيما", "الحمعيه التعاونيه"],
];

/**
 * Every (name, code, distributor) the twelve stems reach on production, spelled as the files spell
 * it — «مركزالخليل» with no space, «دار الدواء  - اخميم ن» with two, «الحمعيه» with a ح. The
 * misspellings are theirs and are kept, because they are what the uploads carry.
 */
const RULED_WAREHOUSES: ReadonlyArray<readonly [string, string, string]> = [
  ["شركة مخازن كومباس فارما للادوية", "444577", "IS"],
  // دار الدواء reaches the whole family on purpose — it is what he named, and the bare company name
  // cannot be narrowed without a code. A code-keyed override would reach the PUBLISHED months.
  ["دار الدواء", "448686", "IS"],
  ["دار الدواء", "", "DIRECT"],
  ["دار الدواء للادويةوالمستلزمات الطبية", "425373", "IS"],
  ["دار الدواء-اكتوبر", "0001533664", "PS"],
  ["دار الدواء  - اخميم ن", "0001545543", "PS"],
  ["دار الدواء المنصورة", "0001519170", "PS"],
  ["شركة فاروس للادوية والمستحضرات الطبي", "452109", "IS"],
  ["الشرق للادوية", "438010", "IS"],
  ["الشرق للادوية", "438010", "IS-S"],
  ["الفجر للادوية", "464940", "IS"],
  ["مركزالخليل للادويةواللقاحات والامصال", "340314", "IS"],
  ["لاستثمارات الدوائية والكيماويات - 1", "1500016697", "SF"],
  ["اورينت للاستيراد والتصدير والتوكيلات", "447184", "IS"],
  ["اورينت للاستيراد والتصدير والتوكيلات", "447184", "IS-S"],
  ["اورينت للاستيراد والتصدير والتوكيلات", "", "PS"],
  ["شركه لابروكس", "1500051885", "SF"],
  // One business on three accounts at two distributors, 177,392.03 EGP between them — the case this
  // list exists for. One stem reaches all three.
  ["شركة صيادلةالبحيرة فرع الاسكندرية", "403594", "IS"],
  ["صيادلة البحيرة", "358607", "IS"],
  ["ص  ش  صيادلة البحيره", "1500027123", "SF"],
  ["جمعية العاملين بشركة مصر حلوان", "334792", "IS"],
  ["جمعية العاملين بشركة مصر حلوان", "334792", "IS-S"],
  ["الحمعيه التعاونيه يشركه كيما", "375342", "IS"],
  ["الحمعيه التعاونيه يشركه كيما", "375342", "IS-S"],
];

/**
 * Warehouses already, on «مخزن», before a word of this was written. The stems reach them and change
 * nothing — kept here so a future tidy of the store words cannot quietly make them depend on the
 * override list instead.
 */
const ALREADY_WAREHOUSES_ON_A_STORE_WORD: ReadonlyArray<readonly [string, string, string]> = [
  ["مخزن الشرق للادوية المنيا", "مخزن الشرق للادوية المنيا", "QM"],
  ["مخزن الشرق للادويه", "1500044288", "SF"],
];

/**
 * Real production customers the twelve stems must NOT reach. Each is a store for its OWN reason —
 * a store word or the trade phrase — so the assertion is about the new list, not the classifier:
 * if one of these starts matching a stem, the stem is too wide even though nothing visibly changed.
 */
const STORES_FOR_ANOTHER_REASON: ReadonlyArray<readonly [string, string, string]> = [
  // 84,530.49 EGP, and the reason «الخليل للادويه» is written with «للادويه» rather than bare
  // «الخليل»: this one puts فارما between the two words and is a store on «فارما / فارم» and on the
  // trade phrase anyway.
  ["الخليل فارما لتجارة الادوية", "433500", "IS"],
  // 31,879.66 EGP, the same business without the trade phrase — still a store, on «فارما / فارم»
  // alone. He ruled on the مركز, not on this one, and the stem correctly misses it.
  ["شركه الخليل فارما", "0001505476", "PS"],
  // 1,672,582.50 and 1,445,355.00 EGP — the two biggest names a bare «صيادله» stem would have
  // swept in. Both are stores already, on «فارما / فارم», which is exactly why a wide stem here is
  // invisible on the surface and still wrong: it would make their split depend on the override
  // list instead of on his own store word.
  ["الصيادلة فارم -الكوامل", "0001582621", "PS"],
  ["شركة الصيادلة فارما للتجارة وا", "0001579780", "PS"],
  ["مخزن فاروس", "0001559431", "PS"],
  ["مخزن كومباس", "0001576668", "PS"],
  // 437,672.60 EGP. طاى جروب's own warehouse account — a store on «مخزن» however the six accounts
  // below are eventually ruled.
  ["مخزن طاى جروب - طاى", "0001573635", "PS"],
  // «الحمعيه التعاونيه» is a ح-for-ج typo of this name. This one is already a store on his own
  // «الجمعيه» keyword, and the ح stem must never adopt it — 13 societies ride that keyword, and
  // none of them was in column C.
  ["الجمعيه التعاونيه", "407800", "IS"],
];

/** Pharmacies today, and pharmacies after this change. He has ruled on none of them. */
const MUST_STAY_PHARMACY: ReadonlyArray<readonly [string, string, string]> = [
  // 820,260.00 EGP — the largest neighbour of «الشرق للادويه». It carries «للادويه» and «الشرقيه»
  // but never the two together, which is the whole reason the stem is two words.
  ["الراوى للادويه - الشرقيه", "163989", "EP-BK"],
  // 184,707.00 EGP. Bare «الشرق» would have taken it.
  ["الشرق - الفيوم", "162943", "EP-BK"],
  // 50,220.00 EGP. Bare «اورينت» would have taken it; «اورينت للاستيراد» does not.
  ["اورينت-شبرا الخيمة ن.م", "0001580323", "PS"],
  // Bare «الفجر» customers. 6,932.25 and 2,962.58 EGP.
  ["الفجر المحلة الكبرى", "0001520651", "PS"],
  ["الفجر", "348336", "IS"],
  // 3,841.92 EGP — carries «الدوائية» but not «لاستثمارات الدوائيه».
  ["الدوائية", "", "DIRECT"],
  // طاى جروب. He NAMED it in column C, and it is deliberately absent from the change: he ruled its
  // four accounts PHARMACY on the 2026-09-06 decision sheet (433363 IS and IS-S, 3080282 RM,
  // 1500023301 SF) with their value and areas in front of him, and those answers are pinned in
  // tests/sos-warehouse-owner-rulings.test.ts. A contradiction in this rule goes back to him — the
  // five before it all did — so 1,060,947.52 EGP across six accounts waits for one word. Until it
  // comes, these stay pharmacies, and this file is where that is enforced.
  ["طاى جروب", "433363", "IS"],
  ["طاى جروب - الاسكندرية", "22197684", "EP-PHS"],
];

export function runStoreSplitOwnerRulings20261009Tests() {
  // 1. The twelve are in the list, stem for stem. A tidy that broadens one fails here.
  for (const [label, stem] of RULED_STEMS) {
    const entry = STORE_OVERRIDE_NAMES.find((candidate) => candidate.label === label);
    assert.ok(entry, `${label} must still be in STORE_OVERRIDE_NAMES — he ruled it on 2026-10-09`);
    assert.equal(entry.stem, stem, `${label}'s stem must stay exactly as measured`);
  }

  // 2. Every account the stems reach on production is a warehouse.
  for (const [name, code, distributor] of RULED_WAREHOUSES) {
    assert.equal(
      classifyCustomerChannel(name, code, distributor),
      "store",
      `${name} is a warehouse by the owner's 2026-10-09 ruling`,
    );
  }

  // 3. The two that were already warehouses stay warehouses on their own store word, not on the
  //    new list.
  for (const [name, code, distributor] of ALREADY_WAREHOUSES_ON_A_STORE_WORD) {
    assert.ok(
      matchedStoreKeywords(name).length > 0,
      `${name} must stay a warehouse on its own store word, independently of the override list`,
    );
    assert.equal(classifyCustomerChannel(name, code, distributor), "store", `${name} is a warehouse`);
  }

  // 4. The neighbours that are stores for another reason must not be REACHED by the new stems.
  //    Classification alone cannot see this — they are stores either way.
  //    Asserted against the LIVE list rather than the twelve above, so a stem added next month is
  //    measured against these neighbours too — which is the failure this file is here to catch.
  for (const [name, code, distributor] of STORES_FOR_ANOTHER_REASON) {
    const matched = nameMatchesAnyKeyword(name, STORE_OVERRIDE_NAMES);
    assert.equal(
      matched,
      null,
      `${name} must not match any STORE_OVERRIDE_NAMES stem — it reached «${matched}», which is too wide`,
    );
    assert.equal(classifyCustomerChannel(name, code, distributor), "store", `${name} stays a store`);
  }

  // 5. The pharmacies stay pharmacies — including طاى جروب, which he named but has not reconciled
  //    with his own 2026-09-06 sheet.
  for (const [name, code, distributor] of MUST_STAY_PHARMACY) {
    assert.equal(
      classifyCustomerChannel(name, code, distributor),
      "pharmacy",
      `${name} was never ruled a warehouse and must not be swept in by a neighbour's stem`,
    );
  }

  // 6. The cutover. Every one of these rulings reaches September and stops at August, so no
  //    published month restates — the reason a NAME, not a code, is the instrument here.
  const [name, code, distributor] = ["شركه لابروكس", "1500051885", "SF"] as const;
  assert.equal(
    isStoreCustomerForPeriod(name, code, distributor, "2026-09", "CNS"),
    true,
    "September CNS takes the ruling — the default cutover is 2026-09",
  );
  assert.equal(
    isStoreCustomerForPeriod(name, code, distributor, "2026-08", "CNS"),
    false,
    "August CNS does not — it is published and judged by the older rule",
  );
  assert.equal(
    isStoreCustomerForPeriod(name, code, distributor, "2026-07", "CNS"),
    false,
    "and July does not move either",
  );
  assert.equal(
    isStoreCustomerForPeriod(name, code, distributor, "2026-08", "Pedia"),
    true,
    "August Pedia does take it — Pedia's cutover is 2026-08, and these names carry no Pedia row today",
  );

  // 7. The legacy rule stays genuinely the old one. A name ruling is invisible to it by
  //    construction — it reads the code-keyed list — and that is what keeps every published month
  //    reproducible. If one ever leaked, all of 2026 would silently restate.
  for (const [legacyName, legacyCode, legacyDistributor] of RULED_WAREHOUSES) {
    if (matchedStoreKeywords(legacyName).length > 0) continue;
    assert.equal(
      legacyIsStoreCustomer(legacyName, legacyCode, legacyDistributor),
      false,
      `${legacyName} must be invisible to the pre-2026-09-06 rule`,
    );
  }
}
