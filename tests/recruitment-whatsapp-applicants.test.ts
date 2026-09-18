import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ScreeningQuestion } from "../src/lib/recruitment/inbound/whatsapp-screening-questions.ts";
import { countCandidatesByDecisionTab } from "../src/lib/recruitment/candidate-decision-tabs.ts";
import { parseScreeningFilters, screeningHref } from "../src/lib/recruitment/screening-link.ts";
import {
  ANSWERED_ALL,
  ANSWERED_FILTER_KEY,
  ANSWERED_NOT_ALL,
  applicantMatches,
  parseWhatsAppApplicantSearch,
  REGION_FILTER_KEY,
  REGION_NOT_KNOWN,
  REGION_OUTSIDE_EGYPT,
  TYPED_ANSWER_VALUE,
  whatsAppApplicantSearchCandidateIds,
  whatsAppApplicantSearchLabel,
  whatsAppApplicantSearchParam,
  whatsAppApplicantsPoolHref,
  type WhatsAppApplicantRow,
} from "../src/lib/recruitment/whatsapp-applicant-filters.ts";
import {
  answeredBuiltInQuestion,
  applicantTitleLabel,
  buildWhatsAppApplicantsView,
  conversationProgress,
  type WhatsAppApplicantCandidate,
  type WhatsAppApplicantSession,
} from "../src/lib/recruitment/whatsapp-applicants.ts";
import { BUILT_IN_ANSWER_QUESTIONS, UNREADABLE_QUESTION_LABEL } from "../src/lib/recruitment/whatsapp-answers.ts";

/**
 * WHATSAPP APPLICANTS — the owner's page of everyone who started the WhatsApp bot's questions,
 * searched by job title and then by that title's own questions.
 *
 * The owner, 2026-09-18: "I want to search for an office coordinator that is living in Cairo and has
 * 25 years." Everyone who started counts, "even if answered two or three only", with a filter for
 * whether they answered all of them. Where they live is "both but source of trust whatsapp answers".
 *
 * The rule most likely to be "fixed" back is what ANSWERED ALL means. It is judged from the
 * conversation's own record, never against today's list of questions, because the list keeps
 * growing: judged against today, every rep who finished before the 2026-09-18 afternoon additions
 * would read "did not answer all".
 */

let sessionSeq = 0;

function session(overrides: Partial<WhatsAppApplicantSession> = {}): WhatsAppApplicantSession {
  sessionSeq += 1;
  return {
    area_name: null,
    area_other_text: null,
    background: null,
    background_other_text: null,
    candidate_id: "cand-1",
    completed_at: "2026-09-10T10:30:00Z",
    expected_salary: null,
    experience: null,
    extra_answers: null,
    extra_current_question_key: null,
    id: `session-${sessionSeq}`,
    job_title_family: "office_coordinator",
    job_title_other_text: null,
    region_code: null,
    region_other_text: null,
    started_at: "2026-09-10T10:00:00Z",
    step: "done",
    wa_id: "201000000001",
    ...overrides,
  };
}

function candidate(overrides: Partial<WhatsAppApplicantCandidate> = {}): WhatsAppApplicantCandidate {
  return {
    cv_unconfirmed_governorate: null,
    full_name: "Mona Adel",
    governorate: null,
    id: "cand-1",
    in_cv_folder: false,
    status: "new",
    ...overrides,
  };
}

function question(overrides: Partial<ScreeningQuestion> = {}): ScreeningQuestion {
  return {
    appliesToRoleFamilies: ["office_coordinator"],
    bodyText: "How old are you?",
    id: "q-age",
    isActive: true,
    kind: "tappable",
    options: [
      { description: null, title: "20 to 25", value: "20_25" },
      { description: null, title: "25 to 30", value: "25_30" },
    ],
    questionKey: "oc_age_band",
    sortOrder: 10,
    ...overrides,
  };
}

const NO_QUESTIONS = new Map<string, Pick<ScreeningQuestion, "bodyText">>();

function view(input: {
  sessions: WhatsAppApplicantSession[];
  candidates?: WhatsAppApplicantCandidate[];
  questions?: ScreeningQuestion[];
  audiences?: Map<string, readonly string[]>;
}) {
  const candidates = input.candidates ?? [candidate()];
  return buildWhatsAppApplicantsView({
    audiences: input.audiences ?? new Map(),
    candidates: new Map(candidates.map((entry) => [entry.id, entry])),
    questions: input.questions ?? [],
    sessions: input.sessions,
  });
}

function onlyRow(rows: WhatsAppApplicantRow[]): WhatsAppApplicantRow {
  assert.equal(rows.length, 1, `expected exactly one row, got ${rows.length}`);
  return rows[0]!;
}

function runProgressTests() {
  // ── A pending extra question: stopped inside the admin's questions ──────────────────────────
  const pending = conversationProgress(
    session({ completed_at: null, expected_salary: "12000", extra_current_question_key: "oc_age_band", step: "done" }),
    new Map([["oc_age_band", { bodyText: "How old are you?" }]]),
  );
  assert.deepEqual(
    pending,
    { finished: false, stillOpen: true, waitingOn: "How old are you?" },
    "a salary is not the end while an extra question is still pending — the pending key outranks it",
  );
  assert.equal(
    conversationProgress(session({ extra_current_question_key: "deleted_question" }), NO_QUESTIONS).waitingOn,
    UNREADABLE_QUESTION_LABEL,
    "a pending question since deleted is still named, never left blank",
  );

  // ── A salary with nothing pending is the end, even before the sweep closes it ─────────────────
  assert.deepEqual(
    conversationProgress(session({ completed_at: null, expected_salary: "negotiable", step: "salary" }), NO_QUESTIONS),
    { finished: true, stillOpen: true, waitingOn: null },
  );

  // ── Parked on a question: waiting for exactly that one ────────────────────────────────────────
  assert.deepEqual(
    conversationProgress(session({ completed_at: null, step: "experience" }), NO_QUESTIONS),
    { finished: false, stillOpen: true, waitingOn: BUILT_IN_ANSWER_QUESTIONS.experience },
  );
  assert.equal(
    conversationProgress(session({ background: "other", completed_at: null, step: "background_other" }), NO_QUESTIONS).waitingOn,
    BUILT_IN_ANSWER_QUESTIONS.background,
    "an 'Other' tap waits on its typed follow-up, which is still the same question",
  );
  // The two 2026-08-28 conversations: closed by the bot while still parked on the area question.
  assert.deepEqual(
    conversationProgress(session({ region_code: "CA", step: "area" }), NO_QUESTIONS),
    { finished: false, stillOpen: false, waitingOn: BUILT_IN_ANSWER_QUESTIONS.area },
    "a closed conversation parked on a question is NOT finished",
  );

  // ── Closed at the end without a salary: salary can be narrowed away from a title ──────────────
  assert.deepEqual(
    conversationProgress(session({ experience: "fresh", step: "done" }), NO_QUESTIONS),
    { finished: true, stillOpen: false, waitingOn: null },
    "judged by where the conversation stopped, not by today's question list",
  );
  assert.deepEqual(
    conversationProgress(session({ completed_at: null, step: "done" }), NO_QUESTIONS),
    { finished: false, stillOpen: true, waitingOn: null },
    "at the end but never closed and no salary: not shown as finished",
  );

  // ── An "Other" tap is not an answer until something is typed ───────────────────────────────────
  assert.equal(answeredBuiltInQuestion(session({ background: "other" }), "background"), false);
  assert.equal(answeredBuiltInQuestion(session({ background: "other", background_other_text: "Nursing" }), "background"), true);
  assert.equal(answeredBuiltInQuestion(session({ region_other_text: "Minya" }), "region"), true);
}

function runRegionTests() {
  const regionOf = (overrides: Partial<WhatsAppApplicantSession>, person: Partial<WhatsAppApplicantCandidate>) =>
    onlyRow(view({ candidates: [candidate(person)], sessions: [session(overrides)] }).rows);

  // THEIR ANSWER FIRST. The owner: "source of trust whatsapp answers".
  const tapped = regionOf({ region_code: "CA" }, { governorate: "Alexandria" });
  assert.deepEqual(tapped.region, { label: "Cairo", source: "whatsapp", sourceLine: "Their WhatsApp answer" });
  assert.equal(tapped.values[REGION_FILTER_KEY], "CA", "the WhatsApp answer, not the CV's Alexandria, is what the filter matches");

  const typed = regionOf({ region_other_text: "Minya" }, {});
  assert.deepEqual(typed.region, { label: "Upper Egypt", source: "whatsapp", sourceLine: "Their WhatsApp answer: Minya" });
  assert.equal(typed.values[REGION_FILTER_KEY], "UE");

  // THE CV AFTER. Office coordinators are no longer asked the region, so this is most of them.
  const confirmed = regionOf({}, { governorate: "Cairo" });
  assert.deepEqual(confirmed.region, { label: "Cairo", source: "cv", sourceLine: "From the address on their CV" });
  assert.equal(confirmed.values[REGION_FILTER_KEY], "CA");

  const hedged = regionOf({}, { cv_unconfirmed_governorate: "Giza" });
  assert.deepEqual(hedged.region, {
    label: "Giza",
    source: "cv_unconfirmed",
    sourceLine: "From the address on their CV, not confirmed",
  });
  assert.equal(hedged.values[REGION_FILTER_KEY], "GZ");

  const abroad = regionOf({}, { governorate: "Dubai" });
  assert.equal(abroad.region?.label, "Outside Egypt");
  assert.equal(abroad.region?.sourceLine, "From the address on their CV (United Arab Emirates)");
  assert.equal(abroad.values[REGION_FILTER_KEY], REGION_OUTSIDE_EGYPT);

  const nowhere = regionOf({}, {});
  assert.equal(nowhere.region, null);
  assert.equal(nowhere.values[REGION_FILTER_KEY], REGION_NOT_KNOWN, "nobody is left out of the Region filter entirely");
}

function runRowTests() {
  // ── Who is on the page ─────────────────────────────────────────────────────────────────────────
  const skipped = view({ sessions: [session({ job_title_family: null, step: "job_title" })] });
  assert.equal(skipped.rows.length, 0, "question one never tapped: not an applicant for anything yet");
  assert.equal(skipped.titles.length, 0);

  // ── One row per person per title: a finished conversation beats a newer abandoned one ─────────
  const finishedOlder = session({ expected_salary: "9000", id: "older", started_at: "2026-09-01T09:00:00Z" });
  const abandonedNewer = session({ completed_at: null, id: "newer", started_at: "2026-09-12T09:00:00Z", step: "background" });
  const kept = onlyRow(view({ sessions: [abandonedNewer, finishedOlder] }).rows);
  assert.equal(kept.finished, true, "a finished application is never hidden behind a later one abandoned at question one");
  assert.equal(kept.appliedAt, "2026-09-01T09:00:00Z");

  const bothFinished = onlyRow(
    view({
      sessions: [
        session({ expected_salary: "9000", started_at: "2026-09-01T09:00:00Z" }),
        session({ expected_salary: "11000", started_at: "2026-09-12T09:00:00Z" }),
      ],
    }).rows,
  );
  assert.equal(bothFinished.appliedAt, "2026-09-12T09:00:00Z", "between two finished ones, the newest");

  const twoJobs = view({
    sessions: [session({ job_title_family: "office_coordinator" }), session({ job_title_family: "medical_rep" })],
  });
  assert.equal(twoJobs.rows.length, 2, "one person applying for two jobs is a row under each");
  assert.deepEqual(
    twoJobs.titles.map((title) => title.value),
    ["medical_rep", "office_coordinator"],
    "titles follow the bot's own menu order",
  );

  // ── Not matched to a candidate: counted under the title, never silently dropped ───────────────
  const unmatched = view({
    sessions: [
      session({ candidate_id: "cand-1", wa_id: "201000000001" }),
      session({ candidate_id: null, wa_id: "201000000002" }),
      session({ candidate_id: null, wa_id: "201000000002" }),
      // Listed already under this title through another conversation, so not counted twice.
      session({ candidate_id: null, wa_id: "201000000001" }),
      session({ candidate_id: null, job_title_family: "finance", wa_id: "201000000003" }),
    ],
  });
  const officeCoordinator = unmatched.titles.find((title) => title.value === "office_coordinator");
  assert.deepEqual(officeCoordinator && { count: officeCoordinator.count, unlinked: officeCoordinator.unlinked }, {
    count: 1,
    unlinked: 1,
  });
  const finance = unmatched.titles.find((title) => title.value === "finance");
  assert.deepEqual(finance && { count: finance.count, unlinked: finance.unlinked }, { count: 0, unlinked: 1 }, "a title with nobody listed still appears, with its count");

  // ── "Other" is last, and is never printed as a code ───────────────────────────────────────────
  const other = view({
    sessions: [
      session({ job_title_family: "other", job_title_other_text: "Pharmacist assistant" }),
      session({ job_title_family: "office_coordinator" }),
    ],
  });
  assert.equal(other.titles.at(-1)?.value, "other");
  assert.equal(other.titles.at(-1)?.label, "Other — typed their own job title");
  assert.equal(other.rows.find((row) => row.titleValue === "other")?.typedTitle, "Pharmacist assistant");
  assert.equal(applicantTitleLabel("no_such_family"), "Another job title", "an unknown family is named in words, never as its code");

  // ── The answers, in the order they were asked; a deleted question is still listed ──────────────
  const answered = onlyRow(
    view({
      questions: [question()],
      sessions: [
        session({
          background: "pharmacy",
          expected_salary: "25 k to 30 k",
          experience: "1_3",
          extra_answers: { gone_question: "Yes", oc_age_band: "25 to 30" },
          region_code: "CA",
        }),
      ],
    }).rows,
  );
  assert.deepEqual(
    answered.answers.map((answer) => [answer.question, answer.answer]),
    [
      [BUILT_IN_ANSWER_QUESTIONS.background, "Pharmacy"],
      [BUILT_IN_ANSWER_QUESTIONS.experience, "1 - 3 years"],
      [BUILT_IN_ANSWER_QUESTIONS.salary, "25 k to 30 k"],
      ["How old are you?", "25 to 30"],
      [UNREADABLE_QUESTION_LABEL, "Yes"],
    ],
    "the job title and region have their own columns; the salary is verbatim",
  );
  assert.equal(answered.statusLabel, "New");
  assert.equal(
    onlyRow(view({ candidates: [candidate({ full_name: " " })], sessions: [session()] }).rows).name,
    "Unnamed applicant",
  );
}

function runFilterTests() {
  const retired = question({
    appliesToRoleFamilies: ["office_coordinator"],
    bodyText: "Can you commute to Sheraton?",
    id: "q-commute",
    isActive: false,
    options: [{ description: null, title: "Yes", value: "yes" }],
    questionKey: "oc_sheraton_commute",
    sortOrder: 20,
  });
  const retiredUnanswered = question({ id: "q-english", isActive: false, questionKey: "oc_english_level", sortOrder: 30 });
  const typedOnly = question({ id: "q-start", kind: "free_text", options: null, questionKey: "oc_start_date", sortOrder: 40 });
  const repOnly = question({ appliesToRoleFamilies: ["medical_rep"], id: "q-military", questionKey: "field_military_service", sortOrder: 50 });

  const built = view({
    candidates: [candidate(), candidate({ id: "cand-2" })],
    questions: [question(), retired, retiredUnanswered, typedOnly, repOnly],
    sessions: [
      session({ extra_answers: { oc_age_band: "25-30 (old wording)", oc_sheraton_commute: "Yes" } }),
      session({ candidate_id: "cand-2", wa_id: "201000000009" }),
    ],
  });
  const filters = built.filtersByTitle.office_coordinator ?? [];
  assert.deepEqual(
    filters.map((filter) => filter.key),
    [REGION_FILTER_KEY, "background", "experience", "extra:oc_age_band", "extra:oc_sheraton_commute", ANSWERED_FILTER_KEY],
    "region first, answered-all last; no area filter while nobody answered it; a typed question has no list; " +
      "another title's question never appears; a retired question appears only if somebody answered it",
  );
  assert.equal(filters.find((filter) => filter.key === "extra:oc_sheraton_commute")?.note, "No longer asked");
  assert.deepEqual(
    filters.find((filter) => filter.key === "extra:oc_age_band")?.options.map((option) => option.value),
    ["20 to 25", "25 to 30", "25-30 (old wording)"],
    "an answer under wording the admin has since changed is still choosable, after the current ones",
  );

  // A saved audience that stops asking a title a question drops its filter once nobody answered it.
  const narrowed = view({
    audiences: new Map([["background", ["medical_rep"]]]),
    sessions: [session()],
  });
  assert.ok(!(narrowed.filtersByTitle.office_coordinator ?? []).some((filter) => filter.key === "background"));

  // The area filter lists what this title's applicants actually chose, plus a typed-answer option.
  const areas = view({
    candidates: [candidate(), candidate({ id: "cand-2" })],
    sessions: [
      session({ area_name: "Nasr City", job_title_family: "medical_rep" }),
      session({ area_other_text: "Shubra", candidate_id: "cand-2", job_title_family: "medical_rep", wa_id: "201000000009" }),
    ],
  });
  assert.deepEqual(
    areas.filtersByTitle.medical_rep?.find((filter) => filter.key === "area")?.options.map((option) => option.value),
    ["Nasr City", TYPED_ANSWER_VALUE],
  );
}

function runMatchTests() {
  // THE OWNER'S OWN EXAMPLE: an office coordinator, living in Cairo, 25.
  const built = view({
    candidates: [
      candidate({ full_name: "Cairo, 25 to 30", governorate: "Cairo", id: "a" }),
      candidate({ full_name: "Giza, 25 to 30", governorate: "Giza", id: "b" }),
      candidate({ full_name: "Cairo, never answered the age", governorate: "Cairo", id: "c" }),
      candidate({ full_name: "Cairo rep", governorate: "Cairo", id: "d" }),
    ],
    questions: [question()],
    sessions: [
      session({ candidate_id: "a", extra_answers: { oc_age_band: "25 to 30" }, wa_id: "1" }),
      session({ candidate_id: "b", extra_answers: { oc_age_band: "25 to 30" }, wa_id: "2" }),
      session({ candidate_id: "c", completed_at: null, extra_current_question_key: "oc_age_band", wa_id: "3" }),
      session({ candidate_id: "d", extra_answers: { oc_age_band: "25 to 30" }, job_title_family: "medical_rep", wa_id: "4" }),
    ],
  });
  const search = (title: string, selections: Record<string, string>) =>
    built.rows.filter((row) => applicantMatches(row, title, selections)).map((row) => row.name);

  assert.deepEqual(search("office_coordinator", { [REGION_FILTER_KEY]: "CA", "extra:oc_age_band": "25 to 30" }), [
    "Cairo, 25 to 30",
  ]);
  assert.deepEqual(search("", {}), [], "nothing is listed until a title is chosen — the page starts blank");
  assert.equal(search("office_coordinator", {}).length, 3, "an empty selection means Any");
  assert.equal(search("office_coordinator", { [REGION_FILTER_KEY]: "", "extra:oc_age_band": "" }).length, 3);
  assert.deepEqual(search("office_coordinator", { [ANSWERED_FILTER_KEY]: ANSWERED_NOT_ALL }), ["Cairo, never answered the age"]);
  assert.equal(search("office_coordinator", { [ANSWERED_FILTER_KEY]: ANSWERED_ALL }).length, 2);
  assert.deepEqual(
    search("office_coordinator", { "extra:oc_english_level": "Good" }),
    [],
    "a filter on a question nobody here answered matches nobody — an unknown answer is never a yes",
  );
}

function runPoolHrefTests() {
  // The HR Business Partner browses under /hr, which proxy.ts rewrites onto the same page. A CV
  // link built from the server's /recruitment would take them out of their own sidebar.
  assert.equal(whatsAppApplicantsPoolHref("/recruitment/whatsapp-applicants"), "/recruitment");
  assert.equal(whatsAppApplicantsPoolHref("/hr/recruitment/whatsapp-applicants"), "/hr/recruitment");
  assert.equal(whatsAppApplicantsPoolHref("/whatsapp-applicants"), "/recruitment", "never an empty pool");
  assert.equal(whatsAppApplicantsPoolHref(null), "/recruitment");
  assert.equal(whatsAppApplicantsPoolHref("/recruitment/screening"), "/recruitment");
}

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function runScreeningHandOffTests() {
  // THE HAND-OFF TO THE SCREENING PAGE. The owner, 2026-09-18: "based on my filters, I can go to
  // screening page and only show those I filtered." The link carries the SEARCH, never a list of
  // names, and the screening page runs it again over the same rows. So the rule that matters is
  // that the two pages find the same people.
  const built = view({
    candidates: [
      candidate({ full_name: "Cairo, 25 to 30", governorate: "Cairo", id: "a" }),
      candidate({ full_name: "Giza, 25 to 30", governorate: "Giza", id: "b" }),
      candidate({ full_name: "Cairo, never answered the age", governorate: "Cairo", id: "c" }),
      candidate({ full_name: "Cairo rep", governorate: "Cairo", id: "d" }),
    ],
    questions: [question()],
    sessions: [
      session({ candidate_id: "a", extra_answers: { oc_age_band: "25 to 30" }, wa_id: "1" }),
      session({ candidate_id: "b", extra_answers: { oc_age_band: "25 to 30" }, wa_id: "2" }),
      session({ candidate_id: "c", completed_at: null, extra_current_question_key: "oc_age_band", wa_id: "3" }),
      session({ candidate_id: "d", extra_answers: { oc_age_band: "25 to 30" }, job_title_family: "medical_rep", wa_id: "4" }),
    ],
  });
  const ownersSearch = { [REGION_FILTER_KEY]: "CA", "extra:oc_age_band": "25 to 30" };

  const param = whatsAppApplicantSearchParam("office_coordinator", ownersSearch);
  assert.equal(param, "title=office_coordinator&extra%3Aoc_age_band=25+to+30&region=CA");
  assert.equal(
    whatsAppApplicantSearchParam("office_coordinator", { "extra:oc_age_band": "25 to 30", [REGION_FILTER_KEY]: "CA" }),
    param,
    "one search is one link, whatever order its filters were picked in",
  );
  assert.equal(
    whatsAppApplicantSearchParam("office_coordinator", { [REGION_FILTER_KEY]: "", "extra:oc_age_band": "" }),
    "title=office_coordinator",
    "a filter left on Any is not part of the search",
  );

  const search = parseWhatsAppApplicantSearch(param);
  assert.ok(search, "the link reads back");
  assert.equal(search.title, "office_coordinator");
  assert.deepEqual({ ...search.selections }, ownersSearch);
  assert.deepEqual(
    [...whatsAppApplicantSearchCandidateIds(built.rows, search)],
    built.rows.filter((row) => applicantMatches(row, "office_coordinator", ownersSearch)).map((row) => row.candidateId),
    "the screening page finds exactly the people this page listed",
  );
  assert.deepEqual([...whatsAppApplicantSearchCandidateIds(built.rows, search)], ["a"]);
  const wholeTitle = parseWhatsAppApplicantSearch(whatsAppApplicantSearchParam("office_coordinator", {}));
  assert.ok(wholeTitle);
  assert.deepEqual(
    [...whatsAppApplicantSearchCandidateIds(built.rows, wholeTitle)].sort(),
    ["a", "b", "c"],
    "a title with no filters is everyone under it, finished or not, and nobody from another title",
  );

  // The link is typed into an address bar as easily as it is clicked, so it is untrusted.
  assert.equal(parseWhatsAppApplicantSearch(null), null);
  assert.equal(parseWhatsAppApplicantSearch(""), null);
  assert.equal(parseWhatsAppApplicantSearch("region=CA"), null, "a search naming no job title narrows nothing");
  assert.equal(parseWhatsAppApplicantSearch("title=%20%20"), null, "and neither does a blank one");
  const hostile = parseWhatsAppApplicantSearch("title=office_coordinator&__proto__=x&constructor=y");
  assert.ok(hostile);
  assert.equal(Object.getPrototypeOf(hostile.selections), null, "the filters sit on a null prototype");
  assert.equal(({} as Record<string, unknown>).x, undefined, "so a key spelled __proto__ changes no other object");
  assert.deepEqual(
    [...whatsAppApplicantSearchCandidateIds(built.rows, hostile)],
    [],
    "and, like a filter on a question nobody answered, it matches nobody",
  );

  // In words for the screening page's header: this page's own names, in this page's order, never a code.
  assert.deepEqual(whatsAppApplicantSearchLabel(built, search), {
    filters: ["Region: Cairo", "How old are you? 25 to 30"],
    title: "Office Coordinator",
  });
  assert.deepEqual(
    whatsAppApplicantSearchLabel(built, { selections: { "extra:oc_english_level": "Good" }, title: "office_coordinator" }),
    { filters: ["A filter this page no longer offers: Good"], title: "Office Coordinator" },
    "a filter this page stopped offering still narrows the list, so it is still named",
  );
  assert.equal(
    whatsAppApplicantSearchLabel(built, { selections: {}, title: "astronaut" }).title,
    "A job title nobody has applied for",
  );

  // THE SCREENING PAGE'S HALF. The search travels as one parameter, and the screening link keeps it.
  assert.equal(
    screeningHref("/recruitment", { whatsapp: param }),
    "/recruitment/screening?whatsapp=title%3Doffice_coordinator%26extra%253Aoc_age_band%3D25%2Bto%2B30%26region%3DCA",
    "the search is one parameter, encoded once more so its own & and = cannot leak into the screening link",
  );
  assert.equal(parseScreeningFilters({ whatsapp: param }).whatsapp, param, "and reads it back unchanged");
  assert.equal(parseScreeningFilters({ whatsapp: "  " }).whatsapp, null);
  assert.equal(
    screeningHref("/hr/recruitment", { candidate: "cand-1", status: "rejected", whatsapp: param }),
    "/hr/recruitment/screening?status=rejected&whatsapp=title%3Doffice_coordinator%26extra%253Aoc_age_band%3D25%2Bto%2B30%26region%3DCA&candidate=cand-1",
    "it composes with the screening page's own filters under either shell, and the open CV still comes last",
  );

  // Every piece of the chain has to pass it on, or the pile silently widens back to everyone.
  const station = read("src/components/recruitment/workstation/workstation-page-client.tsx");
  for (const [name, source] of [
    ["admin", read("app/(admin)/recruitment/screening/page.tsx")],
    ["portal", read("app/employee-portals/recruitment/screening/page.tsx")],
  ] as const) {
    assert.match(source, /whatsapp=\{workspace\.whatsapp\}/, `the ${name} screening page must pass the search on`);
    assert.match(
      source,
      /whatsAppSearchLabel=\{workspace\.whatsAppSearchLabel\}/,
      `the ${name} screening page must pass the search's words on`,
    );
  }
  assert.match(station, /whatsapp: next\.whatsapp !== undefined \? next\.whatsapp : whatsapp,/, "changing a filter keeps the search");
  assert.match(station, /whatsapp: null,/, "and Clear drops it with the rest");
  assert.match(
    read("src/components/recruitment/whatsapp-applicants-search.tsx"),
    /href=\{screeningHref\(pool, \{\s+status: statusFilterForDecisionTab\(decisionTab\),\s+whatsapp: whatsAppApplicantSearchParam\(title, selections\),\s+\}\)\}/,
    "the button on this page carries exactly the search on screen, and the tab it is on",
  );
  // The pile opens on everyone the search found on the open decision tab, not on the "New CVs" queue,
  // which would hide the ones already read that the WhatsApp page had just listed.
  assert.match(
    read("src/components/recruitment/workstation/screening-workstation.tsx"),
    /const \[queue, setQueue\] = useState<ScreeningWorkQueue>\("all"\);/,
  );
  // Shelved and decided CVs are FOUND, because the WhatsApp page lists them too - the decided ones then
  // sit on their own tabs (runDecisionTabTests). A CV in one of the owner's own folders is not: that
  // page leaves it off as well.
  assert.match(
    read("src/lib/recruitment/screening-workspace.ts"),
    /const whatsAppMatches = whatsAppIds\s+\? outsideHandBuiltFolders\.filter\(\(candidate\) => whatsAppIds\.has\(candidate\.id\)\)\s+: null;/,
  );
  assert.match(read("src/lib/recruitment/screening-workspace.ts"), /const pool = seatQueue \?\? whatsAppMatches \?\? reviewPool;/);
}

/**
 * THE DECISION TABS, and the owner's own folders. The owner, 2026-09-18, first: "hide the CVs I
 * already decided from the WhatsApp screening list". Then, the same night, for every screen that
 * lists CVs: "did not decide yet ... shortlisted ... rejected", each its own tab, and a CV he moves
 * into a folder he built ("Archive") shown only inside that folder. So the decided CVs are no longer
 * hidden by a WhatsApp-only rule; they sit on their own tabs, and the pile opens on "Not decided yet".
 */
function runDecisionTabTests() {
  // THE ROW CARRIES ITS PILE, as the code the tabs read, whatever the status was spelled as.
  const sessions = [
    session({ id: "s-new", wa_id: "201000000001", candidate_id: "cand-new" }),
    session({ id: "s-rej", wa_id: "201000000002", candidate_id: "cand-rej" }),
    session({ id: "s-legacy", wa_id: "201000000003", candidate_id: "cand-legacy" }),
    session({ id: "s-filed", wa_id: "201000000004", candidate_id: "cand-filed" }),
  ];
  const built = view({
    candidates: [
      candidate({ id: "cand-new", status: "new" }),
      candidate({ id: "cand-rej", status: "rejected" }),
      candidate({ id: "cand-legacy", status: "Candidate Created" }),
      candidate({ id: "cand-filed", in_cv_folder: true, status: "rejected" }),
    ],
    sessions,
  });
  const statusOf = (id: string) => built.rows.find((row) => row.candidateId === id)?.status;
  assert.equal(statusOf("cand-new"), "new");
  assert.equal(statusOf("cand-rej"), "rejected");
  assert.equal(statusOf("cand-legacy"), "new", "the legacy default reads as not decided yet, like every screen");

  // A CV IN ONE OF THE OWNER'S OWN FOLDERS is off the page, and counted under its title.
  assert.equal(statusOf("cand-filed"), undefined, "a CV moved into a folder he built is not listed");
  const title = built.titles.find((entry) => entry.value === "office_coordinator");
  assert.ok(title, "the title is still offered");
  assert.equal(title.count, 3, "three rows are listed");
  assert.equal(title.inFolders, 1, "and the filed one is counted, never silently dropped");
  assert.equal(title.unlinked, 0, "a filed CV is not an unmatched chat");

  // The tab counts the page prints: one pile each, "All" the sum.
  assert.deepEqual(countCandidatesByDecisionTab(built.rows), {
    all: 3,
    hired: 0,
    new: 2,
    rejected: 1,
    sent_to_manager: 0,
    shortlisted: 0,
  });

  // THE SCREENING LINK. No status now means "Not decided yet"; "All" is spelled out; a retired
  // `decided=1` link, which asked to keep everybody, opens on "All".
  assert.equal(parseScreeningFilters({ whatsapp: "x" }).status, "new", "a WhatsApp pile opens on Not decided yet");
  assert.equal(parseScreeningFilters({ whatsapp: "x", status: "all" }).status, null, "status=all is every pile");
  assert.equal(parseScreeningFilters({ whatsapp: "x", decided: "1" }).status, null, "the retired decided=1 opens on All");
  assert.equal(parseScreeningFilters({ whatsapp: "x", status: "rejected", decided: "1" }).status, "rejected");
  assert.equal(screeningHref("/recruitment", { status: "new", whatsapp: "x" }), "/recruitment/screening?whatsapp=x");
  assert.equal(screeningHref("/recruitment", { status: null, whatsapp: "x" }), "/recruitment/screening?status=all&whatsapp=x");

  // THE WIRING. The retired flag is gone from every link and page, and the tab strip is on the
  // screening page and on this one.
  const workspace = read("src/lib/recruitment/screening-workspace.ts");
  assert.doesNotMatch(workspace, /whatsAppPileHidesDecided|whatsAppDecided/, "no WhatsApp-only hiding rule is left");
  assert.match(workspace, /const decisionCounts = countCandidatesByDecisionTab\(acrossTabs\);/);
  const station = read("src/components/recruitment/workstation/workstation-page-client.tsx");
  assert.doesNotMatch(station, /decided: next\.decided|whatsAppDecided/, "the station carries no decided flag");
  assert.match(station, /onSelect=\{\(tab\) => goTo\(\{ status: statusFilterForDecisionTab\(tab\) \}\)\}/);
  for (const [name, source] of [
    ["admin", read("app/(admin)/recruitment/screening/page.tsx")],
    ["portal", read("app/employee-portals/recruitment/screening/page.tsx")],
  ] as const) {
    assert.match(source, /decisionCounts=\{workspace\.decisionCounts\}/, `the ${name} screening page must pass the tab counts on`);
    assert.doesNotMatch(source, /decided=\{workspace\.decided\}/, `the ${name} screening page must drop the retired flag`);
  }
  const page = read("src/components/recruitment/whatsapp-applicants-search.tsx");
  assert.match(page, /<CandidateDecisionTabStrip/, "the WhatsApp Applicants page has the tabs");
  assert.match(page, /useState<CandidateDecisionTab>\(DEFAULT_CANDIDATE_DECISION_TAB\)/, "and opens on Not decided yet");
}

export function runRecruitmentWhatsAppApplicantsTests() {
  runProgressTests();
  runRegionTests();
  runRowTests();
  runFilterTests();
  runMatchTests();
  runPoolHrefTests();
  runScreeningHandOffTests();
  runDecisionTabTests();
}
