import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  applyPoolColumnLayout,
  poolAnswersByColumn,
  poolAnswersOutsideColumns,
  poolAnswerSummary,
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
      workspace.includes("`/api/recruitment/candidates/${candidateId}/whatsapp-answer`"),
    "every answer cell is editable by a reader holding candidates:update, through the one save route",
  );
  assert.ok(
    workspace.includes('<WhatsAppAnswersList answers={withoutFilterAudience(whatsappAnswers)} className="mt-1" />'),
    "a phone card has no header row, so it lists every answer under its question",
  );

  // ── 9 · A phone edits the same answers (owner, 2026-10-19 — "Add it on phones") ───────────────────
  // The card lists the table's own columns, each with the table's pencil, and every other answer after
  // them read-only — so hiding a column on a phone never hides what the applicant said.
  const place = shared.find((column) => column.key === "place")!;
  const extraStart = poolColumnCatalogue(QUESTIONS, none).find((column) => column.key === "extra:oc_start_date")!;
  const cardAnswers = [
    { key: "background" },
    { key: "region" },
    { key: "area" },
    { key: "extra:oc_cairo" },
    { key: "extra:oc_start_date" },
  ];
  assert.deepEqual(
    poolAnswersOutsideColumns(cardAnswers, [place, extraStart]).map((answer) => answer.key),
    ["background", "extra:oc_cairo"],
    "region and area both sit in the place column; an answer with no column is still listed",
  );
  assert.deepEqual(poolAnswersOutsideColumns(cardAnswers, []).length, cardAnswers.length, "every column hidden — every answer listed");
  assert.equal(poolAnswerSummary({ area: "Nasr City", region: "Cairo" }, place), "Cairo · Nasr City", "region, then area");
  assert.equal(poolAnswerSummary({ area: "", region: "Cairo" }, place), "Cairo");
  assert.equal(poolAnswerSummary({ area: " ", region: "" }, place), "", "nothing answered reads as nothing — the card shows a dash and Add");

  const card = workspace.slice(workspace.indexOf("function CandidatePoolCard("), workspace.indexOf("type PoolDateFilter ="));
  assert.ok(card.length > 0, "CandidatePoolCard must still exist");
  assert.ok(
    workspace.includes("answerColumns={tableColumns}") && workspace.includes("canEditAnswers={canFileCandidates}"),
    "the card gets the table's own columns and the table's own grant — never a second permission",
  );
  assert.match(
    card,
    /<PoolEditableAnswer\s+canEdit\s+column=\{column\}[\s\S]{0,700}?savePoolColumnAnswers\(candidate\.id, column, values, currentValues\)[\s\S]{0,400}?pending=\{pending\}\s+touch\s*>/,
    "each card answer is the table's pencil and editor, saved through the one shared save, drawn for a thumb",
  );
  assert.equal(
    (workspace.match(/await savePoolColumnAnswers\(candidate\.id, column, values, currentValues\);/g) ?? []).length,
    2,
    "the desktop cell and the phone card save through the same function",
  );
  assert.ok(
    /canEditAnswers\s*\?\s*answerColumns\.length > 0 \|\| answersOutsideColumns\.length > 0\s*:\s*whatsappAnswers\.length > 0/.test(card) &&
      card.includes("answers={withoutFilterAudience(answersOutsideColumns)}"),
    "a reader who cannot edit keeps the plain list; one who can sees the answers no column holds after the columns",
  );

  // ── 10 · The answers span the card (owner, 2026-10-19 — "fix the phone card's WhatsApp answers to
  // span the full width"). As one of the two-column grid's fields the list ran about 900px down one
  // half of the card with the other half empty (production, 375px, Medical Representative filter).
  assert.doesNotMatch(card, /label: "WhatsApp answers"/, "the answers are never a half-width field of the grid again");
  assert.match(
    card,
    /<PortalRecordFields[\s\S]*?\/>\s*\{whatsappAnswersSection\}\s*<PortalRecordFields/,
    "the answers sit full width between the screening facts and the contact details",
  );
  // …and under a role filter, "Asked only to … applicants" is left off the questions that role is
  // asked — it repeats the filter, and a question asked to five roles ran to five lines on a phone.
  assert.ok(
    workspace.includes(
      "const roleQuestionKeys: ReadonlySet<string> = new Set(roleView ? defaultColumns.map((column) => column.key) : []);",
    ) && workspace.includes("roleQuestionKeys={roleQuestionKeys}"),
    "the role's own questions are its default columns, and only with a role picked",
  );
  assert.ok(
    card.includes("column.askedTo && !roleQuestionKeys.has(column.key)") &&
      card.includes("roleQuestionKeys.has(answer.key) ? { ...answer, askedTo: null } : answer"),
    "the audience line is dropped only for the picked role's own questions; an answer from another role's question keeps it",
  );
  const medicalRepKeys = new Set(
    poolDefaultColumns({ answeredKeys: none, roleFamily: "medical_rep", whatsapp: QUESTIONS }).map((column) => column.key),
  );
  assert.ok(medicalRepKeys.has("extra:oc_start_date"), "a question asked to several roles, medical reps among them, is a rep question");
  assert.ok(!medicalRepKeys.has("extra:oc_cairo"), "an Office Coordinator's own question is not — it keeps its audience line");
  const cells = read("src/components/recruitment/pool-question-columns.tsx");
  assert.match(
    cells,
    /export function PoolEditableCell\([\s\S]{0,200}?<td className=\{className\}>\s*<PoolEditableAnswer \{\.\.\.answer\} \/>/,
    "the desktop cell is the shared answer inside a <td> — one pencil, one editor",
  );
  assert.match(
    cells,
    /touch\s*\?\s*`[^`]*\bmin-h-8\b[^`]*\$\{adminControlDepthClassName\}`/,
    "a phone has no hover: the card's pencil is full strength with room for a thumb, lifted like every recruitment control",
  );
  assert.doesNotMatch(
    cells.slice(cells.indexOf("touch\n"), cells.indexOf(": \"mt-1 inline-flex")),
    /opacity-60|rounded/,
    "the thumb-sized pencil is neither faded nor rounded",
  );
  // The card prints the question right above an open editor, so a lone field's visible label said it
  // twice — "Expected salary", then "EXPECTED SALARY" (production, 375px, 2026-10-19; owner: "fix the
  // repeated question label in the phone answer editor"). It stays for screen readers; the two-field
  // place column keeps both labels, which tell its boxes apart; the desktop cell is untouched.
  assert.match(
    cells,
    /<PoolAnswerEditor[\s\S]{0,300}?questionShownAbove=\{touch\}/,
    "only the phone card tells the editor its question is already on screen",
  );
  assert.ok(
    cells.includes("const labelOnlyForScreenReaders = questionShownAbove && column.editKeys.length === 1;"),
    "only a lone field loses its visible label — region and area keep theirs",
  );
  assert.match(
    cells,
    /labelOnlyForScreenReaders \? "sr-only" : `mb-1 block break-words normal-case \$\{phxLabelTextClassName\}`/,
    "hidden from sight, never removed: the input keeps its accessible name",
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
