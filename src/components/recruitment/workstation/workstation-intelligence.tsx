"use client";

// Recruitment / ATS — the intelligence panel, beside the CV.
//
// FOUR TABS, and each answers a question a recruiter asks in a different order:
//
//   SUMMARY   — "should I keep reading?"      their WhatsApp answers, snapshot, fit, and a briefing.
//   CV DATA   — "what did the reader find?"   the structured extraction, field by field.
//   TIMELINE  — "what has happened to them?"  every stored event, in order.
//   NOTES     — "what did we say about them?" the existing conversation, added to.
//
// SUMMARY OPENS FIRST because it is the only one that helps decide, and it is arranged in the order
// the decision is actually made: who they are, then how they measure against the seat, then what to
// ask if they get a call. The other three are reference, and they load only when opened.
//
// ── THE TRUST MODEL, WHICH IS THE WHOLE REASON THIS PANEL IS NOT JUST A FIELD DUMP ──────────────
//
// Every value here has a provenance and the panel never hides it. A value a person typed, a value
// the CV reader was confident enough to write into a column, a value it hedged on, and no value at
// all are four different things, and collapsing the middle two is what lets a hedged guess be read
// as settled fact beside a real applicant's name. So: confirmed values render black, hedged ones
// render grey italic with a badge that says so, and an absent one says "not on file" rather than
// leaving a blank a reader fills in themselves.
//
// AND THE FIT NUMBER IS NOT AN AI SCORE. Nothing in this pipeline produces a role-match percentage.
// What is shown is arithmetic over dimensions that a recruiter can check line by line, each naming
// the fact that answered it, and it degrades to "not enough on file" rather than to a low score.

import { useMemo } from "react";
import { Brain, ClipboardList, FileText, Loader2, MessageSquare } from "lucide-react";

import { buildRecruiterBriefing } from "@/lib/recruitment/recruiter-briefing";
import { CandidateFactsSummary } from "@/components/recruitment/candidate-facts-summary";
import { WhatsAppAnswersList } from "@/components/recruitment/whatsapp-answers-list";
import { candidateWhatsAppAnswers, type ScreeningQuestionLabel } from "@/lib/recruitment/whatsapp-answers";
import {
  candidateScreeningFacts,
  unconfirmedCvFactsFromExtraction,
  UNCONFIRMED_FACT_TITLE,
} from "@/lib/recruitment/candidate-screening-facts";
import { CV_FIELD_SECTIONS, getCvPositionSchema, type CvFieldSection } from "@/lib/recruitment/cv-field-schemas";
import {
  CollapsibleSection,
  EmptyNote,
  FitBar,
  PaneHead,
  Pill,
  TrustBadge,
  type TrustLevel,
} from "@/components/recruitment/workstation/workstation-ui";
import { hiringTargetFamily, readRoleFit, roleFitVerdict, roleFitVerdictLabels } from "@/lib/recruitment/role-fit";
import type { Candidate } from "@/lib/recruitment/types";
import {
  listUnappliedCvFields,
  type ExtractedCvValue,
  type StoredCvExtraction,
} from "@/lib/recruitment/cv-extraction-fields";
import { WorkstationNotesTab, WorkstationTimelineTab } from "@/components/recruitment/workstation/workstation-history-tabs";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";

export const intelligenceTabs = ["summary", "cv", "timeline", "notes"] as const;
export type IntelligenceTab = (typeof intelligenceTabs)[number];

const tabLabels: Record<IntelligenceTab, string> = {
  cv: "CV data",
  notes: "Notes",
  summary: "Summary",
  timeline: "Timeline",
};

const tabIcons: Record<IntelligenceTab, React.ReactNode> = {
  cv: <ClipboardList className="h-3.5 w-3.5" />,
  notes: <MessageSquare className="h-3.5 w-3.5" />,
  summary: <Brain className="h-3.5 w-3.5" />,
  timeline: <FileText className="h-3.5 w-3.5" />,
};

export function WorkstationIntelligencePanel({
  appliedForText,
  candidate,
  canWriteNotes,
  extraction,
  loadError,
  loading,
  noteCount,
  onAcceptField,
  onCollapse,
  onNoteCountChange,
  onTabChange,
  screeningQuestions,
  tab,
}: {
  appliedForText: string | null;
  candidate: Candidate | null;
  canWriteNotes: boolean;
  extraction: StoredCvExtraction | null;
  /** The record could not be read. Said as itself, never as an empty panel. */
  loadError: string | null;
  /** A row IS selected and its record is still arriving. */
  loading: boolean;
  noteCount: number;
  /**
   * Write one reader finding onto the record — see CvDataTab for why so many are unwritten.
   * Null when the viewer may not write, so the button is absent rather than answering 403.
   */
  onAcceptField: ((fieldKey: string, value: ExtractedCvValue) => void) | null;
  /** Given, the head grows a fold control. Desktop only — see PaneHead. */
  onCollapse?: () => void;
  onNoteCountChange: (count: number) => void;
  onTabChange: (tab: IntelligenceTab) => void;
  /**
   * The wording of the admin-defined WhatsApp questions, from the profile route, so every answer is
   * printed under the question it answers. Null when it could not be read.
   */
  screeningQuestions: readonly ScreeningQuestionLabel[] | null;
  tab: IntelligenceTab;
}) {
  return (
    // A CARD ON THE COCKPIT'S TRAY (2026-10-19): the soft depth, a full hairline, the dark pane band.
    <div className={`flex h-full min-h-0 w-full flex-col overflow-hidden border border-phx-line bg-white ${adminSoftDepthClassName}`}>
      <PaneHead collapseTo="right" foldLabel="intelligence" onCollapse={onCollapse} title="Candidate intelligence" />
      {/* THE HOUSE TAB BAR, at a pane's size — the same object as the recruitment kit's
          `RecruitmentTabBar`: a recessed tray of square segments, the chosen one lifted onto white
          with the accent rule under it. Kept as pressed buttons rather than the kit's tablist,
          because these four drive the panel below them and screen readers already know them so. */}
      <div className={cn("flex shrink-0 gap-1 border-b border-phx-line bg-phx-surface-2 p-1", adminRecessedDepthClassName)}>
        {intelligenceTabs.map((key) => (
          <button
            /* The label is `hidden sm:inline`, so below the `sm` breakpoint this button is an icon
               and nothing else. Without the name spelled out here a screen reader announces four
               unnamed pressed/unpressed buttons on a phone. */
            aria-label={tabLabels[key]}
            aria-pressed={tab === key}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1 px-1 py-2 text-[11px] font-bold uppercase leading-none tracking-[0.06em] transition-colors",
              tab === key
                ? cn("bg-white text-phx-accent-press", adminChipDepthClassName)
                : "text-phx-ink-faint hover:bg-white/70 hover:text-phx-ink-2",
            )}
            key={key}
            onClick={() => onTabChange(key)}
            type="button"
          >
            {tabIcons[key]}
            <span className="hidden sm:inline">{tabLabels[key]}</span>
            {key === "notes" && noteCount > 0 ? (
              <span
                className={`border border-phx-line bg-phx-paper px-1 text-[10px] tabular-nums text-phx-ink-2 ${adminChipDepthClassName}`}
              >
                {noteCount}
              </span>
            ) : null}
            {tab === key ? <span aria-hidden className="absolute inset-x-1.5 bottom-0 h-0.5 bg-phx-accent" /> : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!candidate ? (
          /* THREE ANSWERS, NEVER ONE. "Pick a candidate" under a header that is already showing a
             candidate's name reads as "you did nothing" when the truth is "the record is still
             arriving" — and it read exactly that way on first paint, measured 2026-09-04. An empty
             panel must say which of the three is true. */
          loadError ? (
            <p className="px-3 py-4 text-[13px] leading-relaxed text-phx-danger">{loadError}</p>
          ) : loading ? (
            <p className="flex items-center gap-2 px-3 py-4 text-[13px] text-phx-ink-soft">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Reading the record…
            </p>
          ) : (
            <EmptyNote icon={<Brain aria-hidden className="h-5 w-5" />} title="No candidate open">
              Pick a candidate from the list to read their record.
            </EmptyNote>
          )
        ) : tab === "summary" ? (
          <SummaryTab
            appliedForText={appliedForText}
            candidate={candidate}
            extraction={extraction}
            screeningQuestions={screeningQuestions}
          />
        ) : tab === "cv" ? (
          <CvDataTab candidate={candidate} extraction={extraction} onAccept={onAcceptField} />
        ) : tab === "timeline" ? (
          <WorkstationTimelineTab candidateId={candidate.id} />
        ) : (
          <WorkstationNotesTab canWrite={canWriteNotes} candidateId={candidate.id} onCountChange={onNoteCountChange} />
        )}
      </div>
    </div>
  );
}

function SummaryTab({
  appliedForText,
  candidate,
  extraction,
  screeningQuestions,
}: {
  appliedForText: string | null;
  candidate: Candidate;
  extraction: StoredCvExtraction | null;
  screeningQuestions: readonly ScreeningQuestionLabel[] | null;
}) {
  const facts = useMemo(
    () =>
      candidateScreeningFacts({
        ...candidate,
        cvUnconfirmed: unconfirmedCvFactsFromExtraction(extraction?.fields),
      }),
    [candidate, extraction],
  );

  // Against the SEAT, never against their own current title. `hiringTargetFamily` is what enforces
  // that order, and the dimensions below say out loud which job they were read against.
  const family = useMemo(() => hiringTargetFamily(appliedForText, facts), [appliedForText, facts]);
  const fit = useMemo(() => readRoleFit(facts, family, appliedForText), [appliedForText, facts, family]);
  const briefing = useMemo(() => buildRecruiterBriefing(facts, fit, family), [facts, fit, family]);
  const answers = useMemo(
    () => candidateWhatsAppAnswers(candidate, screeningQuestions),
    [candidate, screeningQuestions],
  );

  return (
    <div className="pb-4">
      {/* EVERY BLOCK FOLDS, and the fold is keyed to the BLOCK, not to the candidate — a recruiter
          who has closed the snapshot because they only care about role fit today keeps it closed all
          the way down the list, instead of re-closing it on every person. */}
      {/* THEIR ANSWERS COME FIRST. The owner, 2026-09-11: applicants on WhatsApp are asked many
          questions — salary and much else — and he wants to read every answer while he reads the CV.
          They are the one thing on this panel only the applicant could have told us, yet they sat
          under the CV facts inside the snapshot, and the admin-defined questions were missing from
          screening altogether. The count survives the fold. */}
      <CollapsibleSection
        right={answers.length === 0 ? "none" : `${answers.length}`}
        storageKey="summary:whatsapp"
        title="Answers on WhatsApp"
      >
        {answers.length === 0 ? (
          <p className="px-3 py-2 text-[12px] leading-relaxed text-phx-ink-soft">
            No WhatsApp answers are on this record.
          </p>
        ) : (
          <WhatsAppAnswersList answers={answers} frame="flat" />
        )}
      </CollapsibleSection>

      <CollapsibleSection storageKey="summary:snapshot" title="Candidate snapshot">
        {/* The EXISTING summary component, not a second copy of it. It already resolves the confirmed
            and hedged tiers with one convention, and forking it here is how the two screens would
            start disagreeing about the same person. */}
        <CandidateFactsSummary
          candidate={candidate}
          className="px-3 py-2"
          columns={1}
          extraction={extraction}
          frame="flat"
          screeningQuestions={screeningQuestions}
          // The degree rule, gender, age and military service — printed for EVERY candidate, with
          // "not on file" where nothing is known. These are the four the owner opened all 17 CVs to
          // find while screening one vacant seat, and screening is the screen that needs them.
          showScreeningChecks
          // Already the section above. Printing them inside the snapshot too would put the same
          // answers in this panel twice.
          showWhatsAppAnswers={false}
        />
      </CollapsibleSection>

      <CollapsibleSection
        // FOLDED UNTIL ASKED FOR, and it is the headline above that makes that affordable: the score
        // and the verdict stay on the closed bar, so the question this panel is opened to answer —
        // is this one worth my time — is still answered at a glance, while the fourteen check lines
        // behind it wait for the reader who wants to argue with the number. The fold is remembered
        // per reader, so opening it once keeps it open all the way down the list.
        defaultOpen={false}
        // The headline survives the fold: a score and a verdict, so "is this one worth opening" is
        // answerable with every section shut.
        right={
          <span className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-black tabular-nums text-phx-ink">
              {fit.score === null ? "—" : fit.score}
            </span>
            <span className="font-bold text-phx-ink-2">{roleFitVerdictLabels[roleFitVerdict(fit.score)]}</span>
          </span>
        }
        storageKey="summary:fit"
        title={`Role fit · ${fit.roleLabel}`}
      >
        <div className="px-3 py-2">
          {fit.unknownCount > 0 ? (
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-phx-ink-faint">
              {fit.unknownCount} unanswered
            </p>
          ) : null}
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-black leading-none tabular-nums text-phx-ink">
              {fit.score === null ? "—" : fit.score}
            </span>
            <span className="text-[12px] font-bold text-phx-ink-2">{roleFitVerdictLabels[roleFitVerdict(fit.score)]}</span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-phx-ink-soft">
            {fit.score === null
              ? "Too little is on file to read a fit. That is not a low score — it is no score, and the checks below say which answers are missing."
              : "How many of the checks for this job the record answers. Not an AI score — every line below names the fact behind it."}
          </p>

          <ul className="mt-2 space-y-2">
            {fit.dimensions.map((dimension) => (
              <li key={dimension.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-bold text-phx-ink">{dimension.label}</span>
                  <span
                    className={cn(
                      "shrink-0 text-[11px] font-bold uppercase tracking-[0.04em]",
                      dimension.state === "met"
                        ? "text-phx-ok"
                        : dimension.state === "partial"
                          ? "text-phx-warn"
                          : dimension.state === "missing"
                            ? "text-phx-danger"
                            : "text-phx-ink-faint",
                    )}
                  >
                    {dimension.state === "unknown" ? "Not on file" : dimension.state}
                  </span>
                </div>
                <div className="mt-1">
                  <FitBar state={dimension.state} />
                </div>
                {dimension.evidence ? (
                  <p
                    className={cn(
                      "mt-0.5 break-words text-[11px] leading-tight",
                      dimension.confirmed ? "text-phx-ink-soft" : "italic text-phx-ink-faint",
                    )}
                    title={dimension.confirmed ? undefined : UNCONFIRMED_FACT_TITLE}
                  >
                    {dimension.evidence}
                    {dimension.confirmed ? "" : " ?"}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </CollapsibleSection>

      {/* ALSO FOLDED. Every line of the briefing is composed from facts printed above it — it is a
          reading of the record, not new information — so it is the right thing to have to ask for.
          The counts stay on the closed bar so a record with real gaps still says so. */}
      <CollapsibleSection
        defaultOpen={false}
        right={`${briefing.strengths.length} strong · ${briefing.gaps.length} to ask about`}
        storageKey="summary:briefing"
        title="Recruiter briefing"
      >
        <div className="space-y-2 px-3 py-2">
          <BriefingList
            empty="Nothing on the record stands out yet — the CV has not answered enough to say."
            items={briefing.strengths}
            title="Strengths"
            tone="ok"
          />
          <BriefingList
            empty="Nothing on the record is missing against this job."
            items={briefing.gaps}
            title="Gaps and risks"
            tone="warn"
          />
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-phx-ink-soft">Ask them</p>
            {briefing.question ? (
              <p className="mt-1 border-l-2 border-l-phx-accent bg-phx-accent-soft px-2 py-1.5 text-[12px] leading-relaxed text-phx-ink">
                {briefing.question}
              </p>
            ) : (
              <p className="mt-1 text-[12px] leading-relaxed text-phx-ink-soft">
                Nothing on file points at a question worth asking yet.
              </p>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-phx-ink-faint">
            {/* Said plainly. Every line above is composed from a stored fact and names it — none of it
                is a model's opinion about the person, and a recruiter should be able to check any of
                it against the CV on the left in seconds. */}
            Built from what is already on the record. Nothing here is a judgement about the person.
          </p>
        </div>
      </CollapsibleSection>
    </div>
  );
}

function BriefingList({
  empty,
  items,
  title,
  tone,
}: {
  empty: string;
  items: readonly string[];
  title: string;
  tone: "ok" | "warn";
}) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-phx-ink-soft">{title}</p>
      {items.length === 0 ? (
        /* An empty list is an ANSWER, written out. Padding it to three bullets is how a briefing
           starts saying things the record does not support. */
        <p className="mt-1 text-[12px] leading-relaxed text-phx-ink-soft">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li className="flex gap-1.5 text-[12px] leading-relaxed text-phx-ink" key={item}>
              <span aria-hidden className={cn("mt-1.5 h-1.5 w-1.5 shrink-0", tone === "ok" ? "bg-phx-ok" : "bg-phx-warn")} />
              <span className="min-w-0 break-words">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * What the CV reader found, field by field — NOT a JSON dump.
 *
 * Grouped by the same sections the review board uses, labelled with the same words, and every value
 * carries its confidence. A recruiter reading this beside the document should be able to check any
 * line against the page in seconds, which is the only reason to show extracted data at all.
 */
function CvDataTab({
  candidate,
  extraction,
  onAccept,
}: {
  candidate: Candidate | null;
  extraction: StoredCvExtraction | null;
  /** Writes one reader finding onto the record. Null when the viewer may not write. */
  onAccept: ((fieldKey: string, value: ExtractedCvValue) => void) | null;
}) {
  const schema = useMemo(() => getCvPositionSchema(extraction?.positionKey ?? "universal"), [extraction?.positionKey]);

  // WHAT THE READER FOUND AND NOBODY WROTE DOWN.
  //
  // `cv-auto-apply.ts` writes a finding unattended only at high confidence — "the AI's own hedge is
  // respected; low always waits for a human" — and that gate is right. The gap was the other half:
  // for a candidate created by automatic intake there was no screen where a human ever saw the
  // proposal, so `low` waited for a review that never came. Measured on production 2026-09-05: 215
  // candidates carried a perfectly good yearsExperience in the extraction against a null column,
  // and 120 carried a nationalId on a pool holding four in total.
  //
  // So they are offered HERE, to the one person already reading the CV. One rule, shared with the
  // count, so the number and the rows can never disagree.
  const unapplied = useMemo(() => {
    if (!extraction || !schema || !candidate) return new Map<string, ExtractedCvValue>();
    return new Map(
      listUnappliedCvFields(extraction.fields, candidate, schema).map((entry) => [entry.field.key, entry.value]),
    );
  }, [candidate, extraction, schema]);

  const bySection = useMemo(() => {
    const grouped = new Map<CvFieldSection, Array<{ key: string; label: string; level: TrustLevel; value: string }>>();
    if (!extraction || !schema) return grouped;
    for (const field of schema.fields) {
      const stored = extraction.fields[field.key];
      const rendered = renderExtractedValue(stored?.value);
      if (rendered === null) continue;
      const level: TrustLevel =
        stored?.confidence === "low" ? "review" : extraction.reviewed ? "verified" : "extracted";
      const list = grouped.get(field.section) ?? [];
      list.push({ key: field.key, label: field.label, level, value: rendered });
      grouped.set(field.section, list);
    }
    return grouped;
  }, [extraction, schema]);

  if (!extraction) {
    return (
      <EmptyNote>
        No CV has been read for this candidate. The document on the left is still readable — this tab only shows what a
        machine read out of it.
      </EmptyNote>
    );
  }

  const total = [...bySection.values()].reduce((sum, list) => sum + list.length, 0);

  return (
    <div className="pb-4">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        <Pill tone={extraction.reviewed ? "ok" : "info"}>
          {extraction.reviewed ? "Checked by a person" : "Not checked by a person"}
        </Pill>
        {extraction.isCv === false ? <Pill tone="warn">Reader says: not a CV</Pill> : null}
        <span className="text-[11px] text-phx-ink-soft">
          {total} field{total === 1 ? "" : "s"} found
        </span>
      </div>

      {total === 0 ? (
        /* An EMPTY extraction is the designed answer to a document that is not a CV — a certificate,
           a photo, a covering note. It is not a failure to report as one. */
        <EmptyNote>
          The reader found nothing to extract. That is usually what a certificate or a photograph looks like rather than
          a broken read.
        </EmptyNote>
      ) : (
        CV_FIELD_SECTIONS.map((section) => {
          const rows = bySection.get(section.key);
          if (!rows || rows.length === 0) return null;
          return (
            <CollapsibleSection
              key={section.key}
              // Keyed by SECTION rather than by candidate: an "Education" block folded away stays
              // folded for the next fifty CVs, which is the point of folding it at all.
              right={`${rows.length}`}
              storageKey={`cvdata:${section.key}`}
              title={section.label}
            >
              <ul>
                {rows.map((row) => (
                  <li className="border-b border-phx-line/70 px-3 py-1.5 last:border-b-0" key={row.key}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-phx-ink-soft">
                        {row.label}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {/* Says the value is NOT on the record, which is the fact a reader cannot
                            otherwise tell: the tab looks identical whether a finding was saved or
                            silently dropped. */}
                        {unapplied.has(row.key) ? <Pill tone="warn">Not saved to the record</Pill> : null}
                        <TrustBadge level={row.level} />
                      </span>
                    </div>
                    <p
                      className={cn(
                        "mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-[1.45]",
                        row.level === "review" ? "italic text-phx-ink-soft" : "text-phx-ink",
                      )}
                      title={row.level === "review" ? UNCONFIRMED_FACT_TITLE : undefined}
                    >
                      {row.value}
                    </p>
                    {/* One click, on the candidate already open. Never a bulk "apply everything":
                        these are the readings the extractor itself hedged on, so a person confirms
                        them one at a time, looking at the document that produced them. */}
                    {onAccept && unapplied.has(row.key) ? (
                      <button
                        className={`mt-1 border border-phx-accent-line bg-phx-accent-soft px-2 py-0.5 text-[11px] font-bold text-phx-accent-press transition hover:bg-phx-accent hover:text-white ${adminControlDepthClassName}`}
                        onClick={() => onAccept(row.key, unapplied.get(row.key) ?? null)}
                        title="Write this reading onto the candidate record"
                        type="button"
                      >
                        Save this to the record
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CollapsibleSection>
          );
        })
      )}
    </div>
  );
}

/**
 * One extracted value as text, or null when there is nothing to show.
 *
 * The repeating blocks (work history, education, certifications) arrive as arrays of objects. They
 * are rendered as one line per entry with the entry's own values joined — a recruiter reading five
 * jobs wants five lines, and `[object Object]` or a JSON blob is exactly the field dump this tab
 * exists not to be.
 */
function renderExtractedValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (Array.isArray(value)) {
    const lines = value
      .map((entry) => {
        if (entry === null || typeof entry !== "object") return String(entry ?? "").trim();
        return Object.values(entry as Record<string, unknown>)
          .filter((part) => part !== null && part !== undefined && String(part).trim().length > 0)
          .map((part) => String(part).trim())
          .join(" · ");
      })
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines.map((line) => `• ${line}`).join("\n") : null;
  }
  return null;
}
