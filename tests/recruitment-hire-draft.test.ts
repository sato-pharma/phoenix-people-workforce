import assert from "node:assert/strict";

import { buildHireDraft, composeEducation } from "../src/lib/recruitment/hire-draft.ts";

/**
 * Hiring someone meant reading their CV back to yourself and retyping it into a form the
 * recruitment module was standing right next to. This carries the facts across — and, just as
 * importantly, refuses to carry the ones it has no business deciding.
 */

const candidate = {
  address: "12 Nasr Road, Cairo",
  dateOfBirth: "1995-04-12",
  degree: "BSc Pharmacy",
  email: "ahmed.hassan@example.com",
  faculty: "Faculty of Pharmacy",
  fullName: "Ahmed Hassan",
  gender: "Male",
  nationalId: "29504121201234",
  phone: "+201001234567",
  university: "Cairo University",
  whatsapp: "+201119998877",
};

const requisition = {
  areaId: 7,
  departmentId: 3,
  hiringManagerHrId: "PH-0042",
  jobTitle: "Medical Representative",
  lineId: 2,
  positionId: 11,
  teamId: 5,
};

const offer = { jobTitle: "Senior Medical Representative", monthlyGross: 14500, startDate: "2026-09-01" };

export function runRecruitmentHireDraftTests() {
  const draft = buildHireDraft({ candidate, offer, requisition });

  // ── The facts that come straight across ──────────────────────────────────────────────────────
  assert.equal(draft.fullName, "Ahmed Hassan");
  assert.equal(draft.workEmail, "ahmed.hassan@example.com");
  assert.equal(draft.mobileNumber, "+201001234567");
  assert.equal(draft.nationalId, "29504121201234");
  assert.equal(draft.birthDate, "1995-04-12");
  assert.equal(draft.residenceAddress, "12 Nasr Road, Cairo");
  assert.equal(draft.education, "BSc Pharmacy — Faculty of Pharmacy — Cairo University");

  // The offer is the authority on the terms, over the requisition's original title.
  assert.equal(draft.jobTitle, "Senior Medical Representative");
  assert.equal(draft.hireDate, "2026-09-01");
  assert.equal(draft.grossSalary, "14500");

  // The seat, as the requisition inherited it from the organogram vacancy. Numeric ids become the
  // strings the employee form's selects compare against — a number would never match an option.
  assert.equal(draft.lineId, "2");
  assert.equal(draft.areaId, "7");
  assert.equal(draft.departmentId, "3");
  assert.equal(draft.positionId, "11");
  assert.equal(draft.teamId, "5");
  assert.equal(draft.managerHrId, "PH-0042");

  // ── THE HEADLINE: recruitment never derives a salary ─────────────────────────────────────────
  // Every base/basic/net derivation in this system lives in src/lib/payroll/policy.ts, which is an
  // owner-protected file. The offer's agreed gross is carried across exactly as recorded and
  // nothing is computed from it — a draft that quietly filled basicSalary would be a second,
  // unreviewed payroll formula living in the recruitment module.
  for (const forbidden of ["basicSalary", "baseSalary", "netSalary", "socialInsuranceWage", "taxes"]) {
    assert.equal(
      forbidden in draft,
      false,
      `${forbidden} must never appear in a hire draft — salary derivation belongs to src/lib/payroll/policy.ts alone`,
    );
  }

  // ── A CV's email is not automatically a work email ───────────────────────────────────────────
  // employees.work_email is UNIQUE, and a CV that listed two addresses run together would be
  // carried in as one impossible value. Same single-address rule the contact review uses.
  const twoAddresses = buildHireDraft({
    candidate: { ...candidate, email: "ahmed@example.com / ahmed.hassan@work.com" },
    offer,
    requisition,
  });
  assert.equal(twoAddresses.workEmail, "", "a CV listing two addresses must not produce a work email");

  const labelledAddress = buildHireDraft({
    candidate: { ...candidate, email: "Email: ahmed@example.com" },
    offer,
    requisition,
  });
  assert.equal(labelledAddress.workEmail, "", "a label glued to the address is not an address");

  // ── Gender is only carried when it is unambiguous ────────────────────────────────────────────
  assert.equal(buildHireDraft({ candidate: { ...candidate, gender: "female" }, offer, requisition }).gender, "female");
  assert.equal(buildHireDraft({ candidate: { ...candidate, gender: "M" }, offer, requisition }).gender, "male");
  assert.equal(
    buildHireDraft({ candidate: { ...candidate, gender: "Prefer not to say" }, offer, requisition }).gender,
    "",
    "an unrecognised gender is left for a human — a wrong guess here is silent",
  );

  // ── Fallbacks ────────────────────────────────────────────────────────────────────────────────
  const noPhone = buildHireDraft({ candidate: { ...candidate, phone: null }, offer, requisition });
  assert.equal(noPhone.mobileNumber, "+201119998877", "WhatsApp is the fallback number — most of this pool arrived on it");

  const directHire = buildHireDraft({ candidate, offer: null, requisition });
  assert.equal(
    directHire.jobTitle,
    "Medical Representative",
    "the direct-hire path has no offer, so the requisition's title is the fallback",
  );
  assert.equal(directHire.grossSalary, "", "no offer means no agreed figure to carry");
  assert.equal(directHire.hireDate, "", "no offer means no agreed start date to carry");

  const nothingKnown = buildHireDraft({
    candidate: { ...candidate, address: null, dateOfBirth: null, email: null, nationalId: null, phone: null, whatsapp: null },
    offer: null,
    requisition: null,
  });
  assert.equal(nothingKnown.fullName, "Ahmed Hassan", "the name is the one thing always known");
  for (const [key, value] of Object.entries(nothingKnown)) {
    assert.equal(typeof value, "string", `${key} must always be a string — the employee form binds every field to an input`);
  }
  assert.equal(nothingKnown.lineId, "", "a missing requisition leaves the seat blank, never a stray 'null' string");
  assert.equal(nothingKnown.workEmail, "");

  // ── Education is composed from whatever parts the CV gave ────────────────────────────────────
  assert.equal(composeEducation({ degree: "BSc", faculty: null, university: "Ain Shams" }), "BSc — Ain Shams");
  assert.equal(composeEducation({ degree: null, faculty: null, university: null }), "");
  assert.equal(
    composeEducation({ degree: "  ", faculty: "Faculty of Science", university: null }),
    "Faculty of Science",
    "a whitespace-only part must not leave a dangling separator",
  );
}
