"use client";

/**
 * Phoenix CRM — the third tab of Place checks: the SAME place validated by more than one rep, side by
 * side (owner, 2026-10-17: "a place validated by more than a rep … put the validations beside each other
 * and show me insights and show me data to be able to know which one is the most accurate and which one
 * is not … if you are in doubt of a place, ask — but not every place; what is clear and confident, put it
 * direct … I'm talking here about the admin only").
 *
 * Four things on one tab, in the order they are read:
 *   1. the figures across every place that two or more reps validated;
 *   2. how each rep's validations compare with the others' — the table that answers "who is accurate";
 *   3. the questions the system could not settle by itself (the owner's "fourth step"): two readings in
 *      the middle band are put to him as "same place or different places", and his answer is kept so
 *      nothing is asked twice;
 *   4. every place the system IS confident about, drawn with its validations next to each other, best
 *      first, with the numbers that rank them.
 *
 * 🔴 THE SUPER ADMIN'S ALONE. The board never renders in `mode="team"` — the route refuses everyone else,
 * and the tab is not drawn for a district manager at all, because it would set a colleague's work beside
 * theirs.
 *
 * 🔴 LAZY, AND KEPT. The read pages through every validated place and polyclinic (several seconds), which
 * the other two tabs never need, so it starts when the tab is first opened, and the board stays mounted
 * afterwards so switching tabs does not read it again.
 *
 * 🔴 THE SHARED FILTER BAR NARROWS IT WITHOUT SPLITTING A COMPARISON: a place stays whole when ANY of its
 * validations passes, so filtering on one rep still shows the others' readings beside theirs. The outcome
 * selector means nothing here and is not read.
 *
 * Square corners and no horizontal scroll: the per-rep table is a fixed-layout `CrmTable` on a desktop
 * and cards on a phone, and the side-by-side readings are a grid that stacks.
 */

import { useMemo, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { crmPost, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { PLACE_CHECK_WAITING_FOR_ADMIN, usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { countText } from "@/components/phoenix-crm/format";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import {
  CrmButton,
  CrmChoice,
  CrmCardsOnPhone,
  CrmFacts,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPill,
  CrmShowMore,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmTdClassName,
  crmThClassName,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import {
  accuracySentence,
  answersEachReading,
  insightsOf,
  MAX_ANSWER_PAIRS,
  MEMBER_FLAG_TEXT,
  questionSignature,
  splitAnswerPairs,
  type AnsweredDifferent,
  type MatchAnswer,
  type MatchGroup,
  type MatchMember,
  type MatchQuestion,
  type MatchRepAccuracy,
  type MatchSubject,
  type MemberFlag,
  type PlaceMatchBoard,
  type QuestionReading,
} from "@/lib/phoenix-crm/place-match-groups";
import {
  matchesSharedPlaceFilters,
  matchesValidationReviewFilters,
  validationReviewPeriodCutoff,
  withinValidationReviewPeriod,
  type ValidationReviewFilters,
} from "@/lib/phoenix-crm/validation-review-filters";

const ROUTE = "/api/phoenix-crm/validation-reviews/same-place";

/** A board and whether its read stopped at a ceiling, as the route answers it. */
type BoardView = PlaceMatchBoard & { capped: boolean };

type Answer = "same" | "different" | "forget";

/** How many of a place's validations are drawn before "Show more" — the live data has groups of 21. */
const MEMBERS_SHOWN = 6;
const QUESTIONS_PAGE = 10;
const GROUPS_PAGE = 20;
const ANSWERED_PAGE = 10;

const FLAG_TONE: Record<MemberFlag, PillTone> = {
  most_accurate: "good",
  outlier: "warn",
  weak_gps: "warn",
  moved_pin: "warn",
  sign_other_name: "bad",
  sign_no_name: "warn",
};

function meters(value: number | null | undefined): string {
  return value === null || value === undefined ? "Not reported" : `${countText(Math.round(value))} m`;
}

/** The sentence for what the system read on a sign, in the voice of the thing it was judged against. */
function signText(subject: MatchSubject): { tone: PillTone; text: string } {
  const named = subject.kind === "venue" ? "this building" : "the customer";
  switch (subject.signboard) {
    case "match":
      return { tone: "good", text: `The sign names ${named}` };
    case "other_name":
      return { tone: "bad", text: "The sign names somebody else" };
    case "no_name":
      return { tone: "warn", text: "The sign names nobody" };
    case "unjudged":
      return { tone: "neutral", text: "The sign could not be read" };
    default:
      return { tone: "neutral", text: "The sign has not been read yet" };
  }
}

// ── The shared filters, applied to a place by any of its validations ─────────────────────────────

function subjectPasses(subject: MatchSubject, filters: ValidationReviewFilters, cutoff: number | null): boolean {
  if (!withinValidationReviewPeriod(subject.capturedAt, cutoff)) return false;
  // A venue is on nobody's list, so the List filter does not reach it (the polyclinics tab's own rule).
  if (subject.kind === "venue") {
    return matchesSharedPlaceFilters(
      {
        name: subject.title,
        repName: subject.repName,
        line: subject.line,
        region: subject.region,
        territory: subject.territory,
        address: subject.address,
        brickName: subject.brickName,
        areaName: subject.areaName,
      },
      filters,
    );
  }
  // One customer folded from several lines passes on any of his reps and lines.
  const records = [{ repName: subject.repName, line: subject.line, territory: subject.territory }, ...(subject.sameCustomer ?? [])];
  return records.some((record) => matchesValidationReviewFilters(
    {
      repName: record.repName,
      line: record.line,
      region: subject.region,
      listType: subject.listType,
      customerName: subject.title,
      territory: record.territory,
      speciality: subject.speciality,
      placeLabel: null,
      address: subject.address,
      brickName: subject.brickName,
      areaName: subject.areaName,
    },
    filters,
  ));
}

function anyPasses(subjects: ReadonlyArray<MatchSubject>, filters: ValidationReviewFilters, cutoff: number | null): boolean {
  return subjects.some((subject) => subjectPasses(subject, filters, cutoff));
}

// ── One validation, drawn the same way everywhere ────────────────────────────────────────────────

function Reading({ subject }: { subject: MatchSubject }) {
  const sign = signText(subject);
  return (
    <div className="flex min-w-0 gap-3">
      <div className="w-20 shrink-0">
        <CrmPhotoThumb alt={`Sign photo: ${subject.title}, validated by ${subject.repName}`} className="h-20 w-20" lazy path={subject.photoPath} rotatable />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="break-words text-sm font-black text-slate-950">{subject.title}</p>
        <p className="break-words text-xs font-semibold text-slate-700">
          {subject.repName} · {subject.territory}
          {subject.sameCustomer && subject.sameCustomer.length > 0 && subject.line ? ` · ${subject.line}` : ""}
        </p>
        {(subject.sameCustomer ?? []).map((record) => (
          <p className="break-words text-xs font-semibold text-slate-700" key={record.key}>
            The same customer{record.line ? ` on ${record.line}` : ""}: {record.repName} · {record.territory}
          </p>
        ))}
        <p className="break-words text-xs text-slate-500">
          {[subject.subtitle, subject.kind === "venue" && subject.seated > 0 ? `${countText(subject.seated)} seated` : null, subject.capturedAtText]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join(" · ")}
        </p>
        <div className="flex min-w-0 flex-wrap gap-1">
          <CrmPill tone={sign.tone}>{sign.text}</CrmPill>
          {subject.waiting ? <CrmPill tone="warn">Waiting for a decision</CrmPill> : null}
          {subject.sameCustomer && subject.sameCustomer.length > 0 ? (
            <CrmPill tone="neutral">One customer · {subject.sameCustomer.length + 1} lines</CrmPill>
          ) : null}
        </div>
        {subject.address ? <p className="break-words text-xs text-slate-500">{subject.address}</p> : null}
      </div>
    </div>
  );
}

function MemberCard({ member }: { member: MatchMember }) {
  const best = member.flags.includes("most_accurate");
  return (
    <div className={`min-w-0 space-y-3 border border-l-[3px] border-slate-200 bg-white p-3 ${best ? "border-l-emerald-500" : ""}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="inline-flex min-h-6 min-w-6 items-center justify-center border border-slate-300 bg-slate-50 px-1.5 text-xs font-black text-slate-700">
          #{member.rank}
        </span>
        {member.flags.map((flag) => (
          <CrmPill key={flag} tone={FLAG_TONE[flag]}>
            {MEMBER_FLAG_TEXT[flag]}
          </CrmPill>
        ))}
      </div>
      <Reading subject={member} />
      <CrmFacts
        facts={[
          { label: "Phone accuracy", value: member.accuracyMeters === null ? "Not reported" : `about ${meters(member.accuracyMeters)}` },
          { label: "Pin vs photo", value: member.pinGapMeters === null ? "One reading only" : meters(member.pinGapMeters) },
          { label: "Nearest other rep", value: member.nearestOtherMeters === null ? "None" : meters(member.nearestOtherMeters) },
          { label: "Likely error", value: `about ${meters(member.likelyErrorMeters)}` },
        ]}
      />
    </div>
  );
}

// ── Step 4: the questions ────────────────────────────────────────────────────────────────────────

type SplitPairs = { same: Array<[string, string]>; different: Array<[string, string]> };

/**
 * One side of a question. Every reading says how far it sits from the nearest reading on the other side,
 * and a side of several says how far apart all of its readings are, the counted ones included (owner,
 * 2026-11-17: "tell me the diff in m between what we are checking"). While he answers reading by reading
 * every reading is drawn, the ones counted as "and N more" too, and each on a side of several carries its
 * own "Same place" / "A different place" choice; a side of one is what the others are compared with.
 */
function QuestionSide({
  busy,
  choosing,
  hidden,
  label,
  marks,
  onMark,
  spreadMeters,
  subjects,
}: {
  busy: boolean;
  choosing: boolean;
  hidden: QuestionReading[];
  label: string;
  marks: Readonly<Record<string, MatchAnswer | undefined>>;
  onMark: (key: string, mark: MatchAnswer) => void;
  spreadMeters: number;
  subjects: QuestionReading[];
}) {
  const all = [...subjects, ...hidden];
  const drawn = choosing ? all : subjects;
  const several = all.length > 1;
  return (
    <div className="min-w-0 space-y-3 border border-slate-200 bg-slate-50/60 p-3">
      <p className="break-words text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      {several ? (
        <p className="break-words text-xs font-semibold text-slate-600">
          The {countText(all.length)} readings on this side are up to {meters(spreadMeters)} apart
        </p>
      ) : null}
      {drawn.map((subject) => (
        <div key={subject.key} className="min-w-0 space-y-2">
          <Reading subject={subject} />
          <p className="break-words text-xs font-black text-slate-800">{meters(subject.otherSideMeters)} from the nearest reading on the other side</p>
          {choosing && several ? (
            <CrmChoice
              columns={2}
              label={`Is ${subject.title}, validated by ${subject.repName}, the same place as the other side?`}
              onChange={(next) => onMark(subject.key, next)}
              options={[
                { value: "same", label: "Same place", disabled: busy },
                { value: "different", label: "A different place", disabled: busy },
              ]}
              value={marks[subject.key] ?? null}
            />
          ) : null}
        </div>
      ))}
      {!choosing && hidden.length > 0 ? (
        <p className="break-words text-xs font-semibold text-slate-500">
          and {countText(hidden.length)} more validation{hidden.length === 1 ? "" : "s"} beside these
        </p>
      ) : null}
      {choosing && !several ? <p className="break-words text-xs font-semibold text-slate-500">The readings on the other side are each compared with this one.</p> : null}
    </div>
  );
}

function QuestionCard({
  busy,
  onAnswer,
  onSplit,
  question,
}: {
  busy: boolean;
  onAnswer: (answer: Answer, pairs: ReadonlyArray<[string, string]>) => void;
  onSplit: (pairs: SplitPairs) => void;
  question: MatchQuestion;
}) {
  const names = `${question.left[0]?.title ?? "one side"} and ${question.right[0]?.title ?? "the other side"}`;
  // Answering reading by reading (owner, 2026-11-17: "i want to accept 1 and reject 1"): offered only when
  // a side holds several readings, since a question of one reading a side has nothing to split, and only
  // when every pair across fits in the one request the answer is saved in.
  const [choosing, setChoosing] = useState(false);
  const [marks, setMarks] = useState<Record<string, MatchAnswer | undefined>>({});
  const split = choosing ? splitAnswerPairs(question, marks) : null;
  const mark = (key: string, value: MatchAnswer) => setMarks((current) => ({ ...current, [key]: value }));
  const stopChoosing = () => {
    setChoosing(false);
    setMarks({});
  };
  return (
    <div className="min-w-0 space-y-3 border-t border-slate-100 px-4 py-4 first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CrmPill tone="warn">Not sure</CrmPill>
        {question.sameName ? <CrmPill tone="info">The same customer name is on both sides</CrmPill> : null}
        <span className="break-words text-xs font-semibold text-slate-600">The closest two readings are {meters(question.closestMeters)} apart</span>
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <QuestionSide
          busy={busy}
          choosing={choosing}
          hidden={question.leftMore}
          label="One side"
          marks={marks}
          onMark={mark}
          spreadMeters={question.leftSpreadMeters}
          subjects={question.left}
        />
        <QuestionSide
          busy={busy}
          choosing={choosing}
          hidden={question.rightMore}
          label="The other side"
          marks={marks}
          onMark={mark}
          spreadMeters={question.rightSpreadMeters}
          subjects={question.right}
        />
      </div>
      {choosing ? (
        <div aria-busy={busy || undefined} aria-label={`Answer each reading: ${names}`} className="flex min-w-0 flex-wrap items-center gap-2" role="group">
          <span className="break-words text-sm font-black text-slate-800">Choose for each reading, then save.</span>
          <CrmButton disabled={busy || split === null} onClick={() => split && onSplit(split)} size="sm" variant="primary">
            Save these answers
          </CrmButton>
          <CrmButton disabled={busy} onClick={stopChoosing} size="sm" variant="ghost">
            Cancel
          </CrmButton>
        </div>
      ) : (
        <div aria-busy={busy || undefined} aria-label={`Are these the same place: ${names}`} className="flex min-w-0 flex-wrap items-center gap-2" role="group">
          <span className="break-words text-sm font-black text-slate-800">Are these the same place?</span>
          <CrmButton aria-label={`Same place: ${names}`} disabled={busy} onClick={() => onAnswer("same", question.pairs)} size="sm" variant="primary">
            Same place
          </CrmButton>
          <CrmButton aria-label={`Different places: ${names}`} disabled={busy} onClick={() => onAnswer("different", question.pairs)} size="sm">
            Different places
          </CrmButton>
          {answersEachReading(question) ? (
            <CrmButton aria-label={`Answer each reading: ${names}`} disabled={busy} onClick={() => setChoosing(true)} size="sm" variant="ghost">
              Answer each reading
            </CrmButton>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── A place the system is confident about ────────────────────────────────────────────────────────

function GroupCard({ busy, group, onAnswer }: { busy: boolean; group: MatchGroup; onAnswer: (answer: Answer, pairs: ReadonlyArray<[string, string]>) => void }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? group.members : group.members.slice(0, MEMBERS_SHOWN);
  const hidden = group.members.length - shown.length;
  return (
    <div className="min-w-0 space-y-3 border-t-4 border-slate-200 px-4 py-4 first:border-t-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CrmPill tone="neutral">
          {countText(group.seats)} reps · {countText(group.members.length)} validations
        </CrmPill>
        <CrmPill tone="neutral">Readings span {meters(group.spreadMeters)}</CrmPill>
        {group.bestKey === null ? <CrmPill tone="neutral">Too close to call</CrmPill> : null}
        {group.confirmedPairs.length > 0 ? <CrmPill tone="info">Confirmed by you</CrmPill> : null}
        {group.waiting ? <CrmPill tone="warn">Waiting for a decision</CrmPill> : null}
      </div>
      <p className="break-words text-sm font-semibold text-slate-800">{accuracySentence(group)}</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((member) => (
          <MemberCard key={member.key} member={member} />
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {hidden > 0 ? (
          <CrmButton onClick={() => setShowAll(true)} size="sm">
            Show {countText(hidden)} more validation{hidden === 1 ? "" : "s"} of this place
          </CrmButton>
        ) : null}
        {showAll && group.members.length > MEMBERS_SHOWN ? (
          <CrmButton onClick={() => setShowAll(false)} size="sm" variant="ghost">
            Show fewer
          </CrmButton>
        ) : null}
        {group.confirmedPairs.length > 0 ? (
          <CrmButton disabled={busy} onClick={() => onAnswer("forget", group.confirmedPairs)} size="sm" variant="ghost">
            Take my answer back
          </CrmButton>
        ) : null}
      </div>
    </div>
  );
}

// ── What was answered "different" ────────────────────────────────────────────────────────────────

function AnsweredCard({ busy, entry, onAnswer }: { busy: boolean; entry: AnsweredDifferent; onAnswer: (answer: Answer, pairs: ReadonlyArray<[string, string]>) => void }) {
  // One rep's own two readings are never put to him as a question (answering reading by reading is what
  // writes such a pair), so taking it back cannot ask again: it lets the system place them on distance.
  const oneRep = entry.left.seatId === entry.right.seatId;
  return (
    <div className="min-w-0 space-y-3 border-t border-slate-100 px-4 py-4 first:border-t-0">
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <Reading subject={entry.left} />
        <Reading subject={entry.right} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-words text-xs font-semibold text-slate-600">
          {meters(entry.meters)} apart, answered as different places
          {oneRep ? ". Both are one rep's readings, so the system never asks about them: taking this back lets it group them by distance again." : ""}
        </span>
        <CrmButton disabled={busy} onClick={() => onAnswer("forget", entry.pairs)} size="sm" variant="ghost">
          {oneRep ? "Take my answer back" : "Ask me again"}
        </CrmButton>
      </div>
    </div>
  );
}

// ── Who is accurate ──────────────────────────────────────────────────────────────────────────────

function signsText(rep: MatchRepAccuracy): string {
  return rep.signsRead === 0 ? "None read" : `${countText(rep.signsMatching)} of ${countText(rep.signsRead)}`;
}

function RepRows({ reps }: { reps: MatchRepAccuracy[] }) {
  return (
    <>
      <CrmCardsOnPhone>
        {reps.map((rep) => (
          <div key={rep.seatId} className="space-y-2 px-4 py-3">
            <p className="break-words text-sm font-black text-slate-950">{rep.repName}</p>
            <p className="break-words text-xs text-slate-500">{rep.territory}</p>
            <CrmFacts
              facts={[
                { label: "Places compared", value: countText(rep.groups) },
                { label: "Nearest other rep", value: rep.medianNearestOtherMeters === null ? "None" : meters(rep.medianNearestOtherMeters) },
                { label: "Phone accuracy", value: meters(rep.medianReportedMeters) },
                { label: "Pin vs photo", value: rep.medianPinGapMeters === null ? "One reading only" : meters(rep.medianPinGapMeters) },
                { label: "Most accurate on", value: `${countText(rep.mostAccurate)} of ${countText(rep.groups)}` },
                { label: "Far from every other rep", value: countText(rep.outliers) },
                { label: "Signs matching", value: signsText(rep) },
              ]}
            />
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["27%", "14%", "19%", "22%", "18%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Rep</th>
            <th className={crmThClassName}>Places</th>
            <th className={crmThClassName}>Nearest other rep</th>
            <th className={crmThClassName}>Phone accuracy · pin vs photo</th>
            <th className={crmThClassName}>Most accurate · far off</th>
          </tr>
        </thead>
        <tbody>
          {reps.map((rep) => (
            <tr key={rep.seatId}>
              <td className={crmTdClassName}>
                <p className="font-black text-slate-950">{rep.repName}</p>
                <p className="text-xs font-medium text-slate-500">{rep.territory}</p>
              </td>
              <td className={crmTdClassName}>
                {countText(rep.groups)}
                <p className="text-xs font-medium text-slate-500">{countText(rep.validations)} validations</p>
              </td>
              <td className={crmTdClassName}>{rep.medianNearestOtherMeters === null ? "None" : meters(rep.medianNearestOtherMeters)}</td>
              <td className={crmTdClassName}>
                {meters(rep.medianReportedMeters)}
                <p className="text-xs font-medium text-slate-500">{rep.medianPinGapMeters === null ? "One reading only" : meters(rep.medianPinGapMeters)}</p>
              </td>
              <td className={crmTdClassName}>
                {countText(rep.mostAccurate)} of {countText(rep.groups)}
                <p className="text-xs font-medium text-slate-500">{countText(rep.outliers)} far off</p>
                <p className="text-xs font-medium text-slate-500">{signsText(rep)} signs matching</p>
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </>
  );
}

// ── The tab ──────────────────────────────────────────────────────────────────────────────────────

export function PlaceMatchBoardView({ filters }: { filters: ValidationReviewFilters }) {
  // 🔴 AN ANSWER HERE IS A DECISION, THE SUPER ADMIN'S ALONE (owner, 2026-11-19): the SFE Manager reads the
  // groups and the questions, and every answer button stays shut for him (the route refuses him too).
  const decides = usePlaceCheckDecides();
  const resource = useCrmGet<BoardView>(ROUTE, "board");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A question he has just answered leaves the screen at once; the reload that follows confirms it.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [questionsShown, setQuestionsShown] = useState(QUESTIONS_PAGE);
  const [groupsShown, setGroupsShown] = useState(GROUPS_PAGE);
  const [answeredShown, setAnsweredShown] = useState(ANSWERED_PAGE);

  const board = resource.data;
  const cutoff = useMemo(() => validationReviewPeriodCutoff(filters.period), [filters.period]);
  const groups = useMemo(() => (board ? board.groups.filter((group) => anyPasses(group.members, filters, cutoff)) : []), [board, filters, cutoff]);
  const questions = useMemo(
    () => (board ? board.questions.filter((question) => !answered.has(questionSignature(question)) && anyPasses([...question.left, ...question.right], filters, cutoff)) : []),
    [board, filters, cutoff, answered],
  );
  const answeredDifferent = useMemo(
    () => (board ? board.answeredDifferent.filter((entry) => anyPasses([entry.left, entry.right], filters, cutoff)) : []),
    [board, filters, cutoff],
  );
  const insights = useMemo(() => insightsOf(groups), [groups]);

  if (!board) {
    return resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Comparing every validation" />;
  }

  const send = async (answer: Answer, pairs: ReadonlyArray<[string, string]>, questionId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      // The route takes a bounded number of pairs a request; a bigger question goes in several.
      for (let index = 0; index < pairs.length; index += MAX_ANSWER_PAIRS) {
        await crmPost<unknown>(ROUTE, { answer, pairs: pairs.slice(index, index + MAX_ANSWER_PAIRS) }, "saved");
      }
      if (answer === "forget") setAnswered(new Set());
      else if (questionId) setAnswered((current) => new Set(current).add(questionId));
      resource.reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  // His answer reading by reading: both kinds go in ONE request, so a half-saved answer cannot leave one
  // reading confirmed and its neighbour still asked. A card draws three readings a side, nine pairs at most.
  const sendSplit = async (split: SplitPairs, questionId: string) => {
    setBusy(true);
    setError(null);
    try {
      await crmPost<unknown>(ROUTE, { answer: "split", same: split.same, different: split.different }, "saved");
      setAnswered((current) => new Set(current).add(questionId));
      resource.reload();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || resource.loading || !decides;
  const anyFilter =
    filters.rep !== "" || filters.line !== "" || filters.region !== "" || filters.area !== "" || filters.list !== "" || filters.period !== "all" || filters.text.trim() !== "";

  return (
    <div className="space-y-5">
      {board.capped ? (
        <AdminCallout tone="warning">
          <span>This tab is comparing the newest validations only: there are more than it can hold in one read.</span>
        </AdminCallout>
      ) : null}
      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}
      {decides ? null : <CrmNote tone="neutral">{PLACE_CHECK_WAITING_FOR_ADMIN}: the answers on this tab are the administrator&apos;s.</CrmNote>}

      <CrmStatGrid>
        <CrmStat label="Places several reps validated" note="Two or more reps, confidently the same place" value={countText(insights.groups)} />
        <CrmStat label="Validations compared" note={`by ${countText(insights.reps)} reps`} value={countText(insights.validations)} />
        <CrmStat label="Waiting for your answer" note="Readings the system is not sure about" tone={questions.length > 0 ? "warn" : "neutral"} value={countText(questions.length)} />
        <CrmStat label="Typical spread" note="Between one place's readings" value={insights.medianSpreadMeters === null ? "None" : `${countText(insights.medianSpreadMeters)} m`} />
        <CrmStat label="With a far-off reading" note="One rep well away from the others" tone={insights.withOutlier > 0 ? "warn" : "neutral"} value={countText(insights.withOutlier)} />
        <CrmStat label="Too close to call" note="No reading clearly beats the rest" value={countText(insights.tooCloseToCall)} />
        <CrmStat label="Confirmed by you" note="Places you said are one" value={countText(insights.confirmed)} />
        <CrmStat label="Answered different" note="Pairs you said are two places" value={countText(answeredDifferent.length)} />
      </CrmStatGrid>

      <AdminCallout tone="neutral">
        <span className="min-w-0 break-words">
          Readings that sit within about 30 to 60 m of each other — closer for sharp phones, wider for weak ones — are one place and are grouped here with no
          question. Readings clearly apart are never shown. Only the pairs in between are put to you, and an answer is kept so the same pair is never asked
          twice.{anyFilter ? " The filters above narrow this tab; a place stays whole when any of its validations passes." : ""}
        </span>
      </AdminCallout>

      <AdminTableShell
        title={`Who is accurate (${countText(insights.byRep.length)})`}
        description="For each rep, across the places two or more reps validated: how far their validation sits from the nearest validation of the same place by another rep (smaller means the others bear it out), the accuracy their phone reported, how far their pin sits from their own photograph, and how many places they were clearly the most accurate on. Most trustworthy first."
      >
        {insights.byRep.length === 0 ? (
          <div className="px-4 py-4">
            <AdminCallout tone="neutral">
              <span>{anyFilter ? "No rep matches these filters." : "No place has been validated by two reps yet."}</span>
            </AdminCallout>
          </div>
        ) : (
          <RepRows reps={insights.byRep} />
        )}
      </AdminTableShell>

      <AdminTableShell
        title={`Needs your answer (${countText(questions.length)})`}
        description="Two sets of readings close enough that they might be one place and far enough that the system will not decide for you. Look at the sign photographs and the distance, then answer. Customers with different names are never asked about."
      >
        {questions.length === 0 ? (
          <div className="px-4 py-4">
            <AdminCallout tone="success">
              <span>{anyFilter ? "Nothing waiting for your answer matches these filters." : "Nothing is waiting for your answer."}</span>
            </AdminCallout>
          </div>
        ) : (
          <>
            {questions.slice(0, questionsShown).map((question) => (
              <QuestionCard
                key={question.id}
                busy={locked}
                onAnswer={(answer, pairs) => void send(answer, pairs, questionSignature(question))}
                onSplit={(split) => void sendSplit(split, questionSignature(question))}
                question={question}
              />
            ))}
            <CrmShowMore left={questions.length - questionsShown} onMore={() => setQuestionsShown((count) => count + QUESTIONS_PAGE)} page={QUESTIONS_PAGE} />
          </>
        )}
      </AdminTableShell>

      <AdminTableShell
        title={`The same place, several reps (${countText(groups.length)})`}
        description="Every place the system is confident two or more reps validated, with each rep's validation beside the others, the most accurate first. The numbers under each one are what ranks it: the phone's own reported accuracy, how far the pin sits from the photograph, and how far the nearest other rep's validation is. A flag marks a reading that is far from everyone else, a weak signal, a pin that was moved, or a sign that names somebody else."
      >
        {groups.length === 0 ? (
          <div className="px-4 py-4">
            <AdminCallout tone="neutral">
              <span>{anyFilter ? "No place matches these filters." : "No place has been validated by two reps yet."}</span>
            </AdminCallout>
          </div>
        ) : (
          <>
            {groups.slice(0, groupsShown).map((group) => (
              <GroupCard key={group.id} busy={locked} group={group} onAnswer={(answer, pairs) => void send(answer, pairs, null)} />
            ))}
            <CrmShowMore left={groups.length - groupsShown} onMore={() => setGroupsShown((count) => count + GROUPS_PAGE)} page={GROUPS_PAGE} />
          </>
        )}
      </AdminTableShell>

      {answeredDifferent.length > 0 ? (
        <AdminTableShell
          title={`Answered as different places (${countText(answeredDifferent.length)})`}
          description="Pairs you said are two places. They are not asked again; take an answer back here and the pair returns to the questions above."
        >
          {answeredDifferent.slice(0, answeredShown).map((entry) => (
            <AnsweredCard key={entry.id} busy={locked} entry={entry} onAnswer={(answer, pairs) => void send(answer, pairs, null)} />
          ))}
          <CrmShowMore left={answeredDifferent.length - answeredShown} onMore={() => setAnsweredShown((count) => count + ANSWERED_PAGE)} page={ANSWERED_PAGE} />
        </AdminTableShell>
      ) : null}
    </div>
  );
}
