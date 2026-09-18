import assert from "node:assert/strict";

import type { AiUnknown } from "../src/lib/sales/normalizer/ai-suggest.ts";
import {
  ADDRESS_MATCH_MIN_AREA_SHARE,
  ADDRESS_MATCH_MIN_TOP_SCORE,
  buildAddressMatchIndex,
  matchByAddress,
  scoreAddressMatch,
  type AddressMatchRow,
} from "../src/lib/sales/normalizer/customer-address-match.ts";
import {
  ADDRESS_MATCH_CONFIDENCE,
  PLACE_IN_NAME_CONFIDENCE,
  answerFromFreeSteps,
  buildFreeStepIndexes,
  groupIdenticalPharmacies,
} from "../src/lib/sales/normalizer/customer-free-steps.ts";
import { customerPharmacyKey } from "../src/lib/sales/normalizer/customer-normalize.ts";
import { buildPlaceGazetteer, findPlace, placeFromName, type PlaceBrick } from "../src/lib/sales/normalizer/customer-place-match.ts";
import type { MappedCustomerRow } from "../src/lib/sales/normalizer/customer-propagate.ts";
import { packCustomersByPharmacy } from "../src/lib/sales/normalizer/customer-request-packing.ts";

// The free steps of the customer pipeline (customer-free-steps.ts), asked for by the owner on
// 2026-09-18 so the AI is paid only for what the map itself cannot answer.

function mapped(overrides: Partial<MappedCustomerRow>): MappedCustomerRow {
  return { address: "", brickId: "CA1-01", customerCode: "", customerName: "", distributorCode: "PS", ...overrides };
}

export function runCustomerFreeStepsTests() {
  // ---------------------------------------------------------------------------------------
  // Step 1 — the same address as pharmacies already mapped (customer-address-match.ts).
  // ---------------------------------------------------------------------------------------
  // The thresholds are the measured ones (97.5% right on 764 answers). Loosen only after re-measuring.
  assert.equal(ADDRESS_MATCH_MIN_TOP_SCORE, 0.7);
  assert.equal(ADDRESS_MATCH_MIN_AREA_SHARE, 0.7);

  const addressAreas = new Map([
    ["CA1-01", "CA1"],
    ["CA1-02", "CA1"],
    ["CA2-05", "CA2"],
    ["GZ3-01", "GZ3"],
  ]);
  const addressRows: AddressMatchRow[] = [
    // 200 mapped pharmacies with no address. They count towards how common a word is, as the empty
    // addresses in the real map do. Without them a word two pharmacies share would already be held
    // by more than 2% of this small map, and nothing could match.
    ...Array.from({ length: 200 }, () => ({ address: "", brickId: "CA1-01" })),
    // One street: two pharmacies in CA2, and one in CA1 that shares only the street's name.
    { address: "عمارة 5 ش الميرغني الكوربة", brickId: "CA2-05" },
    { address: "الميرغني الكوربه بجوار البنك", brickId: "CA2-05" },
    { address: "الميرغني روكسي", brickId: "CA1-02" },
    // The same address mapped in two areas.
    { address: "الترعة البولاقية", brickId: "CA1-01" },
    { address: "الترعه البولاقيه", brickId: "GZ3-01" },
    // Three words, each held by a different pharmacy.
    { address: "دجلة", brickId: "GZ3-01" },
    { address: "الفسطاط", brickId: "GZ3-01" },
    { address: "المنيل", brickId: "GZ3-01" },
    // A word held by more than 2% of the map.
    ...Array.from({ length: 6 }, () => ({ address: "المنصورة", brickId: "CA1-01" })),
  ];
  const addressIndex = buildAddressMatchIndex(addressRows, addressAreas);

  // A clear match: two neighbours hold every rare word of the address, and their area outvotes the
  // CA1 pharmacy that shares only the street's name.
  const clear = matchByAddress(addressIndex, "ش الميرغني الكوربه");
  assert.ok(clear);
  assert.equal(clear.brickId, "CA2-05");
  assert.equal(clear.areaCode, "CA2");
  assert.equal(clear.topScore, 1);
  assert.ok(clear.areaShare > ADDRESS_MATCH_MIN_AREA_SHARE && clear.areaShare < 1, `area share ${clear.areaShare}`);
  // Respelled (ى for ي, ة for ه, شارع for ش) it is the same address.
  assert.equal(matchByAddress(addressIndex, "شارع الميرغنى الكوربة")?.brickId, "CA2-05");
  // A word more than 2% of the map holds proves nothing: it neither helps nor hurts a match…
  assert.equal(matchByAddress(addressIndex, "ش الميرغني الكوربه المنصورة")?.topScore, 1);
  // …and alone it answers nothing.
  assert.equal(scoreAddressMatch(addressIndex, "المنصورة"), null);
  // An address with no word the map knows answers nothing.
  assert.equal(scoreAddressMatch(addressIndex, "عزبة النخل"), null);

  // A split vote: the same address sits in two areas, so neither is chosen.
  const split = scoreAddressMatch(addressIndex, "الترعه البولاقيه");
  assert.ok(split);
  assert.equal(split.areaShare, 0.5);
  assert.equal(matchByAddress(addressIndex, "الترعه البولاقيه"), null);

  // Weak overlap: one area, but no single neighbour holds most of the address.
  const weak = scoreAddressMatch(addressIndex, "دجلة الفسطاط المنيل");
  assert.ok(weak);
  assert.equal(weak.areaShare, 1);
  assert.ok(weak.topScore < ADDRESS_MATCH_MIN_TOP_SCORE, `top score ${weak.topScore}`);
  assert.equal(matchByAddress(addressIndex, "دجلة الفسطاط المنيل"), null);

  // ---------------------------------------------------------------------------------------
  // Step 3 — one of our brick names in the pharmacy's NAME (customer-place-match.ts).
  // ---------------------------------------------------------------------------------------
  const placeBricks: PlaceBrick[] = [
    { areaCode: "CA1", brickId: "CA1-01", brickName: "النزهة" },
    { areaCode: "CA1", brickId: "CA1-02", brickName: "الماظة" },
    { areaCode: "CA2", brickId: "CA2-05", brickName: "مصر الجديدة - الكوربة" },
    { areaCode: "GZ3", brickId: "GZ3-01", brickName: "إمبابة 1" },
    { areaCode: "GZ3", brickId: "GZ3-02", brickName: "امبابه 2" },
    { areaCode: "AL1", brickId: "AL1-03", brickName: "السلام 1" },
    { areaCode: "CA4", brickId: "CA4-07", brickName: "السلام 2" },
    { areaCode: "QL1", brickId: "QL1-02", brickName: "بنها" },
  ];
  const places = buildPlaceGazetteer(placeBricks);
  const nozha = { areaCode: "CA1", brickId: "CA1-01" };

  // The owner's step: the name holds a brick's place.
  assert.deepEqual(findPlace(places, "صيدلية النزهة"), { ambiguous: false, ...nozha });
  assert.deepEqual(placeFromName(places, "صيدلية النزهة", ""), nozha);
  // A brick named "X - Y" is known by the part before the dash too, and a place can be several words.
  assert.deepEqual(placeFromName(places, "صيدلية د. هاني مصر الجديدة", ""), { areaCode: "CA2", brickId: "CA2-05" });
  // One place, several bricks of one area: the area is known, the brick is not, so no answer.
  assert.deepEqual(findPlace(places, "صيدلية امبابة"), { ambiguous: false, areaCode: "GZ3", brickId: null });
  assert.equal(placeFromName(places, "صيدلية امبابة", ""), null);
  // The same place in two areas (the owner's "same name in another area"): no answer.
  assert.deepEqual(findPlace(places, "صيدلية السلام"), { ambiguous: true });
  assert.equal(placeFromName(places, "صيدلية السلام", ""), null);
  // Whole words only: a person called عبدالسلام is not the place السلام.
  assert.equal(findPlace(places, "صيدلية عبدالسلام"), null);
  assert.equal(findPlace(places, "صيدلية النزهاوي"), null);
  // A place name under five letters is too common a word to name a brick.
  assert.equal(findPlace(places, "صيدلية بنها"), null);

  // Right after a street word the place is a STREET: "ش النزهه" is a street called النزهه.
  assert.equal(findPlace(places, "ش النزهة"), null);
  assert.equal(findPlace(places, "شارع النزهة"), null);
  assert.equal(findPlace(places, "ميدان الماظة"), null);
  // A short number between the street word and the place changes nothing.
  assert.equal(findPlace(places, "ش 26 النزهة"), null);
  assert.equal(findPlace(places, "ش ٢٦ النزهة"), null);
  // A street word AFTER the place does not hide it.
  assert.deepEqual(findPlace(places, "النزهة ش الحجاز"), { ambiguous: false, ...nozha });

  // The address can only VETO. A place of ours in another area, or in several, drops the answer.
  assert.equal(placeFromName(places, "صيدلية النزهة", "12 شارع الحجاز مصر الجديدة"), null);
  assert.equal(placeFromName(places, "صيدلية النزهة", "حي السلام"), null);
  // A place in the same area, or no place of ours at all, is no objection.
  assert.deepEqual(placeFromName(places, "صيدلية النزهة", "امام نادي الماظة"), nozha);
  assert.deepEqual(placeFromName(places, "صيدلية النزهة", "12 ش عثمان بن عفان"), nozha);
  // The address alone never answers.
  assert.equal(placeFromName(places, "صيدلية الرحمة", "النزهة"), null);

  // ---------------------------------------------------------------------------------------
  // Step 0 — identical pharmacies are one question (the owner's "group them").
  // ---------------------------------------------------------------------------------------
  // Spelling and prefixes fold together; the key is what the AI-answer store is keyed by.
  const ahmedKey = customerPharmacyKey("صيدلية د/ أحمد", "ش الجمهورية", "القاهرة");
  assert.equal(ahmedKey, "احمد | ش الجمهوريه | القاهره");
  assert.equal(customerPharmacyKey("صيدليه دكتور احمد", "ش الجمهوريه", "القاهره"), ahmedKey);
  // Another address or another governorate is another pharmacy.
  assert.notEqual(customerPharmacyKey("صيدلية د/ أحمد", "ش النصر", "القاهرة"), ahmedKey);
  assert.notEqual(customerPharmacyKey("صيدلية د/ أحمد", "ش الجمهورية", "الجيزة"), ahmedKey);
  // No name: the AI is shown the code, so it is never the same question as another code.
  assert.equal(customerPharmacyKey("", "ش الجمهورية", "القاهرة"), "");
  assert.equal(customerPharmacyKey(" - ", "ش الجمهورية", "القاهرة"), "");

  const groups = groupIdenticalPharmacies([
    { raw: "C1001", rawAddress: "ش الجمهورية", rawName: "صيدلية د/ أحمد", rawTerritory: "القاهرة" },
    { raw: "C1002", rawAddress: "ش النصر", rawName: "صيدلية د/ أحمد", rawTerritory: "القاهرة" },
    { raw: "C1003", rawAddress: "ش الجمهوريه", rawName: "صيدليه دكتور احمد", rawTerritory: "القاهره" },
    { raw: "C1004", rawAddress: "ش النصر", rawName: "", rawTerritory: "القاهرة" },
    { raw: "C1005", rawAddress: "ش النصر", rawName: "", rawTerritory: "القاهرة" },
  ]);
  assert.deepEqual(groups.map((g) => g.members.map((m) => m.raw)), [["C1001", "C1003"], ["C1002"], ["C1004"], ["C1005"]]);
  assert.deepEqual(groups.map((g) => g.representative.raw), ["C1001", "C1002", "C1004", "C1005"]);
  assert.deepEqual(groups.map((g) => g.key), [ahmedKey, customerPharmacyKey("صيدلية د/ أحمد", "ش النصر", "القاهرة"), "", ""]);

  // ---------------------------------------------------------------------------------------
  // The order: address, then twin, then place — and only bricks still in the master.
  // ---------------------------------------------------------------------------------------
  const bricks: PlaceBrick[] = [
    { areaCode: "CA1", brickId: "CA1-01", brickName: "النزهة" },
    { areaCode: "CA1", brickId: "CA1-02", brickName: "الماظة" },
    { areaCode: "CA2", brickId: "CA2-05", brickName: "مصر الجديدة - الكوربة" },
    { areaCode: "GZ3", brickId: "GZ3-01", brickName: "امبابة 1" },
  ];
  const live = new Set(bricks.map((b) => b.brickId));
  const indexes = buildFreeStepIndexes(
    [
      // Neither name nor address: they only make the 2% common-word cut behave as over the real map.
      ...Array.from({ length: 200 }, (_, i) => mapped({ customerCode: `F${i}` })),
      // Two pharmacies on one street in الكوربه. One-word names, so neither is anyone's twin.
      mapped({ address: "عمارة 5 ش الميرغني الكوربة", brickId: "CA2-05", customerCode: "S1", customerName: "صيدلية ريم" }),
      mapped({ address: "الميرغني الكوربه بجوار البنك", brickId: "CA2-05", customerCode: "S2", customerName: "صيدلية منى" }),
      // Twins.
      mapped({ brickId: "CA1-01", customerCode: "T1", customerName: "صيدلية الشفاء النزهة" }),
      mapped({ brickId: "CA1-02", customerCode: "T2", customerName: "صيدلية النزهة الجديدة" }),
      // Mapped to bricks that have since left the master.
      mapped({ brickId: "OLD-98", customerCode: "R1", customerName: "صيدلية الماظة الكبرى" }),
      mapped({ address: "عزبة النخل الغربية", brickId: "OLD-97", customerCode: "R2", customerName: "صيدلية هدى" }),
    ],
    bricks,
  );
  const unknowns: AiUnknown[] = [
    // All three steps answer, each with a different brick: the address match wins.
    { raw: "U1", rawAddress: "ش الميرغني الكوربه", rawName: "صيدلية الشفاء النزهة" },
    // No address match; the twin and the place in the name disagree: the twin wins.
    { raw: "U2", rawAddress: "12 ش عثمان بن عفان", rawName: "صيدلية النزهة الجديدة" },
    // Only the place in the name.
    { raw: "U3", rawAddress: "", rawName: "صيدلية امبابة" },
    // Nothing answers.
    { raw: "U4", rawAddress: "ش التحرير", rawName: "صيدلية الرحمة" },
    // Its twin's brick has left the master, so the place in the name answers instead.
    { raw: "U5", rawAddress: "", rawName: "صيدلية الماظة الكبرى" },
    // The one pharmacy at its address is mapped to a brick that has left the master.
    { raw: "U6", rawAddress: "عزبة النخل الغربية", rawName: "صيدلية هدى" },
  ];
  const answers = answerFromFreeSteps(unknowns, indexes, (code) => live.has(code));
  assert.deepEqual(answers.get("U1"), {
    code: "CA2-05",
    confidence: ADDRESS_MATCH_CONFIDENCE,
    evidence: { areaShare: 1, topScore: 1 },
    source: "address",
  });
  assert.deepEqual(answers.get("U2"), {
    addressCorroborated: false,
    code: "CA1-02",
    confidence: 90,
    matchedFrom: { customerCode: "T2", customerName: "صيدلية النزهة الجديدة", distributorCode: "PS" },
    source: "propagated",
  });
  assert.deepEqual(answers.get("U3"), { code: "GZ3-01", confidence: PLACE_IN_NAME_CONFIDENCE, source: "place" });
  assert.deepEqual(answers.get("U5"), { code: "CA1-02", confidence: PLACE_IN_NAME_CONFIDENCE, source: "place" });
  assert.equal(answers.has("U4"), false);
  assert.equal(answers.has("U6"), false);
  assert.equal(answers.size, 4);
  // Where each free step starts before geography is scored (customer-suggest.ts).
  assert.equal(ADDRESS_MATCH_CONFIDENCE, 90);
  assert.equal(PLACE_IN_NAME_CONFIDENCE, 80);

  // ---------------------------------------------------------------------------------------
  // The AI pass's requests (customer-request-packing.ts): identical pharmacies travel together.
  // ---------------------------------------------------------------------------------------
  const customers = [
    { raw: "C1", rawAddress: "ش الجمهورية", rawName: "صيدلية د/ أحمد", rawTerritory: "القاهرة" },
    { raw: "C2", rawAddress: "ش النصر", rawName: "صيدلية النور", rawTerritory: "القاهرة" },
    { raw: "C3", rawAddress: "ش الجمهوريه", rawName: "صيدليه دكتور احمد", rawTerritory: "القاهره" },
    { raw: "C4", rawAddress: "", rawName: "", rawTerritory: "" },
    { raw: "C5", rawAddress: "", rawName: "", rawTerritory: "" },
    { raw: "C6", rawAddress: "ش الهرم", rawName: "صيدلية الهدى", rawTerritory: "الجيزة" },
  ];
  // Two pharmacies a request: C1 and C3 share one although the list separates them, and the two
  // nameless codes are two pharmacies, not one.
  assert.deepEqual(
    packCustomersByPharmacy(customers, 2, 300).map((request) => request.map((c) => c.raw)),
    [["C1", "C3", "C2"], ["C4", "C5"], ["C6"]],
  );
  // A pharmacy with more codes than a request may carry is split across requests, never cut.
  const sevenCodes = Array.from({ length: 7 }, (_, i) => ({ raw: `K${i}`, rawAddress: "ش الجمهورية", rawName: "صيدلية د/ أحمد", rawTerritory: "القاهرة" }));
  assert.deepEqual(
    packCustomersByPharmacy([...sevenCodes, customers[1]], 60, 3).map((request) => request.map((c) => c.raw)),
    [["K0", "K1", "K2"], ["K3", "K4", "K5"], ["K6", "C2"]],
  );
  // The workspace's sizes: 60 pharmacies a request.
  const many = Array.from({ length: 130 }, (_, i) => ({ raw: `M${i}`, rawAddress: "", rawName: `صيدلية رقم ${i} الكبرى`, rawTerritory: "" }));
  assert.deepEqual(packCustomersByPharmacy(many, 60, 300).map((request) => request.length), [60, 60, 10]);
}
