// Recruitment / ATS — one candidate's whole page, as a sheet of paper.
//
// THE OWNER, 2026-09-19, on /recruitment/candidate/<id>: "all data appearing here I want it printed."
// The candidate's page shows everything the system holds on a person — the screening summary, how they
// reached us, every field on the record, the files, the sends to managers, the applications and
// interviews, who has opened the CV, the history and the notes. This is that page, laid out for A4 and
// for a printer, in the page's order and words with the three changes he made to it the same day:
//
//   1. WHAT WAS NOT FILLED IN IS NOT PRINTED. No "not on file" row, no "Irrelevant" row, no section that
//      would only say "nobody has opened this yet". A thin record prints short.
//   2. "WHERE THEY STAND" IS NOT PRINTED AT ALL — his words: "the whole section of where they stand.
//      Remove it." The status stays in the line under the name; the star, the decision line, the shelf,
//      the folders and the manager count are on the screen only.
//   3. THE IMPORTANT ANSWERS COME FIRST. His complaint was that the print led with the trivial and buried
//      the salary. The screening summary now opens with the expected salary and the questions HR itself
//      added (the start date, the age); the five the bot always asks — which the CV facts below already
//      repeat — come after them.
//
// WHAT IS NOT ON IT: the CV itself. That is a document of its own, printed from its own pane (and from
// WhatsApp Applicants, where "Print application" prints it as it was sent). This sheet is the DATA.
//
// THE HOUSE IDENTITY, SATO-DIS-2026-01 v1.0, IS WHY IT COSTS LITTLE INK: type and hairlines, the company
// mark and the engine-turned band, no filled area anywhere, square edges. The screen's tinted section
// bars, status pills and coloured timeline dots are what would have turned this into a block of grey.
//
// IT FLOWS ACROSS AS MANY PAGES AS THE RECORD NEEDS. A candidate with three long jobs on their CV has a
// long record, and squeezing it onto one sheet would mean type nobody can read. Instead a row is never
// split across two pages, a heading never sits alone at the foot of one, and every page carries its
// number. The application sheet (whatsapp-application-sheet.ts) is the one-page document.
//
// SAME WORDS AS THE SCREEN, ON PURPOSE. The screen's own page (src/components/recruitment/
// candidate-record-page.tsx) is a client component with the reading rules written inline, so this file
// restates them — through the same shared modules wherever one exists (the CV field schema, the screening
// facts, the WhatsApp answers, the status and stage labels). tests/candidate-record-print.test.ts
// pins the section titles and the fact labels against those two components, so a section added to the
// screen and forgotten here goes red instead of silently missing from the paper. The one section the
// paper leaves out on purpose is named in that test.
//
// NAMES, NEVER IDS. Every HR id is resolved to a name by the record loader; an id that matched nobody
// prints "Unnamed user". READ-ONLY: nothing here writes, and nothing marks a CV read.
//
// PURE — no I/O. The page loads the record, the history and the notes; the company mark arrives as an
// argument.

import { HOUSE_DOCUMENT_STANDARD } from "@/lib/export/house-xlsx-palette";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { isBatchActor } from "@/lib/recruitment/batch-actor";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import {
  candidateFolderKindLabels,
  candidateFolderLabel,
  DUPLICATE_FOLDER_KIND,
  DUPLICATE_FOLDER_LABEL,
} from "@/lib/recruitment/candidate-folder";
import type { CandidateRecord, CandidateRecordPart } from "@/lib/recruitment/candidate-record";
import { candidateRecordSections, type CandidateRecordRow } from "@/lib/recruitment/candidate-record-fields";
import { candidateRecordPrintCss } from "@/lib/recruitment/candidate-record-print-css";
import {
  candidateScreeningChecks,
  candidateScreeningFacts,
  formatYearsOfExperience,
  UNCONFIRMED_FACT_TITLE,
  unconfirmedCvFactsFromExtraction,
} from "@/lib/recruitment/candidate-screening-facts";
import { candidateSourceChannel } from "@/lib/recruitment/candidate-source-context";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import type { CandidateTimelineEvent } from "@/lib/recruitment/candidate-timeline";
import { defaultCvPositionKey, getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import { applicationStageLabel, humanizeRecruitmentTerm } from "@/lib/recruitment/labels";
import type { ManagerSend } from "@/lib/recruitment/manager-sends";
import { isStatedNonEgyptian, nonEgyptianFlagTitle } from "@/lib/recruitment/nationality";
import { managerLabel, UNNAMED_USER_LABEL } from "@/lib/recruitment/person-labels";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import type { Candidate, CandidateComment, RecruitmentFile } from "@/lib/recruitment/types";
import { candidateWhatsAppAnswers, type WhatsAppAnswer } from "@/lib/recruitment/whatsapp-answers";

// ── The model ────────────────────────────────────────────────────────────────────────────────────

/** One value of a field, with the quieter line that goes under it (who, when, where it came from). */
export type PrintValue = { text: string; note: string | null };

export type PrintEntryLine = { label: string; text: string };

export type PrintField = {
  label: string;
  /** A question in a sentence ("If you were offered the job, when could you start?") is not capitalised like a label. */
  sentence: boolean;
  values: PrintValue[];
  /** The CV reader's own guess, not a confirmed fact: printed in italics, the "?" already on the text. */
  hedged: boolean;
  /** The entries of a repeating block (one job, one qualification), each a run of "Label: text" lines. */
  entries: PrintEntryLine[][];
};

export type PrintItem = { title: string; lines: string[] };

export type PrintEvent = { title: string; detail: string | null; at: string };

export type PrintNote = { author: string; role: string | null; at: string; body: string[] };

export type PrintBlock =
  | { kind: "fields"; heading: string | null; count: number | null; fields: PrintField[] }
  | { kind: "items"; items: PrintItem[] }
  | { kind: "events"; events: PrintEvent[] }
  | { kind: "notes"; notes: PrintNote[] }
  | { kind: "text"; lines: string[] }
  | { kind: "say"; text: string; problem: boolean };

export type PrintSection = {
  title: string;
  /** What the screen shows at the right of the section's bar: the status, the channel, a count. */
  aside: string | null;
  blocks: PrintBlock[];
};

export type PrintNotice = { text: string; footnote: string | null };

export type CandidateRecordPrint = {
  name: string;
  subtitle: string;
  notices: PrintNotice[];
  sections: PrintSection[];
  /** "Printed 19 Sept 2026, 03:12 pm (Cairo)". */
  printedLabel: string;
};

export type CandidateRecordPrintInput = {
  record: CandidateRecord;
  /** The history, as the timeline builds it. Null when it could not be read. */
  timeline: readonly CandidateTimelineEvent[] | null;
  /** The notes, newest first. Null when they could not be read. */
  notes: readonly CandidateComment[] | null;
  now: Date;
};

/** What each part is called when it could not be read — in the reader's words, never a code. */
const PART_WORDS: Record<CandidateRecordPart, string> = {
  extraction: "the CV reader's last read",
  folders: "the folders this CV is in",
  questions: "the wording of the WhatsApp questions",
  sends: "the sends to managers",
  viewers: "who has opened this CV",
};

// ── Small readers, the same rules the screen follows ─────────────────────────────────────────────

const stampFormat = stableEnGbFormatter({
  day: "2-digit",
  hour: "2-digit",
  hour12: true,
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

const stampDateFormat = stableEnGbFormatter({
  day: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/** A time in Cairo, always — never a raw UTC instant. The same wording as the screen's `cairoStamp`. */
export function recordStamp(iso: string | null | undefined, options?: { dateOnly?: boolean }): string {
  const value = String(iso ?? "").trim();
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return options?.dateOnly ? stampDateFormat.format(at) : stampFormat.format(at);
}

function personName(people: Record<string, string>, hrId: string | null | undefined): string | null {
  const id = typeof hrId === "string" ? hrId.trim() : "";
  if (!id) return null;
  if (isBatchActor(id)) return "An automated batch";
  return people[id] ?? UNNAMED_USER_LABEL;
}

function byLine(name: string | null, at: string | null | undefined): string | null {
  const when = recordStamp(at);
  if (name && when) return `${name} · ${when}`;
  return name ?? (when || null);
}

function fileSize(bytes: number | null): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKindLabel(kind: string): string {
  return kind.trim().toLowerCase() === "cv" ? "CV" : humanizeRecruitmentTerm(kind) || "File";
}

function shelfLabel(folder: Candidate["folder"]): string | null {
  if (!folder) return null;
  if (folder.kind === DUPLICATE_FOLDER_KIND) return DUPLICATE_FOLDER_LABEL;
  const where = candidateFolderLabel(folder.kind, folder.key);
  const shelf = candidateFolderKindLabels[folder.kind];
  return where && where !== shelf ? `${shelf} · ${where}` : shelf;
}

/** Every send, or the pre-2026-08-30 single send off the candidate row when the sends table has none. */
function sendsToShow(record: CandidateRecord): ManagerSend[] {
  if (record.sends.length > 0) return record.sends;
  const legacy = record.profile.candidate.managerNotified;
  if (!legacy) return [];
  return [
    {
      candidateId: record.profile.candidate.id,
      managerArea: legacy.areaName,
      managerHrId: legacy.hrId,
      managerJobTitle: legacy.jobTitle,
      managerName: legacy.name,
      managerRegion: legacy.regionName,
      position: record.profile.candidate.sentFor,
      sentAt: legacy.sentAt,
    },
  ];
}

/** Free text as lines, each set in its own direction: an Arabic line and an English one in one block. */
function textLines(text: string | null | undefined): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function makeField(
  label: string,
  text: string | null | undefined,
  options: { hedged?: boolean; note?: string | null; sentence?: boolean } = {},
): PrintField {
  return {
    entries: [],
    hedged: options.hedged ?? false,
    label,
    sentence: options.sentence ?? false,
    values: [{ note: options.note ?? null, text: String(text ?? "") }],
  };
}

function makeListField(label: string, values: PrintValue[]): PrintField {
  return { entries: [], hedged: false, label, sentence: false, values };
}

// ── The sections, in the screen's order ──────────────────────────────────────────────────────────

/**
 * Which of the applicant's WhatsApp answers matter most, first.
 *
 * The salary leads. Then the questions HR added on /admin/screening-questions — the start date, the age,
 * whether they can travel — because somebody chose to ask them. Last come the five the bot asks everyone
 * (job, degree, region, area, experience): the CV facts under them already say the same. Within each group
 * the order the applicant met them is kept.
 */
function answersByImportance(answers: WhatsAppAnswer[]): WhatsAppAnswer[] {
  const salary = answers.filter((answer) => answer.key === "salary");
  const asked = answers.filter((answer) => answer.key.startsWith("extra:"));
  const usual = answers.filter((answer) => answer.key !== "salary" && !answer.key.startsWith("extra:"));
  return [...salary, ...asked, ...usual];
}

/**
 * The screening summary — the salary and the applicant's own answers first, then what the CV says, then
 * the four checks. Null when none of it is on file, so a record the reader has not read prints no empty
 * heading; that the read failed is the notice at the top of the sheet, not a line in here.
 */
function screeningSummary(record: CandidateRecord): PrintSection | null {
  const { extraction, screeningQuestions } = record;
  const { candidate } = record.profile;
  const blocks: PrintBlock[] = [];

  const facts = candidateScreeningFacts({
    ...candidate,
    cvUnconfirmed: unconfirmedCvFactsFromExtraction(extraction?.fields),
  });

  const education = [candidate.degree, candidate.faculty, candidate.university].filter(Boolean).join(" · ");
  const graduated = candidate.graduationYear ? `Class of ${candidate.graduationYear}` : null;
  const repFrom = candidate.medicalRepExperienceFrom?.slice(0, 4) ?? null;
  const repTo = candidate.medicalRepExperienceTo?.slice(0, 4) ?? null;
  const repSpan = repFrom ? `${repFrom} → ${repTo ?? "now"}` : null;

  const cells: PrintField[] = [];
  const cell = (label: string, value: string, unconfirmed: boolean, hint?: string | null) =>
    cells.push(
      makeField(label, `${value}${unconfirmed ? " ?" : ""}`, { hedged: unconfirmed, note: unconfirmed ? null : (hint ?? null) }),
    );
  if (facts.roleTitle) cell("Current role", facts.roleTitle.value, !facts.roleTitle.confirmed);
  if (facts.employer) cell("Employer", facts.employer.value, !facts.employer.confirmed);
  if (facts.years) {
    cell("Experience", `${facts.years.confirmed ? "" : "~"}${formatYearsOfExperience(facts.years.value)}`, !facts.years.confirmed);
  }
  if (facts.pharmaRep) {
    cell(
      "Medical rep experience",
      facts.pharmaRep.value ? [candidate.medicalRepEmployer, repSpan].filter(Boolean).join(" · ") || "Yes" : "No",
      !facts.pharmaRep.confirmed,
    );
  }
  if (facts.governorate) {
    cell(
      "Governorate",
      facts.governorate.value,
      !facts.governorate.confirmed,
      facts.region && !facts.region.value.declared ? `${facts.region.value.label} region` : null,
    );
  }
  if (education) cell("Education", education, false, graduated);
  if (!education && graduated) cell("Education", graduated, false);

  // A check with no value ("Military service: not on file") is left out, not printed as a gap.
  const checks: PrintField[] = candidateScreeningChecks(candidate)
    .filter((check) => check.value !== null)
    .map((check) => makeField(check.label, check.value, { note: check.hint ?? null }));

  const answers = answersByImportance(candidateWhatsAppAnswers(candidate, screeningQuestions)).map((entry) =>
    makeField(entry.question, entry.answer, { note: entry.askedTo, sentence: true }),
  );
  // A salary typed in by hand, or read off the CV, when they gave no WhatsApp answer to the salary question.
  const salaryOnFile =
    !candidate.declaredExpectedSalary?.trim() && facts.expectedSalary ? facts.expectedSalary.value : null;

  if (salaryOnFile) {
    blocks.push({ count: null, fields: [makeField("Expected salary", salaryOnFile)], heading: "On the record", kind: "fields" });
  }
  if (answers.length > 0) blocks.push({ count: null, fields: answers, heading: "Answers on WhatsApp", kind: "fields" });
  if (checks.length > 0) blocks.push({ count: null, fields: checks, heading: "Screening checks", kind: "fields" });
  if (cells.length > 0) {
    blocks.push({ count: null, fields: cells, heading: "From the CV", kind: "fields" });
    if (cells.some((entry) => entry.hedged)) {
      blocks.push({ kind: "say", problem: false, text: `Italic with a “?”: ${UNCONFIRMED_FACT_TITLE}` });
    }
  }
  const summaryLines = textLines(candidate.professionalSummary);
  if (summaryLines.length > 0) blocks.push({ kind: "text", lines: summaryLines });

  return blocks.length > 0 ? { aside: null, blocks, title: "Screening summary" } : null;
}

function howTheyReachedUs(record: CandidateRecord): PrintSection {
  const { people } = record;
  const { candidate } = record.profile;
  const channel = candidateSourceChannel(candidate.source, candidate.sourceContext);
  const appliedFor = candidateRowAppliedFor(candidate);
  const addedBy = personName(people, candidate.createdBy);
  const sourceLines = candidate.sourceContext?.detailLines.filter((line) => line.trim()) ?? [];
  const sourceSubject = candidate.sourceContext?.shortLabel?.trim() || null;
  const isEmail = candidate.sourceContext?.channel === "email";
  const isWhatsApp = candidate.sourceContext?.channel === "whatsapp";

  const fields: PrintField[] = [makeField("Came in by", channel.label, { note: channel.title })];
  if (candidate.createdAt) fields.push(makeField("Arrived", recordStamp(candidate.createdAt)));
  if (addedBy) fields.push(makeField("Added by", addedBy));

  const appliedNote = appliedFor.source
    ? [
        APPLIED_FOR_SOURCE_LABEL[appliedFor.source],
        appliedFor.evidence && appliedFor.evidence !== appliedFor.text ? `“${appliedFor.evidence}”` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : null;
  if (appliedFor.text) fields.push(makeField("Applying for", appliedFor.text, { note: appliedNote }));
  if (sourceSubject) fields.push(makeField(isEmail ? "Subject" : "Message", sourceSubject));
  if (sourceLines.length > 0) {
    fields.push(
      makeListField(
        isWhatsApp ? "First messages" : "Message",
        sourceLines.map((line) => ({ note: null, text: line })),
      ),
    );
  }
  if (candidate.cvReferenceName) fields.push(makeField("CV reference", candidate.cvReferenceName));
  if (candidate.cvExternalUrl) fields.push(makeField("CV link", candidate.cvExternalUrl));
  if (candidate.notes) fields.push(makeField("Notes on file", candidate.notes));
  if (candidate.updatedAt) fields.push(makeField("Last changed", recordStamp(candidate.updatedAt)));

  return { aside: channel.label, blocks: [{ count: null, fields, heading: null, kind: "fields" }], title: "How they reached us" };
}

/**
 * A repeating block of the record: one job, one qualification, one language.
 *
 * ONE EXCEPTION TO "THE SAME AS THE SCREEN": a block whose every entry is a single line under one and the
 * same label — the skills, one "Skill: …" per entry — is a list of words, not a set of records. Printed
 * one to a row it takes a third of a page and repeats the word "Skill" a dozen times, so it prints as one
 * wrapped line. Every word is still there, in the same order; only the repeated label and the rules
 * between them go.
 */
function entriesField(label: string, entries: PrintEntryLine[][]): PrintField {
  const oneLabel = entries[0]?.[0]?.label;
  const isWordList = entries.length > 0 && entries.every((lines) => lines.length === 1 && lines[0].label === oneLabel);
  if (isWordList) return makeField(label, entries.map((lines) => lines[0].text).join(" · "));
  return { ...makeListField(label, []), entries };
}

/**
 * Every field on the record, grouped as the CV schema groups it. A field the schema calls irrelevant for
 * this person ("Military service: Irrelevant" on a woman) says nothing on file, so it is not printed, and
 * a group left with no field is not printed either. Null when nothing is left.
 */
function everythingOnTheRecord(record: CandidateRecord): PrintSection | null {
  const { candidate } = record.profile;
  const schema = getCvPositionSchema(defaultCvPositionKey);
  const sections = (schema ? candidateRecordSections(candidate, schema) : [])
    .map((section) => ({
      label: section.label,
      rows: section.rows.filter((row): row is Exclude<CandidateRecordRow, { kind: "irrelevant" }> => row.kind !== "irrelevant"),
    }))
    .filter((section) => section.rows.length > 0);

  if (sections.length === 0) return null;

  return {
    aside: null,
    blocks: sections.map((section): PrintBlock => ({
      count: section.rows.length,
      fields: section.rows.map((row): PrintField => {
        if (row.kind === "entries") return entriesField(row.label, row.entries);
        const lines = textLines(row.text);
        return makeListField(
          row.label,
          (lines.length > 0 ? lines : [""]).map((text) => ({ note: null, text })),
        );
      }),
      heading: section.label,
      kind: "fields",
    })),
    title: "Everything on the record",
  };
}

function filesSection(record: CandidateRecord): PrintSection | null {
  const { people } = record;
  const files: RecruitmentFile[] = record.profile.files;
  if (files.length === 0) return null;
  return {
    aside: `${files.length}`,
    blocks: [
      {
        items: files.map((file) => {
          const uploadedBy = personName(people, file.uploadedByHrId);
          const meta = [
            fileKindLabel(file.kind),
            fileSize(file.sizeBytes),
            file.createdAt ? `added ${recordStamp(file.createdAt)}` : null,
            uploadedBy ? `by ${uploadedBy}` : null,
          ].filter(Boolean);
          return { lines: [meta.join(" · ")], title: file.fileName };
        }),
        kind: "items",
      },
    ],
    title: "Files",
  };
}

/** Null when there is nothing to list, or when the sends could not be read — the notice at the top says so. */
function sentToManagers(record: CandidateRecord): PrintSection | null {
  if (record.unavailable.includes("sends")) return null;
  const sends = sendsToShow(record);
  if (sends.length === 0) return null;
  return {
    aside: `${sends.length}`,
    blocks: [
      {
        items: sends.map((send) => {
          const seat = [send.managerJobTitle, send.managerArea, send.managerRegion].filter(Boolean).join(" · ");
          return {
            lines: [
              ...(seat ? [seat] : []),
              ...(send.position ? [`For: ${positionFolderLabel(send.position)}`] : []),
              `Sent ${recordStamp(send.sentAt)}`,
            ],
            title: managerLabel(send.managerName),
          };
        }),
        kind: "items",
      },
    ],
    title: "Sent to managers",
  };
}

function applicationsAndInterviews(record: CandidateRecord): PrintSection | null {
  const { people, profile } = record;
  const count = profile.applications.length + profile.interviews.length + profile.rejectionHistory.length;
  if (count === 0) return null;

  const items: PrintItem[] = [];
  for (const { application, jobTitle } of profile.applications) {
    const owner = personName(people, application.currentOwnerHrId);
    items.push({
      lines: [
        ...(application.lastStageChangedAt ? [`At this stage since ${recordStamp(application.lastStageChangedAt)}`] : []),
        ...(owner ? [`With ${owner}`] : []),
        ...(application.rejectedReason ? [`Rejected: ${application.rejectedReason}`] : []),
        ...(application.decisionReason ? [`Decision: ${application.decisionReason}`] : []),
      ],
      title: `${jobTitle?.trim() || "A vacancy with no title"} — ${applicationStageLabel(application.stage)}`,
    });
  }
  for (const { interview, summary } of profile.interviews) {
    const interviewer = personName(people, interview.interviewerHrId);
    items.push({
      lines: [
        ...(interview.scheduledAt ? [`Scheduled ${recordStamp(interview.scheduledAt)}`] : []),
        ...(interviewer ? [`Interviewer: ${interviewer}`] : []),
        ...(summary.average !== null ? [`Score ${summary.average} · ${summary.ratedCount} of ${summary.totalCriteria} rated`] : []),
        ...textLines(interview.notes),
      ],
      title: `${humanizeRecruitmentTerm(interview.interviewType)} interview${
        interview.outcome ? ` — ${humanizeRecruitmentTerm(interview.outcome)}` : ""
      }`,
    });
  }
  for (const event of profile.rejectionHistory) {
    const actor = byLine(personName(people, event.actorHrId), event.createdAt);
    items.push({
      lines: [...(event.reason ? [event.reason] : []), ...(actor ? [actor] : [])],
      title: event.action === "app_withdraw" ? "Withdrew" : "Rejected",
    });
  }
  return { aside: `${count}`, blocks: [{ items, kind: "items" }], title: "Applications and interviews" };
}

/** Null when nobody has opened the CV, or when who has could not be read — the notice at the top says so. */
function openedBy(record: CandidateRecord): PrintSection | null {
  if (record.unavailable.includes("viewers")) return null;
  const { viewers } = record;
  if (viewers.length === 0) return null;
  return {
    aside: `${viewers.length}`,
    blocks: [
      {
        items: viewers.map((viewer) => ({
          lines: [
            `First opened ${recordStamp(viewer.firstSeenAt)}`,
            `Last opened ${recordStamp(viewer.lastSeenAt)} · ${viewer.viewCount === 1 ? "once" : `${viewer.viewCount} times`}`,
          ],
          title: viewer.name ?? UNNAMED_USER_LABEL,
        })),
        kind: "items",
      },
    ],
    title: "Opened by",
  };
}

/** A history that could not be loaded stays on the paper as a line saying so; one with nothing in it does not. */
function historySection(timeline: readonly CandidateTimelineEvent[] | null): PrintSection | null {
  if (timeline === null) {
    return {
      aside: null,
      blocks: [{ kind: "say", problem: true, text: "Could not load this candidate's history." }],
      title: "History",
    };
  }
  if (timeline.length === 0) return null;
  return {
    aside: null,
    blocks: [
      {
        events: timeline.map((event) => ({ at: recordStamp(event.at), detail: event.detail, title: event.title })),
        kind: "events",
      },
    ],
    title: "History",
  };
}

/** Notes that could not be loaded stay on the paper as a line saying so; none written does not. */
function notesSection(notes: readonly CandidateComment[] | null): PrintSection | null {
  if (notes === null) {
    return {
      aside: null,
      blocks: [{ kind: "say", problem: true, text: "Could not load the notes on this candidate." }],
      title: "Notes",
    };
  }
  if (notes.length === 0) return null;
  return {
    aside: null,
    blocks: [
      {
        kind: "notes",
        notes: notes.map((note) => ({
          at: recordStamp(note.createdAt),
          author: note.authorName ?? "Unnamed author",
          body: textLines(note.body),
          role: note.authorJobTitle ?? null,
        })),
      },
    ],
    title: "Notes",
  };
}

/**
 * The whole page, section by section, in the order the screen draws it — less "Where they stand", and less
 * every section with nothing in it.
 */
export function buildCandidateRecordPrint(input: CandidateRecordPrintInput): CandidateRecordPrint {
  const { notes, now, record, timeline } = input;
  const { candidate } = record.profile;

  const displayName = candidateDisplayName(candidate.fullName) || "Unnamed candidate";
  const status = candidateStatusLabel(candidate.status);
  const appliedFor = candidateRowAppliedFor(candidate);
  const channel = candidateSourceChannel(candidate.source, candidate.sourceContext);
  const shelf = shelfLabel(candidate.folder);

  const arrivedOn = recordStamp(candidate.createdAt, { dateOnly: true });
  const subtitle = [
    appliedFor.text ? `Applying for ${appliedFor.text}` : null,
    status,
    arrivedOn
      ? channel.key === "manual"
        ? `added in Phoenix ${arrivedOn}`
        : `arrived ${arrivedOn} by ${channel.label}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const notices: PrintNotice[] = [];
  if (isStatedNonEgyptian(candidate.nationality)) {
    notices.push({ footnote: null, text: nonEgyptianFlagTitle(candidate.nationality) });
  }
  if (shelf) {
    notices.push({
      footnote: "A filed CV is kept off the main pool and the screening queue. It is still in the system.",
      text: `Filed: ${shelf}`,
    });
  }
  // The folders are part of "Where they stand", which the paper does not carry, so a failed read of them
  // changes nothing on it and is not reported.
  const missed = record.unavailable.filter((part) => part !== "folders");
  if (missed.length > 0) {
    notices.push({
      footnote: "Everything else on this record was read.",
      text: `Could not read ${missed.map((part) => PART_WORDS[part]).join(", ")}.`,
    });
  }

  const sections = [
    screeningSummary(record),
    howTheyReachedUs(record),
    everythingOnTheRecord(record),
    filesSection(record),
    sentToManagers(record),
    applicationsAndInterviews(record),
    openedBy(record),
    historySection(timeline),
    notesSection(notes),
  ].filter((section): section is PrintSection => section !== null);

  return {
    name: displayName,
    notices,
    printedLabel: `Printed ${recordStamp(now.toISOString())} (Cairo)`,
    sections,
    subtitle,
  };
}

// ── The paper ────────────────────────────────────────────────────────────────────────────────────

/** Each line of a value in its own direction, so an Arabic line reads from its own side. */
function lineSpans(text: string, className = "ln"): string {
  const lines = String(text).split(/\r?\n/);
  return lines.map((line) => `<span class="${className}" dir="auto">${escapeHtml(line)}</span>`).join("");
}

function renderValues(field: PrintField): string {
  const tone = field.hedged ? " hedged" : "";
  return field.values
    .map(
      (value) =>
        `<div class="v${tone}">${lineSpans(value.text)}${
          value.note ? lineSpans(value.note, "n") : ""
        }</div>`,
    )
    .join("");
}

/** A field as table rows. A repeating block gets one row per entry, so a page can break between two jobs. */
function renderField(field: PrintField): string {
  const label = `<th${field.sentence ? ' class="s"' : ""} dir="auto">${escapeHtml(field.label)}</th>`;
  if (field.entries.length === 0) return `<tr>${label}<td>${renderValues(field)}</td></tr>`;
  return field.entries
    .map((lines, index) => {
      const body = lines
        .map(
          (line) =>
            `<span class="ln"><b>${escapeHtml(line.label)}:</b> <span class="pl" dir="auto">${escapeHtml(line.text)}</span></span>`,
        )
        .join("");
      return `<tr>${index === 0 ? label : "<th></th>"}<td><div class="entry">${body}</div></td></tr>`;
    })
    .join("");
}

function renderBlock(block: PrintBlock): string {
  switch (block.kind) {
    case "fields":
      return `${
        block.heading
          ? `<h3><span>${escapeHtml(block.heading)}</span>${block.count === null ? "" : `<span>${block.count}</span>`}</h3>`
          : ""
      }<table><tbody>${block.fields.map(renderField).join("")}</tbody></table>`;
    case "items":
      return `<ul class="items">${block.items
        .map(
          (item) =>
            `<li><span class="t" dir="auto">${escapeHtml(item.title)}</span>${item.lines
              .map((line) => lineSpans(line, "l"))
              .join("")}</li>`,
        )
        .join("")}</ul>`;
    case "events":
      return `<ol class="events">${block.events
        .map(
          (event) =>
            `<li><span class="t" dir="auto">${escapeHtml(event.title)}</span>${
              event.detail ? lineSpans(event.detail, "l") : ""
            }<span class="at">${escapeHtml(event.at)}</span></li>`,
        )
        .join("")}</ol>`;
    case "notes":
      return `<ul class="notes">${block.notes
        .map(
          (note) =>
            `<li><span class="t" dir="auto">${escapeHtml(note.author)}${
              note.role ? ` <i>${escapeHtml(note.role)}</i>` : ""
            }</span><span class="at">${escapeHtml(note.at)}</span>${
              note.body.length > 0 ? `<span class="body">${note.body.map((line) => lineSpans(line)).join("")}</span>` : ""
            }</li>`,
        )
        .join("")}</ul>`;
    case "text":
      return block.lines.map((line) => `<p class="para" dir="auto">${escapeHtml(line)}</p>`).join("");
    case "say":
      return `<p class="say${block.problem ? " say--problem" : ""}" dir="auto">${escapeHtml(block.text)}</p>`;
  }
}

/** The sheet's content, without a document around it — what the print page drops into its own. */
export function buildCandidateRecordBodyHtml(record: CandidateRecordPrint, markDataUri: string | null): string {
  const notices = record.notices
    .map(
      (notice) =>
        `<div class="notice"><strong dir="auto">${escapeHtml(notice.text)}</strong>${
          notice.footnote ? `<span>${escapeHtml(notice.footnote)}</span>` : ""
        }</div>`,
    )
    .join("");

  const sections = record.sections
    .map(
      (section) =>
        `<section><h2><span>${escapeHtml(section.title)}</span>${
          section.aside ? `<span class="aside" dir="auto">${escapeHtml(section.aside)}</span>` : ""
        }</h2>${section.blocks.map(renderBlock).join("")}</section>`,
    )
    .join("");

  return `<div class="rec">
  <header class="lh">
    <div class="lh__mark">${markDataUri ? `<img src="${markDataUri}" alt="">` : ""}</div>
    <div class="lh__id"><strong>Sato Pharma</strong><span dir="ltr">Recruitment · Candidate record</span></div>
  </header>
  <div class="lh__rule"></div>
  <p class="eyebrow">Candidate record</p>
  <h1 dir="auto">${escapeHtml(record.name)}</h1>
  <p class="sub" dir="auto">${escapeHtml(record.subtitle)}</p>
  <p class="printed">${escapeHtml(`${HOUSE_DOCUMENT_STANDARD} · ${record.printedLabel}`)}</p>
  ${notices}
  ${sections}
</div>`;
}

/** The sheet as a whole document — what a headless browser prints, and what the tests read. */
export function buildCandidateRecordDocumentHtml(record: CandidateRecordPrint, markDataUri: string | null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(`${record.name} — candidate record`)}</title>
<style>${candidateRecordPrintCss(record.printedLabel)}</style></head>
<body>${buildCandidateRecordBodyHtml(record, markDataUri)}</body></html>`;
}
