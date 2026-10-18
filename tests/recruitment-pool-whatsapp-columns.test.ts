import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  applyPoolColumnLayout,
  poolAnswersByColumn,
  poolColumnCatalogue,
  poolColumnViewKey,
  poolDefaultColumns,
  poolRoleQuestionColumns,
  poolRoleQuestionsCaption,
  POOL_SHARED_QUESTION_HEADERS,
  type PoolWhatsAppQuestions,
} from "../src/lib/recruitment/pool-whatsapp-columns.ts";
import { BUILT_IN_ANSWER_QUESTIONS } from "../src/lib/recruitment/whatsapp-answers.ts";
import { whatsAppAnswerEditPayload, WHATSAPP_ANSWER_MAX_CHARS } from "../src/lib/recruitment/whatsapp-answer-edit-rules.ts";

/**
 * The candidate pool's headers ARE the WhatsApp bot's questions (owner, 2026-10-19: "make the headers
 * as per the whatsapp questions and match the candidates as per their whatsapp applications and
 * answers", and he chose "switch by role"), and the reader has full control of them ("make me able to
 * edit or add a missing field and full control" — he chose both: edit any answer, and choose the
 * columns).
 *
 * The fixtures are the production question list's shapes on 2026-10-19: Office Coordinator questions
 * with one retired (`oc_sheraton_commute`), a district manager's own, the HR Section Head's own, and
 * `oc_start_date` shared across families.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const QUESTIONS: PoolWhatsAppQuestions = {
  // As saved on the Screening Questions screen: the built-ins narrowed so the HR Section Head is not
  // asked them, and area widened to district managers.
  audiences: {
    area: ["medical_rep", "district_manager"],
    background: ["medical_rep", "district_manager", "office_coordinator"],
    experience: ["medical_rep", "district_manager", "office_coordinator"],
    region: ["medical_rep", "district_manager"],
    salary: ["medical_rep", "district_manager", "office_coordinator"],
  },
  questions: [
    { appliesToRoleFamilies: ["office_coordinator"], bodyText: "Are you based in Cairo?", isActive: true, questionKey: "oc_cairo" },
    {
      appliesToRoleFamilies: ["office_coordinator"],
      bodyText: "The job is on site in Sheraton, Cairo. Could you travel there every working day?",
      isActive: false,
      questionKey: "oc_sheraton_commute",
    },
    { appliesToRoleFamilies: ["district_manager"], bodyText: "Have you managed a team of medical reps?", isActive: true, questionKey: "dm_team_leadership" },
    { appliesToRoleFamilies: ["hr_section_head"], bodyText: "Do you have experience in pharmaceutical companies?", isActive: true, questionKey: "hrsh_pharma" },
    {
      appliesToRoleFamilies: ["office_coordinator", "medical_rep", "district_manager"],
      bodyText: "If you were offered the job, when could you start?",
      isActive: true,
      questionKey: "oc_start_date",
    },
  ],
};

const none = new Set<string>();

export async function runRecruitmentPoolWhatsAppColumnsTests() {
  // ── 1 · No role picked: the questions every applicant meets, in the bot's own words ───────────────
  const shared = poolDefaultColumns({ answeredKeys: none, roleFamily: null, whatsapp: QUESTIONS });
  assert.deepEqual(shared.map((column) => column.key), ["appliedFor", "background", "place", "experience", "salary"]);
  assert.deepEqual(
    shared.map((column) => column.header),
    [
      BUILT_IN_ANSWER_QUESTIONS.job_title,
      BUILT_IN_ANSWER_QUESTIONS.background,
      `${BUILT_IN_ANSWER_QUESTIONS.region} · ${BUILT_IN_ANSWER_QUESTIONS.area}`,
      BUILT_IN_ANSWER_QUESTIONS.experience,
      BUILT_IN_ANSWER_QUESTIONS.salary,
    ],
    "the headers are the one list every screen shares — never a second spelling",
  );
  assert.equal(POOL_SHARED_QUESTION_HEADERS.appliedFor, "What are you applying for?");
  assert.deepEqual(shared.find((column) => column.key === "place")?.editKeys, ["region", "area"], "the place column edits both answers");

  // ── 2 · A role picked: exactly the questions that role is asked ───────────────────────────────────
  const oc = poolDefaultColumns({ answeredKeys: none, roleFamily: "office_coordinator", whatsapp: QUESTIONS });
  assert.deepEqual(
    oc.map((column) => column.key),
    ["background", "experience", "salary", "extra:oc_cairo", "extra:oc_start_date"],
    "an Office Coordinator is asked background, experience, salary, Cairo and start date — not region, not area, not a district manager's question",
  );
  assert.ok(!oc.some((column) => column.key === "appliedFor"), "the Role filter already answers what they applied for");
  assert.equal(oc[3]?.header, "Are you based in Cairo?", "an admin question's header is its wording, never its key");

  const dm = poolDefaultColumns({ answeredKeys: none, roleFamily: "district_manager", whatsapp: QUESTIONS });
  assert.deepEqual(
    dm.map((column) => column.key),
    ["background", "place", "experience", "salary", "extra:dm_team_leadership", "extra:oc_start_date"],
    "region and area fold into one place column, once — and a saved audience widening area is obeyed",
  );

  // ── 3 · A retired question, or a built-in outside its audience, returns only with an answer on screen
  assert.ok(
    poolRoleQuestionColumns({ answeredKeys: new Set(["extra:oc_sheraton_commute"]), roleFamily: "office_coordinator", whatsapp: QUESTIONS })
      .some((column) => column.key === "extra:oc_sheraton_commute"),
    "an answer given before the question was switched off is still an answer",
  );
  assert.deepEqual(
    poolDefaultColumns({ answeredKeys: none, roleFamily: "hr_section_head", whatsapp: QUESTIONS }).map((column) => column.key),
    ["extra:hrsh_pharma"],
  );
  assert.deepEqual(
    poolDefaultColumns({ answeredKeys: new Set(["salary"]), roleFamily: "hr_section_head", whatsapp: QUESTIONS }).map((column) => column.key),
    ["salary", "extra:hrsh_pharma"],
  );

  // ── 4 · No question list: the built-ins on their defaults, never a column under a raw key ─────────
  assert.deepEqual(
    poolDefaultColumns({ answeredKeys: new Set(["extra:oc_cairo"]), roleFamily: "office_coordinator", whatsapp: null }).map(
      (column) => column.key,
    ),
    ["background", "place", "experience", "salary"],
  );

  // ── 5 · Full control: any question can be added, a layout is kept per view, a stale key is dropped ─
  const catalogue = poolColumnCatalogue(QUESTIONS, none);
  assert.deepEqual(
    catalogue.map((column) => column.key),
    ["appliedFor", "background", "place", "experience", "salary", "extra:oc_cairo", "extra:dm_team_leadership", "extra:hrsh_pharma", "extra:oc_start_date"],
    "every built-in and every live question can be added; the retired one only once somebody answered it",
  );
  assert.equal(
    catalogue.find((column) => column.key === "extra:oc_cairo")?.askedTo,
    "Asked only to Office Coordinator applicants",
    "two questions worded alike must be told apart in the chooser",
  );
  assert.deepEqual(
    applyPoolColumnLayout(shared, catalogue, ["salary", "extra:hrsh_pharma", "extra:deleted_since", "salary"]).map((column) => column.key),
    ["salary", "extra:hrsh_pharma"],
    "the reader's order wins; a question deleted since, or a repeat, is dropped",
  );
  assert.deepEqual(applyPoolColumnLayout(shared, catalogue, null), shared, "nothing saved is the view's own questions");
  assert.deepEqual(applyPoolColumnLayout(shared, catalogue, []), [], "hiding every column is a choice, not a reset");
  assert.equal(poolColumnViewKey(null), "all");
  assert.equal(poolColumnViewKey("office_coordinator"), "office_coordinator");

  // ── 6 · Each cell is the candidate's own answer, from the reader every screen shares ──────────────
  const answers = poolAnswersByColumn(
    {
      appliedForJobTitle: "Office Coordinator",
      declaredBackground: "Commerce",
      declaredExpectedSalary: "negotiable",
      declaredExperience: "1 - 3 years",
      preferencesDeclaredAt: "2026-10-18T09:00:00Z",
      screeningExtraAnswers: { oc_cairo: "Yes", oc_start_date: "Immediately" },
    },
    QUESTIONS,
  );
  assert.equal(answers.get("salary"), "negotiable", "verbatim, never a parsed figure");
  assert.equal(answers.get("extra:oc_cairo"), "Yes");
  assert.equal(answers.get("extra:oc_start_date"), "Immediately");
  assert.match(poolRoleQuestionsCaption("office_coordinator", 5), /5 questions the WhatsApp bot asks Office Coordinator applicants/);
  assert.match(poolRoleQuestionsCaption("other", 0), /not asked any WhatsApp questions/);

  // ── 7 · Editing an answer writes the column the bot writes; an empty value clears it ──────────────
  assert.deepEqual(whatsAppAnswerEditPayload("background", "  Pharmacy ", null), { ok: true, payload: { declared_background: "Pharmacy" } });
  assert.deepEqual(whatsAppAnswerEditPayload("salary", "", null), { ok: true, payload: { declared_expected_salary: null } });
  assert.deepEqual(whatsAppAnswerEditPayload("job_title", "District Manager", null), {
    ok: true,
    payload: { applied_for_job_title: "District Manager" },
  });
  const jobTitle = whatsAppAnswerEditPayload("job_title", "District Manager", null);
  assert.ok(
    jobTitle.ok && !("preferences_declared_at" in jobTitle.payload),
    "a recruiter's typing must never stamp the record as the applicant having answered the bot",
  );
  assert.deepEqual(
    whatsAppAnswerEditPayload("region", "alex-bhr", null),
    { ok: true, payload: { preferred_region_code: "AB", preferred_region_name: null } },
    "a company region's name becomes its code, exactly as a tap would",
  );
  assert.deepEqual(whatsAppAnswerEditPayload("region", "Minya", null), {
    ok: true,
    payload: { preferred_region_code: null, preferred_region_name: "Minya" },
  });
  assert.deepEqual(
    whatsAppAnswerEditPayload("extra:oc_cairo", "No", { oc_cairo: "Yes", oc_start_date: "Immediately" }),
    { ok: true, payload: { screening_extra_answers: { oc_cairo: "No", oc_start_date: "Immediately" } } },
    "an admin question's answer is merged in, never written over the others",
  );
  assert.deepEqual(
    whatsAppAnswerEditPayload("extra:oc_cairo", "", { oc_cairo: "Yes", oc_start_date: "Immediately" }),
    { ok: true, payload: { screening_extra_answers: { oc_start_date: "Immediately" } } },
    "clearing removes that one answer",
  );
  assert.equal(whatsAppAnswerEditPayload("full_name", "x", null).ok, false, "only a WhatsApp question can be edited this way");
  assert.equal(whatsAppAnswerEditPayload("extra:Bad Key", "x", null).ok, false);
  assert.equal(whatsAppAnswerEditPayload("salary", 12000, null).ok, false, "an answer is text");
  assert.equal(whatsAppAnswerEditPayload("salary", "x".repeat(WHATSAPP_ANSWER_MAX_CHARS + 1), null).ok, false);

  // ── 8 · The table draws those columns, every cell can be edited, and both pages feed it ───────────
  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.ok(
    /tableColumns\.map\(\(column\) => \(\s*<th[\s\S]{0,500}?\{column\.header\}/.test(workspace),
    "the header row is the column list — the WhatsApp questions, or the reader's own choice",
  );
  assert.ok(
    workspace.includes("const tableColumns = applyPoolColumnLayout(defaultColumns, columnCatalogue, savedColumns);"),
    "the drawn columns are the view's questions with the reader's layout applied",
  );
  assert.ok(
    /roleFilter && roleFilter !== "unknown" \? roleFilter : null/.test(workspace) &&
      workspace.includes("poolDefaultColumns({ answeredKeys, roleFamily: roleView, whatsapp: whatsappQuestions })"),
    "the headers switch on the Role filter — the owner's choice",
  );
  assert.ok(
    workspace.includes("<PoolAnswerText answer={whatsappAnswers.get(column.key) ?? null} />"),
    "an admin question's cell is that candidate's own answer",
  );
  assert.ok(
    workspace.includes("canEdit={canFileCandidates}") &&
      workspace.includes("`/api/recruitment/candidates/${candidate.id}/whatsapp-answer`"),
    "every answer cell is editable by a reader holding candidates:update, through the one save route",
  );
  assert.ok(
    workspace.includes('{ label: "WhatsApp answers", value: <WhatsAppAnswersList answers={whatsappAnswers} /> }'),
    "a phone card has no header row, so it lists every answer under its question",
  );
  for (const page of ["app/(admin)/recruitment/page.tsx", "app/employee-portals/recruitment/page.tsx"]) {
    const source = read(page);
    assert.ok(source.includes("whatsappQuestions: () => loadPoolWhatsAppQuestions(),"), `${page} must read the question list`);
    assert.ok(source.includes("whatsappQuestions={whatsappQuestions}"), `${page} must hand it to the pool`);
  }
  const route = read("app/api/recruitment/candidates/[id]/whatsapp-answer/route.ts");
  assert.ok(
    route.includes('requireRecruitmentAccess(request, "candidates", "update")') && route.includes("assertSameOriginMutation(request)"),
    "the save route asserts candidates:update and same-origin before it writes",
  );
  assert.ok(
    read("src/lib/security/access-registry.ts").includes(
      'pattern: "/api/recruitment/candidates/*/whatsapp-answer", permission: { resource: "candidates", action: "update" }',
    ),
    "and the registry declares it on the same grant, ahead of the read-only catch-all",
  );
}
