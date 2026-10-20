import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { decideTextOnlyAction, type TextOnlyContext } from "../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts";
import {
  firstUnansweredBuiltIn,
  prefilledBuiltInKeys,
  sessionPrefillFromCandidate,
  type ResumeCandidateRow,
} from "../src/lib/recruitment/inbound/whatsapp-classify-resume-plan.ts";
import {
  isDueForReask,
  REASK_QUIET_MIN_MS,
  REASK_WINDOW_MARGIN_MS,
} from "../src/lib/recruitment/inbound/whatsapp-reask-quiet.ts";
import { askAgainRefusal, followupFirstName } from "../src/lib/recruitment/inbound/whatsapp-followup-template-rules.ts";
import { placementFromReply } from "../src/lib/recruitment/workspace/placement-from-reply.ts";
import { computeCompleteness } from "../src/lib/recruitment/workspace/completeness.ts";
import { answerMarkKey, roleFamilyForTypedRole } from "../src/lib/recruitment/whatsapp-answer-edit.ts";
import type { ScreeningQuestion } from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";

/**
 * The WhatsApp half of the recruitment rebuild (owner, 2026-10-20):
 *
 *   1. an applicant's answers are SAVED AS GIVEN — each one reaches the candidate the moment it is
 *      tapped or typed, never only when the conversation finishes;
 *   2. an answer HR types is MARKED as HR's, and the applicant answering again clears the mark;
 *   3. people are FILED by their own replies (role, region, area), never by their CV;
 *   4. a quiet applicant is asked once more inside WhatsApp's 24-hour window, and only then;
 *   5. a reply to "Ask again" RESUMES the conversation where the answers stop, never asks for a CV
 *      they already sent.
 */

const read = (path: string) => stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));

function contact(overrides: Partial<TextOnlyContext> = {}): TextOnlyContext {
  return {
    hasOpenClassifySession: false,
    hasRecentCv: false,
    historical: false,
    isImportSender: false,
    priorTextOnlyEventsInWindow: 0,
    replyEnabled: true,
    ...overrides,
  };
}

function candidate(overrides: Partial<ResumeCandidateRow> = {}): ResumeCandidateRow {
  return {
    applied_for_job_title: null,
    declared_background: null,
    declared_expected_salary: null,
    declared_experience: null,
    declared_role_family: null,
    expected_salary: null,
    preferred_area_name: null,
    preferred_region_code: null,
    preferred_region_name: null,
    screening_extra_answers: null,
    ...overrides,
  };
}

function question(overrides: Partial<ScreeningQuestion> & { questionKey: string }): ScreeningQuestion {
  return {
    appliesToRoleFamilies: null,
    bodyText: "?",
    id: overrides.questionKey,
    isActive: true,
    kind: "free_text",
    options: null,
    sortOrder: 0,
    ...overrides,
  };
}

const NO_AUDIENCES = new Map<string, readonly string[]>();
const HOUR = 60 * 60 * 1000;

export function runRecruitmentWhatsAppAnswersSavedTests() {
  // ── 1. Saved as given ───────────────────────────────────────────────────────────────────────
  const classify = read("../src/lib/recruitment/inbound/whatsapp-classify-session.ts");
  const advance = classify.slice(classify.indexOf("async function advanceAfterBuiltIn("), classify.indexOf("async function askBuiltInQuestion("));
  assert.ok(advance.length > 0, "advanceAfterBuiltIn and askBuiltInQuestion are still there");
  assert.ok(
    /const write = async[\s\S]*?\.update\(\{ \.\.\.patch, \.\.\.extra, updated_at: nowIso \}\)[\s\S]*?await applyBuiltInAnswerToCandidate\(answered, after\);/.test(advance),
    "every one of the six is written onto the candidate in the same step that records it on the conversation — saved as given",
  );
  const extraSession = read("../src/lib/recruitment/inbound/whatsapp-screening-questions-session.ts");
  const extraDecision = extraSession.slice(extraSession.indexOf("async function applyExtraDecision("));
  assert.ok(
    /applyExtraAnswerToCandidate\(/.test(extraDecision),
    "every extra answer is written onto the candidate as it is given, not only at the finish",
  );
  assert.ok(
    /if \(reason === "window_closed"\) await applyAnswersBeforeClosing\(sessionId\);/.test(classify),
    "a conversation the applicant walked away from is closed with what they DID answer saved first",
  );

  // ── 2. The "added by HR" mark ───────────────────────────────────────────────────────────────
  const edit = read("../src/lib/recruitment/whatsapp-answer-edit.ts");
  assert.ok(/rpc\("ats_set_answer_mark"/.test(edit), "an edited built-in answer stamps HR's mark");
  assert.ok(
    /rpc\("ats_merge_screening_answer",[\s\S]*?p_marked_by_hr_id: typed \? hrId : null/.test(edit),
    "an edited extra answer is merged key by key, marked as HR's — never the whole map written back",
  );
  assert.equal(answerMarkKey("job_title"), "role", "the role's mark is keyed 'role', as the workspace shows it");
  assert.equal(answerMarkKey("extra:hr_ats_experience"), "hr_ats_experience", "an extra answer's mark is its question key");
  assert.equal(roleFamilyForTypedRole("medical_rep"), "medical_rep", "a family code from the workspace is the family");
  assert.equal(roleFamilyForTypedRole("   "), null, "a cleared role names no family");
  const sync = read("../src/lib/recruitment/inbound/whatsapp-answer-sync.ts");
  assert.ok(
    /await clearAnswerMarks\(candidateId, \[BUILT_IN_ANSWER_KEYS\[key\]\]\);/.test(sync),
    "the applicant answering again clears HR's mark: their own word wins",
  );
  assert.ok(
    /const unmarked = answeredBuiltInKeys\(session\)\.filter\(\(key\) => !\(BUILT_IN_ANSWER_KEYS\[key\] in marks\)\)/.test(classify),
    "the finishing write never re-writes an answer HR corrected since",
  );

  // ── 3. Filed by the replies ─────────────────────────────────────────────────────────────────
  assert.deepEqual(
    placementFromReply({ areaCode: "CA-01", areaName: "Cairo East 1", areaSalesRegionCode: "CA", regionCode: "CA", roleFamily: "medical_rep" }),
    { areaCode: "CA-01", areaName: "Cairo East 1", botRoleFamily: "medical_rep", regionCode: "CA", roleTab: "medical_rep" },
    "a Medical Rep whose area is in AU is filed in the Medical Rep tab, in that area",
  );
  assert.equal(
    placementFromReply({ areaCode: null, areaName: "Somewhere New", regionCode: "CA", roleFamily: "medical_rep" }),
    null,
    "a Medical Rep area that matches nothing in AU is never guessed into a tab — Needs placing",
  );
  assert.equal(
    placementFromReply({ areaCode: null, areaName: null, regionCode: "CA", roleFamily: "human_resources" }),
    null,
    "the retired Human Resources tap files nobody — neither HR tab is a safe guess",
  );
  assert.deepEqual(
    placementFromReply({ areaCode: "CA-01", areaName: "Cairo East 1", regionCode: "CA", roleFamily: "district_manager" }),
    { areaCode: null, areaName: null, botRoleFamily: "district_manager", regionCode: "CA", roleTab: "district_manager" },
    "a District Manager is filed by region only",
  );
  assert.equal(placementFromReply({ areaCode: null, areaName: null, regionCode: null, roleFamily: null }), null, "no reply, no tab");

  // Completeness counts what this person was asked, by their role.
  const rep = computeCompleteness({
    answers: {
      builtIns: { area: false, background: true, experience: true, job_title: true, region: true, salary: false },
      extras: { start: "Now" },
      roleFamily: "medical_rep",
    },
    audiences: NO_AUDIENCES,
    questions: [question({ questionKey: "start" }), question({ appliesToRoleFamilies: ["office_coordinator"], questionKey: "typing" })],
  });
  assert.deepEqual(
    rep,
    { expected: 7, given: 5, missingKeys: ["area", "salary"] },
    "a Medical Rep owes all six and the unscoped extra — never the Office Coordinator's question",
  );
  const unknownRole = computeCompleteness({
    answers: {
      builtIns: { area: false, background: false, experience: false, job_title: false, region: false, salary: false },
      extras: {},
      roleFamily: null,
    },
    audiences: NO_AUDIENCES,
    questions: [question({ appliesToRoleFamilies: ["office_coordinator"], questionKey: "typing" })],
  });
  assert.ok(unknownRole.missingKeys.includes("role"), "with no role the role itself is missing");
  assert.ok(!unknownRole.missingKeys.includes("area"), "with no role, the Medical-Rep-only area question is not owed");
  assert.ok(!unknownRole.missingKeys.includes("typing"), "with no role, no role-scoped extra is owed");

  // ── 4. The re-ask inside the 24-hour window ─────────────────────────────────────────────────
  const now = Date.parse("2026-10-20T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(isDueForReask({ lastInboundAt: null, updatedAt: at(3 * HOUR) }, now), true, "quiet three hours: asked once more");
  assert.equal(isDueForReask({ lastInboundAt: null, updatedAt: at(REASK_QUIET_MIN_MS - 60_000) }, now), false, "a person mid-way is not chased");
  assert.equal(isDueForReask({ lastInboundAt: null, updatedAt: at(REASK_WINDOW_MARGIN_MS + 60_000) }, now), false, "past 22 hours the window is too close to closing");
  assert.equal(
    isDueForReask({ lastInboundAt: at(23 * HOUR), updatedAt: at(3 * HOUR) }, now),
    false,
    "their own last message is what WhatsApp's window counts from: 23 hours ago is too late",
  );
  assert.equal(isDueForReask({ lastInboundAt: null, updatedAt: null }, now), false, "no time on record, no re-ask");
  const reaskSource = read("../src/lib/recruitment/inbound/whatsapp-reask-quiet.ts");
  assert.ok(/\.is\("reasked_at", null\)/.test(reaskSource), "only a conversation never re-asked is read — once, never a stream");
  assert.ok(
    /if \(!isWhatsAppClassifyEnabled\(\) \|\| !\(await isWhatsAppReaskEnabled\(\)\)\) return result;/.test(reaskSource),
    "the re-ask sends nothing until he switches it on",
  );
  const settings = read("../src/lib/recruitment/recruitment-settings-db.ts");
  assert.ok(
    /getRecruitmentSetting<unknown>\(WHATSAPP_REASK_ENABLED_KEY, false\)\) === true/.test(settings),
    "the switch reads OFF on any doubt — a failed read never turns it on",
  );

  // ── 5. "Ask again" and the resume ───────────────────────────────────────────────────────────
  assert.deepEqual(
    decideTextOnlyAction(contact({ canResume: true, hasRecentCv: true })),
    { ask: false, notify: false, record: true, reason: "resume" },
    "a reply to Ask again resumes the conversation — never 'send your CV as a file' to someone who sent one",
  );
  assert.equal(
    decideTextOnlyAction(contact({ canResume: true, hasOpenClassifySession: true })).reason,
    "classify_open",
    "an open conversation is the bot's already: nothing is resumed on top of it",
  );
  assert.equal(decideTextOnlyAction(contact()).reason, "new_contact", "a caller that never says canResume is unchanged");

  const prefill = sessionPrefillFromCandidate(
    candidate({
      declared_background: "Pharmacy",
      declared_experience: "1 - 3 years",
      declared_role_family: "medical_rep",
      preferred_region_code: "CA",
      screening_extra_answers: { start: "Now", empty: "  " },
    }),
  );
  assert.equal(prefill.background, "pharmacy", "a background label goes back to its code");
  assert.equal(prefill.experience, "1_3", "an experience label goes back to its band");
  assert.deepEqual(prefill.extra_answers, { start: "Now" }, "a blank extra is not an answer");
  assert.equal(firstUnansweredBuiltIn(prefill, NO_AUDIENCES), "area", "a Medical Rep with no area is asked the area, and nothing before it");
  assert.equal(
    firstUnansweredBuiltIn(sessionPrefillFromCandidate(candidate({ declared_role_family: "district_manager", preferred_region_code: "CA", declared_background: "Science" })), NO_AUDIENCES),
    "experience",
    "a District Manager is never asked an area: the next missing one is experience",
  );
  assert.equal(firstUnansweredBuiltIn(sessionPrefillFromCandidate(candidate()), NO_AUDIENCES), "job_title", "no role on record: question one");
  const typedByHr = sessionPrefillFromCandidate(candidate({ declared_experience: "about two years", declared_background: "Biology" }));
  assert.equal(typedByHr.experience, "about two years", "an experience outside the bands is kept raw, so it reads as answered");
  assert.equal(typedByHr.background, "other", "a background outside the list is an 'Other' answer");
  assert.equal(typedByHr.background_other_text, "Biology", "with their words kept");
  assert.ok(prefilledBuiltInKeys(typedByHr).has("experience"), "a kept-raw answer is never asked again");
  assert.ok(
    /let next = nextAfter\(after\);\s*while \(next && alreadyAnswered\.has\(next\)\) next = nextAfter\(next\);/.test(advance),
    "the bot's one transition steps over a question the conversation already holds — the resume's skip",
  );
  const textOnly = read("../src/lib/recruitment/inbound/whatsapp-text-only-applicant.ts");
  assert.ok(
    /if \(action\.reason === "resume" && history\.resumeCandidateId\)[\s\S]*?resumeClassification\(\{/.test(textOnly),
    "the text handler hands a resume to the bot on the line the reply came in on",
  );

  assert.equal(
    askAgainRefusal({ candidate: { archived_at: null, followup_sent_at: null, missing_answer_keys: ["area"], status: "new" }, forwarder: false, nowMs: now, placed: true, waId: "201000000000" }),
    null,
    "an open applicant with a missing answer can be asked again",
  );
  assert.match(
    String(askAgainRefusal({ candidate: { archived_at: null, followup_sent_at: null, missing_answer_keys: ["area"], status: "new" }, forwarder: true, nowMs: now, placed: true, waId: "201000000000" })),
    /several people/,
    "a forwarder's number is never asked: the message would reach the wrong person",
  );
  assert.match(
    String(askAgainRefusal({ candidate: { archived_at: null, followup_sent_at: at(2 * HOUR), missing_answer_keys: ["area"], status: "new" }, forwarder: false, nowMs: now, placed: true, waId: "201000000000" })),
    /last 24 hours/,
    "one ask a day: a second press inside it is refused, never a second message",
  );
  assert.match(
    String(askAgainRefusal({ candidate: { archived_at: null, followup_sent_at: null, missing_answer_keys: [], status: "rejected" }, forwarder: false, nowMs: now, placed: false, waId: "201000000000" })),
    /closed/,
    "a rejected applicant is not asked to carry on",
  );
  assert.match(
    String(askAgainRefusal({ candidate: { archived_at: null, followup_sent_at: null, missing_answer_keys: [], status: "new" }, forwarder: false, nowMs: now, placed: true, waId: "201000000000" })),
    /Nothing is missing/,
    "nobody is asked when every question is answered and they are filed",
  );
  assert.equal(followupFirstName("  Mona Ali "), "Dr Mona", "the template greets \"Dr\" and the first name (owner, 2026-10-20)");
  assert.equal(followupFirstName("Dr. Mona Ali"), "Dr Mona", "a CV's own \"Dr.\" never doubles into \"Dr Dr.\"");
  assert.equal(followupFirstName(null), "there", "and never sends an empty greeting");
}
