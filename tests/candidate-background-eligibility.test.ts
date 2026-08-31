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
}
