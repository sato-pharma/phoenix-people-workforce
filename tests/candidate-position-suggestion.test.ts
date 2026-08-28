import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { suggestPositions } from "../src/lib/recruitment/position-suggestion.ts";
import type { VacancyOption } from "../src/lib/recruitment/vacancy-options.ts";

/**
 * "Why don't we use the help of the AI to recommend? And that's your confirm. The HR confirm."
 *
 * The owner, 2026-08-28, on the position picker shipped that morning. So the system proposes and a
 * person decides.
 *
 * EVERY CASE BELOW EXCEPT THE LAST GROUP IS A REAL DEFECT, found by running the matcher over all
 * 447 CVs and all 49 open seats in production before any of it shipped. None was hypothetical, and
 * three of the four would have put a real person in front of the wrong manager. They are pinned as
 * behaviour rather than as source text, because the failing input is the thing worth keeping — a
 * spelling can be refactored, but "an address in Rajasthan resolved to Dakahlia" must stay false.
 *
 * The measured outcome after the fixes, on those same 447 CVs: one seat pre-filled on 35, a
 * shortlist of 2 to 5 on 66, and nothing at all on 346. Those numbers are deliberately NOT pinned —
 * they move whenever a vacancy opens or closes, and a test that fails because somebody filled a
 * seat is a test nobody trusts. What is pinned is that each known-bad input stays bad.
 */

/**
 * Seats copied from production, 2026-08-28, chosen to carry every shape that broke something.
 *
 * "Cairo" is an area name AND a governorate name, on a district manager's seat. "Egypt" is an area
 * name on the national sales manager's seat. "Delta (2)" parenthesises a digit. "Kafr El-Sheikh 1"
 * hyphenates inside a name while "Helwan-Maadi" hyphenates between two. Nasr City holds two seats
 * differing only by line, which is why even a perfect address match there cannot pre-fill one.
 */
const SEATS: VacancyOption[] = [
  { areaName: "Cairo", id: 348, jobTitle: "District Sales Manager", lineName: "Pedia", managerHrId: "m1", managerName: "Ali Mohamed Ali Elsayed", regionName: "Cairo" },
  { areaName: "Egypt", id: 360, jobTitle: "National Sales Manager", lineName: "Anti Infective", managerHrId: "m2", managerName: "Anwar Gaweesh", regionName: "Egypt" },
  { areaName: "Delta (2)", id: 356, jobTitle: "District Sales Manager", lineName: "Pedia", managerHrId: "m3", managerName: "Hany Saad Mohamed Omar", regionName: "Delta (2)" },
  { areaName: "Nasr City", id: 298, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m4", managerName: "Momen Abdelhady Mohamed Shehata", regionName: "Cairo" },
  { areaName: "Nasr City", id: 330, jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "m1", managerName: "Ali Mohamed Ali Elsayed", regionName: "Cairo" },
  { areaName: "Heliopolis", id: 297, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m4", managerName: "Momen Abdelhady Mohamed Shehata", regionName: "Cairo" },
  // Helwan-Maadi's sales REGION is called Giza, but the governorate its name resolves to is Cairo.
  // Region and governorate are different things in this company and neither implies the other.
  { areaName: "Haram - Faisal", id: 3, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m5", managerName: "Mahmoud Eldaly", regionName: "Giza" },
  { areaName: "Helwan-Maadi", id: 261, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m5", managerName: "Mahmoud Eldaly", regionName: "Giza" },
  { areaName: "Kafr El-Sheikh 1", id: 301, jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "m3", managerName: "Hany Saad Mohamed Omar", regionName: "Alex-BHR" },
  { areaName: "Dakahlia 3", id: 323, jobTitle: "Medical Representative", lineName: "CNS", managerHrId: "m6", managerName: "Sally Saied Sedhom Mankrios Sedhom", regionName: "Delta (2)" },
  { areaName: "Gharbia 1 (Tanta)", id: 353, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m7", managerName: "Dina Hamdy Fadel Mohamed Bdair", regionName: "Delta (1)" },
  { areaName: "Fayoum", id: 316, jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "m8", managerName: "Taha Mohamed Taha Elsayed AboElftouh", regionName: "Giza" },
  { areaName: "Head office", id: 354, jobTitle: "Talent Acquisition", lineName: "Head Office", managerHrId: "m9", managerName: "Omar Anwar Ibrahim Ahmed Gawish", regionName: "Head office" },
];

const areasOf = (list: ReadonlyArray<{ vacancy: VacancyOption }>): string[] =>
  list.map((entry) => `${entry.vacancy.areaName ?? "-"} · ${entry.vacancy.lineName ?? "-"}`);

export async function runCandidatePositionSuggestionTests(): Promise<void> {
  // ── 1. A governorate name is not an area name ──────────────────────────────
  // THE BIGGEST DEFECT OF THE FIRST RUN. One open seat sits in an area called simply "Cairo" and it
  // is a district manager's post. Because no other area name appears in a plain Cairo address, it
  // won on precision over eleven genuine Cairo seats and took 48 of the 81 pre-fills — a general
  // accountant in Shubra and a director of legal affairs among them.
  {
    // NO TITLE is the case that exercises this. With a title the family filter removes the Cairo
    // seat by another route entirely, so a rep CV here would pass whether the rule existed or not.
    const untitled = suggestPositions({ address: "Shubra Misr, Cairo, Egypt" }, SEATS);
    assert.equal(
      untitled.confident,
      null,
      "a plain Cairo address must not pre-fill anything — writing Cairo says which governorate, not which seat",
    );
    // The Cairo seat may still appear among several — with no title at all, nothing rules it out —
    // but it must never WIN, which is what naming an area does and naming a governorate must not.
    assert.ok(
      untitled.shortlist.length > 1,
      "living in Cairo names a governorate, so every seat in it stays level — none is singled out",
    );
    assert.ok(
      untitled.shortlist.every((entry) => entry.placeTier === "governorate"),
      "and every one of them is reached as a governorate match, never as an area match",
    );

    const rep = suggestPositions(
      { address: "Shubra Misr, Cairo, Egypt", currentJobTitle: "Senior Medical Representative" },
      SEATS,
    );
    assert.equal(rep.confident, null, "and a Cairo medical rep is a shortlist at best — twelve seats share that governorate");
    assert.ok(
      !areasOf(rep.shortlist).some((label) => label.startsWith("Cairo ·")),
      "the district manager's Cairo seat must not appear for a medical representative at all",
    );
  }

  // A district manager in Cairo is the case that SHOULD reach that seat, and does — by the
  // governorate tier, once the title filter has removed everything a district manager is not.
  {
    const manager = suggestPositions(
      { address: "Helwan / Cairo", currentJobTitle: "District sales manager" },
      SEATS,
    );
    assert.equal(manager.confident?.vacancy.id, 348, "the one open district manager seat in Cairo");
    assert.equal(manager.confident?.placeTier, "governorate", "reached by governorate, not by naming the area");
  }

  // ── 2. A short alias must not match inside a longer word ───────────────────
  // "New Bapunagar, Bhilwara, Rajasthan" resolved to DAKAHLIA on the first run, because the shared
  // resolver tests aliases as bare substrings and "bapunAGAr" contains "aga", the town of Aga.
  // Twelve more Indian and Gulf addresses followed it into Egyptian governorates.
  {
    const abroad = suggestPositions(
      {
        // A title that DOES match a family, deliberately: an unrecognised one is silenced before
        // the address is ever examined, and the case would then pass with the boundary rule gone.
        address: "C-183, New Bapunagar, Bhilwara, Rajasthan -311001",
        currentJobTitle: "Senior Medical Representative",
      },
      SEATS,
    );
    assert.equal(abroad.confident, null, "an address in Rajasthan is not in Dakahlia");
    assert.deepEqual(abroad.shortlist, [], "and nothing else in Egypt either");
  }

  // ── 3. Splitting a hyphen must not cut a name in half ──────────────────────
  // "Kafr El-Sheikh 1" split into "kafr el" and "sheikh", so a candidate in Al Sheikh Zayed — which
  // is in GIZA, at the opposite end of the country — matched Kafr El-Sheikh on the fragment.
  {
    const zayed = suggestPositions(
      { address: "Al Sheikh Zayed", currentJobTitle: "Medical Representative" },
      SEATS,
    );
    assert.ok(
      !areasOf(zayed.shortlist).some((label) => label.startsWith("Kafr El-Sheikh")),
      "Sheikh Zayed is in Giza and must never reach a Kafr El-Sheikh seat",
    );
    assert.equal(zayed.confident?.vacancy.areaName, "Haram - Faisal", "the Giza seat is the right answer");
    assert.equal(zayed.confident?.placeTier, "governorate", "reached by governorate — Sheikh Zayed is not one of the area's own names");
  }

  // The same hyphen in the other sense still splits, because that one really is two places.
  {
    const maadi = suggestPositions(
      { address: "Zahraa El Maadi", currentJobTitle: "Medical Representative" },
      SEATS,
    );
    assert.equal(maadi.confident?.vacancy.areaName, "Helwan-Maadi", "Maadi names the Helwan-Maadi area");
    assert.equal(maadi.confident?.placeTier, "area", "and names it outright, not by governorate");
  }

  // ── 4. A digit is not a place ──────────────────────────────────────────────
  // "Delta (2)" produced the bare token "2", and a sales manager living at "2 St. El Mahata, El
  // Marg" — which is in Cairo — was pre-filled into the Delta district manager's seat because their
  // street number happened to match.
  {
    const marg = suggestPositions(
      { address: "2 St. El Mahata, EL Marg", currentJobTitle: "District Sales Manager" },
      SEATS,
    );
    assert.equal(marg.confident?.vacancy.areaName, "Cairo", "El Marg is in Cairo");
    assert.ok(
      !areasOf(marg.shortlist).some((label) => label.startsWith("Delta")),
      "and a street number must never reach the Delta seat",
    );
  }

  // ── 5. "Egypt" is an area name, and every Egyptian address ends with it ────
  {
    const anyone = suggestPositions(
      { address: "Tanta, Gharbia, Egypt", currentJobTitle: "Senior Product Specialist" },
      SEATS,
    );
    assert.equal(anyone.confident?.vacancy.areaName, "Gharbia 1 (Tanta)", "Tanta names its area");
    assert.ok(
      !areasOf(anyone.shortlist).some((label) => label.startsWith("Egypt ·")),
      "writing the country down must not offer the national sales manager's seat",
    );
  }

  // ── 6. The title filter runs first, and its order is load-bearing ──────────
  {
    const hr = suggestPositions(
      { address: "Nasr City, Cairo", currentJobTitle: "HR Coordinator" },
      SEATS,
    );
    assert.equal(
      hr.confident?.vacancy.jobTitle,
      "Talent Acquisition",
      "an HR coordinator reaches the talent acquisition seat, not the office coordinator seat — the family order decides that",
    );
    assert.equal(
      hr.confident?.placeTier,
      "none",
      "and reaches it with NO place signal: head office is not an address anybody writes, and when the job leaves one seat there is nothing for an address to decide",
    );
    assert.ok(
      !areasOf(hr.shortlist).some((label) => label.startsWith("Nasr City")),
      "and must never be offered a medical representative seat merely for living in the right area",
    );
  }

  // ── 7. One survivor is a suggestion; several are a shortlist ───────────────
  // Nasr City holds two seats that differ only by line, so even a perfect address match there
  // cannot pre-fill one of them. That is the honest answer, and two options beat forty-nine.
  {
    const nasr = suggestPositions(
      { address: "Zahraa Nasr city", currentJobTitle: "Medical Representative" },
      SEATS,
    );
    assert.equal(nasr.confident, null, "two seats differing only by line is a tie, and a tie pre-fills nothing");
    assert.deepEqual(
      areasOf(nasr.shortlist),
      ["Nasr City · Anti Infective", "Nasr City · Pedia"],
      "both are offered, in the picker's own order",
    );
    assert.ok(
      nasr.shortlist.every((entry) => entry.placeTier === "area"),
      "and both were reached by the address naming the area",
    );
  }

  // A seat that is alone in its governorate pre-fills, because nothing else competes.
  {
    const fayoum = suggestPositions({ governorate: "Fayoum", currentJobTitle: "Pharmacist", hasMedicalRepExperience: true }, SEATS);
    assert.equal(fayoum.confident?.vacancy.id, 316, "the only open seat in Fayoum");
  }

  // ── 8. Silence is an answer ────────────────────────────────────────────────
  {
    const nowhere = suggestPositions({ currentJobTitle: "Medical Representative" }, SEATS);
    assert.deepEqual(nowhere.shortlist, [], "a title with no address cannot choose between seats in twenty governorates");

    // A STATED JOB WE ARE NOT HIRING FOR IS SILENCE. Before this was separated from "the CV named
    // no job at all", a primary lawyer in Nasr City was offered two medical representative seats on
    // the strength of his address alone.
    const noSeat = suggestPositions(
      { address: "Nasr City, Cairo", currentJobTitle: "Primary Lawyer" },
      SEATS,
    );
    assert.deepEqual(noSeat.shortlist, [], "no open seat is a lawyer's, and inventing one would be worse than silence");

    // But a pharmacist IS a medical representative candidate here — most Egyptian reps are pharmacy
    // graduates — so that title must not fall into the same silence.
    const pharmacist = suggestPositions(
      { address: "Zahraa El Maadi", currentJobTitle: "Chief Pharmacist and Pharmacy Manager" },
      SEATS,
    );
    assert.equal(pharmacist.confident?.vacancy.areaName, "Helwan-Maadi", "a pharmacist in Maadi reaches the Maadi rep seat");

    // And a CV with NO title at all keeps the place-only answer, because nothing was claimed to
    // contradict it. That is a different fact from an unrecognised title.
    const noTitle = suggestPositions({ address: "Zahraa Nasr city" }, SEATS);
    assert.equal(noTitle.shortlist.length, 2, "no title still narrows to the two Nasr City seats by address");

    const empty = suggestPositions({}, SEATS);
    assert.deepEqual(empty.shortlist, [], "an empty CV yields an empty answer");
    assert.equal(empty.confident, null, "and certainly no pre-fill");
  }

  // ── 9. Reasons are facts, never scores, and never mention how they were made ──
  // Standing owner rule: assistive inference is invisible to users. A percentage would also invite
  // trusting the number instead of reading the CV, which is the one thing this must not encourage.
  {
    const suggestion = suggestPositions(
      { address: "Zahraa El Maadi", currentJobTitle: "Senior Medical Representative" },
      SEATS,
    ).confident;
    assert.ok(suggestion, "the Maadi case produces a suggestion to inspect");
    const joined = suggestion.reasons.join(" ");
    assert.ok(suggestion.reasons.length > 0, "a suggestion always says why");
    assert.doesNotMatch(joined, /\bAI\b|artificial|model|GPT|confiden|score|%|probabilit/i,
      "a reason names a fact from the CV — never the machinery, never a number");
    assert.match(joined, /Zahraa El Maadi/, "and quotes what the CV actually said, so it can be checked");
  }

  // ── 10. The module stays pure ──────────────────────────────────────────────
  // It is imported by a client component. A database or network call here would either break the
  // build or, worse, ship a service-role client to a browser.
  {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/recruitment/position-suggestion.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /getSupabaseAdmin|createClient|fetch\(|process\.env/,
      "the suggestion module must not read the database, the network, or the environment");
    assert.match(source, /from "@\/lib\/geo\/egypt-locations"/,
      "and must reuse the shared Egypt vocabulary rather than carry a second copy of it");
  }

  // ── 11. The screen suggests, and never says who suggested ──────────────────
  {
    const screen = readFileSync(
      path.join(process.cwd(), "src/components/recruitment/candidate-screening-session.tsx"),
      "utf8",
    );

    // What actually gets SENT must be the effective value, not the raw picker state. The whole
    // point of a pre-filled suggestion is that it is what leaves when nobody changes it, and a send
    // path still reading `positionChoice` would post an empty position on every suggested send —
    // silently, and looking exactly like the old behaviour.
    assert.match(screen, /vacancyId: Number\(effectivePosition\)/,
      "the send posts the position that is actually showing, not the untouched picker state");
    assert.match(screen, /managerHrId: effectiveManagerHrId/,
      "and the manager the suggestion filled in, or the send goes nowhere");
    assert.match(screen, /disabled=\{busy \|\| !effectiveManagerHrId\}/,
      "and the button unlocks on the suggested manager too, or a suggestion cannot be acted on");

    // A recruiter must be able to say no. With "" meaning both "untouched" and "none", choosing the
    // blank option handed the suggestion straight back and there was no way to refuse it.
    assert.match(screen, /value=\{NO_POSITION\}>No position/,
      "there is an explicit way to send with no position at all");

    // STANDING OWNER RULE: assistive inference is invisible to users. No screen may name it.
    //
    // Reads the ATTRIBUTES too, not just the text between tags. On this screen the words a person
    // actually reads are mostly in `label` and `title` — the optgroup heading over the suggested
    // seats is an attribute, and a first version of this check scanned text nodes only, so
    // `label="AI suggests"` passed it. Proven by breaking it: the text-node scan did not fire.
    const visibleText = [
      ...(screen.match(/>[^<>{}]{4,}</g) ?? []),
      ...(screen.match(/(?:label|title|placeholder|aria-label)="[^"]{4,}"/g) ?? []),
    ];
    for (const chunk of visibleText) {
      assert.doesNotMatch(chunk, /AI|artificial intelligence|machine learning|GPT|automatically detected|we think|our system (thinks|suggests)/i,
        `no visible label may name the machinery: ${chunk.trim()}`);
    }
    for (const label of ["Looks like this one", "Looks like one of these"]) {
      assert.ok(screen.includes(label), `the suggestion is offered in plain words: ${label}`);
    }
  }
}
