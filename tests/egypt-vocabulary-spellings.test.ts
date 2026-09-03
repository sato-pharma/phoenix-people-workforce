import assert from "node:assert/strict";

import { placeAliases, resolveGovernorate } from "../src/lib/geo/egypt-locations.ts";
import { areaGovernorate, areaGovernorates, governorateNamedBy } from "../src/lib/recruitment/cv-address-place.ts";

/**
 * Two governorates the company spells its own way, and the ORDER that keeps a third one intact.
 *
 * WHY THIS SUITE EXISTS. The district-folder work of 2026-09-03 routes a CV by the governorate it
 * names, and two governorates never routed at all: the areas are called "Domiat" and "Qalubeya",
 * spellings the shared vocabulary did not carry, so every CV from either landed in a folder called
 * "No area named". The owner's answer was "fix the spellings" — correct the vocabulary once, in the
 * one module that holds Egypt's place names, rather than teach the folder rule a private list.
 *
 * WHAT MAKES THIS DELICATE, AND WHY THE CASES BELOW ARE THE ONES CHOSEN. `resolveGovernorate`
 * matches by SUBSTRING and returns the FIRST table row that hits, so the row order IS the priority
 * and adding a key can silently re-file a string that already resolved. Damietta sat first in the
 * table. Adding "domiat" to it therefore captured "Port said - Domiat" — a real area name carried by
 * 11,347 rows of imported sales — and turned it from Port Said into Damietta. The row was moved to
 * sit AFTER Port Said, which is the whole reason section 3 exists. Measured before landing: of the
 * 458 distinct aliases in the vocabulary exactly one changed its answer, "dumyat", which is section
 * 2 — the correction itself.
 *
 * These are pinned as BEHAVIOUR through the two entry points that differ: `resolveGovernorate`
 * (substring, comma-segmented, used by outstation pay, sales geography and marketing) and
 * `governorateNamedBy` (whole-word, used by recruitment). A key that satisfies one can miss the
 * other, so both are asked.
 */
export async function runEgyptVocabularySpellingsTests(): Promise<void> {
  // ── 1. The two spellings the company actually uses ─────────────────────────
  //
  // These are area names out of the organogram, not guesses: a CV from either governorate had no
  // route to a district folder before this landed.
  {
    assert.equal(resolveGovernorate("Domiat"), "Damietta", "the company spells Damietta 'Domiat'");
    assert.equal(resolveGovernorate("New Domiat"), "Damietta", "including the new-city form");
    assert.equal(resolveGovernorate("Qalubeya"), "Qalyubia", "and Qalyubia 'Qalubeya'");

    assert.equal(governorateNamedBy("Domiat"), "Damietta", "and the recruitment side agrees — whole-word matching needs the key to stand alone");
    assert.equal(governorateNamedBy("Qalubeya"), "Qalyubia", "which is the half that routes a CV to a district folder");

    assert.equal(areaGovernorate("Domiat"), "Damietta", "so an area named that way reports the governorate it sits in");
    assert.deepEqual(areaGovernorates("Qalubeya"), ["Qalyubia"], "…and the plural form, which is what the folder rule counts areas with");
  }

  // ── 2. The misfiling this corrected ────────────────────────────────────────
  //
  // "Dumyat" is Damietta transliterated, and it was sitting in Dakahlia's alias list — the one
  // alias in the whole vocabulary whose answer this change moves. Dakahlia and Damietta are
  // neighbours, so the wrong answer was plausible enough to survive.
  {
    assert.equal(resolveGovernorate("Dumyat"), "Damietta", "Dumyat is Damietta, and had been filed under Dakahlia");
    assert.equal(governorateNamedBy("Dumyat"), "Damietta", "on both paths");
  }

  // ── 3. THE ORDER, which is what a later edit will break ────────────────────
  //
  // Every assertion here passes today for one reason only: Damietta sits BELOW Port Said in the
  // priority table. Move it back up, or add "domiat" to a row above Port Said, and the first two
  // go red — which is the point. A blanket re-sort of that table is not a tidy-up.
  {
    assert.equal(resolveGovernorate("Port said - Domiat"), "Port Said",
      "a real area name holding BOTH governorates answers Port Said, because Port Said is the row above — 11,347 imported sales rows carry this exact string");
    assert.equal(areaGovernorate("Port said - Domiat"), "Port Said", "and the recruitment side reads it the same way round");
    assert.deepEqual(areaGovernorates("Port said - Domiat"), ["Port Said", "Damietta"],
      "while the plural form sees both, which is what stops that area being treated as a governorate holding exactly one area");

    const labels = placeAliases.map((entry) => entry.label);
    assert.ok(labels.indexOf("Damietta") > labels.indexOf("Port Said"),
      "the priority table decides that, so the order is pinned directly as well as through the behaviour above");

    // AND THE SUBSTRING TRAP THAT LOOKS LIKE THE SAME BUG AND IS NOT. This address contains
    // "domiat" inside a street name, in Dakahlia. It stays Dakahlia because the resolver splits on
    // commas and tries the LAST segment first, reaching "dakahlia governorate" before the segment
    // holding "Al Domiati" is ever considered.
    assert.equal(
      resolveGovernorate("392C+8VM, Al Domiati, Talkha City, Talkha, Dakahlia Governorate 7625341, Egypt"),
      "Dakahlia",
      "a street called Al Domiati in Dakahlia is still Dakahlia — the comma segments are read from the end",
    );
  }

  // ── 3b. Two more spellings, found the same way and costing the same thing ──
  //
  // Sweeping the candidates who reached NO district manager on 2026-09-03 turned up two more of
  // exactly the shape section 1 fixed. Both had a place written on them and neither resolved:
  // "Kafr El-Shiekh" transposes the vowels of a governorate the table already carried four ways,
  // and "Bani Swef" is a spelling of Beni Suef the table missed while carrying "bani sweif". The
  // second belonged to a SHORTLISTED candidate — someone the company was actively hiring, whom no
  // district manager could see.
  {
    assert.equal(resolveGovernorate("Kafr El-Shiekh"), "Kafr El-Sheikh", "the transposed spelling resolves");
    assert.equal(governorateNamedBy("Kafr El-Shiekh"), "Kafr El-Sheikh", "on the recruitment path too");
    assert.equal(resolveGovernorate("Kafr El-Sheikh"), "Kafr El-Sheikh", "and the usual spelling is untouched");

    assert.equal(resolveGovernorate("Bani Swef city"), "Beni Suef", "a Beni Suef address spelled the way a candidate wrote it");
    assert.equal(governorateNamedBy("Bani Swef city"), "Beni Suef", "on both paths, since only one of them routes a CV");
    assert.equal(resolveGovernorate("Beni Suef"), "Beni Suef", "and the usual spelling is untouched");
    assert.equal(resolveGovernorate("Bani Sweif"), "Beni Suef", "as is the variant the table already carried");
  }

  // ── 4. The vocabulary stays single ─────────────────────────────────────────
  //
  // The correction is worth nothing if a caller keeps its own copy of Egypt. Both spellings are
  // asked for through the recruitment entry point above; here the same two are asked of the
  // canonical table, so a future private alias list shows up as a disagreement rather than as a
  // second right answer.
  {
    const damietta = placeAliases.find((entry) => entry.label === "Damietta");
    const qalyubia = placeAliases.find((entry) => entry.label === "Qalyubia");
    assert.ok(damietta && qalyubia, "both governorates are in the canonical table");
    assert.ok(damietta.aliases.includes("domiat") && damietta.aliases.includes("dumyat"),
      "Damietta carries the company's spelling and the transliteration");
    assert.ok(qalyubia.aliases.includes("qalubeya"), "Qalyubia carries the company's spelling");

    const dakahlia = placeAliases.find((entry) => entry.label === "Dakahlia");
    assert.ok(dakahlia && !dakahlia.aliases.includes("dumyat"),
      "and Dakahlia no longer claims a Damietta name");
  }
}
