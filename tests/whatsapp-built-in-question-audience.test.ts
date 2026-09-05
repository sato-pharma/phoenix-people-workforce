import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import {
  audienceViolations,
  BUILT_IN_DEFAULT_AUDIENCE,
  builtInQuestionAppliesToRole,
  builtInQuestionKeys,
  canChooseAudience,
  nextBuiltInQuestion,
  resolveBuiltInAudience,
  type BuiltInQuestionKey,
} from "../src/lib/recruitment/inbound/whatsapp-question-audience.ts";
import { withStableOptionValues } from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";

/**
 * WHO IS ASKED WHICH of the six built-in WhatsApp questions, and what happens to an answer code when
 * an already-answered question is reworded.
 *
 * The owner asked on 2026-09-05 for two things on /admin/screening-questions: the per-question
 * job-title audience the extra questions already had, extended to the six built-in ones above them;
 * and the ability to edit a question people have already answered. Both are one-way doors if they go
 * wrong quietly — a question skipped for the wrong applicant looks like a bot that lost interest,
 * and a rewritten answer code looks like an applicant who never replied.
 */

/** No audience saved for anything — every question on its code default. */
const NOTHING_SAVED = new Map<string, readonly string[]>();

function saved(entries: Record<string, readonly string[]>): Map<string, readonly string[]> {
  return new Map(Object.entries(entries));
}

/** Walk the whole fixed six for one applicant, as the session state machine does. */
function flowFor(input: {
  roleFamily: string | null;
  audiences: Map<string, readonly string[]>;
  /** Whether the region question yields a region. False only when region itself is skipped. */
  regionAnswered?: boolean;
}): BuiltInQuestionKey[] {
  const asked: BuiltInQuestionKey[] = ["job_title"];
  let after: BuiltInQuestionKey = "job_title";
  for (;;) {
    const next = nextBuiltInQuestion({
      after,
      audiences: input.audiences,
      // A region is on file once the region question has actually been asked and answered.
      hasRegion: asked.includes("region") && input.regionAnswered !== false,
      roleFamily: input.roleFamily,
    });
    if (!next) return asked;
    asked.push(next);
    after = next;
  }
}

export function runWhatsAppBuiltInQuestionAudienceTests() {
  // ── The defaults are the behaviour that existed before this control ──────────────────────────
  // Five questions asked to everyone, and the area question asked to Medical Reps only — the owner's
  // cascade rule of 2026-08-30, which used to be the hardcoded `askAreaForRole`. If this block ever
  // goes red, the change stopped being behaviour-neutral on an empty table.
  assert.deepEqual(BUILT_IN_DEFAULT_AUDIENCE.area, ["medical_rep"], "the area question defaults to Medical Reps only");
  for (const key of builtInQuestionKeys) {
    if (key === "area") continue;
    assert.equal(BUILT_IN_DEFAULT_AUDIENCE[key], null, `${key} defaults to every applicant`);
  }

  // ── THREE STORED STATES, and the middle one is the whole reason the type is not string[]|null ─
  assert.deepEqual(
    resolveBuiltInAudience("area", undefined),
    ["medical_rep"],
    "nothing configured takes the code default",
  );
  assert.equal(
    resolveBuiltInAudience("area", []),
    null,
    "an EMPTY saved audience is a decision to ask everyone, and it must beat the code default",
  );
  assert.deepEqual(
    resolveBuiltInAudience("area", ["district_manager"]),
    ["district_manager"],
    "a saved list narrows the question to those job titles",
  );
  // The regression this asymmetry exists to prevent, stated as the behaviour a reader would check:
  // with two states, widening the area question would save, read back as untouched, and go on
  // asking Medical Reps only.
  assert.equal(
    builtInQuestionAppliesToRole("area", [], "district_manager"),
    true,
    "widening the area question to everyone must actually reach a District Manager",
  );
  assert.equal(
    builtInQuestionAppliesToRole("area", undefined, "district_manager"),
    false,
    "with nothing configured a District Manager is still not asked an area",
  );

  // ── TWO NULLS, TWO MEANINGS — an unknown applicant gets the unscoped questions only ───────────
  assert.equal(
    builtInQuestionAppliesToRole("salary", undefined, null),
    true,
    "a question asked to everyone reaches an applicant whose job we cannot name",
  );
  assert.equal(
    builtInQuestionAppliesToRole("salary", ["medical_rep"], null),
    false,
    "a narrowed question never reaches an applicant whose job we cannot name",
  );

  // ── Question 1 is never scopable, in all three places ────────────────────────────────────────
  assert.equal(canChooseAudience("job_title"), false, "question 1 establishes the role and cannot be scoped by it");
  for (const key of builtInQuestionKeys) {
    if (key === "job_title") continue;
    assert.equal(canChooseAudience(key), true, `${key} must offer the audience control`);
  }
  assert.ok(
    audienceViolations({ appliesToRoleFamilies: ["medical_rep"], key: "job_title" }).length > 0,
    "scoping question 1 is refused on the save path, not merely hidden on the screen",
  );
  assert.ok(
    audienceViolations({ appliesToRoleFamilies: [], key: "job_title" }).length > 0,
    "even a harmless 'everyone' is refused on question 1 — a stored row there implies a control that does not exist",
  );
  assert.deepEqual(
    audienceViolations({ appliesToRoleFamilies: undefined, key: "job_title" }),
    [],
    "question 1 with nothing configured is the normal state and must be saveable",
  );

  // ── The vocabulary check the database deliberately does not make ─────────────────────────────
  assert.ok(
    audienceViolations({ appliesToRoleFamilies: ["chief_astronaut"], key: "area" }).length > 0,
    "an unrecognised job title is refused — it would match nobody while the screen showed the question as live",
  );
  for (const family of candidateRoleFamilies) {
    assert.deepEqual(
      audienceViolations({ appliesToRoleFamilies: [family], key: "background" }),
      [],
      `${family} is a real job title and must be saveable as an audience`,
    );
  }
  assert.deepEqual(
    audienceViolations({ appliesToRoleFamilies: [], key: "area" }),
    [],
    "an empty audience is legal on a built-in question — it is how the area question is widened",
  );

  // ── The flow, end to end, with nothing configured ────────────────────────────────────────────
  assert.deepEqual(
    flowFor({ audiences: NOTHING_SAVED, roleFamily: "medical_rep" }),
    ["job_title", "background", "region", "area", "experience", "salary"],
    "a Medical Rep walks all six, area included",
  );
  assert.deepEqual(
    flowFor({ audiences: NOTHING_SAVED, roleFamily: "district_manager" }),
    ["job_title", "background", "region", "experience", "salary"],
    "every other role skips the area and goes straight to experience — the cascade, unchanged",
  );

  // ── The area question's data dependency is NOT an audience rule ──────────────────────────────
  // Narrowing the region question away from a Medical Rep must take the area question with it: the
  // area menu's rows ARE the live areas of the chosen region, so with no region there is nothing to
  // send. Without this the applicant would be stranded on a menu that cannot be built.
  assert.deepEqual(
    flowFor({ audiences: saved({ region: ["office_coordinator"] }), roleFamily: "medical_rep" }),
    ["job_title", "background", "experience", "salary"],
    "skipping the region question must skip the area question too, whatever the area audience says",
  );
  assert.equal(
    nextBuiltInQuestion({
      after: "region",
      audiences: NOTHING_SAVED,
      hasRegion: false,
      roleFamily: "medical_rep",
    }),
    "experience",
    "a rep with no region on file is sent past the area question rather than to an empty menu",
  );

  // ── Narrowing the LAST question — the reason the hand-off was extracted from the salary step ──
  // Salary is no longer guaranteed to be the last question asked. An applicant it does not apply to
  // finishes the fixed six on `experience`, and the extra-question hand-off has to happen there too.
  assert.deepEqual(
    flowFor({ audiences: saved({ salary: ["office_coordinator"] }), roleFamily: "medical_rep" }),
    ["job_title", "background", "region", "area", "experience"],
    "a question narrowed away from this applicant ends the fixed six early",
  );
  assert.equal(
    nextBuiltInQuestion({
      after: "experience",
      audiences: saved({ salary: ["office_coordinator"] }),
      hasRegion: true,
      roleFamily: "medical_rep",
    }),
    null,
    "null is what tells the session to hand off to the extra questions, or finish",
  );

  // ── Narrowing every question at once still leaves a working conversation ─────────────────────
  assert.deepEqual(
    flowFor({
      audiences: saved({
        area: ["office_coordinator"],
        background: ["office_coordinator"],
        experience: ["office_coordinator"],
        region: ["office_coordinator"],
        salary: ["office_coordinator"],
      }),
      roleFamily: "medical_rep",
    }),
    ["job_title"],
    "a rep excluded from all five finishes on question 1 — which is asked, always",
  );
  // The resolver can never propose question 1: it is index 0, and the walk always starts after the
  // question just answered. Proved rather than asserted in prose, because BUILT_IN_MENUS in the
  // session file carries a job_title entry purely to stay total, and a reader could mistake that
  // entry for a reachable path.
  for (const after of builtInQuestionKeys) {
    for (const family of [...candidateRoleFamilies, null]) {
      assert.notEqual(
        nextBuiltInQuestion({ after, audiences: NOTHING_SAVED, hasRegion: true, roleFamily: family }),
        "job_title",
        "question 1 is never proposed as the NEXT question",
      );
    }
  }

  // ── An answered question's answer CODES survive a rewording ──────────────────────────────────
  // This is the half of the owner's request that could break a live conversation silently. A saved
  // answer keeps its code however the title is rewritten; only a brand-new answer is given one.
  const reworded = withStableOptionValues([
    { description: "", title: "Yes", value: "yes_i_have_one" },
    { description: "", title: "No, not yet", value: "no" },
    { description: "", title: "Yes", value: null },
  ]);
  assert.equal(
    reworded[0].value,
    "yes_i_have_one",
    "retitling a saved answer must NOT rewrite its code — a menu already on a phone still answers",
  );
  assert.equal(reworded[0].title, "Yes", "the title is what changes");
  assert.equal(reworded[1].value, "no", "an untouched saved answer keeps its code");
  assert.equal(
    reworded[2].value,
    "yes",
    "a brand-new answer derives its code from its own title",
  );
  // The two-pass ordering: a new answer must not be able to take a code a SAVED answer already holds.
  const collided = withStableOptionValues([
    { description: "", title: "Yes", value: null },
    { description: "", title: "Anything", value: "yes" },
  ]);
  assert.equal(
    collided[1].value,
    "yes",
    "the saved answer keeps `yes` — reserving saved codes before deriving any is what protects it",
  );
  assert.equal(
    collided[0].value,
    "yes_2",
    "the new answer is pushed aside instead, which is the direction that breaks nothing",
  );
  assert.equal(
    new Set(collided.map((option) => option.value)).size,
    collided.length,
    "codes stay unique within a question — a duplicate would make one answer unreachable",
  );

  // ── The screen cannot re-derive a saved code behind the domain's back ────────────────────────
  // The rule above only holds if the admin component actually routes through it. It used to carry
  // its own copy, which is exactly where the re-derivation lived.
  const manager = readFileSync("src/components/admin/screening-questions-manager.tsx", "utf8");
  assert.ok(
    manager.includes("withStableOptionValues"),
    "the extra-question editor must resolve answer codes through the domain rule, not its own copy",
  );
  assert.ok(
    !/function withDerivedValues/.test(manager),
    "the component's own value-deriving helper is gone — two copies of this rule is how the codes drift",
  );

  // ── The six keys are one vocabulary, not four that happen to agree ───────────────────────────
  const migration = readFileSync(
    "supabase/migrations/20260831183000_ats_whatsapp_question_prompts.sql",
    "utf8",
  );
  for (const key of builtInQuestionKeys) {
    assert.ok(
      migration.includes(`'${key}'`),
      `${key} must be in the prompts table's own key CHECK — a key it refuses cannot hold an audience`,
    );
  }

  // ── The audience column is storable on its own ───────────────────────────────────────────────
  // Narrowing a question whose wording is untouched writes a row with nothing else in it. The
  // original not-empty constraint predates the column and would have refused exactly that row, with
  // a message naming none of this — the one thing in this change that would have shipped broken.
  const audienceMigration = readFileSync(
    "supabase/migrations/20260905093000_ats_question_prompts_role_audience.sql",
    "utf8",
  );
  assert.ok(
    /not_empty_check[\s\S]*applies_to_role_families is not null/.test(audienceMigration),
    "the not-empty constraint must count the audience, or an audience-only row is refused",
  );
  assert.ok(
    /question_key <> 'job_title' or applies_to_role_families is null/.test(audienceMigration),
    "the database must refuse a scoped question 1, not only the screen and the validator",
  );
}
