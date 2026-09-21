import assert from "node:assert/strict";

import type { SavedAudiences } from "../src/lib/recruitment/inbound/whatsapp-question-audience.ts";
import type { ScreeningQuestion } from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";
import {
  assembleWebsiteApplyForm,
  resolveWebsiteApplyRole,
  validateWebsiteApplication,
  websiteApplyRoleKeys,
  websiteExtraFieldKey,
  type WebsiteApplyRawAnswers,
} from "../src/lib/recruitment/inbound/website-apply.ts";

/**
 * The PURE half of the public careers-site application form: the role registry, the form assembly
 * that reuses the WhatsApp bot's own audience rules, and the answer validator that stores an option's
 * TITLE exactly as screening_extra_answers holds it. No database — the audiences and extra questions
 * are passed in, which is what keeps `websiteApplyFormFor` the ONLY thing that has to read live state.
 */

// The saved built-in audiences as production holds them (verified 2026-09-21): region, area and
// background are all scoped to the sales/field families and NOT to human_resources, while experience
// and salary carry no override and so are asked to everyone. An HR applicant is therefore asked
// exactly experience + salary of the six.
const HR_AUDIENCES: SavedAudiences = new Map<string, readonly string[]>([
  ["area", ["medical_rep", "district_manager", "area_regional_manager", "national_sales_manager", "sales"]],
  [
    "background",
    [
      "district_manager",
      "area_regional_manager",
      "national_sales_manager",
      "medical_rep",
      "product_manager",
      "sales",
      "pharmacist",
      "finance",
      "office_coordinator",
      "other",
    ],
  ],
  ["region", ["medical_rep", "district_manager", "area_regional_manager", "national_sales_manager", "sales"]],
]);

const ATS_EXTRA: ScreeningQuestion = {
  appliesToRoleFamilies: ["human_resources"],
  bodyText: "Have you used an ATS before?",
  id: "q-ats",
  isActive: true,
  kind: "tappable",
  options: [
    { description: null, title: "Yes", value: "yes" },
    { description: null, title: "No", value: "no" },
  ],
  questionKey: "hr_ats_experience",
  sortOrder: 12,
};

const NOTE_EXTRA: ScreeningQuestion = {
  appliesToRoleFamilies: ["human_resources"],
  bodyText: "Anything else you would like us to know?",
  id: "q-note",
  isActive: true,
  kind: "free_text",
  options: null,
  questionKey: "hr_note",
  sortOrder: 20,
};

export function runWebsiteApplyFormTests() {
  // ── The role registry ─────────────────────────────────────────────────────────────────────────
  assert.deepEqual(websiteApplyRoleKeys(), ["talent_acquisition_specialist"]);
  const role = resolveWebsiteApplyRole("talent_acquisition_specialist");
  assert.ok(role, "the launch role must resolve");
  assert.equal(role.jobTitle, "Talent Acquisition Specialist");
  assert.equal(role.roleFamily, "human_resources");
  assert.equal(resolveWebsiteApplyRole("nope"), null);
  assert.equal(resolveWebsiteApplyRole(null), null);

  assert.equal(websiteExtraFieldKey("hr_ats_experience"), "extra:hr_ats_experience");

  // ── Form assembly: identity + CV, then experience + salary, then the extras in sort order ───────
  const form = assembleWebsiteApplyForm(role, HR_AUDIENCES, [ATS_EXTRA, NOTE_EXTRA]);
  assert.deepEqual(
    form.fields.map((field) => field.key),
    ["full_name", "email", "phone", "cv", "experience", "salary", "extra:hr_ats_experience", "extra:hr_note"],
    "HR is asked experience + salary of the six, then its two extras — region/area/background are scoped out",
  );

  const experience = form.fields.find((field) => field.key === "experience");
  assert.ok(experience);
  assert.equal(experience.kind, "select");
  assert.deepEqual(
    experience.options?.map((option) => option.value),
    ["fresh", "lt_1", "1_3", "3_5", "gt_5"],
    "experience options are the fixed bands, verbatim",
  );
  // The extras are optional — a blank answer must never block an application.
  assert.equal(form.fields.find((field) => field.key === "extra:hr_ats_experience")?.required, false);

  // A role whose flow would include an unsupported built-in (region/area/background) is a
  // code-level misconfiguration and fails loudly rather than shipping a form that drops the answer.
  const regionForHr: SavedAudiences = new Map<string, readonly string[]>([["region", ["human_resources"]]]);
  assert.throws(() => assembleWebsiteApplyForm(role, regionForHr, []), /built-in "background"|built-in "region"/);

  // ── Validation: a good submission produces the exact classification the bot would write ─────────
  const good: WebsiteApplyRawAnswers = {
    answers: {
      experience: "3_5",
      "extra:hr_ats_experience": "yes",
      "extra:hr_note": "  I am relocating to Cairo.  ",
      salary: "15000",
    },
    email: "sara@example.com",
    fullName: "  Sara Ali  ",
    phone: "01000000000",
  };
  const validated = validateWebsiteApplication(role, form, good);
  assert.ok(validated.ok, "a complete, valid submission is accepted");
  assert.equal(validated.classification.jobTitle, "Talent Acquisition Specialist");
  assert.equal(validated.classification.experienceLabel, "3 - 5 years");
  assert.equal(validated.classification.expectedSalary, "15000");
  assert.equal(validated.classification.expectedSalaryFigure, 15000);
  // The stored answer is the option TITLE, never the wire value — exactly screening_extra_answers.
  assert.deepEqual(validated.classification.extraAnswers, {
    hr_ats_experience: "Yes",
    hr_note: "I am relocating to Cairo.",
  });

  // A verbatim, non-numeric salary is kept as words and never coerced to a number.
  const negotiable = validateWebsiteApplication(role, form, { ...good, answers: { ...good.answers, salary: "negotiable" } });
  assert.ok(negotiable.ok);
  assert.equal(negotiable.classification.expectedSalary, "negotiable");
  assert.equal(negotiable.classification.expectedSalaryFigure, null);

  // A tappable answer that is not one the question offers is rejected — a stale or forged value can
  // never become a stored TITLE.
  const forged = validateWebsiteApplication(role, form, {
    ...good,
    answers: { ...good.answers, "extra:hr_ats_experience": "maybe" },
  });
  assert.equal(forged.ok, false);

  // Required fields: a missing experience, and a malformed email, each fail.
  const noExperience = validateWebsiteApplication(role, form, { ...good, answers: { ...good.answers, experience: "" } });
  assert.equal(noExperience.ok, false);
  const badEmail = validateWebsiteApplication(role, form, { ...good, email: "not-an-email" });
  assert.equal(badEmail.ok, false);

  // An unanswered optional extra writes NOTHING — the silent-erase trap: an optional column left out
  // of the payload, never blanked.
  const noExtras = validateWebsiteApplication(role, form, {
    ...good,
    answers: { experience: "3_5", salary: "15000" },
  });
  assert.ok(noExtras.ok);
  assert.deepEqual(noExtras.classification.extraAnswers, {});
}
