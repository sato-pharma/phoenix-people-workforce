import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { candidateRoleFamily, candidateRoleFamilyLabels } from "../src/lib/recruitment/candidate-role-family.ts";
import { jobTitleMenu, menuViolations, WHATSAPP_LIST_MAX_ROWS } from "../src/lib/recruitment/inbound/whatsapp-classify-menus.ts";
import {
  questionAppliesToRole,
  questionsForRole,
  screeningQuestionViolations,
  type ScreeningQuestion,
} from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";

/**
 * Who an admin-defined WhatsApp screening question is asked to.
 *
 * The extra-question feature shipped asking every question to every applicant, which was harmless
 * only while the table was empty. The first real question — the Sheraton Office Coordinator set —
 * is one a medical rep must never see: "how long is your commute to our office in Sheraton?" reads
 * to a Qena field applicant as though the rep job were Cairo-based, and it is asked at the very end
 * of the flow, after the highest-friction question there is.
 */

function q(overrides: Partial<ScreeningQuestion> = {}): ScreeningQuestion {
  return {
    appliesToRoleFamilies: null,
    bodyText: "How long is your daily commute to Sheraton?",
    id: "q-1",
    isActive: true,
    kind: "free_text",
    options: null,
    questionKey: "commute",
    sortOrder: 1,
    ...overrides,
  };
}

export function runWhatsAppScreeningQuestionRoleScopeTests() {
  // ── The two nulls mean two different things, and that asymmetry IS the rule ────────────────────
  assert.ok(
    questionAppliesToRole(q({ appliesToRoleFamilies: null }), "medical_rep"),
    "an unscoped question must reach everyone — that is the meaning every question had before scoping existed, and a question saved without touching the control must not silently go dark",
  );
  assert.ok(
    questionAppliesToRole(q({ appliesToRoleFamilies: null }), null),
    "an unscoped question must reach an applicant whose role we do not know as well",
  );
  assert.ok(
    questionAppliesToRole(q({ appliesToRoleFamilies: ["office_coordinator"] }), "office_coordinator"),
    "a scoped question must reach the family it names",
  );
  assert.equal(
    questionAppliesToRole(q({ appliesToRoleFamilies: ["office_coordinator"] }), "medical_rep"),
    false,
    "THE HEADLINE: a question scoped to the Office Coordinator must NOT reach a medical rep — this is the whole reason the scope column exists",
  );
  assert.equal(
    questionAppliesToRole(q({ appliesToRoleFamilies: ["office_coordinator"] }), null),
    false,
    "a SCOPED question must not reach an applicant with no known role — the safe direction is not symmetrical, because we cannot say this person is a coordinator",
  );
  assert.ok(
    questionAppliesToRole(q({ appliesToRoleFamilies: [] }), "medical_rep"),
    "an empty scope is treated as unscoped rather than as ask-nobody — the database refuses to store one, so reaching here means a hand-written row, and going dark silently is the worse failure",
  );

  // ── questionsForRole keeps the admin's order and drops only what is out of scope ───────────────
  const asked = questionsForRole(
    [
      q({ id: "a", questionKey: "everyone_1", sortOrder: 1 }),
      q({ appliesToRoleFamilies: ["office_coordinator"], id: "b", questionKey: "commute", sortOrder: 2 }),
      q({ appliesToRoleFamilies: ["medical_rep"], id: "c", questionKey: "driving", sortOrder: 3 }),
      q({ id: "d", questionKey: "everyone_2", sortOrder: 4 }),
    ],
    "office_coordinator",
  );
  assert.deepEqual(
    asked.map((question) => question.questionKey),
    ["everyone_1", "commute", "everyone_2"],
    "the coordinator is asked the two general questions and their own, in the admin's order, and never the medical rep's",
  );

  // ── The validator owns the vocabulary the database deliberately does not ───────────────────────
  assert.ok(
    screeningQuestionViolations(q({ appliesToRoleFamilies: ["office_coordinator"] })).length === 0,
    "a real family must validate clean",
  );
  assert.ok(
    screeningQuestionViolations(q({ appliesToRoleFamilies: ["office_cordinator"] })).some((problem) =>
      /is not a role we recognise/.test(problem),
    ),
    "a mis-typed family must be named at save time — it matches no applicant, so the question would be asked to NOBODY while the screen still shows it active",
  );
  assert.ok(
    screeningQuestionViolations(q({ appliesToRoleFamilies: [] })).some((problem) =>
      /leave the roles empty to ask everyone/.test(problem),
    ),
    "selecting no roles at all must be refused with an explanation, not saved as a question nobody is asked",
  );

  // ── Office Coordinator is a real, tappable role now ───────────────────────────────────────────
  assert.equal(candidateRoleFamilyLabels.office_coordinator, "Office Coordinator");
  for (const title of [
    "Office Coordinator",
    "office administrator",
    "Administrative Assistant",
    "Executive Assistant",
    "Receptionist",
    "Secretary",
  ]) {
    assert.equal(
      candidateRoleFamily(title),
      "office_coordinator",
      `"${title}" is the same front-office seat and must bucket as office_coordinator`,
    );
  }
  assert.equal(
    candidateRoleFamily("Purchase Officer / Store/Logistic Supervisor / HR & Admin Officer"),
    "human_resources",
    "the one production title the new patterns also match is an HR job, and the hr rule runs first — this pins the measured claim that adding this family moved NOBODY out of the family they already had",
  );

  const menu = jobTitleMenu();
  assert.ok(
    menu.rows.some((row) => row.title === "Office Coordinator"),
    "the applicant must be able to TAP the role rather than type it — a tapped role is what the scope matches on, and what spells the folder key the same way every time",
  );
  assert.equal(menu.rows[menu.rows.length - 1].title, "Other", "Other stays last — offering it early invites it");
  assert.ok(
    menu.rows.length <= WHATSAPP_LIST_MAX_ROWS,
    `the role menu is ${menu.rows.length} rows against Meta's ${WHATSAPP_LIST_MAX_ROWS}-row cap — one more and the whole message 400s rather than merely looking crowded`,
  );
  assert.deepEqual(menuViolations(menu), [], "the widened role menu must still pass the real send-time check");

  // ── The filter cannot be bypassed at a call site ──────────────────────────────────────────────
  // TypeScript already forces the argument to exist. What it cannot catch is somebody passing a
  // literal null to quiet the compiler, which restores the exact behaviour this change removed and
  // looks like a one-word diff. Both readers must pass a real session value.
  for (const path of [
    "../src/lib/recruitment/inbound/whatsapp-screening-questions-session.ts",
    "../src/lib/recruitment/inbound/whatsapp-classify-session.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(
      /listActiveScreeningQuestions\(\s*(null|undefined)\s*\)/.test(source),
      false,
      `${path} passes a literal null to listActiveScreeningQuestions, which un-scopes every question again while reading as a trivial change`,
    );
    // Anchored on `await` so this matches CALL sites only — the function's own definition lives in
    // the first of these two files and would otherwise be read as a call that forgot the role.
    //
    // `roleFamily` is accepted alongside `job_title_family` for exactly one reason: resendExtraQuestion
    // (added 2026-09-02 with the stale-conversation re-prompt) FORWARDS the role rather than reading
    // the session itself, so at that one call site the field name is a hop away. That hop is closed
    // immediately below — its own caller must name the field — so a forwarded role is still a real
    // tapped role, and not a way to launder a null past this check.
    for (const call of source.match(/await listActiveScreeningQuestions\([^)]*\)/g) ?? []) {
      assert.ok(
        /job_title_family|roleFamily/.test(call),
        `${path} calls listActiveScreeningQuestions without the applicant's tapped role: ${call}`,
      );
    }
    // The hop itself. Anchored on return/await so the function's own definition — whose parameter
    // list names `roleFamily` and nothing else — is not read as a call that forgot the role.
    for (const call of source.match(/(?:return|await) resendExtraQuestion\([^;]*?\)/g) ?? []) {
      assert.ok(
        /job_title_family/.test(call),
        `${path} re-asks an extra question without the applicant's tapped role, which re-opens the entire question list to them: ${call}`,
      );
    }
  }
}
