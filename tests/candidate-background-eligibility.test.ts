// The paramedical split — who is eligible for the field force, and who waits for a human.
//
// Owner's rule, 2026-08-31: *"I want the non science or pharmacy or vet to be excluded in a separate
// folder. Name this folder paramedical."* and, the same day, *"medicine and dentistry are accepted."*
//
// EVERY FACULTY STRING BELOW IS REAL. They were read out of production on 2026-08-31 with their
// counts, and the two that decide the whole design are the commonest kind rather than exotic:
//
//   "Faculty of Veterinary Medicine"   22 people   — contains "Medicine", is not medicine
//   "Oral and dental medicine"          1 person   — contains "Medicine", is not medicine
//
// A rule that tests medicine before veterinary files 22 vets as doctors, which is wrong in the
// direction nobody notices, because both are eligible. It only shows up later, when somebody asks
// how many veterinary graduates are in the pool. So the ordering is asserted here directly.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canAutoFileBackground,
  describeBackgroundVerdict,
  judgeBackground,
  matchDiscipline,
  PARAMEDICAL_FOLDER_KEY,
} from "@/lib/recruitment/candidate-background";

export function runCandidateBackgroundEligibilityTests(): void {
  // ── The ordering traps, asserted first because they are the reason this module is shaped as it is
  // ────────────────────────────────────────────────────────────────────────────────────────────────
  assert.equal(
    matchDiscipline("Faculty of Veterinary Medicine"),
    "vet",
    "22 people in production carry this exact string — it is veterinary, never medicine",
  );
  assert.equal(matchDiscipline("Veterinary Medicine"), "vet", "the same trap without the Faculty prefix");
  assert.equal(matchDiscipline("Veterinary medicine"), "vet", "…and in the casing production actually holds");
  assert.equal(
    matchDiscipline("Oral and dental medicine"),
    "dentistry",
    "the standard Egyptian name for a dentistry faculty contains the word Medicine",
  );
  assert.equal(matchDiscipline("Dental Medicine and Surgery"), "dentistry", "the same trap, second real spelling");
  assert.equal(matchDiscipline("Oral & maxillofacial dentistry"), "dentistry", "a specialist dentistry string");
  // Only after those does a bare medicine string read as medicine.
  assert.equal(matchDiscipline("Faculty of Medicine"), "medicine", "a real medicine faculty still reads as medicine");

  // ── The five eligible disciplines, on strings production actually holds ─────────────────────────
  for (const [faculty, expected] of [
    ["Faculty of Science", "science"],
    ["Faculty of science", "science"],
    ["FACULTY OF SCIENCE", "science"],
    ["biological science", "science"],
    ["Botany & Microbiology Department", "science"],
    ["Chemistry & Microbiology", "science"],
    // Chemistry, added by name 2026-08-31 — a Faculty of Science department that the CV names on its
    // OWN, so these strings never contain the word "science" and dropped toward the queue before.
    ["Chemistry", "science"],
    ["Chemistry Department", "science"],
    ["Applied Chemistry", "science"],
    ["Analytical Chemistry", "science"],
    ["كيمياء", "science"],
    ["Pharmacy", "pharmacy"],
    ["Faculty of Pharmacy", "pharmacy"],
    ["College of Pharmacy", "pharmacy"],
    ["Clinical Pharmacy", "pharmacy"],
    ["Pharmaceutical Biotechnology", "pharmacy"],
    ["Veterinary", "vet"],
    ["Faculty of Dentistry", "dentistry"],
    ["كلية الصيدلة", "pharmacy"],
    ["الطب البيطري", "vet"],
  ] as const) {
    assert.equal(matchDiscipline(faculty), expected, `"${faculty}" must read as ${expected}`);
  }

  // ── The false friends that would otherwise be promoted INTO the eligible set ────────────────────
  // This is the one direction the review queue cannot catch, because an eligible verdict is filed
  // without anybody looking. Both strings below are live in production.
  assert.equal(
    matchDiscipline("Sciences Commerciales"),
    null,
    "a French commerce degree contains the word Sciences and must not read as a science degree",
  );
  assert.equal(
    matchDiscipline("Computer Science"),
    null,
    "a computing degree contains the word Science and must not read as a Faculty of Science degree",
  );
  assert.equal(matchDiscipline("Political Science"), null, "same false friend, different discipline");
  assert.equal(
    matchDiscipline("JSS Medical College"),
    null,
    "the ADJECTIVE medical is never a medicine degree — Medical Laboratory and Medical Rep both use it",
  );

  // ── Chemistry is eligible; its own false friends are not ────────────────────────────────────────
  // Owner 2026-08-31: *"add chemistry to be approved with pharma vet science."* Folded into science —
  // it is a Faculty of Science degree, not a sixth code. The one direction to guard is the adjective
  // "chemical" (engineering) and geology, the other science department in the same missed CVs, which
  // the owner named neither and which must stay out of the eligible set.
  assert.equal(
    matchDiscipline("Chemical Engineering"),
    null,
    "the ADJECTIVE chemical is engineering, never a chemistry degree — it must not read as science",
  );
  assert.equal(matchDiscipline("Geology"), null, "geology was deliberately left out of the eligible set");
  const chemistry = judgeBackground({ faculty: "Chemistry Department" });
  assert.equal(chemistry.outcome, "eligible", "a chemistry graduate is eligible for the field force");
  assert.equal(chemistry.discipline, "science", "recorded as science — chemistry is not offered as its own code");
  assert.ok(chemistry.autoFilable, "and may be filed without a human, like every eligible verdict");
  assert.notEqual(
    judgeBackground({ faculty: "Geology" }).outcome,
    "eligible",
    "geology is not approved — the owner named chemistry only",
  );

  // ── A tapped answer is exact, and beats whatever the CV says ───────────────────────────────────
  const tapped = judgeBackground({ declaredBackground: "Veterinary", faculty: "Faculty of Commerce" });
  assert.equal(tapped.outcome, "eligible", "the applicant's own tapped answer decides");
  assert.equal(tapped.source, "declared", "and it is recorded as their statement, not as an extraction");
  assert.equal(tapped.discipline, "vet");
  assert.ok(tapped.autoFilable, "an eligible verdict may be filed without a human");

  // The two the owner added by name — both must now be eligible off a tapped answer.
  for (const label of ["Medicine", "Dentistry"]) {
    const verdict = judgeBackground({ declaredBackground: label });
    assert.equal(verdict.outcome, "eligible", `${label} is accepted — owner's instruction 2026-08-31`);
    assert.ok(verdict.autoFilable, `${label} is auto-filable`);
  }

  // ── The exclusive direction NEVER auto-files, however confident it looks ────────────────────────
  // This is the asymmetry the module exists to hold: an eligible mistake costs one extra CV read, an
  // exclusion mistake loses a real applicant off the screen recruiters work from.
  const declaredOther = judgeBackground({ declaredBackground: "Bachelor of Commerce" });
  assert.equal(declaredOther.outcome, "paramedical", "the one real Other answer in production is paramedical");
  assert.equal(declaredOther.source, "declared", "they did answer — it is their own statement");
  assert.equal(
    declaredOther.autoFilable,
    false,
    "an exclusion is a recommendation to an admin, never an action — owner: the admin confirms first",
  );

  for (const faculty of ["Faculty of Law", "Commerce", "Engineering", "Faculty of Agriculture", "Physical Therapy"]) {
    const verdict = judgeBackground({ faculty });
    assert.equal(verdict.outcome, "paramedical", `"${faculty}" is recognisably another degree`);
    assert.equal(verdict.autoFilable, false, `"${faculty}" must still wait for a person`);
  }

  // ── Unreadable is UNKNOWN, not paramedical ─────────────────────────────────────────────────────
  // A parsing failure is not evidence about a person. Both go to the admin; only the wording differs,
  // and that wording is what stops an unreadable string being confirmed as an exclusion by reflex.
  for (const faculty of ["Vijaya College", "Dar Al-Uloom", "كلية البنات القبطية"]) {
    const verdict = judgeBackground({ faculty });
    assert.equal(verdict.outcome, "unknown", `"${faculty}" cannot be placed and must not be called paramedical`);
    assert.equal(verdict.autoFilable, false, "an unknown is never filed on its own");
  }

  // ── Arabic presentation forms, which is how PDF extraction actually emits Arabic ───────────────
  // "ﺣﻠﻮﻋ" is not the string this looks like: production holds the law faculty
  // written in Unicode ARABIC PRESENTATION FORMS, whose codepoints differ from the ordinary Arabic
  // block entirely. Without NFKC it matches no pattern and reads as unparseable.
  const presentationFormLaw = "ﺡﻕﻭﻕ"; // what a PDF extractor emits for حقوق — different codepoints
  assert.notEqual(presentationFormLaw, "حقوق", "the two spellings really are different strings");
  assert.equal(
    judgeBackground({ faculty: "حقوق" }).outcome,
    "paramedical",
    "the ordinary Arabic spelling of law is recognised",
  );
  assert.equal(
    judgeBackground({ faculty: presentationFormLaw }).outcome,
    "paramedical",
    "…and so is the presentation-form spelling, which is the one production actually holds",
  );

  // Nothing recorded at all is unknown with no source and no evidence — never a guess.
  const empty = judgeBackground({});
  assert.equal(empty.outcome, "unknown");
  assert.equal(empty.source, null);
  assert.equal(empty.evidence, null);
  assert.equal(canAutoFileBackground(null), false, "a missing candidate is never auto-filed");

  // ── The verdict explains itself, quoting what was read ─────────────────────────────────────────
  // An admin confirming an exclusion has to see the words the machine read, or they are rubber-
  // stamping rather than deciding.
  const explained = describeBackgroundVerdict(judgeBackground({ faculty: "Faculty of Law" }));
  assert.ok(explained.includes("Faculty of Law"), "the explanation quotes the evidence verbatim");
  assert.ok(explained.includes("read from the CV"), "…and says where it came from");
  const explainedDeclared = describeBackgroundVerdict(judgeBackground({ declaredBackground: "Pharmacy" }));
  assert.ok(
    explainedDeclared.includes("answered on WhatsApp"),
    "a declared answer is described as the applicant's own, not as an extraction",
  );

  // The folder name is the owner's own word, and every writer reads it from here rather than typing
  // it — grouping is case-folded, so a stray spelling renames the folder rather than splitting it,
  // and the heading he reads is what moves. DEFINED in candidate-folder.ts, which owns the folder
  // vocabulary, and re-exported here so this module can name the shelf it files onto without holding
  // a second copy of the string.
  assert.equal(PARAMEDICAL_FOLDER_KEY, "Paramedical", "the owner named this folder himself");

  // ── 🔒 A COMBINED CHEMISTRY AND GEOLOGY DEPARTMENT IS SCIENCE (owner, 2026-09-28) ─────────────
  // Egyptian science faculties commonly run the two as ONE department, and four candidates on
  // production carry exactly these strings — one already sent to a hiring manager. `chemist\w*`
  // already matched them, so the ruling changed no behaviour; it is pinned here because the comment
  // beside the science pattern reads like a reason to exclude them, and a future reader tightening
  // that would silently reverse his decision.
  for (const faculty of [
    "Chemistry and Geology",
    "Chemistry and geology department",
    "Faculty of Science of Chemistry & Geology",
    "كيمياء وجيولوجيا",
  ]) {
    const verdict = judgeBackground({ faculty });
    assert.equal(verdict.outcome, "eligible", `"${faculty}" is a combined science department — the owner ruled it SCIENCE`);
    assert.equal(verdict.discipline, "science", `"${faculty}" files under science, not its own discipline`);
  }
  // GEOLOGY ALONE is a different question and he has not ruled it science. It must NOT read eligible.
  for (const faculty of ["Geology", "Geology Department", "Faculty of Geology", "Geology and Geophysics"]) {
    assert.notEqual(
      judgeBackground({ faculty }).outcome,
      "eligible",
      `"${faculty}" names no chemistry — the owner has approved chemistry and the combined department, never geology on its own`,
    );
  }

  // ── EVERY Pick THAT FEEDS THE RULE MUST CARRY THE DEGREE ──────────────────────────────────────
  // BackgroundSubject.degree is OPTIONAL, so a caller handing over a candidate shape without it
  // compiles cleanly and simply judges on the faculty alone — the same CV routing in one screen and
  // not another. The typechecker caught district-manager-folders.ts only because its own Pick made
  // the field required; nothing would have caught the next one. So this reads the source: any
  // Pick of Candidate that takes "faculty" takes "degree" too.
  for (const file of [
    "src/lib/recruitment/background-review.ts",
    "src/lib/recruitment/district-manager-folders.ts",
    "src/lib/recruitment/whatsapp-application-form.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes("| \"faculty\""), file + " is expected to pick faculty — if it stopped, drop it from this list");
    assert.ok(
      source.includes("| \"degree\""),
      file + " picks faculty for the eligibility rule, so it must pick degree too, or that screen judges a CV on half the evidence",
    );
  }

  // ── THE DEGREE LINE, ADDED 2026-09-28 ─────────────────────────────────────────────────────────
  // An Egyptian CV very often names the degree and not the faculty, and this module read only the
  // faculty. Measured on production that day: 241 candidates read UNKNOWN, 112 of them still live,
  // and 44 had a degree line that classifies on its own. UNKNOWN is never auto-filable, so those
  // CVs waited for a human who had no reason to open them.
  const byDegree = judgeBackground({ degree: "Bachelor of Pharmacy" });
  assert.equal(byDegree.outcome, "eligible", "a degree line alone must answer when nothing else can");
  assert.equal(byDegree.discipline, "pharmacy");
  assert.equal(byDegree.source, "cv", "a degree is a CV reading, not a declared answer");
  assert.equal(byDegree.evidence, "Bachelor of Pharmacy", "the admin sees the words that decided it");
  assert.equal(canAutoFileBackground({ degree: "Bachelor's degree in Veterinary Medical Sciences" }), true);

  // 🔴 THE ONE DIRECTION THAT MUST NEVER HAPPEN BY ACCIDENT: paramedical -> eligible.
  // A faculty we RECOGNISE as something else outranks the degree line, always. "Bachelor of Science
  // in Business Administration" beside a Faculty of Commerce is a commerce graduate.
  const commerce = judgeBackground({ degree: "Bachelor of Science in Business Administration", faculty: "Faculty of Commerce" });
  assert.equal(commerce.outcome, "paramedical", "a recognised non-eligible faculty can never be overturned by a degree");
  assert.equal(commerce.evidence, "Faculty of Commerce", "…and the faculty stays the evidence");
  // A declared answer outranks it too — the applicant's own word about their own degree.
  const declaredWins = judgeBackground({ declaredBackground: "Commerce", degree: "Bachelor of Pharmacy" });
  assert.equal(declaredWins.outcome, "paramedical", "the applicant's own answer is never overruled by a CV reading");
  assert.equal(declaredWins.source, "declared");

  // An UNPARSEABLE faculty is a gap, not a verdict, so the degree may fill that one.
  const gapFilled = judgeBackground({ degree: "Bachelor of Pharmacy", faculty: "Bi-technology Dep." });
  assert.equal(gapFilled.outcome, "eligible", "a faculty nobody can parse leaves a gap the degree answers");

  // The false-friend guard travels with matchDiscipline, so it holds on the degree line too.
  assert.equal(judgeBackground({ degree: "Bachelor of Computer Science" }).outcome, "paramedical");
  assert.notEqual(judgeBackground({ degree: "Bachelor of Computer Science" }).discipline, "science");
  // And a degree that parses to nothing at all still reads UNKNOWN rather than becoming an exclusion.
  assert.equal(judgeBackground({ degree: "Bachelor" }).outcome, "unknown", "a bare Bachelor names no discipline at all");

  // A widened signature nobody passes degree to would be inert — pin all three call sites.
  for (const [file, label] of [
    ["src/lib/recruitment/candidate-screening-facts.ts", "the screening checks"],
    ["src/lib/recruitment/background-review.ts", "the background review queue"],
    ["src/lib/cv/cv-library.ts", "the CV library row"],
  ] as const) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      /degree: candidate\??\.degree,/.test(source),
      label + " must pass the degree through, or the widening is dead code",
    );
  }
}
