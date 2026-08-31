import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PLACE_TIERS, suggestPositions, TIER_RANK } from "../src/lib/recruitment/position-suggestion.ts";
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
  { areaName: "Cairo", id: 348, jobTitle: "District Sales Manager", lineName: "Pedia", managerHrId: "m1", managerName: "Ali Mohamed Ali Elsayed", regionName: "Cairo", standingInFor: null },
  { areaName: "Egypt", id: 360, jobTitle: "National Sales Manager", lineName: "Anti Infective", managerHrId: "m2", managerName: "Anwar Gaweesh", regionName: "Egypt", standingInFor: null },
  { areaName: "Delta (2)", id: 356, jobTitle: "District Sales Manager", lineName: "Pedia", managerHrId: "m3", managerName: "Hany Saad Mohamed Omar", regionName: "Delta (2)", standingInFor: null },
  { areaName: "Nasr City", id: 298, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m4", managerName: "Momen Abdelhady Mohamed Shehata", regionName: "Cairo", standingInFor: null },
  { areaName: "Nasr City", id: 330, jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "m1", managerName: "Ali Mohamed Ali Elsayed", regionName: "Cairo", standingInFor: null },
  { areaName: "Heliopolis", id: 297, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m4", managerName: "Momen Abdelhady Mohamed Shehata", regionName: "Cairo", standingInFor: null },
  // Helwan-Maadi's sales REGION is called Giza, but the governorate its name resolves to is Cairo.
  // Region and governorate are different things in this company and neither implies the other.
  { areaName: "Haram - Faisal", id: 3, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m5", managerName: "Mahmoud Eldaly", regionName: "Giza", standingInFor: null },
  { areaName: "Helwan-Maadi", id: 261, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m5", managerName: "Mahmoud Eldaly", regionName: "Giza", standingInFor: null },
  { areaName: "Kafr El-Sheikh 1", id: 301, jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "m3", managerName: "Hany Saad Mohamed Omar", regionName: "Alex-BHR", standingInFor: null },
  { areaName: "Dakahlia 3", id: 323, jobTitle: "Medical Representative", lineName: "CNS", managerHrId: "m6", managerName: "Sally Saied Sedhom Mankrios Sedhom", regionName: "Delta (2)", standingInFor: null },
  { areaName: "Gharbia 1 (Tanta)", id: 353, jobTitle: "Medical Representative", lineName: "Anti Infective", managerHrId: "m7", managerName: "Dina Hamdy Fadel Mohamed Bdair", regionName: "Delta (1)", standingInFor: null },
  { areaName: "Fayoum", id: 316, jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "m8", managerName: "Taha Mohamed Taha Elsayed AboElftouh", regionName: "Giza", standingInFor: null },
  { areaName: "Head office", id: 354, jobTitle: "Talent Acquisition", lineName: "Head Office", managerHrId: "m9", managerName: "Omar Anwar Ibrahim Ahmed Gawish", regionName: "Head office", standingInFor: null },
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
    // The manager picker went MULTI-select on 2026-08-31, so the send loops the effective LIST. The
    // `effective` prefix is the part that matters and is what these two pin: a loop over the raw
    // `sendManagerHrIds` would post nothing on a suggested send, silently, looking exactly like the
    // old behaviour — which is the bug the single-value version of this assertion was written for.
    assert.match(screen, /for \(const managerHrId of effectiveManagerHrIds\)/,
      "the send goes to every manager the suggestion or the recruiter put in the picker");
    assert.match(screen, /disabled=\{busy \|\| effectiveManagerHrIds\.length === 0\}/,
      "and the button unlocks on the suggested manager too, or a suggestion cannot be acted on");

    // A recruiter must be able to say no. With "" meaning both "untouched" and "none", choosing the
    // blank option handed the suggestion straight back and there was no way to refuse it.
    //
    // The row itself moved into `vacancy-picker.tsx` when the flat `<select>` became a grouped,
    // searchable picker, so this is now pinned in two halves: the screen must still ASK for the
    // option, and the picker must still OFFER it. Pinning only one half would let the option quietly
    // stop rendering while the assertion stayed green.
    assert.match(screen, /offerNoPosition=\{Boolean\(suggestion\.confident\)\}/,
      "the screen offers the refusal exactly when there is a suggestion to refuse");
    const vacancyPicker = readFileSync(
      path.join(process.cwd(), "src/components/recruitment/vacancy-picker.tsx"),
      "utf8",
    );
    assert.match(vacancyPicker, /id: NO_POSITION/,
      "and the picker carries a row for it");
    assert.match(vacancyPicker, /name: "No position"/,
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
      assert.doesNotMatch(chunk, /\bAI\b|artificial intelligence|machine learning|\bGPT\b|automatically detected|we think|our system (thinks|suggests)/i,
        `no visible label may name the machinery: ${chunk.trim()}`);
    }
    for (const label of ["Looks like this one", "Looks like one of these"]) {
      assert.ok(screen.includes(label), `the suggestion is offered in plain words: ${label}`);
    }
  }

  // ── 12. A neighbourhood is its own evidence ────────────────────────────────
  // The bricks are this company's only fine-grained map of Egypt and all 697 are written in Arabic;
  // every CV address is written in English. Until they could see each other, "Helmeyet El-Zeitoun"
  // reached nothing finer than "Cairo" — a governorate covering twelve open seats, which is silence.
  {
    const maadi = suggestPositions(
      { address: "Zahra Almaadi", currentJobTitle: "Medical Representative" },
      SEATS,
    );
    assert.equal(
      maadi.confident?.vacancy.areaName,
      "Helwan-Maadi",
      "Zahra El Maadi is in Helwan-Maadi, and the address never says so in as many words",
    );
    assert.equal(maadi.confident?.placeTier, "neighbourhood", "and it is reached at the neighbourhood tier");

    const haram = suggestPositions(
      { address: "El Haram, Giza", currentJobTitle: "Medical Representative" },
      SEATS,
    );
    assert.equal(haram.confident?.vacancy.areaName, "Haram - Faisal", "El Haram names its own area");

    // NO GOVERNORATE FIELD AT ALL. This is the case a governorate gate would have thrown away, and
    // 52 of the 448 CVs on file are in exactly this state: an address, and nothing else.
    const bare = suggestPositions(
      { address: "Maadi", currentJobTitle: "Medical Representative", governorate: null },
      SEATS,
    );
    assert.equal(
      bare.confident?.vacancy.areaName,
      "Helwan-Maadi",
      "a neighbourhood answers on its own — requiring the governorate to agree first would delete this",
    );
  }

  // ── 13. An address outside Egypt stays silent ──────────────────────────────
  // All three were CONFIDENT pre-fills before the matcher learned to read vowels. Two of the three
  // candidates live on another continent.
  {
    const foreign = [
      "House R-397 Sector 15A/5 Bufferzone Karachi 75850 Karachi",
      "A 2160, UGF, Green fields colony, Faridabad, Haryana 121002.",
      "Post Office Box 5, Suma - Ahenkro",
      "No 20, Eternity Drive, Off Elioparanwo Road, By Ada George Road",
    ];
    for (const address of foreign) {
      const result = suggestPositions({ address, currentJobTitle: "Medical Representative" }, SEATS);
      assert.equal(result.confident, null, `an address outside Egypt must pre-fill nothing: ${address}`);
      assert.equal(result.shortlist.length, 0, `and must not shortlist anything either: ${address}`);
    }
  }

  // ── 14. Two real places of one name ────────────────────────────────────────
  // The brick table tells them apart by appending where the second one is: "المطريه" is in Cairo and
  // "المطريه الدقهلية" is in Dakahlia. Read literally the bare spelling belongs to Cairo alone — but
  // "Matarya" is all anybody writes, so a Dakahlia candidate was being pre-filled into a Cairo seat
  // with no sign a second Matarya existed. Owner's decision, 2026-08-28: show both, recruiter picks.
  {
    const matarya = suggestPositions(
      // NO governorate field, deliberately: with one, the governorate rung would supply Dakahlia 3
      // anyway and this assertion would pass whether the widening existed or not.
      { address: "Matarya", currentJobTitle: "Medical Representative", governorate: null },
      SEATS,
    );
    assert.ok(
      matarya.shortlist.some(
        (entry) => entry.vacancy.areaName === "Dakahlia 3" && entry.placeTier === "neighbourhood",
      ),
      "the bare spelling must reach the Dakahlia Matarya as a NEIGHBOURHOOD, not only the Cairo one",
    );

    // AND THE FULLER SPELLING STILL WINS OUTRIGHT. Where the address names the qualifier too, the
    // longer reading has consumed more of it and is the one the candidate wrote down.
    const twoSalams: VacancyOption[] = [
      { areaName: "Helwan-Maadi", id: 901, jobTitle: "Medical Representative", lineName: "Pedia", managerHrId: "m5", managerName: "Mahmoud Eldaly", regionName: "Giza", standingInFor: null },
      { areaName: "Sohag2", id: 902, jobTitle: "Medical Representative", lineName: "CNS", managerHrId: "m6", managerName: "Sally Saied Sedhom Mankrios Sedhom", regionName: "Upper Egypt", standingInFor: null },
    ];
    const sohag = suggestPositions(
      { address: "Dar Al-Salam, Sohag", currentJobTitle: "Medical Representative" },
      twoSalams,
    );
    assert.equal(
      sohag.confident?.vacancy.areaName,
      "Sohag2",
      "Dar El Salam Sohag reads three words of the address where the Cairo one reads two",
    );
  }

  // ── 15. Every place tier has a rank, checked at RUNTIME ────────────────────
  // An exhaustive Record does not gate the build here: next.config sets ignoreBuildErrors, so a new
  // tier added without a rank compiles, builds and DEPLOYS, and every seat at that tier then sorts
  // on undefined. That exact shape shipped once in this repository and scattered 63 real candidates
  // through a screening queue at random, because NaN comparisons do not throw. So the union is
  // walked here rather than trusted to the compiler.
  {
    for (const tier of PLACE_TIERS) {
      const rank = TIER_RANK[tier];
      assert.ok(
        Number.isFinite(rank),
        `place tier "${tier}" has no rank — every seat at that tier would sort on undefined`,
      );
    }
    for (const key of Object.keys(TIER_RANK)) {
      assert.ok(
        (PLACE_TIERS as readonly string[]).includes(key),
        `TIER_RANK ranks "${key}", which is not a place tier — a rename left it behind`,
      );
    }
    assert.equal(
      new Set(Object.values(TIER_RANK)).size,
      PLACE_TIERS.length,
      "two tiers sharing a rank would make the better of them lose ties silently",
    );
  }

  // ── 16. The governorate breaks a tie, and never anything else ──────────────
  // Measured on all 448 candidates: exactly TWO land on a shortlist because one Arabic name is two
  // real places, and in both the CV had already said which one. "Dayrout, Asyut" writes the answer
  // into the address; "Matarya" leaves the governorate column to say Dakahlia. Offering the second
  // seat in either case offers something the candidate has contradicted.
  //
  // THE DANGEROUS VERSION OF THIS IS A GATE, AND IT IS NOT WHAT THIS IS. Refusing any neighbourhood
  // match whose governorate disagrees deletes 52 candidates' answers, because a blank governorate
  // column is ordinary and a wrong one is not rare. Every assertion below that says "unchanged" is
  // guarding that difference.
  {
    const rep = (id: number, areaName: string, lineName: string): VacancyOption => ({
      areaName,
      id,
      jobTitle: "Medical Representative",
      lineName,
      managerHrId: "m1",
      managerName: "Ali Mohamed Ali Elsayed",
      regionName: "R",
      standingInFor: null,
    });

    // A. Two real Dayrouts. The address itself names the governorate, so the Beheira seat goes.
    const dayrout = suggestPositions(
      { address: "Dayrout, Asyut", currentJobTitle: "Medical Representative", governorate: "Assiut" },
      [rep(1, "Assuit 1", "Pedia"), rep(2, "Behira 2", "CNS")],
    );
    assert.equal(
      dayrout.confident?.vacancy.areaName,
      "Assuit 1",
      "the address says Asyut, so the Beheira Dayrout is not a live option",
    );
    assert.equal(dayrout.shortlist.length, 1, "and it is no longer offered as a choice either");

    // B. The two Matareyas. The address names neither governorate; the column names one.
    const matarya = suggestPositions(
      { address: "Matarya", currentJobTitle: "Medical Representative", governorate: "Dakahlia" },
      [rep(1, "Cairo East 1", "Anti Infective"), rep(2, "Cairo East 1", "Pedia"), rep(3, "Dakahlia 3", "CNS")],
    );
    assert.equal(
      matarya.confident?.vacancy.areaName,
      "Dakahlia 3",
      "the governorate column settles which Matarya this candidate lives in",
    );

    // C. AND WITHOUT THAT COLUMN, BOTH STILL STAND. This is the whole difference from a gate: no
    // stated governorate is not a disagreeing one, and the owner's rule is that the recruiter picks.
    const unstated = suggestPositions(
      { address: "Matarya", currentJobTitle: "Medical Representative", governorate: null },
      [rep(1, "Cairo East 1", "Anti Infective"), rep(2, "Cairo East 1", "Pedia"), rep(3, "Dakahlia 3", "CNS")],
    );
    assert.equal(unstated.confident, null, "with nothing to break the tie, nothing is pre-filled");
    assert.ok(
      areasOf(unstated.shortlist).includes("Dakahlia 3 · CNS"),
      "and the Dakahlia Matarya is still on the list",
    );

    // D. WHEN NOTHING AGREES, NOTHING IS DROPPED. Bahteem is in Qalyubia and this company serves it
    // from Cairo West — deliberately, per its own commercial map. A gate would delete the answer;
    // the tie-break leaves it exactly as it found it.
    const seats = [rep(1, "Cairo West", "CNS"), rep(2, "Cairo West", "Pedia")];
    const bahteem = suggestPositions(
      { address: "Bahteem ,sh.el khema, kaliobia", currentJobTitle: "Medical Representative", governorate: "Qalyubia" },
      seats,
    );
    assert.equal(
      bahteem.shortlist.length,
      2,
      "no seat agrees with Qalyubia, so the company's own map is left to stand",
    );
    assert.deepEqual(
      areasOf(bahteem.shortlist),
      ["Cairo West · CNS", "Cairo West · Pedia"],
      "and the seats offered are unchanged, not narrowed to nothing",
    );

    // E. WHEN EVERYTHING AGREES, NOTHING IS DROPPED EITHER. Two seats in one area on two lines is
    // the commonest shortlist there is — twelve of the fourteen — and no address can choose between
    // a CNS seat and a Pedia one.
    const zagazig = suggestPositions(
      { address: "Zagazig, Sharkia", currentJobTitle: "Medical Representative", governorate: "Sharqia" },
      [rep(1, "Sharkia 1", "Anti Infective"), rep(2, "Sharkia 1", "Pedia")],
    );
    assert.equal(zagazig.confident, null, "a product line is not something an address decides");
    assert.equal(zagazig.shortlist.length, 2, "both seats stay on offer");

    // F. THE GOVERNORATE TIER IS INERT BY CONSTRUCTION. Every seat there matched BECAUSE its
    // governorate is the stated one, so they all agree and there is no tie to break. Sohag covers
    // Sohag1 and Sohag2 and the CV said nothing finer.
    const sohag = suggestPositions(
      { governorate: "Sohag", currentJobTitle: "Medical Representative" },
      [rep(1, "Sohag1", "Pedia"), rep(2, "Sohag2", "Anti Infective")],
    );
    assert.equal(sohag.shortlist.length, 2, "a governorate-tier shortlist cannot be narrowed by the governorate");
    assert.equal(sohag.shortlist[0].placeTier, "governorate", "and it is still a governorate-tier answer");

    // G. A SINGLE SURVIVOR IS NEVER TOUCHED, even when its governorate disagrees outright. Reaching
    // here at all means the address named this area, and one seat is not a tie.
    const lone = suggestPositions(
      { address: "Bahteem", currentJobTitle: "Medical Representative", governorate: "Qalyubia" },
      [rep(1, "Cairo West", "CNS")],
    );
    assert.equal(lone.confident?.vacancy.areaName, "Cairo West", "one seat is not a tie, so nothing is broken");

    // H. THE ADDRESS OUTRANKS THE COLUMN, because the column is the half that is wrong. Four real
    // addresses on file read "Zagazig, sharkia" beside a Governorate field saying Cairo — the CV
    // wrote the truth in the longer string and the extraction filled the short one in badly. Here
    // the column would send an Assiut candidate to Beheira.
    const columnIsWrong = suggestPositions(
      { address: "Dayrout, Asyut", currentJobTitle: "Medical Representative", governorate: "Beheira" },
      [rep(1, "Assuit 1", "Pedia"), rep(2, "Behira 2", "CNS")],
    );
    assert.equal(
      columnIsWrong.confident?.vacancy.areaName,
      "Assuit 1",
      "the governorate written INSIDE the address beats the one typed into the column",
    );
  }
}
