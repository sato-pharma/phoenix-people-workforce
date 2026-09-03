import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  addressNamesArea,
  areaGovernorate,
  areaNamedByCv,
  areaTokens,
  governorateNamedBy,
  neighbourhoodMatchStrength,
  normalizePlaceText,
} from "../src/lib/recruitment/cv-address-place.ts";

/**
 * The shared answer to "which area does this CV's own text name".
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING. The rules here were written for position-suggestion.ts and
 * moved out on 2026-09-03 so district-manager-folders.ts could reach them — a CV whose address said
 * "Nasr City" was being filed in a folder literally called "No area named", because the folder rule
 * read the `governorate` column and nothing else. The move is what makes the fix possible, and the
 * risk of a move is that a correction gets dropped on the way. Every refusal below is one this
 * matcher learned the hard way against the real CV pool, so each is pinned here as well.
 *
 * The fixture area list is production's own spelling, taken from the organogram: an area named for
 * a governorate is deliberately absent because the folder rule never offers one — what IS here is
 * the pair Qena 1 / Qena 2, which is the shape that must refuse to answer.
 */

const AREAS = ["Nasr City", "Heliopolis", "Kafr El-Sheikh 1", "Menoufia 1", "Qena 1", "Qena 2", "Sohag"];

export function runCvAddressPlaceTests(): void {
  // ── 1. The address names the area outright ─────────────────────────────────
  {
    const hit = areaNamedByCv({ address: "12 Ismail Elkabany st., Nasr City, Cairo", governorate: "Cairo" }, AREAS);
    assert.deepEqual(hit, { areaName: "Nasr City", grade: "area" },
      "a CV that writes the area's own name down is the strongest evidence there is short of being asked");
  }

  // ── 2. A GOVERNORATE IS NOT AN AREA, and this is the refusal that matters most ─────────────
  //
  // Cairo covers twelve areas in this company. Answering "Cairo" would put one CV in one district
  // manager's folder and hide it from the other eleven, which is worse than the catch-all it would
  // otherwise fall to — the catch-all at least reaches every district covering the region.
  {
    assert.equal(areaNamedByCv({ address: "Cairo, Egypt", governorate: "Cairo" }, AREAS), null,
      "a plain Cairo address names no area");
    assert.equal(areaNamedByCv({ address: null, governorate: "Cairo" }, AREAS), null,
      "and a governorate column on its own is not an address at all");
  }

  // ── 3. Two areas of one governorate: refuse, never pick ────────────────────
  //
  // The organogram splits Qena into Qena 1 and Qena 2. A CV saying "Qena" belongs to neither in
  // particular, and filing it into one puts it in front of a manager who cannot act on it while the
  // right one reads an empty folder as "nobody applied".
  {
    assert.equal(areaNamedByCv({ address: "Qena, Egypt", governorate: "Qena" }, AREAS), null,
      "a governorate the company splits between two reps resolves to neither");
  }

  // ── 4. An English address naming an ARABIC neighbourhood ───────────────────
  //
  // This is the rung that only exists because the two halves are written in different scripts: all
  // 697 bricks are Arabic and every CV address is English. Baltim and Desouk are real bricks of
  // Kafr El-Sheikh 1, and neither address contains the area's name.
  {
    assert.deepEqual(areaNamedByCv({ address: "Baltim", governorate: "Kafr El-Sheikh" }, AREAS),
      { areaName: "Kafr El-Sheikh 1", grade: "neighbourhood" },
      "a brick name in the address places the CV in the area covering it");
    assert.deepEqual(areaNamedByCv({ address: "Desouk, Kafr El-Sheikh" }, AREAS),
      { areaName: "Kafr El-Sheikh 1", grade: "neighbourhood" },
      "and the governorate beside it neither helps nor is needed");
  }

  // ── 5. The four addresses that lied, and must keep failing ─────────────────
  //
  // Each of these matched a real Egyptian place under the consonant-skeleton matcher that came
  // first: Box became Bacos in Alexandria, George became Girga in Sohag. They are pinned here, at
  // the level a folder rule actually calls, because that matcher's own suite cannot see whether
  // this function still consults it correctly.
  {
    for (const address of [
      "Post Office BOX 1234",
      "New Bapunagar, Bhilwara, Rajasthan",
      "Ada GEORGE Road",
      "KARACHI 75850",
    ]) {
      assert.equal(areaNamedByCv({ address }, AREAS), null, `"${address}" names nowhere in Egypt`);
    }
  }

  // ── 6. Nothing is invented: the answer is always from the caller's own list ─
  {
    assert.equal(areaNamedByCv({ address: "12 Ismail Elkabany st., Nasr City, Cairo" }, ["Heliopolis"]), null,
      "an area the caller does not hold is not an answer, however plainly the CV names it");
    assert.equal(areaNamedByCv({ address: "Nasr City" }, []), null, "and an empty list answers nothing");
    assert.equal(areaNamedByCv({ address: null, governorate: null }, AREAS), null, "as does an empty CV");
  }

  // ── 7. The area-name tokeniser's own corrections ───────────────────────────
  {
    // "Kafr El-Sheikh 1" must never be cut at its hyphen: the fragments are "kafr el" and "sheikh",
    // and a candidate in Al Sheikh Zayed — which is in GIZA — was matched on the second.
    assert.ok(!areaTokens("Kafr El-Sheikh 1").includes("sheikh"),
      "a name cut mid-word by its own hyphen is thrown away, never matched on");
    assert.ok(areaTokens("Gharbia 1 (Tanta)").includes("tanta"),
      "but a parenthesised alias IS split out — Tanta is what anybody actually writes");
    assert.ok(areaTokens("Assuit 2").includes("assuit"),
      "and the rep-split index comes off, because it means nothing on a CV");

    // "Egypt" is the National Sales Manager's own area, and every Egyptian address ends with it.
    assert.equal(addressNamesArea(" cairo egypt ", "Egypt"), false,
      "writing your country down must never hand you the country's top sales job");
  }

  // ── 8. The pieces the position screen still leans on ───────────────────────
  {
    assert.equal(governorateNamedBy("Alexandria, Egypt (Willing to relocate to Cairo)"), "Alexandria",
      "where somebody lives, not where they say they would move");
    assert.equal(governorateNamedBy("New Bapunagar, Bhilwara, Rajasthan"), null,
      "and a whole-word match, or the town of Aga swallows 'bapunAGAr'");
    assert.equal(areaGovernorate("Nasr City"), "Cairo", "an area reports the governorate it sits in");
    assert.ok(neighbourhoodMatchStrength("Baltim", "Kafr El-Sheikh 1") > 0, "the brick rung answers on its own");
    assert.equal(neighbourhoodMatchStrength("Baltim", null), 0, "and refuses a seat with no area");
    assert.equal(normalizePlaceText("  Kafr  El-Sheikh 1 "), "kafr el sheikh 1", "one normaliser, punctuation to spaces");
  }

  // ── 9. The module stays pure, and the vocabulary stays single ──────────────
  //
  // Both callers are reached from "use client" screens, so a database or network call here would
  // ship a service-role client to a browser. The second assertion is the one that moved from
  // candidate-position-suggestion.test.ts when these rules did: Egypt's place names are imported,
  // never copied, and this is now the file that has to hold that line.
  {
    const source = readFileSync(path.join(process.cwd(), "src/lib/recruitment/cv-address-place.ts"), "utf8");
    assert.doesNotMatch(source, /getSupabaseAdmin|createClient|fetch\(|process\.env/,
      "the place module must not read the database, the network, or the environment");
    assert.match(source, /from "@\/lib\/geo\/egypt-locations"/,
      "and must reuse the shared Egypt vocabulary rather than carry a second copy of it");
  }
}
