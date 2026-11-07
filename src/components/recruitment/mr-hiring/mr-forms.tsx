"use client";

// Recruitment / Medical Rep hiring — the three forms of the workflow: a result at a step, the NSM's
// recommendation, and booking the next interview. Every form wears THE ONE FORM DESIGN (form-kit and
// form-tokens). Each submits to its route and the route decides again — a form never decides who may.

import { useEffect, useState } from "react";

import { patchJson, postJson, getJson } from "@/components/recruitment/recruitment-fetch";
import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { CheckTile, FormActions, FormError, FormField, RatingScale } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxCheckTileClassName,
  phxFieldClassName,
  phxFieldGridTwoClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cairoDateKey, cairoMinutesOfDay } from "@/lib/recruitment/interview-calendar-week";
import type { MrRow } from "@/lib/recruitment/mr-hiring/rows";
import type { MrBookingFact } from "@/lib/recruitment/mr-hiring/stage";
import {
  MR_COMMENT_LIMIT,
  MR_LINE_LABELS,
  MR_LINES,
  MR_LOCATION_LIMIT,
  MR_PHONE_CALL_MINUTES,
  MR_RECOMMENDATION_LABELS,
  MR_RESULT_STEP_LABELS,
  MR_RESULTS,
  MR_ROUND_LABELS,
  mrResultLabel,
  type MrAreaChoice,
  type MrInterviewRound,
  type MrLine,
  type MrRecommendation,
  type MrResult,
  type MrResultStep,
} from "@/lib/recruitment/mr-hiring/vocabulary";
import { rejectionReasonLabels, rejectionReasons, type RejectionReason } from "@/lib/recruitment/workspace/vocabulary";
import { cn } from "@/lib/utils";

const RATING_OPTIONS = [1, 2, 3, 4, 5].map((value) => ({ label: String(value), title: `${value} of 5`, value }));

function cairoTodayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ─── A result at one step ─────────────────────────────────────────────────────

export function MrResultForm({
  areaChoices = [],
  candidateId,
  candidateName,
  decidedWithoutDsm = false,
  defaultArea = null,
  defaultLine = null,
  onCancel,
  onDone,
  step,
}: {
  /** The 1st interview only: the areas HR may confirm, region by region. */
  areaChoices?: MrAreaChoice[];
  candidateId: string;
  candidateName: string;
  decidedWithoutDsm?: boolean;
  /** The area the candidate is filed under or asked for — pre-selected when it is on the list. */
  defaultArea?: string | null;
  defaultLine?: MrLine | null;
  onCancel: () => void;
  onDone: () => void;
  step: MrResultStep;
}) {
  const [result, setResult] = useState<MrResult | null>(null);
  const isFirst = step === "hr_first";
  const [area, setArea] = useState(() =>
    defaultArea && areaChoices.some((choice) => choice.areas.includes(defaultArea)) ? defaultArea : "",
  );
  const [line, setLine] = useState<MrLine | null>(defaultLine);
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState<RejectionReason>("other");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDecision = step === "final_decision";
  const isInterview = step !== "hr_screening" && !isDecision;
  const commentLabel =
    step === "dsm" && !decidedWithoutDsm ? "Your feedback" : step === "rsm" ? "Your evaluation" : isDecision ? "Reason for the decision" : "Comment";

  async function submit() {
    if (!result) return setError("Choose one answer.");
    if (!comment.trim()) return setError("Write a short comment — every result carries one.");
    if (isFirst && result === "pass" && !area) return setError("Confirm the area the candidate is applying to.");
    if (isFirst && result === "pass" && !line) return setError("Confirm the line — Pedia, Anti Infective or CNS.");
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/recruitment/mr-hiring/${encodeURIComponent(candidateId)}/result`, {
        comment,
        confirmedArea: isFirst ? area || null : null,
        confirmedLine: isFirst ? line : null,
        decidedWithoutDsm,
        rating: isInterview ? rating : null,
        rejectionReason: step === "hr_screening" && result === "not_pass" ? reason : null,
        result,
        step,
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, "Could not record the result."));
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-600">
          {decidedWithoutDsm ? "Decide without DSM feedback" : MR_RESULT_STEP_LABELS[step]}
        </p>
        <p className="mt-1 break-words text-sm font-bold text-slate-900">{candidateName}</p>
        {decidedWithoutDsm ? (
          <p className="mt-1 text-xs leading-5 text-slate-600">
            The DSM interview has ended and the DSM has not written feedback. HR&apos;s evaluation decides this step, and the
            journey shows it was decided without DSM feedback.
          </p>
        ) : null}
      </div>
      <FormField label="Answer" required>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup">
          {MR_RESULTS.map((value) => (
            <CheckTile checked={result === value} key={value} name="mr-result" onChange={() => setResult(value)} type="radio">
              {mrResultLabel(step, value)}
            </CheckTile>
          ))}
        </div>
      </FormField>
      {isFirst ? (
        <>
          <FormField
            error={areaChoices.length === 0 ? "The area list could not be loaded — close this and open the journey again." : null}
            hint="Pre-filled from the candidate's filing. The DSM interview is booked for this area."
            htmlFor="mr-area"
            label="Area the candidate is applying to"
            required={result === "pass"}
          >
            <select className={phxSelectClassName} id="mr-area" onChange={(event) => setArea(event.target.value)} value={area}>
              <option value="">Choose the area</option>
              {areaChoices.map((choice) => (
                <optgroup key={choice.region} label={choice.region}>
                  {choice.areas.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </FormField>
          <FormField hint="Pedia adds the RSM interview after the DSM's. The other lines go straight to the 3rd interview." label="Line" required={result === "pass"}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup">
              {MR_LINES.map((value) => (
                <CheckTile checked={line === value} key={value} name="mr-line" onChange={() => setLine(value)} type="radio">
                  {MR_LINE_LABELS[value]}
                </CheckTile>
              ))}
            </div>
          </FormField>
        </>
      ) : null}
      {step === "hr_screening" && result === "not_pass" ? (
        <FormField htmlFor="mr-reason" label="Why is the CV rejected?" required>
          <select className={phxSelectClassName} id="mr-reason" onChange={(event) => setReason(event.target.value as RejectionReason)} value={reason}>
            {rejectionReasons.map((value) => (
              <option key={value} value={value}>
                {rejectionReasonLabels[value]}
              </option>
            ))}
          </select>
        </FormField>
      ) : null}
      {isInterview ? (
        <FormField hint="Optional — 1 is weak, 5 is excellent." label="Rating">
          <RatingScale ariaLabel="Rating from 1 to 5" emptyLabel="No rating" onChange={setRating} options={RATING_OPTIONS} value={rating} />
        </FormField>
      ) : null}
      <FormField
        hint="Kept on the candidate's record. Everyone involved in this hire can read it."
        htmlFor="mr-comment"
        label={commentLabel}
        required
      >
        <textarea
          className={phxTextareaClassName}
          id="mr-comment"
          maxLength={MR_COMMENT_LIMIT}
          onChange={(event) => setComment(event.target.value)}
          rows={4}
          value={comment}
        />
      </FormField>
      <FormError>{error}</FormError>
      <FormActions
        left={
          <button className={phxButtonGhostClassName} disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
        }
        right={
          <button className={phxButtonAccentClassName} disabled={busy} type="submit">
            {busy ? "Saving…" : "Save the result"}
          </button>
        }
      />
    </form>
  );
}

// ─── The NSM's recommendation (§8) ────────────────────────────────────────────

export function MrRecommendationForm({
  candidateId,
  candidateName,
  onCancel,
  onDone,
}: {
  candidateId: string;
  candidateName: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [recommendation, setRecommendation] = useState<MrRecommendation | null>(null);
  const [salary, setSalary] = useState("");
  const [joining, setJoining] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(cairoTodayKey);
  const offer = recommendation === "make_offer";

  async function submit() {
    if (!recommendation) return setError("Choose Make an offer or Keep as backup.");
    if (offer && (!salary.trim() || !joining)) return setError("To recommend an offer, give the proposed salary and the proposed joining date.");
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/recruitment/mr-hiring/${encodeURIComponent(candidateId)}/recommendation`, {
        note,
        proposedJoiningDate: joining || null,
        proposedSalary: salary.trim() || null,
        recommendation,
      });
      onDone();
    } catch (caught) {
      setError(errorText(caught, "Could not save the recommendation."));
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-600">Your recommendation</p>
        <p className="mt-1 break-words text-sm font-bold text-slate-900">{candidateName}</p>
        <p className="mt-1 text-xs leading-5 text-slate-600">The HR Manager makes the final decision after reading it.</p>
      </div>
      <FormField label="Recommendation" required>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
          {(Object.keys(MR_RECOMMENDATION_LABELS) as MrRecommendation[]).map((value) => (
            <CheckTile checked={recommendation === value} key={value} name="mr-recommendation" onChange={() => setRecommendation(value)} type="radio">
              {MR_RECOMMENDATION_LABELS[value]}
            </CheckTile>
          ))}
        </div>
      </FormField>
      <div className={phxFieldGridTwoClassName}>
        <FormField
          hint="Seen only by the HR Manager, Talent Acquisition and you — never the DSM."
          htmlFor="mr-salary"
          label="Proposed salary (EGP a month)"
          required={offer}
        >
          <input
            className={phxFieldClassName}
            id="mr-salary"
            inputMode="numeric"
            onChange={(event) => setSalary(event.target.value)}
            placeholder="e.g. 18000"
            value={salary}
          />
        </FormField>
        <FormField htmlFor="mr-joining" label="Proposed joining date" required={offer}>
          <input className={phxFieldClassName} id="mr-joining" min={today} onChange={(event) => setJoining(event.target.value)} type="date" value={joining} />
        </FormField>
      </div>
      <FormField htmlFor="mr-note" label="Note">
        <textarea className={phxTextareaClassName} id="mr-note" maxLength={MR_COMMENT_LIMIT} onChange={(event) => setNote(event.target.value)} rows={3} value={note} />
      </FormField>
      <FormError>{error}</FormError>
      <FormActions
        left={
          <button className={phxButtonGhostClassName} disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
        }
        right={
          <button className={phxButtonAccentClassName} disabled={busy} type="submit">
            {busy ? "Saving…" : "Send the recommendation"}
          </button>
        }
      />
    </form>
  );
}

// ─── Booking the next interview ───────────────────────────────────────────────

type Person = { hrId: string; name: string; jobTitle: string | null };

function PersonPicker({ id, label, onChange, required, value }: { id: string; label: string; onChange: (person: Person | null) => void; required?: boolean; value: Person | null }) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (value || text.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await getJson(`/api/recruitment/interview-calendar/people?for=interviewer&q=${encodeURIComponent(text)}`);
        if (cancelled) return;
        setPeople(Array.isArray(data.people) ? (data.people as Person[]) : []);
        setError(null);
      } catch (caught) {
        if (!cancelled) setError(errorText(caught, "Could not search for people."));
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, value]);

  if (value) {
    return (
      <FormField label={label} required={required}>
        <div className={`flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-3 py-2 ${adminRecessedDepthClassName}`}>
          <span className="min-w-0 break-words text-sm font-bold text-slate-900">
            {value.name}
            {value.jobTitle ? <span className="ml-1 font-normal text-slate-500">· {value.jobTitle}</span> : null}
          </span>
          <button className={phxButtonGhostClassName} onClick={() => onChange(null)} type="button">
            Change
          </button>
        </div>
      </FormField>
    );
  }
  return (
    <FormField error={error} hint="Type two letters of the name or job title." htmlFor={id} label={label} required={required}>
      <input className={phxFieldClassName} id={id} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name" value={query} />
      {query.trim().length >= 2 && people.length > 0 ? (
        <div className="mt-1 grid gap-1">
          {people.map((person) => (
            <button
              className={cn(phxCheckTileClassName(false), "text-left")}
              key={person.hrId}
              onClick={() => {
                onChange(person);
                setQuery("");
                setPeople([]);
              }}
              type="button"
            >
              <span className="min-w-0 break-words">
                {person.name}
                {person.jobTitle ? <span className="ml-1 text-slate-500">· {person.jobTitle}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </FormField>
  );
}

const DURATIONS = [30, 45, 60, 90];

function interviewerLabel(round: MrInterviewRound): string {
  if (round === "dsm") return "The DSM who interviews";
  if (round === "rsm") return "The RSM who interviews";
  if (round === "hr_manager") return "The HR Manager who interviews";
  if (round === "nsm_final") return "The NSM who interviews";
  if (round === "joint_final") return "The HR Manager";
  return "Interviewer";
}

/** "09:05" for 545 minutes after midnight — the value a time field takes. */
function timeValue(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Book the next interview — or, given `existing`, CHANGE the one booked and not yet held: its day,
 * time, length, way and place, pre-filled as booked (owner, 7 Nov 2026: "I set up the time for the
 * interview as a phone call. Make me able to change this time"). The round and the interviewer stay.
 */
export function MrBookingForm({
  existing = null,
  onCancel,
  onDone,
  row,
}: {
  existing?: MrBookingFact | null;
  onCancel: () => void;
  onDone: (notice: string | null) => void;
  row: MrRow;
}) {
  const changing = existing !== null && existing.round !== null;
  const rounds: MrInterviewRound[] = changing && existing.round ? [existing.round] : row.can.book;
  const [round, setRound] = useState<MrInterviewRound>(rounds[0] ?? "hr_first");
  const [dateKey, setDateKey] = useState(() => (changing ? cairoDateKey(new Date(existing.startsAt)) : ""));
  const [time, setTime] = useState(() => (changing ? timeValue(cairoMinutesOfDay(new Date(existing.startsAt))) : ""));
  const [duration, setDuration] = useState(() => (changing ? existing.durationMinutes : 30));
  // The 1st interview's way: §3's answer pre-filled from the governorate, or a phone call (owner,
  // 7 Nov 2026: "only for hr first interview u will add a third option which is phone call").
  const [firstWay, setFirstWay] = useState<"in_office" | "zoom" | "phone" | null>(() =>
    changing ? existing.platform : row.inCairoOrGiza === null ? null : row.inCairoOrGiza ? "in_office" : "zoom",
  );
  const [platform, setPlatform] = useState<"zoom" | "in_office">(() => (changing && existing.platform !== "phone" ? existing.platform : "zoom"));
  const [location, setLocation] = useState(() => (changing ? (existing.location ?? "") : ""));
  const [interviewer, setInterviewer] = useState<Person | null>(null);
  const [nsm, setNsm] = useState<Person | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [today] = useState(cairoTodayKey);
  const first = round === "hr_first";
  const inPerson = first ? firstWay === "in_office" : platform === "in_office";
  const byPhone = first && firstWay === "phone";

  async function submit() {
    if (!dateKey || !time) return setError("Choose the interview day and time.");
    if (first && firstWay === null) return setError("Say whether the candidate is in Cairo or Giza, or choose a phone call.");
    if (!changing && !first && !interviewer) return setError("Choose who conducts this interview.");
    if (!changing && round === "joint_final" && !nsm) return setError("A joint final has the HR Manager and the NSM — choose both.");
    const [hours, minutes] = time.split(":").map(Number);
    setBusy(true);
    setError(null);
    try {
      const url = `/api/recruitment/mr-hiring/${encodeURIComponent(row.candidateId)}/book`;
      const send = changing ? (body: unknown) => patchJson(url, body) : (body: unknown) => postJson(url, body);
      const data = await send({
        bookingId: changing ? existing.id : undefined,
        dateKey,
        // A phone call's length is never asked — the server books it for MR_PHONE_CALL_MINUTES.
        durationMinutes: byPhone ? undefined : duration,
        inCairoOrGiza: first && !byPhone ? firstWay === "in_office" : undefined,
        interviewerHrId: interviewer?.hrId ?? null,
        location: inPerson ? location : null,
        notes: changing ? undefined : notes,
        panelistHrIds: round === "joint_final" && nsm ? [nsm.hrId] : [],
        platform: first ? (byPhone ? "phone" : undefined) : platform,
        round,
        startMinutes: hours * 60 + minutes,
      });
      onDone(typeof data.notice === "string" ? data.notice : null);
    } catch (caught) {
      setError(errorText(caught, changing ? "Could not change the interview." : "Could not book the interview."));
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-600">{changing ? "Change the interview" : "Book the interview"}</p>
        <p className="mt-1 break-words text-sm font-bold text-slate-900">{row.name}</p>
      </div>
      {rounds.length > 1 ? (
        <FormField htmlFor="mr-round" hint="The joint final replaces the 3rd interview and the NSM final." label="Interview" required>
          <select className={phxSelectClassName} id="mr-round" onChange={(event) => setRound(event.target.value as MrInterviewRound)} value={round}>
            {rounds.map((value) => (
              <option key={value} value={value}>
                {MR_ROUND_LABELS[value]}
              </option>
            ))}
          </select>
        </FormField>
      ) : (
        <p className="border-l-4 border-orange-500 bg-orange-50 px-3 py-2 text-sm font-bold text-slate-900">{MR_ROUND_LABELS[round]}</p>
      )}
      <div className={phxFieldGridTwoClassName}>
        <FormField htmlFor="mr-day" label="Day" required>
          <input className={phxFieldClassName} id="mr-day" min={changing && dateKey && dateKey < today ? dateKey : today} onChange={(event) => setDateKey(event.target.value)} type="date" value={dateKey} />
        </FormField>
        <FormField hint="Cairo time." htmlFor="mr-time" label="Time" required>
          <input className={phxFieldClassName} id="mr-time" onChange={(event) => setTime(event.target.value)} step={60} type="time" value={time} />
        </FormField>
      </div>
      {byPhone ? null : (
        <FormField htmlFor="mr-duration" label="Length">
          <select className={phxSelectClassName} id="mr-duration" onChange={(event) => setDuration(Number(event.target.value))} value={duration}>
            {(DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((left, right) => left - right)).map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} minutes
              </option>
            ))}
          </select>
        </FormField>
      )}
      {first ? (
        <FormField
          hint={
            row.governorate
              ? `The candidate's governorate is ${row.governorate}. Cairo or Giza is in person at the office; anywhere else is Zoom.`
              : "No governorate is recorded. Cairo or Giza is in person at the office; anywhere else is Zoom."
          }
          label="Is the candidate in Cairo or Giza?"
          required
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup">
            <CheckTile checked={firstWay === "in_office"} name="mr-cairo" onChange={() => setFirstWay("in_office")} type="radio">
              Yes — in person at the office
            </CheckTile>
            <CheckTile checked={firstWay === "zoom"} name="mr-cairo" onChange={() => setFirstWay("zoom")} type="radio">
              No — on Zoom
            </CheckTile>
            <CheckTile checked={firstWay === "phone"} name="mr-cairo" onChange={() => setFirstWay("phone")} type="radio">
              Phone call
            </CheckTile>
          </div>
        </FormField>
      ) : (
        <FormField label="How" required>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
            <CheckTile checked={platform === "in_office"} name="mr-platform" onChange={() => setPlatform("in_office")} type="radio">
              In person
            </CheckTile>
            <CheckTile checked={platform === "zoom"} name="mr-platform" onChange={() => setPlatform("zoom")} type="radio">
              Zoom
            </CheckTile>
          </div>
        </FormField>
      )}
      {inPerson ? (
        <FormField hint="Leave empty for the head office." htmlFor="mr-location" label="Location">
          <input
            className={phxFieldClassName}
            id="mr-location"
            maxLength={MR_LOCATION_LIMIT}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Head office"
            value={location}
          />
        </FormField>
      ) : byPhone ? (
        <p className="text-xs leading-5 text-slate-600">
          No Zoom meeting and no place — the interviewer calls the candidate at the booked time. The call holds {MR_PHONE_CALL_MINUTES} minutes on the calendar.
        </p>
      ) : (
        <p className="text-xs leading-5 text-slate-600">The Zoom link is created from the official Sato Pharma Zoom account when the interview is booked.</p>
      )}
      {changing ? (
        <p className="text-xs leading-5 text-slate-600">
          {existing.interviewerName ? `${existing.interviewerName} still conducts it. ` : ""}Everyone on the interview is told the new time in Phoenix and
          on Telegram. Nothing is sent to the candidate.
        </p>
      ) : first ? (
        <PersonPicker id="mr-interviewer" label="Interviewer (you, if left empty)" onChange={setInterviewer} value={interviewer} />
      ) : (
        <PersonPicker id="mr-interviewer" label={interviewerLabel(round)} onChange={setInterviewer} required value={interviewer} />
      )}
      {!changing && round === "joint_final" ? <PersonPicker id="mr-nsm" label="The NSM" onChange={setNsm} required value={nsm} /> : null}
      {changing ? null : round === "dsm" ? (
        <p className="text-xs leading-5 text-slate-600">Booking sends the CV to the DSM through Phoenix and notifies the DSM.</p>
      ) : round === "rsm" ? (
        <p className="text-xs leading-5 text-slate-600">
          For a Pedia line candidate who passed the DSM interview. Booking sends the RSM the interview details through Phoenix, and the RSM
          submits the evaluation in Phoenix.
        </p>
      ) : null}
      {changing ? null : (
        <FormField htmlFor="mr-notes" label="Notes for the interviewer">
          <textarea className={phxTextareaClassName} id="mr-notes" onChange={(event) => setNotes(event.target.value)} rows={2} value={notes} />
        </FormField>
      )}
      <FormError>{error}</FormError>
      <FormActions
        left={
          <button className={phxButtonGhostClassName} disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
        }
        right={
          <button className={phxButtonAccentClassName} disabled={busy} type="submit">
            {busy ? (changing ? "Saving…" : "Booking…") : changing ? "Save the new time" : "Book the interview"}
          </button>
        }
      />
    </form>
  );
}
