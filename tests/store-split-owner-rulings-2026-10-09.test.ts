import assert from "node:assert/strict";

import {
  NEVER_STORE_KEYWORDS,
  STORE_OVERRIDE_NAMES,
  classifyCustomerChannel,
  isStoreCustomerForPeriod,
  legacyIsStoreCustomer,
  matchedNeverStoreKeywords,
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
 * A THIRTEENTH went in later the same day. He had named «طاى جروب» in column C and had also ruled
 * its four accounts PHARMACY on the 2026-09-06 decision sheet, so the contradiction went back to
 * him — and he settled it: **"split طاى جروب too, it overrides the Sep 6 sheet"**. The sixth such
 * reversal in this rule, handled like the five before it. Measured on production the same day:
 * «طاي جروب» reaches that ONE business on its SIX accounts and no neighbour at all, which is why
 * the stem is TWO words — «طاى» is a substring of «مطاى», the town Matay, in 60+ Minia pharmacy
 * names. All six sell from AB2 (Alex Center) alone, so the split deals them into thirds across
 * Alexandria — AB1 Alex East, AB2 Alex Center, AB3 Alex West, evenly, because the banded rule is El
 * Qema on Pedia alone and this is neither.
 *
 * 🔴 RE-MEASURED LATE THE SAME NIGHT, AFTER THE LAST BOOKS LANDED, AND BOTH HALVES OF THAT SENTENCE
 * HAD MOVED. September 2026 now holds **20 CNS rows / 460 units / 31,027.80 EGP** across four of the
 * accounts, of which two thirds — **20,685.20 EGP** — deals out to Alex East and Alex West. The
 * «11 rows and 20,025.30 EGP» reading was taken at 16:40 Cairo and three books landed after it.
 *
 * 🔴 AND A FIFTH SLICE APPEARED THAT IS NOT CNS. «طاى جروب - الاسكندرية» (22197684, EP-PHS) filed
 * **4 rows / 380 units / 79,515.00 EGP on Head Office** — 72% of everything the stem now reaches. It
 * classifies as a store and still moves nothing, because `isSplitEligibleLine("Head Office")` is
 * false; the danger is in the reporting, not the split. Head Office is in neither weekly nor monthly
 * tracking, so a total quoted off this stem without filtering the line overstates the ruling's reach
 * more than threefold.
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
  // THE THIRTEENTH, later the same day: his override of the 2026-09-06 sheet. Two words, because
  // «طاى» is a substring of «مطاى» — the town Matay, carried by 60+ Minia pharmacies.
  ["طاى جروب", "طاي جروب"],
];

/**
 * Every (name, code, distributor) the thirteen stems reach on production, spelled as the files spell
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
  // طاى جروب, on the five accounts that were not already stores. The four he had ruled PHARMACY on
  // 2026-09-06 are the first four: his 2026-10-09 words override that sheet, and
  // tests/sos-warehouse-owner-rulings.test.ts carries the same four as warehouses now.
  ["طاى جروب", "433363", "IS"],
  ["طاى جروب", "433363", "IS-S"],
  ["شركة طاى جروب", "3080282", "RM"],
  ["شركة طاى جروب", "1500023301", "SF"],
  ["طاى جروب - الاسكندرية", "22197684", "EP-PHS"],
];

/**
 * Warehouses already, on «مخزن», before a word of this was written. The stems reach them and change
 * nothing — kept here so a future tidy of the store words cannot quietly make them depend on the
 * override list instead.
 */
const ALREADY_WAREHOUSES_ON_A_STORE_WORD: ReadonlyArray<readonly [string, string, string]> = [
  ["مخزن الشرق للادوية المنيا", "مخزن الشرق للادوية المنيا", "QM"],
  ["مخزن الشرق للادويه", "1500044288", "SF"],
  // 437,672.60 EGP. طاى جروب's own warehouse account. It was a store on «مخزن» before he ruled on
  // the business at all, so the 2026-10-09 override changes nothing for it — and it belongs HERE
  // rather than among the neighbours a stem must miss, because «طاي جروب» reaches it on purpose:
  // it is the same business. The assertion below is the one that matters for it — its store word
  // holds on its own, with the override list taken out of the picture.
  ["مخزن طاى جروب - طاى", "0001573635", "PS"],
];

/**
 * Real production customers the stems must NOT reach. Each is a store for its OWN reason —
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
  // The two neighbours «طاي جروب» must still miss, now that it IS a stem: a pharmacy carrying the
  // town Matay, and one carrying جروب. Both would fall to a one-word stem.
  ["هيثم اسامة مطاى", "0001504502", "PS"],
  ["شركه أيه ام جروب", "0001535504", "PS"],
];

/**
 * The other half of the same day's ruling, and the only one that STOPS a split: **"the three تامين
 * الصحي depots are government, never split them"** (owner, 2026-10-09). The deeper audit found them
 * splitting against his own 17-of-17 «government depot, do NOT split» answers of 2026-09-06, because
 * the abbreviation stem ت.ص cannot reach a name that spells تامين الصحي out in full — and all three
 * carry مخزن, so the store word won.
 *
 * Measured on production before the word was written: تامين reaches 26 accounts, every one of them
 * the health-insurance authority, a branch, a depot or a clinic of it, or the unified-procurement
 * authority buying for it; NOT ONE is a wholesaler. Seven of the 26 were measured as splitting, all
 * seven on مخزن — his three plus four more of exactly the same kind, which the ruling therefore
 * reaches too.
 *
 * 🔴 RE-MEASURED THROUGH THE CLASSIFIER ITSELF LATE THE SAME NIGHT, AND IT IS **NINE** OF THE 26,
 * NOT SEVEN — AND THE TWO IT MISSED ARE A SPELLING, NOT A NEW CUSTOMER. `تأمين` with a hamza does
 * not match a raw `like '%تامين%'`: the classifier normalizes أ/إ/آ/ى/ة before it matches and a SQL
 * sweep does not, so the audit's own query could not see them. The two are 781
 * «هيئة الشراء الموحد - للتأمين الصحي المنطقة الثانية حلوان- المخزن الاقليمى» — **1,827 units /
 * 65,596.65 EGP, the LARGEST of all nine**, July and August only on RM-T out of Helwan-Maadi, so it
 * is published and restates nothing — and 3430120 كفر الشيخ, which landed at 10:44 Cairo on the day
 * itself and is live. Both are refused correctly; only the count and this list were wrong. Normalize
 * the name in SQL (`translate(name, 'ىأإآة', 'ياااه')`) or the sweep under-reports.
 *
 * WHAT IT MOVES. The never-store words are invisible to `legacyIsStoreCustomer`, so every month
 * before the cutover is judged by the old rule and nothing published restates. In a gated period the
 * nine hold **three** rows, every one September 2026 CNS:
 *
 *   23495    D24 Sharkia 1        249 units   8,889.30 EGP   2-area city — half stays put
 *   64845    D11 Qalubeya         200 units   7,140.00 EGP   1-area city — the split was a no-op
 *   3430120  D16 Kafr El-Sheikh 1 165 units   5,680.13 EGP   2-area city — half stays put
 *
 * So what actually changes hands is **207 units / 7,284.71 EGP** held in the rep's own area instead
 * of dealt across the city: 124.5 units / 4,444.65 EGP that would have gone to Sharkia 2 and
 * 82.5 units / 2,840.06 EGP that would have gone to Kafr El-Sheikh 2. Two more September rows reach
 * the word and were never splitting anyway — 21000166 سوهاج and 512 بنى سويف carry no store word at
 * all — so the ruling's credit is the 207 units, never the 706 the word touches.
 */
const GOVERNMENT_HEALTH_INSURANCE_DEPOTS: ReadonlyArray<readonly [string, string, string]> = [
  // The three he named. 23495, 64845 and 3430120 below are the three with a row in a gated period.
  ["فرع شرق الدلتا - المخزن الاقليمى العاشر من رمضان - تامين الصحي", "23495", "EG-HOS"],
  // Its own spelling runs the dash onto the word with no space before it — a search for the spaced
  // form misses it, which is why it was first reported as two depots and not three.
  ["فرع شرق الدلتا - المخزن الاقليمي القليوبية- تامين الصحي", "64845", "EG-HOS"],
  ["فرع شرق الدلتا - المخزن الاقليمي شبرا الخيمة - تامين الصحي", "27863", "EG-HOS"],
  // The four of the same kind the audit found in the same sweep. Last sold 2026-08, 2026-08,
  // 2026-05 and 2026-08 — all before the CNS cutover, so none of them moves a figure today.
  ["فرع المنوفية - المخزن الرئيسى بمنوف - تامين الصحي", "139383", "EG-HOS"],
  ["فرع شمال الصعيد - المخزن الرئيسي بنى سويف - تامين صحي", "66085", "EG-HOS"],
  ["فرع شمال شرق الدلتا- مخزن ادوية الطلبة الرئيسى بجديلة - تامين الصحي", "139359", "EG-HOS"],
  ["فرع وسط الصعيد - مخزن العاشر من رمضان سوهاج - تامين صحي", "139062", "EG-HOS"],
  // The two the audit's own SQL could not see, because they spell it «تأمين» with a hamza — added
  // once the classifier was asked instead of a `like`. 781 is the largest of the nine and sold only
  // in published months; 3430120 is the third live row, out of Kafr El-Sheikh 1.
  ["هيئة الشراء الموحد - للتأمين الصحي المنطقة الثانية حلوان- المخزن الاقليمى", "781", "RM-T"],
  ["هيئه الشراء الموحد - الهيئه العامه للتامين الصحى - فرع كفر الشيخ - المخزن الرئيسى بفوه", "3430120", "RM-T"],
];

/**
 * A SYNTHETIC control, and deliberately so: the stem must stay تامين and never be shortened to
 * امين. Broadening it by one letter reaches 257 real customers on production, every one a person
 * called أمين — and not one of them carries a store word today, so no real name can prove the
 * difference. This one would: a warehouse whose owner happens to be called أمين. Shorten the stem
 * and this flips to a pharmacy, taking its city split with it.
 */
const WIDENING_CONTROL = ["مخزن امين عبدالكريم للادوية", "SYNTHETIC-AMIN", "IS"] as const;

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

  // 5. The pharmacies stay pharmacies — including the two neighbours the «طاي جروب» stem must miss.
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

  // 7a. The government health-insurance depots. Each one still carries مخزن, so this asserts the
  //     never-store word is what refuses the split — delete the word and these go back to splitting
  //     while every other assertion in this file stays green.
  const insuranceLabel = "تأمين صحى (هيئة التأمين الصحي)";
  const insuranceEntry = NEVER_STORE_KEYWORDS.find((candidate) => candidate.label === insuranceLabel);
  assert.ok(insuranceEntry, `${insuranceLabel} must still be a NEVER_STORE keyword — he ruled it on 2026-10-09`);
  assert.equal(insuranceEntry.stem, "تامين", "the health-insurance stem must stay تامين, never the bare امين");
  for (const [depotName, depotCode, depotDistributor] of GOVERNMENT_HEALTH_INSURANCE_DEPOTS) {
    assert.ok(
      matchedStoreKeywords(depotName).length > 0,
      `${depotName} carries a store word — if it ever stops, this test no longer proves anything`,
    );
    assert.ok(
      matchedNeverStoreKeywords(depotName).includes(insuranceLabel),
      `${depotName} must be refused by «${insuranceLabel}» — he ruled these government, never split`,
    );
    assert.equal(
      classifyCustomerChannel(depotName, depotCode, depotDistributor),
      "pharmacy",
      `${depotName} is a government health-insurance depot and must never split`,
    );
  }

  // 7b. And a published month does NOT restate: the never-store words are invisible to the legacy
  //     rule, so August CNS still reads 23495 the way it was published.
  const [depot, depotCode, depotDistributor] = GOVERNMENT_HEALTH_INSURANCE_DEPOTS[0];
  assert.equal(
    isStoreCustomerForPeriod(depot, depotCode, depotDistributor, "2026-09", "CNS"),
    false,
    "September CNS stops splitting the 10th of Ramadan depot — the ruling's only live effect",
  );
  assert.equal(
    isStoreCustomerForPeriod(depot, depotCode, depotDistributor, "2026-08", "CNS"),
    true,
    "August CNS is published and still judged by the legacy rule, which never reads a never-store word",
  );

  // 7c. The widening control — see WIDENING_CONTROL.
  assert.equal(
    classifyCustomerChannel(...WIDENING_CONTROL),
    "store",
    "a warehouse whose owner is called أمين must still split — the stem is تامين, not امين",
  );

  // 8. The legacy rule stays genuinely the old one. A name ruling is invisible to it by
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
