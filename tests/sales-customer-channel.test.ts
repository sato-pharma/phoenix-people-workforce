import assert from "node:assert/strict";

import {
  classifyCustomerChannel,
  HOSPITAL_NAME_KEYWORDS,
  isStoreCustomer,
  matchedChannelKeywords,
  matchedHospitalKeywords,
  matchedStoreKeywords,
  normalizeCustomerName,
  splitByCustomerChannel,
  STORE_NAME_KEYWORDS,
} from "../src/lib/sales/customer-channel.ts";
import { mapDirectoryRowsToNames, splitDirectoryByChannel } from "../src/lib/sales/customer-directory.ts";

const emptyMaps = {
  areaName: new Map<string, string>(),
  brickName: new Map<string, string>(),
  distributorName: new Map<string, string>(),
  regionName: new Map<string, string>(),
};

function directoryRow(clientName: string, totalValue: number, clientCode: string) {
  return {
    area_code: "A1",
    brick_id: "B-1",
    client_address: "",
    client_code: clientCode,
    client_name: clientName,
    distributor_code: "PS",
    region_code: "CA",
    total_units: 10,
    total_value: totalValue,
  };
}

export function runSalesCustomerChannelTests() {
  // Each of the owner's six words, as actually spelled in production customer names, makes a store.
  const realStoreNames: ReadonlyArray<readonly [string, string]> = [
    ["مخزن النهضة للادوية", "مخزن"],
    ["مكه فارما - اسيوط", "فارما / فارم"],
    ["الاندلس فارم", "فارما / فارم"],
    ["سينا تريد - العبور", "تريد"],
    ["الشركة الوطنية للصيادلة", "الشركة"],
    ["الجمعية التعاونية - قنا ن", "الجمعيه"],
    ["نبض للتجارة وتوزيع الادوية", "للتجارة"],
  ];
  for (const [name, expectedWord] of realStoreNames) {
    assert.equal(classifyCustomerChannel(name), "store", `"${name}" carries a store keyword`);
    assert.ok(
      matchedStoreKeywords(name).includes(expectedWord),
      `"${name}" must report ${expectedWord} as the reason it is a store, so a false positive stays visible`,
    );
  }
  // Every configured keyword is reachable — a typo'd stem would silently classify nothing.
  for (const keyword of STORE_NAME_KEYWORDS) {
    assert.equal(
      classifyCustomerChannel(`عميل ${keyword.stem} تجريبي`),
      "store",
      `keyword ${keyword.label} must actually match its own stem`,
    );
  }

  // Ordinary pharmacies stay pharmacies — this is the side the money mostly sits on.
  for (const name of ["صيدلية النور", "صيدلية الشفاء - طنطا", "Pharmacy A", "احمد محمد"]) {
    assert.equal(classifyCustomerChannel(name), "pharmacy", `"${name}" carries no store keyword`);
  }

  // ---------------------------------------------------------------- hospitals
  // Real production spellings. مستشف is the shared prefix, so both ى and ي endings must land.
  const realHospitalNames: ReadonlyArray<readonly [string, string]> = [
    ["مستشفى دارالفؤاد مدينة نصر", "مستشفى / مستشفي"],
    ["مستشفي راشد", "مستشفى / مستشفي"],
    ["مستشفىالانبا تكلا", "مستشفى / مستشفي"],
    ["المستشفى الروماني", "مستشفى / مستشفي"],
    ["صيدلية خاصة تابعة لمستشفى دار السلام", "مستشفى / مستشفي"],
    ["Cleopatra Hospital", "hospital"],
  ];
  for (const [name, expectedWord] of realHospitalNames) {
    assert.equal(classifyCustomerChannel(name), "hospital", `"${name}" carries a hospital keyword`);
    assert.ok(
      matchedHospitalKeywords(name).includes(expectedWord),
      `"${name}" must report ${expectedWord} as the reason it is a hospital`,
    );
  }
  for (const keyword of HOSPITAL_NAME_KEYWORDS) {
    assert.equal(
      classifyCustomerChannel(`عميل ${keyword.stem} تجريبي`),
      "hospital",
      `keyword ${keyword.label} must actually match its own stem`,
    );
  }
  // A pharmacy INSIDE a hospital is a hospital customer — the name says مستشفى, so it lands there
  // rather than being buried among 49,000 ordinary pharmacies.
  assert.equal(classifyCustomerChannel("صيدلية مستشفى النيل – ملوى"), "hospital");
  // …but صيدلية on its own never makes a hospital.
  assert.equal(classifyCustomerChannel("صيدلية النيل"), "pharmacy");
  assert.deepEqual(matchedHospitalKeywords(null), [], "a null name reports no hospital keywords");

  // THE headline invariant for this channel. Six real production names carry BOTH a hospital word
  // and a store word — this is one of them (the Saudi-German hospital, run by a company whose name
  // starts الشركه). Two things must both hold:
  const overlap = "الشركه المصريه السعوديه للرعايه الصحيه -مستشفى السعودى الالمانى";
  assert.equal(
    classifyCustomerChannel(overlap),
    "hospital",
    "a name carrying BOTH a hospital and a store word is a hospital — hospital wins the overlap",
  );
  assert.equal(
    isStoreCustomer(overlap),
    true,
    "…but it must STILL be a store customer for the Monthly Closing's city split. isStoreCustomer is "
      + "keyword-based on purpose: routing it through the classifier would silently stop splitting "
      + "this customer's sales across its city, moving money between areas in the closing.",
  );
  // A second real one, carrying مخزن rather than الشركه.
  const overlapStore = "هيئه الشراء الموحد - مستشفى المنزله العام-مخزن نفقه الدوله";
  assert.equal(classifyCustomerChannel(overlapStore), "hospital");
  assert.equal(isStoreCustomer(overlapStore), true, "a مخزن that is also a hospital still splits");

  // matchedChannelKeywords explains the channel the customer actually landed in.
  assert.deepEqual(matchedChannelKeywords(overlap), ["مستشفى / مستشفي"]);
  assert.deepEqual(matchedChannelKeywords("مخزن الحجاز"), ["مخزن"]);
  assert.deepEqual(matchedChannelKeywords("صيدلية النور"), []);

  // THE headline invariant. Egyptian data entry writes ة and ه interchangeably; without folding,
  // searching الشركة finds NONE of the real customers, which reads as "there are none".
  assert.equal(
    classifyCustomerChannel("الشركه المصريه السعوديه للرعايه الصحيه"),
    "store",
    "الشركه spelled with ه must match the keyword written الشركة — the fold is the whole point",
  );
  assert.equal(
    classifyCustomerChannel("الجمعية التعاونية الانتاجية"),
    "store",
    "الجمعية spelled with ة must match the keyword written الجمعيه",
  );
  assert.equal(
    classifyCustomerChannel("شركة الصيادلة فارما للتجاره وا"),
    "store",
    "للتجاره spelled with ه must match the keyword written للتجارة",
  );
  // Harakat and tatweel are decoration a distributor may or may not type.
  assert.equal(
    classifyCustomerChannel("مَخْزَن الفتح للادوية"),
    "store",
    "harakat must be stripped before comparing, not treated as different letters",
  );
  assert.equal(
    classifyCustomerChannel("مخـــزن الفتح"),
    "store",
    "tatweel must be stripped before comparing",
  );

  // فارم is a PREFIX of فارما, so the one stem has to cover both spellings and their derivatives.
  for (const name of ["ايمدج فارم لتجارة", "البدري فارما", "احمد فهمى ار تى فارمسى"]) {
    assert.equal(classifyCustomerChannel(name), "store", `"${name}" must match on the فارم stem`);
  }

  // Substring, not whole-word: a keyword glued to the definite article still counts.
  assert.equal(classifyCustomerChannel("المخزن الكبير"), "store", "المخزن contains مخزن");

  // A blank name cannot be shown to be a store; it must not throw and must not become one.
  assert.equal(classifyCustomerChannel(""), "pharmacy", "an empty name is not evidence of a store");
  assert.equal(classifyCustomerChannel(null), "pharmacy", "a null name is not evidence of a store");
  assert.deepEqual(matchedStoreKeywords(null), [], "a null name reports no matched keywords");
  assert.equal(normalizeCustomerName(null), "", "normalizing a null name yields an empty string");

  // The generic splitter keeps incoming order within each side.
  const split = splitByCustomerChannel(
    [{ n: "صيدلية النور" }, { n: "مخزن الحجاز" }, { n: "مستشفى الصفوة" }, { n: "صيدلية الشفاء" }],
    (row) => row.n,
  );
  assert.deepEqual(split.stores.map((row) => row.n), ["مخزن الحجاز"]);
  assert.deepEqual(split.hospitals.map((row) => row.n), ["مستشفى الصفوة"]);
  assert.deepEqual(split.pharmacies.map((row) => row.n), ["صيدلية النور", "صيدلية الشفاء"]);

  // The directory row carries the channel, so the UI never re-derives the rule itself.
  const mapped = mapDirectoryRowsToNames(
    [
      directoryRow("مخزن الحجاز فارما لتجارة وتوزيع", 1_000, "C1"),
      directoryRow("صيدلية النور", 250, "C2"),
      directoryRow("الجمعية التعاونية - قنا", 750, "C3"),
      directoryRow("مستشفى دارالفؤاد", 500, "C4"),
    ],
    emptyMaps,
  );
  assert.equal(mapped[0]?.channel, "store");
  assert.equal(mapped[1]?.channel, "pharmacy");
  assert.equal(mapped[3]?.channel, "hospital");
  assert.deepEqual(
    mapped[3]?.matchedKeywords,
    ["مستشفى / مستشفي"],
    "a hospital reports the hospital word, not an empty list — the reason must stay visible",
  );
  assert.deepEqual(mapped[1]?.matchedKeywords, [], "a pharmacy reports no matched keywords");
  assert.deepEqual(
    mapped[0]?.matchedKeywords,
    ["مخزن", "فارما / فارم"],
    "a name carrying two keywords reports both, in the configured order",
  );

  // Totals must cover EVERY row on that side, not just the ones the display cap kept — a channel
  // total that silently means "the first page" is the same defect as rendering missing data as 0.
  const grouped = splitDirectoryByChannel(mapped);
  assert.equal(grouped.stores.totalCustomers, 2, "both store-keyword customers land in stores");
  assert.equal(grouped.pharmacies.totalCustomers, 1);
  assert.equal(grouped.hospitals.totalCustomers, 1);
  assert.equal(grouped.stores.totalValue, 1_750, "store value sums every store row");
  assert.equal(grouped.pharmacies.totalValue, 250, "pharmacy value sums every pharmacy row");
  assert.equal(grouped.hospitals.totalValue, 500, "hospital value sums every hospital row");
  assert.equal(grouped.stores.totalUnits, 20);
  assert.equal(
    grouped.stores.totalValue + grouped.pharmacies.totalValue + grouped.hospitals.totalValue,
    2_500,
    "the three channels partition the directory — no customer is counted twice or dropped",
  );
  assert.equal(grouped.stores.truncated, false, "three rows are far below the display cap");
  assert.equal(
    grouped.stores.customers.length,
    grouped.stores.totalCustomers,
    "below the cap, the displayed list is the whole list",
  );
}
