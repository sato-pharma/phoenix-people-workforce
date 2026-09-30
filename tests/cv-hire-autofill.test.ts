import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildOfferHireDraft } from "../src/lib/offers/hire-draft.ts";
import {
  buildCvHireFacts,
  collegeNameFromCv,
  CV_HIRE_FACT_KEYS,
  describeCvHireFacts,
  normalizeCvGender,
  withCvHireFacts,
  type CvHireSubject,
} from "../src/lib/recruitment/cv-hire-facts.ts";

/**
 * The CV, wired to the offer letter, wired to Add Employee (owner, 2026-09-30: *"so when I add
 * employee I have much data auto populated because I hate manual work"*).
 *
 * Add Employee has three doors and each carried a different amount of the person. The offer door
 * carried NONE of it — ten fields, not one personal — even though the candidate record points
 * straight at the letter. These assertions pin the one mapping all three now share, the direction
 * rule it must not break, and the four things it still refuses to invent.
 */

const subject: CvHireSubject = {
  address: "12 Nasr Road, Nasr City",
  dateOfBirth: "1995-04-12",
  degree: "BSc Pharmacy",
  faculty: "Faculty of Pharmacy",
  gender: "Male",
  governorate: "Cairo",
  graduationYear: 2017,
  nationalId: "29504121201234",
  phone: "+201001234567",
  placeOfBirth: "Giza",
  university: "Cairo University",
  whatsapp: "+201119998877",
};

function read(path: string): string {
  return readFileSync(path, "utf8");
}

export function runCvHireAutofillTests() {
  // ── 1 · Every fact lands in the box that holds it ────────────────────────────────────────────
  const facts = buildCvHireFacts(subject);
  assert.equal(facts.nationalId, "29504121201234");
  assert.equal(facts.birthDate, "1995-04-12");
  assert.equal(facts.birthPlace, "Giza");
  assert.equal(facts.gender, "male");
  assert.equal(facts.mobileNumber, "+201001234567");
  assert.equal(facts.residenceAddress, "12 Nasr Road, Nasr City");
  assert.equal(facts.residenceCity, "Cairo");
  assert.equal(facts.qualification, "BSc Pharmacy");
  assert.equal(facts.education, "Pharmacy");
  assert.equal(facts.universityName, "Cairo University");
  assert.equal(facts.seniorYear, "2017");

  // Every key is always present and always a string — the form binds each one to an input, and an
  // `undefined` there is React's uncontrolled-input warning rather than an empty box.
  const empty = buildCvHireFacts(null);
  for (const key of CV_HIRE_FACT_KEYS) {
    assert.equal(typeof empty[key], "string", `${key} must be a string even with no candidate at all`);
    assert.equal(empty[key], "", `${key} must be empty, never the word "null"`);
  }
  assert.deepEqual(
    Object.keys(empty).sort(),
    [...CV_HIRE_FACT_KEYS].sort(),
    "CV_HIRE_FACT_KEYS is what the doors iterate — it must name every key the mapping produces, or a new fact is silently dropped at two of the three doors",
  );

  // ── 2 · "College Name" is a ONE-WORD vocabulary, and this is the fix ─────────────────────────
  //
  // Production, 2026-09-30, all 165 filled rows of `employees.education`: Science 94, Pharmacy 29,
  // Vet 27, Commerce 4, Dentist 3. Until this change the application door wrote
  // "BSc Pharmacy — Faculty of Pharmacy — Cairo University" into it — correct while `education` was
  // the form's ONLY education field (#2283, 2026-08-21), wrong from the moment #4828 gave the
  // qualification, university and graduation year their own boxes on 2026-09-30.
  assert.equal(collegeNameFromCv({ degree: null, faculty: "Faculty of Pharmacy" }), "Pharmacy");
  assert.equal(collegeNameFromCv({ degree: null, faculty: "Faculty of Science" }), "Science");

  // The EMPLOYEE column's spelling wins over the candidate menu's. `candidateBackgroundLabels` says
  // "Veterinary" and "Dentistry"; 27 and 3 live employee rows say "Vet" and "Dentist". A new hire
  // has to count alongside the people already there.
  assert.equal(
    collegeNameFromCv({ degree: null, faculty: "Faculty of Veterinary Medicine" }),
    "Vet",
    "veterinary is tested before medicine, and the column's word is Vet",
  );
  assert.equal(collegeNameFromCv({ degree: null, faculty: "Faculty of Oral and Dental Medicine" }), "Dentist");

  // Arabic, including the ARABIC PRESENTATION FORMS that PDF text extraction emits — the reason
  // this reuses `matchDiscipline` instead of stripping a prefix of its own.
  assert.equal(collegeNameFromCv({ degree: null, faculty: "كلية الصيدلة" }), "Pharmacy");
  assert.equal(collegeNameFromCv({ degree: null, faculty: "كلية العلوم" }), "Science");

  // The owner's ruling, 2026-08-31 and 2026-09-28: chemistry — and a combined chemistry-and-geology
  // department — IS science. Inherited from `matchDiscipline` rather than restated here.
  assert.equal(collegeNameFromCv({ degree: null, faculty: "Chemistry and Geology" }), "Science");

  // A false friend must not push a computing graduate into the Faculty of Science column.
  assert.equal(
    collegeNameFromCv({ degree: null, faculty: "Faculty of Computer Science" }),
    "Computer Science",
    "'Computer Science' is not a science faculty — it keeps its own words instead of being canonicalised",
  );

  // 1,039 candidates carry a degree against 894 a faculty: 145 people whose college is knowable
  // only from the degree line.
  assert.equal(
    collegeNameFromCv({ degree: "Bachelor of Veterinary Medicine", faculty: null }),
    "Vet",
    "the degree names the college when the faculty line is missing",
  );
  assert.equal(
    collegeNameFromCv({ degree: "BSc Pharmacy", faculty: "Faculty of Science" }),
    "Science",
    "the faculty is asked first — it is the field that exists to name a college",
  );

  // An unrecognised college is KEPT, prefix stripped. Commerce, Arts and Al-Alsun are all live
  // values and office hires are real; dropping them would be a worse answer than the honest words.
  assert.equal(collegeNameFromCv({ degree: null, faculty: "Faculty of Commerce" }), "Commerce");
  assert.equal(collegeNameFromCv({ degree: null, faculty: "College of Arts" }), "Arts");
  assert.equal(collegeNameFromCv({ degree: null, faculty: null }), "");

  // ── 3 · The two values that are refused rather than guessed ──────────────────────────────────
  assert.equal(normalizeCvGender("female"), "female");
  assert.equal(normalizeCvGender("ذكر"), "male");
  assert.equal(
    normalizeCvGender("Prefer not to say"),
    "",
    "an unrecognised gender is left for a human — a wrong guess here is silent",
  );

  // `senior_year` is a TEXT column, so nothing stops a page number reaching a permanent record.
  assert.equal(buildCvHireFacts({ ...subject, graduationYear: 7 }).seniorYear, "");
  assert.equal(buildCvHireFacts({ ...subject, graduationYear: 2101 }).seniorYear, "");
  assert.equal(buildCvHireFacts({ ...subject, graduationYear: 1950 }).seniorYear, "1950");
  assert.equal(buildCvHireFacts({ ...subject, graduationYear: null }).seniorYear, "");

  // WhatsApp is the fallback number, not a second field: 1,227 of 1,262 candidates carry a phone,
  // and the ones that do not arrived on WhatsApp, where the number IS how to reach them.
  assert.equal(buildCvHireFacts({ ...subject, phone: null }).mobileNumber, "+201119998877");

  // ── 4 · What the CV must never fill ──────────────────────────────────────────────────────────
  assert.equal(
    "workEmail" in facts,
    false,
    "employees.work_email is a COMPANY address and UNIQUE — a personal Gmail there looks filled in and is wrong; the mailbox task opens the real one",
  );
  assert.equal(
    "collegeMajor" in facts,
    false,
    "the CV schema has no specialisation distinct from the faculty — filling the major with the college would read as confirmation",
  );
  for (const forbidden of ["basicSalary", "baseSalary", "netSalary", "grossSalary", "jobTitle", "hireDate", "lineId", "areaId"]) {
    assert.equal(
      forbidden in facts,
      false,
      `${forbidden} is the offer's or the requisition's to state — a CV is the authority on the PERSON and on nobody else`,
    );
  }

  // ── 5 · The CV goes UNDER the letter, never over it ──────────────────────────────────────────
  const offerDraft = buildOfferHireDraft({
    offer: {
      candidateName: "Abdallah Saad",
      startDate: "01 October 2026",
      title: "Medical Representative",
      totalMonthly: 18000,
    },
    vacancy: null,
  });

  // 🔴 THE REAL GUARD: the two key sets are disjoint today, so the spread order cannot matter yet.
  // The moment somebody adds a personal field to the offer letter it WOULD matter, and this is what
  // makes that visible instead of silent.
  const overlap = CV_HIRE_FACT_KEYS.filter((key) => key in offerDraft);
  assert.deepEqual(
    overlap,
    [],
    "an offer draft field and a CV fact now share a name — decide which wins in withCvHireFacts before shipping it",
  );

  const merged = withCvHireFacts(offerDraft, facts);
  assert.equal(merged.fullName, "Abdallah Saad", "the letter's own facts survive the merge untouched");
  assert.equal(merged.hireDate, "2026-10-01");
  assert.equal(merged.netSalary, "18000");
  assert.equal(merged.nationalId, "29504121201234", "and the CV fills what the letter never knew");
  assert.equal(merged.universityName, "Cairo University");

  // An empty CV value never blanks a box that already holds something.
  const alreadyTyped = withCvHireFacts({ nationalId: "11111111111111", universityName: "" }, buildCvHireFacts(null));
  assert.equal(alreadyTyped.nationalId, "11111111111111", "a blank CV field must not erase a filled box");
  assert.equal(alreadyTyped.universityName, "");

  // A non-empty draft value wins over a non-empty CV value, in that direction only.
  const draftWins = withCvHireFacts({ residenceCity: "Alexandria" }, facts);
  assert.equal(draftWins.residenceCity, "Alexandria");
  assert.equal(draftWins.birthPlace, "Giza", "the other facts still arrive");

  // ── 6 · Named, so a screen can say what was carried instead of implying a full form ──────────
  const described = describeCvHireFacts(facts);
  assert.ok(described.includes("national id") && described.includes("university"));
  assert.deepEqual(describeCvHireFacts(buildCvHireFacts(null)), [], "no CV means the notice says nothing about one");

  // ── 7 · The module can never create the forbidden edge ───────────────────────────────────────
  //
  // `tests/candidate-offer-pointer.test.ts` guards the other direction — nothing in src/lib/offers
  // may import recruitment. This guards THIS module: it stays generic rather than importing the
  // offer draft's type, so no edge exists in either direction and the mapping serves both doors.
  const mappingSrc = read("src/lib/recruitment/cv-hire-facts.ts");
  assert.equal(
    /from "@\/lib\/offers/.test(mappingSrc),
    false,
    "cv-hire-facts.ts must not import the offers module — withCvHireFacts is generic for exactly this reason",
  );

  // ── 8 · All three doors actually carry it ────────────────────────────────────────────────────
  const routeSrc = read("app/api/offers/[id]/hire-draft/route.ts");
  assert.match(
    routeSrc,
    /withCvHireFacts\(buildOfferHireDraft\(/,
    "the offer door must lay the CV under the letter — without this it is the ten-field draft it was before",
  );
  assert.match(
    routeSrc,
    /canAccess\(access, "recruitment", "read"\)/,
    'a CV is released on the grant that governs candidate records, not on "offers:read" which governs letters',
  );

  const formSrc = read("src/components/employees/employee-management.tsx");
  const emptyFormBlock = formSrc.slice(
    formSrc.indexOf("const emptyForm: EmployeeFormState = {"),
    formSrc.indexOf("const salaryPaymentModeOptions"),
  );
  assert.ok(emptyFormBlock.length > 0, "emptyForm moved — this guard reads it by name");

  // The keys are the FORM's own field names. A renamed form field must break here rather than
  // quietly stop filling a box.
  for (const key of CV_HIRE_FACT_KEYS) {
    assert.match(
      emptyFormBlock,
      new RegExp(`\\b${key}:`),
      `${key} is not a field on the employee form any more — cv-hire-facts.ts fills a box that no longer exists`,
    );
  }

  // The third door — the seat's candidate picker — is a hand-written whitelist, so every fact has
  // to be let through by name. It is spelled out rather than spread because the placement fields
  // MUST be dropped there: the seat is what is being filled.
  const pickerBlock = formSrc.slice(
    formSrc.indexOf("async function pickSeatCandidate"),
    formSrc.indexOf("setPickedApplicationId(applicationId);"),
  );
  assert.ok(pickerBlock.length > 0, "pickSeatCandidate moved — this guard reads it by name");
  for (const key of CV_HIRE_FACT_KEYS) {
    assert.match(
      pickerBlock,
      new RegExp(`${key}: draft\\.${key} \\|\\| current\\.${key}`),
      `the seat's candidate picker drops ${key} — it is identity, and identity travels with the person`,
    );
  }
  for (const placement of ["lineId", "areaId", "departmentId", "positionId", "teamId", "managerHrId"]) {
    assert.equal(
      new RegExp(`${placement}: draft\\.${placement}`).test(pickerBlock),
      false,
      `the seat's candidate picker must never carry ${placement} — a requisition opened months ago against a neighbouring area would silently move this hire`,
    );
  }
}
