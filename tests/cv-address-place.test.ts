import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  addressNamesArea,
  areaGovernedByCv,
  areaGovernorate,
  areaGovernorateOverrides,
  areaGovernorates,
  areaNamedByCv,
  areaTokens,
  governorateNamedBy,
  neighbourhoodMatchStrength,
  normalizePlaceText,
} from "../src/lib/recruitment/cv-address-place.ts";
import { placeAliases } from "../src/lib/geo/egypt-locations.ts";

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
 * The fixture area list is production's own spelling, taken from the organogram. Two shapes in it
 * carry the weight: the pair Qena 1 / Qena 2, which must refuse to answer, and "Sohag", an area
 * named exactly like the governorate it covers. Sohag is what separates the two questions this
 * module answers — an address saying "Sohag" NAMES no area (section 2), while a CV whose only
 * location is Sohag GOVERNORATE has exactly one area to go to (section 10).
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

  // ── 10. The governorate, when it holds exactly one area ───────────────────
  //
  // The owner, 2026-09-03, asked the question and answered it: "put them in that area folder". The
  // weakest of the three grades, and the one that has to refuse most often.
  {
    assert.deepEqual(areaGovernedByCv({ governorate: "Sohag" }, AREAS), { areaName: "Sohag", grade: "governorate" },
      "one area in the governorate means the governorate IS the area, and a catch-all would hide a person nobody has to guess about");
    assert.equal(areaNamedByCv({ governorate: "Sohag" }, AREAS), null,
      "and the stronger grade still refuses the same input — the two questions stay separate");
    assert.deepEqual(areaGovernedByCv({ address: "Baltim", governorate: "Kafr El Sheikh" }, AREAS),
      { areaName: "Kafr El-Sheikh 1", grade: "governorate" },
      "the company's spelling of an area need not match the CV's spelling of the governorate");

    // THE REFUSALS. Cairo holds two areas in this fixture and six in production; Qena holds two.
    assert.equal(areaGovernedByCv({ governorate: "Cairo" }, AREAS), null,
      "a governorate covering several areas names none of them, which is what the catch-all is for");
    assert.equal(areaGovernedByCv({ address: "Qena, Egypt", governorate: "Qena" }, AREAS), null,
      "and a split governorate refuses however many times it is written down");
    assert.equal(areaGovernedByCv({ address: "qwerty", governorate: null }, AREAS), null,
      "text naming no governorate at all resolves to nothing, never to the only area on the list");

    // MATCHED BY THE GOVERNORATE EACH AREA SITS IN, NEVER BY THE AREA'S NAME. Only one area name
    // contains the word "Giza", so name-matching would answer "Giza - Giza Centers" outright —
    // while Giza governorate really holds five areas and the CV distinguishes none of them.
    const GIZA = ["Giza - Giza Centers", "Haram - Faisal", "Imbaba - Imbaba Centers"];
    assert.equal(areaGovernedByCv({ governorate: "Giza" }, GIZA), null,
      "the tier reads which governorate each area sits in, so three Giza areas refuse even though only one is called Giza");

    assert.deepEqual(areaGovernorates("Nasr City"), ["Cairo"], "an area usually names one governorate");
    assert.deepEqual(areaGovernorates("Qalubeya"), ["Qalyubia"],
      "and the company's own spelling of an area resolves too — this pinned [] until 2026-09-03, when the owner had the vocabulary corrected rather than the folder rule taught a second spelling");
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

  // ── 11. The answers are remembered, and remembering must not change one ────────
  //
  // The owner, 2026-09-12: the screening page takes 5 to 12 seconds. Measured against the live pool,
  // the ten database reads accounted for about 5 of those and the rest was this module — the queue
  // scores 607 candidates against 45 open seats, so every address was normalised, padded and walked
  // against the whole alias table once per seat. Timed side by side on the same pool in the same
  // minute, the loader went from 17.9 / 13.4 / 14.6 seconds to 6.2 / 6.2 / 5.4.
  //
  // Nothing here is a new RULE — sections 1 to 10 above are the proof that no answer moved, and they
  // are now also the proof that the caches cannot corrupt one, because they all run in this process
  // and share them. What this section guards is the two things memoisation can break by itself.
  {
    // A REMEMBERED LIST IS EVERYBODY'S LIST. Both of these hand out a copy for that reason; return
    // the cached array itself and one caller's `push` teaches the whole module a place that is not
    // on the map, for the life of the server.
    const tokens = areaTokens("Gharbia 1 (Tanta)");
    tokens.push("karachi");
    assert.ok(!areaTokens("Gharbia 1 (Tanta)").includes("karachi"),
      "a caller must not be able to write into the remembered token list");

    const governorates = areaGovernorates("Nasr City");
    governorates.push("Aswan");
    assert.deepEqual(areaGovernorates("Nasr City"), ["Cairo"],
      "nor into the remembered governorate list");
  }
  {
    // THE BUDGET. 9,000 scorings is a fifth of one page load (607 candidates against 45 seats).
    // With the answers remembered it costs about 26ms; without, 3,600ms. One second sits 38x above
    // the first and 3.6x below the second, so a loaded CI runner passes and a lost cache fails.
    const addresses = Array.from({ length: 200 }, (_, index) => `${index} St. El Mahata, El Marg, Cairo, Egypt`);
    const areas = Array.from({ length: 45 }, (_, index) => `Gharbia ${index} (Tanta)`);
    const started = Date.now();
    for (const address of addresses) {
      const haystack = normalizePlaceText(address);
      for (const areaName of areas) {
        addressNamesArea(haystack, areaName);
        governorateNamedBy(haystack);
        areaGovernorate(areaName);
      }
    }
    const spent = Date.now() - started;
    assert.ok(spent < 1000,
      `scoring 9,000 address-by-seat pairs must stay under a second; took ${spent}ms — the place answers are no longer being remembered`);
  }

  // ── DOWN TOWN SITS IN CAIRO, BY THE OWNER'S RULING ─────────────────────────────
  //
  // Area `CA5` is named "Down town" and filed under the GIZA sales region, and it was the ONLY one
  // of the 40 live area names that resolved to no governorate at all — every other name carries its
  // governorate inside it. Asked directly, the owner ruled on 2026-09-12: "downtown move top cairo
  // yes". He ruled in the same breath that Behira needs NOTHING, which is pinned below.
  //
  // WHY THIS MATTERS BEYOND A TIDY LOOKUP. position-suggestion.ts exempts a last-remaining seat from
  // the address check when its area has no governorate — an exemption meant for seats that are not
  // anywhere a person lives. "Down town" was falling through it, so the one downtown seat could be
  // pre-filled for somebody whose address agreed with nothing at all.
  {
    assert.equal(areaGovernorate("Down town"), "Cairo", "Down town sits in Cairo — the owner's ruling, 2026-09-12");
    assert.deepEqual(areaGovernorates("Down town"), ["Cairo"], "and it names exactly one governorate");

    // THE SAME LABEL the rest of the map uses, not a second spelling of Cairo. An override whose
    // value did not match the vocabulary would resolve to a governorate nothing else can join on.
    assert.equal(areaGovernorate("Nasr City"), "Cairo", "the label must be the one Cairo's other areas carry");

    // Keyed by the EXACT production name: a rename in au.canonical_areas silently drops the override
    // and returns Down town to resolving nothing, which is what this line is here to catch.
    assert.ok(
      Object.keys(areaGovernorateOverrides).includes("Down town"),
      "the override is keyed by the exact area name in production",
    );

    // AN AREA OVERRIDE, NOT AN ALIAS. The address gazetteer already answers Cairo for the ONE-WORD
    // "downtown" and for "وسط البلد" — it always has, and this change adds nothing to it. What must
    // not happen is the ruling being re-implemented by pasting the SPACED area name into Cairo's
    // alias list, which would hand an address gazetteer the power to decide where an area sits.
    //
    // THIS CHECKS THE VOCABULARY, NOT THE ANSWER, on purpose. The two questions are now answered by
    // two different mechanisms and only one of them is the ruling: an ADDRESS saying "down town"
    // resolves to Cairo through the vocabulary (pinned in the section below, which closed the
    // spelling gap the same day), while the AREA sits in Cairo because the owner said so. Reading
    // the alias list directly is what keeps this assertion about the ruling alone — a later change
    // to how addresses are matched must not be able to make it pass or fail.
    const cairoAliases = placeAliases.find((entry) => entry.label === "Cairo")?.aliases ?? [];
    assert.ok(cairoAliases.length > 0, "Cairo must still be in the place vocabulary at all");
    assert.deepEqual(
      cairoAliases.filter((alias) => normalizePlaceText(alias) === "down town"),
      [],
      "the spaced area name must stay out of Cairo's alias list — the ruling moved the AREA, not the words",
    );

    // AND BEHIRA IS UNTOUCHED. Both halves already resolved correctly through the `behira` alias;
    // the owner confirmed twice that there is nothing to fix there. A session that reads the
    // override map as an invitation to "finish the job" should fail here.
    assert.equal(areaGovernorate("Behira 1"), "Beheira", "Behira 1 already resolved — leave it alone");
    assert.equal(areaGovernorate("Behira 2"), "Beheira", "Behira 2 already resolved — leave it alone");
    assert.deepEqual(
      Object.keys(areaGovernorateOverrides).filter((name) => name.toLowerCase().startsWith("behira")),
      [],
      "no Behira area may be given an override — the owner ruled the spelling correct, 2026-09-12",
    );
  }

  // ── ONE PLACE, TWO SPELLINGS — THE SPACE IS NOT PART OF THE NAME ───────────────
  //
  // Two comments in cv-address-place.ts promised this already worked, in both directions, and
  // neither did. The old test squashed the WHOLE address into a single token and then looked for a
  // PADDED alias inside it — but once every space is gone there are no internal spaces left for
  // that padding to find, so it could only ever match an address that said nothing except the
  // place's name. A CV never says only "down town"; it says "15 Abbas El Akkad, down town, Cairo".
  //
  // Measured on the real pool the day this was fixed — 532 distinct production CV addresses, old
  // matcher against new: 4 gained an answer, NONE lost one, and NONE moved to a different
  // governorate. Two of the four are below verbatim.
  //
  // The owner, 2026-09-12: "fix the down town address gap too".
  {
    // THE GAP ITSELF, both spellings and both directions.
    assert.equal(governorateNamedBy("down town"), "Cairo", 'an address written "down town" names Cairo');
    assert.equal(governorateNamedBy("downtown"), "Cairo", 'and so does the one-word spelling, as it always did');
    assert.equal(
      governorateNamedBy("down town, egypt"),
      "Cairo",
      "and it still reads inside a real address, where the place name is one item among several",
    );

    // THE SAME MECHANISM CARRIES THE AREA, which is the half that reaches a seat suggestion.
    for (const written of ["15 st down town cairo", "15 st downtown cairo"]) {
      assert.equal(
        addressNamesArea(normalizePlaceText(written), "Down town"),
        true,
        `the address ${JSON.stringify(written)} names the area Down town — the spelling must not decide it`,
      );
    }
    assert.equal(
      addressNamesArea(normalizePlaceText("cairo egypt"), "Down town"),
      false,
      "but a bare governorate still names no area — that correction is older and stands",
    );

    // THE OTHER DIRECTION: a run-on address reaching a spaced alias.
    assert.equal(governorateNamedBy("nasrcity"), "Cairo", 'a run-on "nasrcity" reaches the alias "nasr city"');
    assert.equal(
      addressNamesArea(normalizePlaceText("nasrcity cairo"), "Nasr City"),
      true,
      "and it names the area Nasr City as well",
    );

    // TWO REAL PRODUCTION ADDRESSES that answered NOTHING before this, quoted as they are filed.
    assert.equal(governorateNamedBy("Bani Suef, Egypt"), "Beni Suef", 'the filed address "Bani Suef, Egypt" resolved to nothing until 2026-09-12');
    assert.equal(governorateNamedBy("Alkhalifa Street, Kafrelsheikh City"), "Kafr El-Sheikh", "and so did this one");

    // WHOLE WORDS ARE WHAT MAKES JOINING THEM SAFE. This matcher's founding bug was a bare
    // substring test resolving a candidate in Rajasthan to DAKAHLIA, because "bapunAGAr" contains
    // the alias "aga". A window is cut on word boundaries before it is squashed, so no alias can
    // be found hiding inside a longer word. Twelve more addresses followed that one; this is the
    // assertion that must never come back green by accident.
    assert.equal(
      governorateNamedBy("C-183, New Bapunagar, Bhilwara, Rajasthan -311001"),
      null,
      "an alias must never be found inside a longer word — the Bapunagar/Aga correction",
    );

    // AND THE WORDS MUST BE CONSECUTIVE. Squashing joins neighbours, never a scatter.
    assert.equal(governorateNamedBy("port said"), "Port Said", "neighbouring words join");
    assert.equal(governorateNamedBy("port a b c said"), null, "words four apart do not");

    // THE VOCABULARY'S OWN ORDER STILL DECIDES when an address names two governorates. This is a
    // real address on file, and the person lives in Alexandria.
    assert.equal(
      governorateNamedBy("Alexandria, Egypt (Willing to relocate to Cairo if available Post)"),
      "Alexandria",
      "the first governorate the vocabulary ranks still wins",
    );
    assert.equal(
      governorateNamedBy("down town alexandria"),
      "Alexandria",
      "and the new spelling match does not jump that queue",
    );
  }
}
