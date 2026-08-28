import assert from "node:assert/strict";

import {
  buildBrickNameIndex,
  suggestBrickForCrmRegion,
  type BrickForSuggestion,
} from "../src/lib/crm/region-brick-suggest.ts";
import {
  nameMatchStrength,
  placeNameKey,
  placeNameKeyCandidates,
  placeNamesMatch,
} from "../src/lib/geo/arabic-name-key.ts";

/**
 * The CRM writes Egypt in English, Phoenix writes it in Arabic, and until this shipped the two never
 * met: 0 mapped regions against 295 the visits actually use.
 *
 * Every brick below is a REAL row from production, Arabic name and area included, so a change that
 * breaks the transliteration breaks a named town rather than an invented fixture.
 */
function brick(
  brickId: string,
  brickName: string,
  areaCode: string,
  areaName: string,
  regionName = "Giza",
): BrickForSuggestion {
  return { brickId, brickName, areaCode, areaName, regionCode: areaCode.slice(0, 2), regionName };
}

const BRICKS: BrickForSuggestion[] = [
  brick("B198-3", "الكيت كات", "GZ3", "Imbaba - Imbaba Centers"),
  brick("B198-2", "إمبابه", "GZ3", "Imbaba - Imbaba Centers"),
  brick("B191-6", "بيبا", "BS1", "Beni Suef"),
  brick("B191-1", "الوسطى", "BS1", "Beni Suef"),
  brick("B181-1", "مدينة أسيوط", "UE3", "Assuit 2", "Upper Egypt"),
  brick("B201-1", "شبين الكوم", "D12", "Menoufia 1", "Delta (1)"),
  brick("B192-1", "المحله الكبرى", "D15", "Gharbia 2 (Mahalla)", "Delta (1)"),
  brick("B192-15", "محلة زياد", "D15", "Gharbia 2 (Mahalla)", "Delta (1)"),
  brick("B140-31", "نجع حمادى", "UE7", "Qena 1", "Upper Egypt"),
  brick("B60-1", "المعادى", "GZ5", "Maadi"),
  brick("B60-9", "المعادى الجديده", "GZ5", "Maadi"),
  brick("B90-1", "الزقازيق", "SH1", "Sharkia 1", "Delta (2)"),
  brick("B70-4", "المنوات", "GZ4", "Giza - Giza Centers"),
  brick("B105-9", "إدكو", "AB5", "Behira 2", "Alex-BHR"),
];

const INDEX = buildBrickNameIndex(BRICKS);

export function runCrmRegionBrickSuggestTests() {
  // ── The key itself: the same town, written twice, in two scripts ──
  {
    assert.equal(placeNameKey("الكيت كات"), placeNameKey("Kit Kat"), "Kit Kat must key the same in both scripts");
    assert.ok(placeNamesMatch("بيبا", "Beba"), "Beba / بيبا");
    assert.ok(placeNamesMatch("شبين الكوم", "Shebeen El Kom"), "Shebeen El Kom");
    assert.ok(placeNamesMatch("نجع حمادى", "Naga Hamady"), "Naga Hamady");
    assert.ok(placeNamesMatch("دمنهور", "Damanhor"), "Damanhor");
    assert.ok(placeNamesMatch("كفر الشيخ", "Kafr El Shekh"), "Kafr El Sheikh");

    // The definite article, glued to the front of a LATIN word. 8 regions and 585 visits rode on
    // this one alone.
    assert.ok(placeNamesMatch("المنوات", "Elmanwat"), "Elmanwat — the article is attached in Latin");

    // ق is k in most of the country and g in the Delta. Both spellings must reach the same brick.
    assert.ok(placeNamesMatch("الزقازيق", "Zagazig"), "Zagazig spells ق as g");
    assert.ok(placeNamesMatch("قنا", "Qena"), "Qena spells ق as q");

    // An ordinal suffix is an English habit, not part of the name.
    assert.ok(placeNamesMatch("6 اكتوبر", "6th October"), "6th October");

    // Strength reads the SAME key set the match does, so a ق town is strong rather than unmatched,
    // and a one-letter name is never strong however certain it looks.
    assert.equal(nameMatchStrength("الزقازيق", "Zagazig"), "strong", "Zagazig is a long, distinctive key");
    assert.equal(nameMatchStrength("بيبا", "Beba"), "weak", "Beba keys to one letter — the name alone cannot carry it");
    assert.equal(nameMatchStrength("دمنهور", "Cleopatra"), "none", "two different places never match");

    // Nothing survives -> no key. Two empty keys are NOT a match; that would map every unnamed
    // region to every unnamed brick.
    assert.equal(placeNameKey("مركز"), "", "a classifier word alone yields no key");
    assert.equal(placeNamesMatch("", ""), false, "empty never matches empty");
    assert.equal(placeNamesMatch("مركز", "City"), false, "two empty keys are not a match");
  }

  // ── The owner's own example, end to end: the specific thing he said would be found ──
  {
    const kitKat = suggestBrickForCrmRegion("Kit kat Imbaba", "GZ3", INDEX);
    assert.ok(kitKat, "Kit kat Imbaba must reach a brick");
    assert.equal(kitKat.brickId, "B198-3", "Kit kat Imbaba is the Kit Kat brick, not the Imbaba one");
    assert.equal(kitKat.brickName, "الكيت كات");
    assert.equal(kitKat.confidence, "confirmed");
    assert.equal(kitKat.areaName, "Imbaba - Imbaba Centers");

    // The reason a human reads must name the place in words, never a score or a code.
    assert.ok(kitKat.reason.includes("Imbaba - Imbaba Centers"), "the reason names the area in full");
    assert.equal(/\b\d+(\.\d+)?%|score/i.test(kitKat.reason), false, "no scores in the reason");
  }

  // ── Longest run wins: the parent district must not swallow the place inside it ──
  {
    // Strip the Kit Kat brick and the SAME string should now legitimately resolve to Imbaba.
    const withoutKitKat = buildBrickNameIndex(BRICKS.filter((b) => b.brickId !== "B198-3"));
    const fallback = suggestBrickForCrmRegion("Kit kat Imbaba", "GZ3", withoutKitKat);
    assert.equal(fallback?.brickId, "B198-2", "with no Kit Kat brick it falls back to Imbaba");
  }

  // ── The second signal decides, and without it a short name is NOT an answer ──
  {
    // "Beba" keys to a single consonant. Alone it is a coin toss; with the area it is the answer.
    const withArea = suggestBrickForCrmRegion("Beba", "BS1", INDEX);
    assert.equal(withArea?.brickId, "B191-6", "the reps' own area picks بيبا out of Beni Suef");

    // "Dokki" and "Edku" share the skeleton "dk" and are 200km apart. With no organogram evidence
    // the matcher must NOT claim this one — this is the trap the confidence levels exist for.
    const dokki = suggestBrickForCrmRegion("Dokki", null, INDEX);
    assert.notEqual(dokki?.confidence, "confirmed", "a 2-letter key with no area evidence is never confirmed");
  }

  // ── Whole name beats opening words ──
  {
    const maadi = suggestBrickForCrmRegion("Ma-adi", "GZ5", INDEX);
    assert.equal(maadi?.brickId, "B60-1", "Ma-adi is المعادى, not المعادى الجديده");
  }

  // ── When nothing separates the candidates it is a QUESTION, and says so ──
  {
    // Both Mahalla bricks sit in the same area, so even the second signal cannot choose.
    const mahalla = suggestBrickForCrmRegion("Mahalla", "D15", INDEX);
    assert.equal(mahalla?.confidence, "unsure", "two bricks in one area cannot be auto-resolved");
    assert.ok(mahalla.otherCandidates >= 1, "and it says how many others there were");
  }

  // ── A name that reaches nothing returns nothing, rather than the nearest thing ──
  {
    assert.equal(suggestBrickForCrmRegion("Cleopatra", "AB1", INDEX), null, "no brick, no suggestion");
    assert.equal(suggestBrickForCrmRegion("", "AB1", INDEX), null, "an empty name suggests nothing");
    assert.equal(suggestBrickForCrmRegion(null, null, INDEX), null, "a null name suggests nothing");
  }

  // ── Candidate order is longest-first, which is what makes the fallback above safe ──
  {
    const candidates = placeNameKeyCandidates("Kit kat Imbaba");
    assert.ok(candidates.length > 1, "a three-word name yields several candidate keys");
    const full = candidates.indexOf(placeNameKey("Kit kat Imbaba"));
    const kitKat = candidates.indexOf(placeNameKey("Kit kat"));
    const imbaba = candidates.indexOf(placeNameKey("Imbaba"));
    assert.ok(full === 0, "the whole name is tried first");
    assert.ok(kitKat < imbaba, "two words before one");
  }
}
