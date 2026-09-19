// Recruitment / ATS — WhatsApp Applicants: everyone who started the WhatsApp bot's questions, one
// row per person per job title, with their answers and the filters their title's questions make.
//
// THE OWNER, 2026-09-18: "I want to build a new page in recruitment module. This page will show only
// the CVs that we received on WhatsApp ... the first filter will be job position or job title ... I
// choose the title I want, and based on the title, the next questions of the WhatsApp appear as
// filters. For example, I want to search for an office coordinator that is living in Cairo and has
// 25 years." Asked who belongs on it, he said everyone who STARTED the questions, "even if answered
// two or three only", with a filter for whether they answered all of them. Asked where "living in"
// comes from, he said "both but source of trust whatsapp answers".
//
// WHO IS ON IT. A conversation counts once question one, the job title, has been tapped, because
// that answer is what places the person under a title at all. On 2026-09-18 production held 591
// such conversations, and 118 more that never got that far. A row needs a candidate record to
// open, and the loader finds it the way the bot does. A conversation whose CV is not a candidate
// yet is COUNTED under its title and not listed, so it is never silently dropped.
//
// ONE ROW PER PERSON PER TITLE. Somebody who sends a second CV starts a second conversation; 20
// senders had done so by 2026-09-18. The row shows the newest conversation that reached the end,
// else the newest one, so a finished application is never hidden behind a later one abandoned at
// question one.
//
// "ANSWERED ALL QUESTIONS" MEANS EVERY QUESTION THE BOT PUT TO THEM, NOT EVERY QUESTION ON TODAY'S
// LIST. The list keeps changing. Background, experience and salary were added on the night of
// 2026-08-30. Region and area have been asked only of field roles since 2026-09-05. Military
// service, age and start date reached medical reps and district managers at 13:27 on 2026-09-18.
// Judged against today's list, every rep who finished before that afternoon would read "did not
// answer all", which is not what happened. So `conversationProgress` reads the conversation's own
// record, which says exactly where it stopped. Measured on 2026-09-18: all 56 open conversations
// were parked on the question their `step` names, and all 531 the bot closed normally had
// answered the last question of the flow they were on.
//
// A CV IN ONE OF THE OWNER'S OWN FOLDERS IS NOT LISTED. He asked on 2026-09-18 to "cut" CVs he is
// done with into a folder he made (an "Archive") so they stop appearing with all the CVs, and chose
// that such a CV appears only inside that folder. So it is left off this page too, and counted under
// its title as `inFolders` rather than silently dropped. The same rule is `isInCvFolder` on the
// screening page and the pool.
//
// REGION: THEIR ANSWER FIRST, THE CV AFTER. That is exactly `candidateScreeningFacts`'s region, so it
// is called rather than re-derived. This page and the screening workstation cannot disagree about
// where somebody is. Office coordinators have not been asked the region since 2026-09-05, so for most
// of them the CV's address is the only place it can come from. That is the owner's "both".

import { candidateRegionCodes, candidateRegionLabels, foreignRegionLabel } from "@/lib/recruitment/candidate-region";
import { candidateRoleFamilyLabels } from "@/lib/recruitment/candidate-role-family";
import { candidateDecisionTabOf } from "@/lib/recruitment/candidate-decision-tabs";
import { candidateScreeningFacts } from "@/lib/recruitment/candidate-screening-facts";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import {
  candidateBackgroundCodes,
  candidateBackgroundLabels,
  candidateExperienceCodes,
  candidateExperienceLabels,
  offeredRoleMenuFamilies,
  OTHER_ROW_VALUE,
} from "@/lib/recruitment/inbound/whatsapp-classify-menus";
import type { SessionRow } from "@/lib/recruitment/inbound/whatsapp-classify-session-row";
import {
  sessionAreaLabel,
  sessionBackgroundLabel,
  sessionExperienceLabel,
} from "@/lib/recruitment/inbound/whatsapp-classify-session";
import {
  builtInQuestionAppliesToRole,
  type BuiltInQuestionKey,
  type SavedAudiences,
} from "@/lib/recruitment/inbound/whatsapp-question-audience";
import { questionAppliesToRole, type ScreeningQuestion } from "@/lib/recruitment/inbound/whatsapp-screening-questions";
import { BUILT_IN_ANSWER_QUESTIONS, UNREADABLE_QUESTION_LABEL } from "@/lib/recruitment/whatsapp-answers";
import {
  ANSWERED_ALL,
  ANSWERED_FILTER_KEY,
  ANSWERED_NOT_ALL,
  REGION_FILTER_KEY,
  REGION_NOT_KNOWN,
  REGION_OUTSIDE_EGYPT,
  TYPED_ANSWER_VALUE,
  type WhatsAppApplicantAnswer,
  type WhatsAppApplicantFilter,
  type WhatsAppApplicantRow,
  type WhatsAppApplicantsView,
  type WhatsAppApplicantTitle,
} from "@/lib/recruitment/whatsapp-applicant-filters";

/** One conversation, as the loader reads it off `ats_whatsapp_classification_sessions`. */
export type WhatsAppApplicantSession = Pick<
  SessionRow,
  | "id"
  | "wa_id"
  | "step"
  | "job_title_family"
  | "job_title_other_text"
  | "background"
  | "background_other_text"
  | "region_code"
  | "region_other_text"
  | "area_name"
  | "area_other_text"
  | "experience"
  | "expected_salary"
> & {
  /** The extra question the bot is waiting on. Cleared only when the last one is answered. */
  extra_current_question_key: string | null;
  /** Answers to the admin's extra questions, keyed by question key. A tapped answer is the option's TITLE. */
  extra_answers: Record<string, unknown> | null;
  started_at: string;
  completed_at: string | null;
  /** The candidate this conversation belongs to, resolved by the loader. Null when there is none yet. */
  candidate_id: string | null;
};

export type WhatsAppApplicantCandidate = {
  id: string;
  full_name: string | null;
  status: string | null;
  /** The governorate column: a person typed it, or the CV reader was sure of it. */
  governorate: string | null;
  /** The CV reader's governorate when it was NOT sure enough to write the column. */
  cv_unconfirmed_governorate: string | null;
  /** Filed in one of the folders the owner built by hand, so it appears only inside that folder. */
  in_cv_folder: boolean;
};

/** What an unfinished row says in place of a name nobody ever gave. */
const UNNAMED_APPLICANT = "Unnamed applicant";

/** The dropdown's words for the family whose people typed their own job title. */
const OTHER_TITLE_LABEL = "Other — typed their own job title";

/** A family with no label cannot be printed as a code. It is named in words instead. */
const UNLABELLED_TITLE = "Another job title";

function text(raw: unknown): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value.length > 0 ? value : null;
}

function ownValue(record: Record<string, unknown> | null | undefined, key: string): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Whether one of the six fixed questions has a real answer on this conversation.
 *
 * An "Other" tap is not an answer by itself. It opens a typed follow-up, and until something is
 * typed the bot is still waiting. So `background = "other"` with no typed words is unanswered, which
 * is the state 9 production conversations were parked in on 2026-09-18.
 */
export function answeredBuiltInQuestion(session: WhatsAppApplicantSession, key: BuiltInQuestionKey): boolean {
  switch (key) {
    case "job_title":
      return session.job_title_family === OTHER_ROW_VALUE
        ? Boolean(text(session.job_title_other_text))
        : Boolean(text(session.job_title_family));
    case "background":
      return session.background === OTHER_ROW_VALUE
        ? Boolean(text(session.background_other_text))
        : Boolean(text(session.background));
    case "region":
      return Boolean(text(session.region_other_text)) || Boolean(text(session.region_code));
    case "area":
      return Boolean(text(session.area_name)) || Boolean(text(session.area_other_text));
    case "experience":
      return Boolean(text(session.experience));
    case "salary":
      return Boolean(text(session.expected_salary));
  }
}

export type ConversationProgress = {
  /** Every question the bot put to them has an answer. */
  finished: boolean;
  /** The question it was left waiting on, in words. Null when finished, or when it cannot be named. */
  waitingOn: string | null;
  /** The conversation has not been closed, so they may still answer. */
  stillOpen: boolean;
};

/**
 * The question each `step` value waits on. The "_other" steps wait for the typed follow-up to the
 * same question. Same vocabulary as the session table's CHECK constraint.
 */
const STEP_QUESTIONS: Readonly<Record<string, string>> = {
  area: BUILT_IN_ANSWER_QUESTIONS.area,
  area_other: BUILT_IN_ANSWER_QUESTIONS.area,
  background: BUILT_IN_ANSWER_QUESTIONS.background,
  background_other: BUILT_IN_ANSWER_QUESTIONS.background,
  experience: BUILT_IN_ANSWER_QUESTIONS.experience,
  job_title: BUILT_IN_ANSWER_QUESTIONS.job_title,
  job_title_other: BUILT_IN_ANSWER_QUESTIONS.job_title,
  region: BUILT_IN_ANSWER_QUESTIONS.region,
  region_other: BUILT_IN_ANSWER_QUESTIONS.region,
  salary: BUILT_IN_ANSWER_QUESTIONS.salary,
};

/** The step a conversation is left on once the bot closes it (`closeSession`). */
const CLOSED_STEP = "done";

/**
 * How far one conversation got, from the conversation's own record. See the header for why it is
 * not judged against today's list of questions.
 *
 *   1. An extra question still pending means they stopped inside the extra questions. The loop
 *      writes the key of the question it is waiting on and clears it only once the last one is
 *      answered.
 *   2. Otherwise a salary means they finished. Salary is the last fixed question and the extra
 *      questions come after it, so with nothing pending there is nothing left. This also covers a
 *      conversation the bot has not closed yet: the sweep closes those after 30 quiet minutes.
 *   3. Otherwise a conversation parked on a question is waiting for that question. The bot writes
 *      the step before it sends each question. Two conversations from 2026-08-28 were closed while
 *      still parked on the area question, and they read as not finished too.
 *   4. Otherwise the bot closed it, and it closes a conversation at the end of the questions. Salary
 *      can be narrowed to some job titles, so a closed conversation without one is still finished.
 *      A conversation closed because WhatsApp's 24-hour window had shut is written the same way and
 *      cannot be told apart. None of the 531 closed on 2026-09-18 was one.
 */
export function conversationProgress(
  session: WhatsAppApplicantSession,
  questionsByKey: ReadonlyMap<string, Pick<ScreeningQuestion, "bodyText">>,
): ConversationProgress {
  const stillOpen = !text(session.completed_at);
  const finished: ConversationProgress = { finished: true, stillOpen, waitingOn: null };
  const waiting = (question: string | null): ConversationProgress => ({ finished: false, stillOpen, waitingOn: question });

  const pendingExtra = text(session.extra_current_question_key);
  if (pendingExtra) return waiting(text(questionsByKey.get(pendingExtra)?.bodyText) ?? UNREADABLE_QUESTION_LABEL);

  if (answeredBuiltInQuestion(session, "salary")) return finished;

  const step = text(session.step);
  if (step && step !== CLOSED_STEP) return waiting(STEP_QUESTIONS[step] ?? null);

  return stillOpen ? waiting(null) : finished;
}

/** The dropdown's words for a title. Never a raw code. */
export function applicantTitleLabel(family: string): string {
  if (family === OTHER_ROW_VALUE) return OTHER_TITLE_LABEL;
  return (candidateRoleFamilyLabels as Record<string, string | undefined>)[family] ?? UNLABELLED_TITLE;
}

/**
 * The region cell and the Region filter's value. Their WhatsApp answer, else the CV's address.
 * `candidateScreeningFacts` decides, so the screening workstation says the same thing.
 */
function applicantRegion(
  session: WhatsAppApplicantSession,
  candidate: WhatsAppApplicantCandidate,
): { cell: WhatsAppApplicantRow["region"]; value: string } {
  const region = candidateScreeningFacts({
    cvUnconfirmed: { governorate: candidate.cv_unconfirmed_governorate },
    governorate: candidate.governorate,
    preferredRegionCode: session.region_code,
    preferredRegionName: session.region_other_text,
  }).region;
  if (!region) return { cell: null, value: REGION_NOT_KNOWN };

  const { code, declared, foreignCountry, label } = region.value;
  const value = code ?? (foreignCountry ? REGION_OUTSIDE_EGYPT : REGION_NOT_KNOWN);
  if (declared) {
    // A typed answer ("Minya") is filed under the region it names ("Upper Egypt"), and their own
    // words are kept beside it. The region alone would not show what they actually said.
    const typed = text(session.region_other_text);
    const sourceLine = typed && typed !== label ? `Their WhatsApp answer: ${typed}` : "Their WhatsApp answer";
    return { cell: { label, source: "whatsapp", sourceLine }, value };
  }
  const where = foreignCountry ? ` (${foreignCountry})` : "";
  return region.confirmed
    ? { cell: { label, source: "cv", sourceLine: `From the address on their CV${where}` }, value }
    : {
        cell: { label, source: "cv_unconfirmed", sourceLine: `From the address on their CV${where}, not confirmed` },
        value,
      };
}

/**
 * Everything they answered, in the order they were asked, as question and answer. The job title is
 * the page's own filter and the region has its own column, so neither is repeated here. Admin
 * questions follow in the admin's order, retired ones included. A question since deleted is still
 * listed under UNREADABLE_QUESTION_LABEL rather than dropped. Same reading as `candidateWhatsAppAnswers`.
 */
function applicantAnswers(
  session: WhatsAppApplicantSession,
  questions: readonly ScreeningQuestion[],
): WhatsAppApplicantAnswer[] {
  const answers: WhatsAppApplicantAnswer[] = [];
  const add = (key: string, question: string, raw: unknown) => {
    const answer = text(raw);
    if (answer) answers.push({ answer, key, question });
  };
  add("background", BUILT_IN_ANSWER_QUESTIONS.background, sessionBackgroundLabel(session));
  add("area", BUILT_IN_ANSWER_QUESTIONS.area, sessionAreaLabel(session));
  add("experience", BUILT_IN_ANSWER_QUESTIONS.experience, sessionExperienceLabel(session));
  // Verbatim. "25 k to 30 k" and "negotiable" are the answer; a number pulled out of either is not.
  add("salary", BUILT_IN_ANSWER_QUESTIONS.salary, session.expected_salary);

  const named = new Set<string>();
  for (const question of questions) {
    named.add(question.questionKey);
    add(
      `extra:${question.questionKey}`,
      text(question.bodyText) ?? UNREADABLE_QUESTION_LABEL,
      ownValue(session.extra_answers, question.questionKey),
    );
  }
  for (const key of Object.keys(session.extra_answers ?? {})) {
    if (!named.has(key)) add(`extra:${key}`, UNREADABLE_QUESTION_LABEL, ownValue(session.extra_answers, key));
  }
  return answers;
}

/** This row's value for every filter it can be matched on. A question never answered has no key. */
function applicantFilterValues(session: WhatsAppApplicantSession, regionValue: string): Record<string, string> {
  const values: Record<string, string> = { [REGION_FILTER_KEY]: regionValue };

  const background = text(session.background);
  if (background && answeredBuiltInQuestion(session, "background")) {
    if (background === OTHER_ROW_VALUE || (candidateBackgroundCodes as readonly string[]).includes(background)) {
      values.background = background;
    }
  }
  const area = text(session.area_name);
  if (area) values.area = area;
  else if (text(session.area_other_text)) values.area = TYPED_ANSWER_VALUE;

  const experience = text(session.experience);
  if (experience && (candidateExperienceCodes as readonly string[]).includes(experience)) {
    values.experience = experience;
  }

  for (const key of Object.keys(session.extra_answers ?? {})) {
    const answer = text(ownValue(session.extra_answers, key));
    if (answer) values[`extra:${key}`] = answer;
  }
  return values;
}

type Candidacy = {
  candidate: WhatsAppApplicantCandidate;
  progress: ConversationProgress;
  session: WhatsAppApplicantSession;
};

/** Which conversation represents a person under a title: a finished one first, then the newest. */
function outranks(challenger: Candidacy, holder: Candidacy): boolean {
  if (challenger.progress.finished !== holder.progress.finished) return challenger.progress.finished;
  return Date.parse(challenger.session.started_at) > Date.parse(holder.session.started_at);
}

const REGION_OPTIONS = [
  ...candidateRegionCodes.map((code) => ({ label: candidateRegionLabels[code], value: code as string })),
  { label: foreignRegionLabel, value: REGION_OUTSIDE_EGYPT },
  { label: "Region not known", value: REGION_NOT_KNOWN },
];

/**
 * The filters one title offers, in the order the bot asks its questions: region first, because it
 * stands for their answer and their CV together, and "answered all" last.
 *
 * A question appears when the bot asks this title today, OR when anybody under the title answered
 * it. The second half keeps a retired question's answers searchable: office coordinators answered
 * the Sheraton commute question before it was switched off on 2026-09-05. Such a question is marked
 * "No longer asked", so an empty result on it is not read as nobody saying yes.
 */
function filtersForTitle(input: {
  family: string;
  rows: readonly WhatsAppApplicantRow[];
  questions: readonly ScreeningQuestion[];
  audiences: SavedAudiences;
}): WhatsAppApplicantFilter[] {
  const { audiences, family, questions, rows } = input;
  const answeredBy = (key: string) => rows.filter((row) => Object.prototype.hasOwnProperty.call(row.values, key));
  const askedToday = (key: BuiltInQuestionKey) => builtInQuestionAppliesToRole(key, audiences.get(key), family);

  const filters: WhatsAppApplicantFilter[] = [
    {
      key: REGION_FILTER_KEY,
      label: "Region",
      note: "Their WhatsApp answer. If they were not asked, the address on their CV.",
      options: REGION_OPTIONS,
    },
  ];

  if (askedToday("background") || answeredBy("background").length > 0) {
    filters.push({
      key: "background",
      label: BUILT_IN_ANSWER_QUESTIONS.background,
      note: askedToday("background") ? null : "No longer asked",
      options: [
        ...candidateBackgroundCodes.map((code) => ({ label: candidateBackgroundLabels[code], value: code as string })),
        { label: "Something else — typed their own", value: OTHER_ROW_VALUE },
      ],
    });
  }

  // The area list is whatever this title's applicants actually chose. The menu they were shown is
  // built live from the company's areas, and it changes as the org does.
  const areaRows = answeredBy("area");
  if (areaRows.length > 0) {
    const areaNames = [...new Set(areaRows.map((row) => row.values.area))].filter((area) => area !== TYPED_ANSWER_VALUE);
    areaNames.sort((a, b) => a.localeCompare(b));
    filters.push({
      key: "area",
      label: BUILT_IN_ANSWER_QUESTIONS.area,
      note: askedToday("area") ? null : "No longer asked",
      options: [
        ...areaNames.map((area) => ({ label: area, value: area })),
        ...(areaRows.some((row) => row.values.area === TYPED_ANSWER_VALUE)
          ? [{ label: "Not on the list — typed their own", value: TYPED_ANSWER_VALUE }]
          : []),
      ],
    });
  }

  if (askedToday("experience") || answeredBy("experience").length > 0) {
    filters.push({
      key: "experience",
      label: BUILT_IN_ANSWER_QUESTIONS.experience,
      note: askedToday("experience") ? null : "No longer asked",
      options: candidateExperienceCodes.map((code) => ({ label: candidateExperienceLabels[code], value: code as string })),
    });
  }

  for (const question of questions) {
    // A typed answer is somebody's own sentence, so there is no list to choose from. It is still
    // printed on the row.
    if (question.kind !== "tappable") continue;
    const key = `extra:${question.questionKey}`;
    const asked = question.isActive && questionAppliesToRole(question, family);
    const answered = answeredBy(key);
    if (!asked && answered.length === 0) continue;

    // The answer stored is the option's title at the moment it was tapped. A title the admin has
    // since reworded is still a real answer, so it stays choosable after the current ones.
    const titles = (question.options ?? []).map((option) => option.title).filter((title) => Boolean(text(title)));
    const older = [...new Set(answered.map((row) => row.values[key]))].filter((answer) => !titles.includes(answer));
    older.sort((a, b) => a.localeCompare(b));
    filters.push({
      key,
      label: text(question.bodyText) ?? UNREADABLE_QUESTION_LABEL,
      note: asked ? null : "No longer asked",
      options: [...titles, ...older].map((title) => ({ label: title, value: title })),
    });
  }

  filters.push({
    key: ANSWERED_FILTER_KEY,
    label: "Answered all the questions?",
    note: null,
    options: [
      { label: "Answered all questions", value: ANSWERED_ALL },
      { label: "Did not answer all questions", value: ANSWERED_NOT_ALL },
    ],
  });
  return filters;
}

/** The owner's menu order, then any title the menu no longer offers, then "Other" last. */
function titleOrder(a: string, b: string): number {
  const rank = (family: string) => {
    if (family === OTHER_ROW_VALUE) return Number.MAX_SAFE_INTEGER;
    const index = (offeredRoleMenuFamilies as readonly string[]).indexOf(family);
    return index === -1 ? offeredRoleMenuFamilies.length : index;
  };
  return rank(a) - rank(b) || applicantTitleLabel(a).localeCompare(applicantTitleLabel(b));
}

/**
 * The whole page: the titles, each title's filters, and every row. Built once on the server. The
 * browser only filters it.
 */
export function buildWhatsAppApplicantsView(input: {
  sessions: readonly WhatsAppApplicantSession[];
  candidates: ReadonlyMap<string, WhatsAppApplicantCandidate>;
  /** Every admin-defined question, retired ones included. */
  questions: readonly ScreeningQuestion[];
  /** The built-in questions' saved audiences, as the bot reads them. */
  audiences: SavedAudiences;
}): WhatsAppApplicantsView {
  const questions = [...input.questions].sort((a, b) => a.sortOrder - b.sortOrder);
  const questionsByKey = new Map(questions.map((question) => [question.questionKey, question]));

  const chosen = new Map<string, Candidacy>();
  const linkedSenders = new Map<string, Set<string>>();
  const unlinkedSenders = new Map<string, Set<string>>();
  const filedCandidates = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, family: string, sender: string) => {
    const senders = map.get(family) ?? new Set<string>();
    senders.add(sender);
    map.set(family, senders);
  };

  for (const session of input.sessions) {
    const family = text(session.job_title_family);
    // Question one never tapped: not an applicant for anything yet.
    if (!family) continue;
    const candidate = session.candidate_id ? input.candidates.get(session.candidate_id) : undefined;
    if (!candidate) {
      note(unlinkedSenders, family, session.wa_id);
      continue;
    }
    note(linkedSenders, family, session.wa_id);
    // Filed by hand into one of the owner's folders: counted under the title, never listed.
    if (candidate.in_cv_folder) {
      note(filedCandidates, family, candidate.id);
      continue;
    }
    const entry: Candidacy = { candidate, progress: conversationProgress(session, questionsByKey), session };
    const key = `${candidate.id}:${family}`;
    const holder = chosen.get(key);
    if (!holder || outranks(entry, holder)) chosen.set(key, entry);
  }

  const rows: WhatsAppApplicantRow[] = [...chosen.entries()].map(([key, { candidate, progress, session }]) => {
    const family = text(session.job_title_family) as string;
    const region = applicantRegion(session, candidate);
    return {
      answers: applicantAnswers(session, questions),
      appliedAt: session.started_at,
      candidateId: candidate.id,
      finished: progress.finished,
      key,
      name: text(candidate.full_name) ?? UNNAMED_APPLICANT,
      region: region.cell,
      sessionId: session.id,
      status: candidateDecisionTabOf(candidate.status),
      statusLabel: candidateStatusLabel(candidate.status),
      stillOpen: progress.stillOpen,
      titleValue: family,
      typedTitle: family === OTHER_ROW_VALUE ? text(session.job_title_other_text) : null,
      values: applicantFilterValues(session, region.value),
      waitingOn: progress.waitingOn,
    };
  });
  rows.sort((a, b) => Date.parse(b.appliedAt) - Date.parse(a.appliedAt) || a.name.localeCompare(b.name));

  const families = [
    ...new Set([...rows.map((row) => row.titleValue), ...unlinkedSenders.keys(), ...filedCandidates.keys()]),
  ].sort(titleOrder);
  const titles: WhatsAppApplicantTitle[] = families.map((family) => {
    // A sender who ALSO has a listed conversation under this title is already on the page.
    const linked = linkedSenders.get(family) ?? new Set<string>();
    const unlinked = [...(unlinkedSenders.get(family) ?? [])].filter((sender) => !linked.has(sender)).length;
    return {
      count: rows.filter((row) => row.titleValue === family).length,
      inFolders: filedCandidates.get(family)?.size ?? 0,
      label: applicantTitleLabel(family),
      unlinked,
      value: family,
    };
  });

  const filtersByTitle: Record<string, WhatsAppApplicantFilter[]> = {};
  for (const family of families) {
    filtersByTitle[family] = filtersForTitle({
      audiences: input.audiences,
      family,
      questions,
      rows: rows.filter((row) => row.titleValue === family),
    });
  }

  return { filtersByTitle, rows, titles };
}
