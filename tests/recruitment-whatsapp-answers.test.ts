import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { candidateRegionCodes, candidateRegionLabels } from "../src/lib/recruitment/candidate-region.ts";
import { builtInPrompts } from "../src/lib/recruitment/inbound/whatsapp-question-prompts.ts";
import {
  BUILT_IN_ANSWER_QUESTIONS,
  candidateWhatsAppAnswers,
  UNREADABLE_QUESTION_LABEL,
} from "../src/lib/recruitment/whatsapp-answers.ts";

function read(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

/**
 * EVERY WhatsApp answer, beside the CV.
 *
 * The owner, 2026-09-11: applicants on WhatsApp are asked many questions — salary and much else —
 * and he could not read their answers while screening. Measured that day: the questions an admin adds
 * on /admin/screening-questions had been answered by 116 candidates and were printed on no screening
 * screen, and the six built-in answers sat under the CV facts inside the snapshot.
 */
export function runWhatsAppAnswersTests() {
  const questions = [
    { bodyText: "How old are you?", questionKey: "oc_age_band" },
    {
      appliesToRoleFamilies: ["office_coordinator"],
      bodyText: "The job is on site in Sheraton, Cairo. Could you travel there every working day?",
      questionKey: "oc_sheraton_commute",
    },
    { bodyText: "If you were offered the job, when could you start?", questionKey: "oc_start_date" },
  ];
  const region = candidateRegionCodes[0];

  // --- 1 · THE HEADLINE. All six built-in answers in the order the applicant met them, then every
  // --- admin-defined answer in the ADMIN's order — not the order the jsonb happens to hold them — and
  // --- each under the question it answers. `oc_sheraton_commute` is retired in production; the
  // --- answer given to it is still an answer and still listed.
  const everything = candidateWhatsAppAnswers(
    {
      appliedForJobTitle: "Office Coordinator",
      declaredBackground: "Commerce",
      declaredExperience: "1 - 3 years",
      declaredExpectedSalary: "12 k, negotiable",
      preferencesDeclaredAt: "2026-09-10T08:00:00.000Z",
      preferredAreaName: "Nasr City",
      preferredRegionCode: region,
      screeningExtraAnswers: { oc_age_band: "25 - 29", oc_sheraton_commute: "Yes", oc_start_date: "Immediately" },
    },
    questions,
  );
  assert.deepEqual(
    everything.map((entry) => [entry.question, entry.answer]),
    [
      ["What are you applying for?", "Office Coordinator"],
      ["What did you graduate in?", "Commerce"],
      ["Which region?", candidateRegionLabels[region]],
      ["Which area?", "Nasr City"],
      ["How much experience?", "1 - 3 years"],
      ["Expected salary", "12 k, negotiable"],
      ["How old are you?", "25 - 29"],
      ["The job is on site in Sheraton, Cairo. Could you travel there every working day?", "Yes"],
      ["If you were offered the job, when could you start?", "Immediately"],
    ],
    "every answer on the record is listed, the admin-defined ones included, each under its own question",
  );
  assert.equal(
    new Set(everything.map((entry) => entry.key)).size,
    everything.length,
    "every answer carries its own key, so a screen can never collapse two of them into one row",
  );

  const reordered = candidateWhatsAppAnswers(
    { screeningExtraAnswers: { oc_start_date: "Next month", oc_age_band: "30 - 34" } },
    questions,
  );
  assert.deepEqual(
    reordered.map((entry) => entry.answer),
    ["30 - 34", "Next month"],
    "the admin's question order decides the list, never the order the answers were stored in",
  );

  // --- 1b · A role-scoped question says who it is asked to. One WhatsApp number applied for four
  // --- roles in production, and its record read "Medical Representative" above answers only an
  // --- Office Coordinator applicant is ever asked — the owner reasonably read that as the bot asking
  // --- medical reps about Sheraton. The audience line is what tells the two apart.
  assert.deepEqual(
    everything.map((entry) => entry.askedTo),
    [null, null, null, null, null, null, null, "Asked only to Office Coordinator applicants", null],
    "a role-scoped question carries its audience in words; the built-in six and an unscoped question carry none",
  );
  assert.equal(
    candidateWhatsAppAnswers({ screeningExtraAnswers: { q_new: "Yes" } }, [
      { appliesToRoleFamilies: ["not_a_role"], bodyText: "A question?", questionKey: "q_new" },
    ])[0]?.askedTo,
    null,
    "a role we have no name for is never printed as a code",
  );

  // --- 2 · The job title is the applicant's only where the bot's completion stamp says so. The same
  // --- column is filled by the CV reader and by people; printing that under "What are you applying
  // --- for?" would put somebody else's words in the applicant's mouth.
  assert.deepEqual(
    candidateWhatsAppAnswers({ appliedForJobTitle: "District Manager", declaredExperience: "More than 5 years" }, []).map(
      (entry) => entry.question,
    ),
    ["How much experience?"],
    "no completion stamp, no job-title answer",
  );

  // --- 3 · Region: their words when they typed one, and never a raw code.
  assert.deepEqual(
    candidateWhatsAppAnswers({ preferredRegionName: "Minia Government ( Minia North )" }, []).map((entry) => entry.answer),
    ["Minia Government ( Minia North )"],
    "a typed region is shown as they typed it, not as the region it was filed under",
  );
  assert.deepEqual(
    candidateWhatsAppAnswers({ preferredRegionCode: "NOT_A_REGION" }, []),
    [],
    "a stored value that is not a live region code is never printed as though it were an answer",
  );

  // --- 4 · An answer is never dropped because its question cannot be named.
  assert.deepEqual(
    candidateWhatsAppAnswers({ screeningExtraAnswers: { oc_age_band: "25 - 29" } }, null),
    [{ answer: "25 - 29", askedTo: null, key: "extra:oc_age_band", question: UNREADABLE_QUESTION_LABEL }],
    "when the question list could not be read, the answer still shows, under a label that says so",
  );
  assert.deepEqual(
    candidateWhatsAppAnswers({ screeningExtraAnswers: { some_other_question: "An answer" } }, questions).map(
      (entry) => entry.question,
    ),
    [UNREADABLE_QUESTION_LABEL],
    "an answer whose key is not in the list is shown too, never under its raw key",
  );

  // --- 5 · Nothing invented.
  assert.deepEqual(candidateWhatsAppAnswers({}, questions), [], "somebody who never met the bot has no answers");
  assert.deepEqual(
    candidateWhatsAppAnswers(
      { declaredBackground: "   ", declaredExpectedSalary: "", screeningExtraAnswers: { oc_age_band: "  " } },
      questions,
    ),
    [],
    "a blank is not an answer",
  );
  assert.deepEqual(
    candidateWhatsAppAnswers({ screeningExtraAnswers: {} }, [{ bodyText: "Anything?", questionKey: "constructor" }]),
    [],
    "a question key that shares a name with an Object member reads the record's own keys, not the prototype",
  );

  // --- 6 · The six questions carry the names the admin screen gives them, so the owner sees one
  // --- wording for one question wherever he meets it.
  const prompts = builtInPrompts();
  assert.equal(Object.keys(BUILT_IN_ANSWER_QUESTIONS).length, prompts.length, "one name for each built-in question");
  for (const prompt of prompts) {
    assert.equal(
      (BUILT_IN_ANSWER_QUESTIONS as Record<string, string>)[prompt.key],
      prompt.label.replace(/^\d+ · /, ""),
      `the "${prompt.key}" question reads the same here as on the admin screen`,
    );
  }

  // --- 7 · Wired where he looks. The answers are the FIRST section beside the CV, and the profile
  // --- route actually hands the question wording to the screens. The screens' own props are required,
  // --- so a caller that forgets them fails to compile; the route is the one link a compiler cannot see.
  const intelligence = read("src/components/recruitment/workstation/workstation-intelligence.tsx");
  const answersAt = intelligence.indexOf('storageKey="summary:whatsapp"');
  const snapshotAt = intelligence.indexOf('storageKey="summary:snapshot"');
  assert.ok(answersAt > 0, "the screening workstation has a WhatsApp answers section");
  assert.ok(answersAt < snapshotAt, "and it sits above the candidate snapshot, first thing beside the CV");
  assert.match(
    read("app/api/recruitment/candidates/[id]/route.ts"),
    /NextResponse\.json\(\{ latestCvExtraction, profile, screeningQuestions, success: true \}\)/,
    "the candidate profile route returns the question wording alongside the profile",
  );
}
