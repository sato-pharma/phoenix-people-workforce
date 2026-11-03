import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { addressBrick, addressBrickFinding, type AddressMaps } from "../src/lib/sales/normalizer/address-brick.ts";
import { addressRulingRefusal, moveTargetRefusal } from "../src/lib/sales/normalizer/address-findings.ts";
import type { BrickRef } from "../src/lib/sales/normalizer/types.ts";

// THE WRONG-TOWN FINDER'S READING (owner, 2026-11-03). Every address below is a real row. The flagged
// ones are the Heliopolis pharmacies that sat on Alexandria's النزهه and the rows the first live scan
// read correctly; the refused ones are what that scan got wrong when it was read by hand (6 of 50).
export function runAddressBrickFindingTests() {
  const brick = (brickId: string, brickName: string, areaCode: string, regionCode: string, blockName = ""): BrickRef => ({
    areaCode, areaName: `Area ${areaCode}`, blockCode: `BL-${areaCode}`, blockName, brickId, brickName, regionCode, regionName: regionCode,
  });
  const bricks = [
    brick("NOZHA", "النزهه", "AB2", "AB"),
    brick("NOZHA-NEW", "النزهه الجديدة", "CA1", "CA"),
    brick("HELIOPOLIS", "مصر الجديدة", "CA1", "CA"),
    brick("SAHEL", "الساحل", "CA6", "CA"),
    brick("SAHEL-SALIM", "ساحل سليم", "UE4", "UE"),
    brick("DAR-HELWAN", "دار السلام", "GZ5", "GZ"),
    brick("DAR-SOHAG", "دار السلام -سوهاج", "UE6", "UE"),
    brick("SOHAG-CITY", "مدينة سوهاج", "UE5", "UE"),
    brick("SINBILLAWIN", "السنبلاوين", "D22", "D2"),
    brick("TANAH", "طناح", "D23", "D2"),
    brick("MANSOURA", "المنصورة", "D21", "D2"),
    brick("SALHIA-SH", "الصالحية", "D24", "D2"),
    brick("SALHIA-Q", "الصالحية", "UE7", "UE"),
    brick("GERGA", "جرجا", "UE6", "UE"),
    brick("MAGHAGHA", "مغاغه", "UE1", "UE"),
    brick("FATH", "الفتح", "UE4", "UE"),
    brick("QUSIYA", "القوصيه", "UE3", "UE"),
    brick("QUS", "قوص", "UE8", "UE"),
    brick("SAYEDA", "السيده زينب", "CA5", "CA"),
    brick("HELMIA", "حلمية", "CA3", "CA"),
    brick("KAFR-SAAD", "كفر سعد", "D26", "D2"),
    brick("MANSHIET-NASR", "منشية النصر", "D21", "D2"),
    brick("ABU-MATAMIR", "أبو المطامير", "AB5", "AB"),
    brick("GANAKLIS", "جناكليس", "AB1", "AB"),
    brick("QURAIN", "القرين", "D25", "D2"),
    brick("ABU-HAMMAD", "أبو حماد", "D24", "D2"),
    brick("SADAT-CITY", "مدينة السادات", "D13", "D1"),
    brick("MANSHIET-SADAT", "منشية السادات", "D25", "D2"),
    brick("MAHALLA", "المحله الكبرى", "D15", "D1"),
    brick("MOVED", "ساحل طهطا", "UE5", "UE"),
  ];
  const maps: AddressMaps = {
    brickById: new Map(bricks.map((b) => [b.brickId, b])),
    movedBrickIds: new Set(["MOVED"]),
  };
  const find = (address: string, currentBrickId: string, distributorCode = "RM") =>
    addressBrickFinding({ addressValues: [address], currentBrickId, distributorCode }, maps);

  // ── 1. The hole in addressBrick: the current brick's name inside a longer brick's name ──────────
  for (const address of ["1 ش على الخفيف- النزهه الجديده", "48 ش محمد كامل حسين النزهة الجديدة", "عماره 2 مربع 1328 - النزهه الجديده"]) {
    const found = find(address, "NOZHA");
    assert.equal(found?.brick.brickId, "NOZHA-NEW", `Heliopolis, not Alexandria: ${address}`);
    assert.equal(found?.kind, "longer-name");
    assert.equal(addressBrick({ addressValues: [address], baseline: { areaCode: "AB2", brickId: "NOZHA", regionCode: "AB" }, distributorCode: "RM" }, maps), null,
      "and the importer keeps not moving it: the finder asks, it never widens the upload");
  }
  assert.equal(find("ش صالح ابو زيد- ساحل سليم", "SAHEL")?.brick.brickId, "SAHEL-SALIM", "the same shape in another governorate");
  assert.equal(find("6 ش احمد ذكى - النزهة الجديدة - القاهره", "NOZHA")?.brick.brickId, "NOZHA-NEW", "a stated governorate agrees");
  assert.equal(find("8 شارع حمزه بن عبد المطلب - النزهه - مصر الجديده - القاهره", "NOZHA"), null,
    "the stated governorate discards the Alexandria namesake, but مصر الجديدة is all generic words and no town to suggest: silence, never a guess");

  // ── 2. Another town, across regions, only when the address says the governorate ────────────────
  const sohag = find("دار السلام -سوهاج", "DAR-HELWAN", "PS");
  assert.equal(sohag?.brick.brickId, "DAR-SOHAG", "ريهام الجديدة: Sohag's دار السلام, not Helwan's");
  assert.equal(sohag?.kind, "other-town");
  assert.equal(find("جرجا - بجوار المستشفى", "MANSOURA"), null, "another region with no governorate said may be a namesake");
  assert.equal(find("جرجا - سوهاج", "MANSOURA")?.brick.brickId, "GERGA");

  // ── 3. nextUploadMoves tells the two apart ──────────────────────────────────────────────────────
  assert.equal(find("طناح-المنصورة", "SINBILLAWIN")?.nextUploadMoves, true, "inside the region the importer would make this move itself");
  assert.equal(find("ساحل سليم", "SAHEL")?.nextUploadMoves, false);

  // ── 4. Never flagged ────────────────────────────────────────────────────────────────────────────
  assert.equal(find("منشية النزهة", "NOZHA"), null, "a name inside another name with nothing to point at");
  assert.equal(find("مطار النزهة", "NOZHA"), null);
  assert.equal(find("ش النزهه الجديده", "NOZHA"), null, "straight after the street marker it IS the street");
  assert.equal(find("الصالحية", "MAGHAGHA"), null, "two namesakes: nothing, never a guess");
  assert.equal(find("دار السلام", "DAR-HELWAN"), null, "the row's own area named");
  assert.equal(find("ساحل سليم", "SAHEL", "QM"), null, "El Qema's address is a depot");
  assert.equal(find("طهطا الجديدة شارع", "SAHEL"), null);
  assert.equal(find("ساحل طهطا - سوهاج", "SAHEL"), null, "a brick kept as history is never suggested");
  assert.equal(addressBrickFinding({ addressValues: ["Heliopolis"], currentBrickId: "NOZHA", distributorCode: "RM" }, maps), null, "the matcher reads Arabic");
  assert.equal(find("طناح-المنصورة", "NO-SUCH-BRICK"), null);

  // ── 5. What the hand-read of the first 50 live findings got wrong ───────────────────────────────
  assert.equal(find("اول ابا بجوار معرض الفتح للسيراميك", "MAGHAGHA"), null, "a shop's name, not a town");
  assert.equal(find("ب القوص ش متفرع من ش المحطة شر", "QUSIYA", "PS"), null, "the current brick misspelt");
  assert.equal(find("14 ش الماس الحاجب- الحلمية الج", "SAYEDA", "PS"), null, "the sheet cut الجديدة off, so this is not the same الحلمية");
  assert.equal(find("منشية النصر . كفر الغاب . كفر", "KAFR-SAAD", "PS"), null, "the sheet cut the current brick's own name to كفر");
  assert.equal(find("السابع جناكليس مركز ابوالمطامير", "ABU-MATAMIR"), null, "the current brick, glued into one word");
  assert.equal(find("منشية السادات / المحلة الكبرى - عمارة 3", "SADAT-CITY"), null, "the address's own city is another governorate than the town");
  assert.equal(find("ش اولاد نورالدين-القرين-شرقيه", "ABU-HAMMAD", "PS")?.brick.brickId, "QURAIN",
    "a complete governorate word at the cut is not a cut name: this row is right and must stay");

  // ── 6. A ruling is on the row the person read ───────────────────────────────────────────────────
  const row = { active: true, brick_id: "NOZHA", confidence: 80, updated_at: "2026-10-27T19:38:44Z" };
  const expected = { brickId: "NOZHA", updatedAt: "2026-10-27T19:38:44Z" };
  assert.equal(addressRulingRefusal(row, expected), null);
  assert.equal(addressRulingRefusal({ ...row, confidence: null }, expected), null, "a row with no confidence can be ruled on");
  assert.match(String(addressRulingRefusal({ ...row, confidence: 100 }, expected)), /already a ruling/);
  assert.match(String(addressRulingRefusal({ ...row, brick_id: "HELIOPOLIS" }, expected)), /changed/);
  assert.match(String(addressRulingRefusal({ ...row, updated_at: "2026-11-03T00:00:00Z" }, expected)), /changed/);
  assert.match(String(addressRulingRefusal({ ...row, active: false }, expected)), /no longer exists/);
  assert.match(String(addressRulingRefusal(null, expected)), /no longer exists/);

  // ── 7. A Move goes to the brick the person read ─────────────────────────────────────────────────
  assert.equal(moveTargetRefusal("NEW-NOZHA", "NEW-NOZHA"), null);
  assert.equal(moveTargetRefusal("NEW-NOZHA", "new-nozha"), null, "the same brick in any casing");
  assert.match(String(moveTargetRefusal("HELIOPOLIS", "NEW-NOZHA")), /another brick/, "the master changed while the screen was open");
  assert.match(String(moveTargetRefusal("NEW-NOZHA", null)), /another brick/, "a Move that names no brick is refused");
  assert.match(String(moveTargetRefusal(null, "NEW-NOZHA")), /no longer points/);

  // ── 8. Only an empty page ends the walk, whatever the row cap is ────────────────────────────────
  const findings = readFileSync(new URL("../src/lib/sales/normalizer/address-findings.ts", import.meta.url), "utf8");
  assert.match(findings, /done: page\.length === 0,/);
  assert.doesNotMatch(findings, /done: page\.length < /, "a capped page would call the whole map read");
  const finder = readFileSync(new URL("../src/components/sales/wrong-town-finder.tsx", import.meta.url), "utf8");
  assert.match(finder, /expectedTargetBrickId: row\.suggested\.brickId/, "the screen sends the brick it shows");
}
