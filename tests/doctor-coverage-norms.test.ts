import assert from "node:assert/strict";

import { classifyCrmContactSpeciality, isDoctorSpeciality } from "../src/lib/crm/contact-taxonomy.ts";
import {
  DEFAULT_DOCTOR_COVERAGE_NORMS,
  DoctorCoverageConfigValidationError,
  MAX_VISITS_PER_MONTH,
  validateDoctorCoverageNorms,
} from "../src/lib/crm/doctor-coverage-config.ts";
import {
  buildDoctorCoverageBoard,
  type DoctorCoverageVisitInput,
} from "../src/lib/crm/sfe-doctor-coverage.ts";

/** One type-0 visit. Defaults make a graded, named contact visited by a mapped rep. */
function visit(over: Partial<DoctorCoverageVisitInput> = {}): DoctorCoverageVisitInput {
  return {
    agent_crm_id: 1,
    agent_hr_id: "B-1",
    agent_name: "Rep One",
    contact_crm_id: 100,
    contact_name: "Contact 100",
    crm_contact_grade: "A",
    crm_save_date: "2026-08-05T09:00:00",
    crm_visit_id: 1,
    double_crm_id: null,
    speciality: "Internal Medicine",
    visit_date: "2026-08-05",
    visit_type: 0,
    ...over,
  };
}

export function runDoctorCoverageNormsTests() {
  // ── taxonomy ──────────────────────────────────────────────────────────────────────────────────
  assert.equal(classifyCrmContactSpeciality("Internal Medicine"), "sp");
  assert.equal(classifyCrmContactSpeciality("Urology"), "sp", "a small specialty is still a specialty — it used to be buried in 'Other'");
  assert.equal(classifyCrmContactSpeciality("Pharmacy"), "hcp");
  assert.equal(classifyCrmContactSpeciality("Private Hospital"), "hcp");
  assert.equal(classifyCrmContactSpeciality("Contract"), "hcp", "owner rule 2026-08-09: contract and insurance are HCP");
  assert.equal(classifyCrmContactSpeciality("Health Insurance"), "hcp");
  assert.equal(classifyCrmContactSpeciality("  pHaRmAcY  "), "hcp", "vendor casing and padding must not change the kind");
  assert.equal(classifyCrmContactSpeciality(null), "unclassified");
  assert.equal(
    classifyCrmContactSpeciality("Dermatology"),
    "unclassified",
    "a value this build has never seen is surfaced, NEVER guessed into a bucket — guessing is how Contract came to be scored as a doctor",
  );
  assert.equal(isDoctorSpeciality("ENT"), true);
  assert.equal(isDoctorSpeciality("Hospital"), false);

  // ── norms validation ──────────────────────────────────────────────────────────────────────────
  const ok = validateDoctorCoverageNorms({ sp: { A: 2, B: 1, C: 1 }, hcp: { A: 1, B: 0, C: 0 } });
  assert.deepEqual(ok.hcp, { A: 1, B: 0, C: 0 }, "zero is a legal, meaningful value — 'not scored'");

  assert.throws(
    () => validateDoctorCoverageNorms({ sp: { A: -1, B: 1, C: 1 }, hcp: { A: 1, B: 1, C: 1 } }),
    DoctorCoverageConfigValidationError,
    "a negative norm is rejected",
  );
  assert.throws(
    () => validateDoctorCoverageNorms({ sp: { A: 1.5, B: 1, C: 1 }, hcp: { A: 1, B: 1, C: 1 } }),
    DoctorCoverageConfigValidationError,
    "half a visit is not a thing",
  );
  assert.throws(
    () => validateDoctorCoverageNorms({ sp: { A: MAX_VISITS_PER_MONTH + 1, B: 1, C: 1 }, hcp: { A: 1, B: 1, C: 1 } }),
    DoctorCoverageConfigValidationError,
    "more than one visit a day is a typo, and the admin must be told rather than silently clamped",
  );
  assert.throws(
    () => validateDoctorCoverageNorms({ sp: { A: 2, B: 1 }, hcp: { A: 1, B: 1, C: 1 } }),
    DoctorCoverageConfigValidationError,
    "a missing grade is rejected rather than defaulted",
  );

  // ── the norms actually drive the board ────────────────────────────────────────────────────────
  // One A-grade doctor with a single August visit. Under the default norm (A = 2) that is a MISS.
  const oneVisitToAnADoctor = [visit()];
  const strict = buildDoctorCoverageBoard(oneVisitToAnADoctor, "2026-08");
  assert.equal(strict.totals.activePanel, 1);
  assert.equal(strict.totals.green, 0, "1 visit against the default A-norm of 2 is not covered");

  const relaxed = buildDoctorCoverageBoard(oneVisitToAnADoctor, "2026-08", {
    norms: { ...DEFAULT_DOCTOR_COVERAGE_NORMS, sp: { A: 1, B: 1, C: 1 } },
  });
  assert.equal(relaxed.totals.green, 1, "lowering the A-norm to 1 makes the same visit count as covered — the norms are live");

  // ── ZERO REMOVES A POPULATION, it does not turn it green ──────────────────────────────────────
  // This is the whole reason 0 needed a defined meaning: `visitsThisMonth >= 0` is always true, so
  // a naive zero target would mark every pharmacy covered and inflate the company coverage %.
  const doctorAndPharmacy = [
    visit({ contact_crm_id: 100, contact_name: "Doctor", speciality: "Internal Medicine" }),
    visit({ contact_crm_id: 200, contact_name: "Pharmacy", crm_visit_id: 2, speciality: "Pharmacy" }),
  ];
  const bothScored = buildDoctorCoverageBoard(doctorAndPharmacy, "2026-08");
  assert.equal(bothScored.totals.activePanel, 2, "by default both the doctor and the pharmacy are scored");

  const pharmacyUnscored = buildDoctorCoverageBoard(doctorAndPharmacy, "2026-08", {
    norms: { hcp: { A: 0, B: 0, C: 0 }, sp: { A: 2, B: 1, C: 1 } },
  });
  assert.equal(
    pharmacyUnscored.totals.activePanel,
    1,
    "a 0 norm REMOVES the pharmacy from the panel and the denominator — it must never be counted as covered",
  );
  assert.equal(pharmacyUnscored.totals.green, 0, "and removing it cannot manufacture a green");
  assert.ok(
    !pharmacyUnscored.doctors.some((row) => row.kind === "hcp"),
    "no HCP row survives a 0 norm",
  );
  assert.equal(pharmacyUnscored.accountMix.length, 0, "the HCP mix is empty once that population is unscored");

  // ── the two mixes are split, and complete ─────────────────────────────────────────────────────
  assert.deepEqual(
    bothScored.specialtyMix.map((row) => row.label),
    ["Internal Medicine"],
    "doctors mix holds only SP values",
  );
  assert.deepEqual(
    bothScored.accountMix.map((row) => row.label),
    ["Pharmacy"],
    "a pharmacy belongs in the account mix, never ranked against paediatricians",
  );

  // An unclassified value stays SCORED (as SP) so the coverage number cannot silently move when the
  // vendor invents a label, and is labelled so somebody classifies it.
  const withUnknown = buildDoctorCoverageBoard(
    [visit({ contact_crm_id: 300, contact_name: "New Kind", speciality: "Dermatology" })],
    "2026-08",
  );
  assert.equal(withUnknown.totals.activePanel, 1, "an unknown speciality is still scored — dropping it would move the number silently");
  assert.ok(
    withUnknown.specialtyMix.some((row) => row.label.includes("unclassified")),
    "and it is flagged as unclassified rather than passing as a normal specialty",
  );

  // ── one rep, one name ─────────────────────────────────────────────────────────────────────────
  // Production case (DM B-94, 2026-08-09): rep B-164 inherited a VACANT seat, so the mirror holds
  // "( Nasr City / P )" — a territory with no person in it — for their earlier visits and
  // "Essam.Youssef ( Dokki / P )" for the later ones. Naming each doctor from its OWN last visit
  // put the same rep on the board under two labels, one of which named nobody.
  const renamedRepVisits = [
    // Older doctor, visited while the seat was still vacant and unnamed.
    visit({
      agent_name: "( Nasr City / P )",
      contact_crm_id: 400,
      contact_name: "Seen in June",
      crm_visit_id: 10,
      visit_date: "2026-06-10",
    }),
    // Newer doctor, after the seat was taken over and renamed. Same agent_hr_id throughout.
    visit({
      agent_name: "Essam.Youssef ( Dokki / P )",
      contact_crm_id: 401,
      contact_name: "Seen in August",
      crm_visit_id: 11,
      visit_date: "2026-08-05",
    }),
  ];
  const renamed = buildDoctorCoverageBoard(renamedRepVisits, "2026-08");
  const namesOnRows = [...new Set(renamed.doctors.map((row) => row.repName))];
  assert.deepEqual(
    namesOnRows,
    ["Essam.Youssef ( Dokki / P )"],
    "every row for one rep shows that rep's CURRENT name — a doctor last seen in June must not still carry the old vacant-seat label",
  );
  assert.ok(
    !namesOnRows.some((name) => name.trim().startsWith("(")),
    "a rep label must never be a bare territory with no person in it (owner rule: always human-readable names)",
  );
  assert.equal(renamed.reps.length, 1, "both visits share one agent_hr_id, so they roll up to ONE rep row");
  assert.equal(renamed.reps[0].repName, "Essam.Youssef ( Dokki / P )", "and the rep table agrees with the rows");
}
