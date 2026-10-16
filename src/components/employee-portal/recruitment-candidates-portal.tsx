"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  CandidateCallControl,
  CandidateCallNotice,
  hiddenPhoneText,
  useCandidateCall,
} from "@/components/employee-portal/candidate-call-control";
import { CandidateCommentThread } from "@/components/employee-portal/candidate-comment-thread";
import {
  CandidateOpenedNotice,
  CandidateOpenersProvider,
} from "@/components/employee-portal/candidate-opened-notice";
import { CandidateCvActions } from "@/components/employee-portal/candidate-cv-actions";
import { CandidateFolderControl } from "@/components/employee-portal/candidate-folder-control";
import { DistrictFoldersSection } from "@/components/employee-portal/district-folders-section";
import { ManagerFoldersSection } from "@/components/employee-portal/manager-folders-section";
import { TeamCandidatesSection, type TeamManagerOption } from "@/components/employee-portal/team-candidates-section";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { dateOnly } from "@/lib/format/date-only";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import type { ApplicationWithContext } from "@/lib/recruitment/applications";
import type { CandidateCallClaim, CandidateCallClaims } from "@/lib/recruitment/candidate-call-claims";
import type { CandidateOpeners } from "@/lib/recruitment/candidate-openers";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  candidateStatusLabel,
  hiringManagerDecisionLabels,
  isUnreviewedCandidateStatus,
  type HiringManagerDecision,
} from "@/lib/recruitment/candidate-status";
import type { CandidateFolderAreaOption } from "@/lib/recruitment/candidate-folder-options";
import type { DistrictManagerBoard } from "@/lib/recruitment/district-manager-folders";
import { MANAGER_HOLD_DAYS } from "@/lib/recruitment/manager-hold-window";
import {
  partitionManagerCandidates,
  withManagerFiling,
  type ManagerFolderFiling,
  type ManagerFolderFilings,
} from "@/lib/recruitment/manager-folder-shelf";
import { groupCandidatesByPosition, shouldShowGroupHeadings } from "@/lib/recruitment/position-folder";
import type { Candidate, Interview, TeamCandidateFile } from "@/lib/recruitment/types";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminChipDepthClassName } from "@/components/admin/admin-design-tokens";

type Props = {
  /**
   * Every active area with its RECRUITMENT region, for the folder picker. Loaded on the server
   * because it reads the org chart — see candidate-folder-options.ts, and note that a Sharkia area
   * files under Delta (3) here while the sales geography deliberately still says Delta (2).
   */
  areaOptions: CandidateFolderAreaOption[];
  initialApplications: ApplicationWithContext[];
  /**
   * Who has said "I will call" on each CV on this page, keyed by candidate id.
   *
   * Loaded on the SERVER with the lists themselves, never per card. A card fetching its own claim is
   * the pattern that made the View CV button take fifteen seconds to appear on the team screen, and
   * this one is worse to get wrong: the claim decides whether the phone number is printed, so a card
   * that has not heard back yet would show "Hidden" to the very manager holding the reservation.
   *
   * An absent key means nobody has claimed that CV. Absent for EVERY key — which is what a database
   * without the table answers — is the pre-claim screen and is deliberately not an error state.
   */
  initialCallClaims: CandidateCallClaims;
  /**
   * This manager's own districts, and inside each one a folder per area he holds — every area,
   * including the ones nobody has applied to. Empty for anybody who holds no district seat, which is
   * most people who reach this screen, and the section then renders nothing at all.
   *
   * Computed on the server from the organogram; see district-manager-folders.ts. These CVs were NOT
   * sent to him: they are the applicants who asked for one of his areas, which is a deliberate
   * widening — the owner, 2026-08-31: "if you need a CV from any area, he click the folder and open
   * he find all CVs."
   */
  initialDistrictBoards: DistrictManagerBoard<Candidate>[];
  /**
   * The CVs in his folders he has not opened since they were sent — what makes a folder pulse and
   * opens the first such folder on arrival. Computed on the server from his own view history.
   */
  initialUnseenIds?: string[];
  /**
   * What this manager has filed onto HIS OWN shelf, keyed by candidate id.
   *
   * His own, not the recruitment team's: filing here writes ats_candidate_manager_folders and
   * the recruiter's pool does not move. See manager-folder-shelf.ts for why the two must stay
   * separate — the short version is that the recruiter's filing hides a CV from every recruiter.
   */
  initialFilings: ManagerFolderFilings;
  /**
   * Every card's CV file, keyed by candidate id, loaded on the server with the lists themselves.
   *
   * The owner's rule for this screen is that the CV must be openable — "he must be able to screen
   * and must have a button to download the CV or to view it. It is a must." Letting each card ask
   * for its own files met that on paper and failed it on screen: eleven cards meant eleven requests,
   * and the View/Download control appeared long after the card it belongs to. A missing key means
   * this candidate was never asked about, so the card falls back to asking; an EMPTY ARRAY is a real
   * answer and means the candidate has no file.
   */
  initialFiles: Record<string, TeamCandidateFile[]>;
  /**
   * The CVs a recruiter pushed STRAIGHT to this manager — no requisition, no application, no seat on
   * the org chart. This is the flow the module is actually used for; the applications above are the
   * long way round, taken 7 times in the module's history against 226 candidates.
   */
  initialSentToMe: Candidate[];
  /**
   * Who ELSE has already opened each CV on this page — a colleague's name, title, and the Cairo date
   * and time — keyed by candidate id. The owner, 2026-09-20: the same applicant lands in several
   * district managers' folders (CNS, Anti-infective, Pedia), and each must see that another has read
   * it. Loaded on the server with the lists, never per card, for the reason `initialCallClaims` is.
   * Optional and absent means "nobody", which is the screen as it stood before the banner.
   */
  initialOpeners?: CandidateOpeners;
  /**
   * The managers reporting to this caller, for the picker the owner asked for on 2026-08-30. Empty
   * for anybody who manages nobody, which is most people who reach this screen.
   */
  initialTeam: TeamManagerOption[];
  /** Only used to decide which comments offer a Delete — every delete is re-checked server-side. */
  viewerHrId: string | null;
};

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

async function sendJson(url: string, method: "POST" | "PATCH", body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Request failed.");
  return data;
}

// A narrow, DM-relevant subset of the full 26-stage pipeline — everything else (CV/phone
// screening, interview scheduling) is the recruiter's own stage, shown as a neutral
// "With recruitment" badge below.
const stageLabels: Record<string, { label: string; tone: string }> = {
  application_rejected: { label: "Not qualified", tone: "border-rose-200 bg-rose-50 text-rose-700" },
  application_withdrawn: { label: "Withdrawn", tone: "border-slate-200 bg-slate-100 text-slate-500" },
  final_selection: { label: "Final selection (recruitment)", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  hired: { label: "Hired", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  hiring_manager_interview: { label: "Ready for your interview", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  manager_interview_completed: { label: "Passed to recruitment", tone: "border-emerald-200 bg-emerald-50 text-emerald-700" },
};

function stageBadge(stage: string) {
  return stageLabels[stage] ?? { label: "With recruitment", tone: "border-slate-200 bg-slate-50 text-slate-500" };
}

function formatYesNo(value: boolean | null | undefined) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Not stated";
}

// Dates on this card follow the backing column, not the field's name. `cairoDateTime` for an
// instant we stamped (`created_at`, `sent_at`, `ats_interviews.scheduled_at` — all timestamptz),
// `dateOnly` for a `date` column (`medical_rep_experience_from`/`_to`). Both pin their zone, so the
// server and the phone render the same characters; the unpinned local formatter that used to live
// here did not, and an unpinned formatter is a hydration mismatch waiting for its first row.
const hiringManagerCriteria = [
  { key: "territory_knowledge", label: "Territory knowledge" },
  { key: "sales_skills", label: "Sales skills" },
  { key: "business_awareness", label: "Business awareness" },
  { key: "product_knowledge", label: "Product knowledge" },
  { key: "customer_handling", label: "Customer handling" },
] as const;

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-slate-700">{value?.trim() ? value : "—"}</p>
    </div>
  );
}

function CandidateCard({
  application,
  claim,
  files,
  onChanged,
  viewerHrId,
}: {
  application: ApplicationWithContext;
  /** Who has said they will call this candidate — the only thing that reveals the phone number. */
  claim: CandidateCallClaim | null;
  /** Loaded with the page, for the same reason as the sent-to-you cards. */
  files: TeamCandidateFile[];
  onChanged: () => void;
  viewerHrId: string | null;
}) {
  const candidate = application.candidate!;
  const requisition = application.requisition!;
  // The phone is hidden here too, on a candidate already booked into this manager's own round.
  // "On every CV", the owner said, and this is the list where an exception would be most tempting —
  // nobody is competing for somebody already assigned to him. It is also the list where a hidden
  // number with no way to reveal it would be worst, which is why the SAME control sits on the card:
  // one press and he has it. There is no Skip here; the round has its own reject path.
  const call = useCandidateCall(candidate, claim, viewerHrId);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scheduledAt, setScheduledAt] = useState("");
  const [location, setLocation] = useState("");
  const [meetingLink, setMeetingLink] = useState("");
  const [scores, setScores] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const interviewsData = await getJson(`/api/recruitment/hiring-manager/applications/${application.id}/interviews`);
        if (!active) return;
        setInterviews(Array.isArray(interviewsData.interviews) ? (interviewsData.interviews as Interview[]) : []);
      } catch {
        /* leave empty — the card still shows the candidate's own details */
      }
    })();
    return () => {
      active = false;
    };
  }, [application.id]);

  const hmInterview = interviews.find((interview) => interview.interviewType === "hiring_manager") ?? null;
  const badge = stageBadge(application.stage);
  const canAct = application.stage === "hiring_manager_interview";

  const schedule = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await sendJson(`/api/recruitment/hiring-manager/applications/${application.id}/interviews`, "POST", {
        interviewType: "hiring_manager",
        location: location || undefined,
        meetingLink: meetingLink || undefined,
        scheduledAt: scheduledAt || undefined,
      });
      // Update local state directly — onChanged() only refreshes the parent's application
      // list, which doesn't change this card's own [candidate.id, application.id] effect
      // dependencies, so it would never re-fetch this card's interviews on its own.
      if (data.interview) setInterviews((prev) => [data.interview as Interview, ...prev]);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to schedule the interview.");
    } finally {
      setBusy(false);
    }
  };

  const recordOutcome = async (decision: "proceed" | "not_qualified") => {
    if (!hmInterview) return;
    if (decision === "not_qualified" && !notes.trim()) {
      setError("Add a short reason before marking the candidate not qualified.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const numericScores: Record<string, number> = {};
      for (const [key, value] of Object.entries(scores)) {
        const n = Number(value);
        if (Number.isFinite(n) && value !== "") numericScores[key] = n;
      }
      const outcomeData = await sendJson(`/api/recruitment/hiring-manager/interviews/${hmInterview.id}`, "PATCH", {
        notes,
        outcome: decision === "proceed" ? "recommended" : "rejected",
        score: numericScores,
      });
      if (outcomeData.interview) {
        const updated = outcomeData.interview as Interview;
        setInterviews((prev) => prev.map((interview) => (interview.id === updated.id ? updated : interview)));
      }
      await sendJson(`/api/recruitment/hiring-manager/applications/${application.id}/workflow`, "POST", {
        action: decision === "proceed" ? "app_record_hm_interview" : "app_reject",
        reason: decision === "not_qualified" ? notes : undefined,
      });
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to record the interview outcome.");
    } finally {
      setBusy(false);
    }
  };

  const tenureLine = [
    candidate.medicalRepEmployer,
    [dateOnly(candidate.medicalRepExperienceFrom), dateOnly(candidate.medicalRepExperienceTo)]
      .filter(Boolean)
      .join(" – "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6" id={`candidate-${candidate.id}`}>
      <CandidateCallNotice claim={call.claim} viewerHrId={viewerHrId} />
      <CandidateOpenedNotice candidateId={candidate.id} />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-slate-900">{candidate.fullName}</p>
          <p className="text-xs text-slate-500">
            {requisition.jobTitle} · {requisition.requisitionCode}
          </p>
        </div>
        <span className={`inline-block rounded border px-2 py-0.5 text-phx-xs font-semibold ${badge.tone}`}>
          {badge.label}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Email" value={candidate.email} />
        {/* The hint tracks `canAct`, which gates every control on this card. Hard-coding it to true
            would point a manager at an "I will call" button that his own card is not rendering,
            because the candidate has not reached his interview round yet. */}
        <Field label="Phone" value={call.phone ?? hiddenPhoneText(canAct)} />
        <Field label="Governorate" value={candidate.governorate} />
        <Field label="Address" value={candidate.address} />
        <Field label="Faculty" value={candidate.faculty} />
        <Field label="University" value={candidate.university} />
        <Field label="Prior work experience" value={formatYesNo(candidate.hasPriorWorkExperience)} />
        <Field label="Medical Rep experience" value={formatYesNo(candidate.hasMedicalRepExperience)} />
        {candidate.hasMedicalRepExperience ? <Field label="Medical Rep tenure" value={tenureLine} /> : null}
      </div>

      <CandidateCvActions
        candidateId={candidate.id}
        candidateName={candidate.fullName}
        initialFiles={files}
        showPhoneNumbers={call.mine}
      />

      <CandidateCallControl
        canAct={canAct}
        candidateId={candidate.id}
        claim={call.claim}
        onChanged={call.apply}
        viewerHrId={viewerHrId}
      />

      <CandidateCommentThread candidateId={candidate.id} viewerHrId={viewerHrId} />

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      {canAct && !hmInterview ? (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Schedule your interview</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              className={phxFieldClassName}
              onChange={(event) => setScheduledAt(event.target.value)}
              type="datetime-local"
              value={scheduledAt}
            />
            <input
              className={phxFieldClassName}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Location (or phone/video)"
              value={location}
            />
            <input
              className={phxFieldClassName}
              onChange={(event) => setMeetingLink(event.target.value)}
              placeholder="Meeting link (optional)"
              value={meetingLink}
            />
          </div>
          <Button disabled={busy || !scheduledAt} onClick={schedule} size="sm">
            Schedule interview
          </Button>
        </div>
      ) : null}

      {canAct && hmInterview && !hmInterview.outcome ? (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Interview{hmInterview.scheduledAt ? ` on ${cairoDateTime(hmInterview.scheduledAt)}` : ""} — record your feedback
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {hiringManagerCriteria.map((criterion) => (
              <label className="flex items-center justify-between gap-2 text-xs text-slate-600" key={criterion.key}>
                {criterion.label}
                <select
                  className={phxSelectClassName}
                  onChange={(event) => setScores((prev) => ({ ...prev, [criterion.key]: event.target.value }))}
                  value={scores[criterion.key] ?? ""}
                >
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <textarea
            className={phxTextareaClassName}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Feedback notes"
            rows={2}
            value={notes}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => recordOutcome("proceed")} size="sm">
              Proceed to second interview
            </Button>
            <Button disabled={busy} onClick={() => recordOutcome("not_qualified")} size="sm" variant="destructive">
              Not qualified
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * A CV a recruiter sent straight to this manager, and the two answers they can give back.
 *
 * The whole module exists to get to this card: a CV arrives, the AI reads it, a recruiter sends the
 * person to the District Manager who would actually work with them. Everything the manager needs to
 * answer is on the card — the extracted details, the CV itself, and the two buttons — because the
 * alternative is the state this replaced, where the alert arrived and pointed at a page the manager
 * was not allowed to open.
 */
function SentCandidateCard({
  areaOptions,
  candidate: initial,
  claim: initialClaim,
  filing,
  files,
  onFilingChanged,
  viewerHrId,
}: {
  areaOptions: CandidateFolderAreaOption[];
  candidate: Candidate;
  /** Who has said they will call this candidate, loaded with the list. */
  claim: CandidateCallClaim | null;
  /** This manager's own filing of this CV, or null while it is still in his live list. */
  filing: ManagerFolderFiling | null;
  /** This candidate's files, already loaded with the list — so View CV is there with the card. */
  files: TeamCandidateFile[];
  onFilingChanged: (candidateId: string, filing: ManagerFolderFiling | null) => void;
  viewerHrId: string | null;
}) {
  const [candidate, setCandidate] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A CV sent to this manager is fully his — number, file, everything (owner, 2026-10-16).
  const call = useCandidateCall(initial, initialClaim, viewerHrId, true);

  const notified = candidate.managerNotified;
  // Only an untouched candidate still needs an answer. Once the manager (or the recruiter) has
  // moved them, the card shows what was decided instead of offering the buttons again — a second
  // "Not interested" on somebody already rejected writes a new event and tells nobody anything.
  const awaitingAnswer = isUnreviewedCandidateStatus(candidate.status) || candidate.status === "sent_to_manager";

  /**
   * The manager's answer, taking its note from the ONE box the card now has.
   *
   * The note used to come from a second textarea of the card's own; the owner asked for the two to
   * be merged, so the text arrives from the comment composer and `clearDraft` empties it once the
   * answer has been recorded. Skip still refuses without a reason — that requirement is unchanged,
   * only where the words are typed has moved.
   */
  const answer = async (decision: HiringManagerDecision, draft: string, clearDraft: () => void) => {
    const note = draft.trim();
    if (decision === "not_interested" && !note) {
      setError("Say why before you skip, so the recruitment team knows.");
      return;
    }
    // ONE BOX, TWO LIMITS. The shared box takes a 2,000-character comment; the status note the
    // decision route stores is capped at 300. Sending a long one would come back as a bare "keep the
    // note under 300 characters" from the server, which reads as the screen having lost his words.
    // He is told here instead, and pointed at the option that takes the whole thing — posting it as
    // a comment.
    if (note.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
      setError(
        `Skip takes a short reason, under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters. `
          + "Shorten it, or press Add comment to keep the whole note.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await sendJson(`/api/recruitment/hiring-manager/candidates/${candidate.id}/decision`, "PATCH", {
        decision,
        note: note || undefined,
      });
      if (data.candidate) setCandidate(data.candidate as Candidate);
      clearDraft();
      // Skipping releases his reservation on the server, so the card has to follow: without this the
      // number stays printed on a CV he has just passed on, until he happens to reload. The route
      // answers with whatever claim now stands — null after his own Skip, unchanged when somebody
      // else holds it — so the card never has to work it out for itself.
      call.apply({ claim: (data.claim as CandidateCallClaim | null) ?? null, phone: null, whatsapp: null });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to record your answer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6" id={`candidate-${candidate.id}`}>
      {/* Who has taken this CV, at the TOP of the card. A manager must know it is somebody else's
          before he reads a word of it, not after he has formed an opinion at the foot of the card. */}
      <CandidateCallNotice claim={call.claim} viewerHrId={viewerHrId} />
      {/* Who ELSE has read this CV, right under who has taken it. Same reason, same place: a manager
          must know a colleague has already looked before he reads a word of it. */}
      <CandidateOpenedNotice candidateId={candidate.id} />

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-slate-900">{candidate.fullName}</p>
          {/* The one question a manager opens this card to answer. Read through the same evidence
              ladder the pool table uses, because `applied_for_job_title` is filled on 15 of the 555
              production rows — reading only that made this line say "no role stated" on 540 CVs.
              The source is named in the hover text, so a derived role never reads as a stated one. */}
          {(() => {
            const appliedFor = candidateRowAppliedFor(candidate);
            return (
              <p
                className="text-xs text-slate-500"
                title={appliedFor.source ? `${APPLIED_FOR_SOURCE_LABEL[appliedFor.source]}: ${appliedFor.evidence}` : undefined}
              >
                {appliedFor.text ? `Applying for ${appliedFor.text}` : "No role stated on the application"}
              </p>
            );
          })()}
        </div>
        <span className={`inline-block rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-phx-xs font-semibold text-slate-600 ${adminChipDepthClassName}`}>
          {candidateStatusLabel(candidate.status)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {/* Hidden until he takes the CV. The owner, 2026-09-09 — and it is the reservation that
            reveals it, which is what makes "I will call" something he can act on. */}
        <Field label="Phone" value={call.phone} />
        <Field label="Email" value={candidate.email} />
        <Field label="Governorate" value={candidate.governorate} />
        <Field label="Current job title" value={candidate.currentJobTitle} />
        <Field label="Current employer" value={candidate.currentEmployer} />
        <Field
          label="Years of experience"
          value={candidate.yearsExperience === null ? null : String(candidate.yearsExperience)}
        />
        <Field label="Medical Rep experience" value={formatYesNo(candidate.hasMedicalRepExperience)} />
        <Field label="CV received" value={cairoDateTime(candidate.createdAt)} />
        <Field label="Sent to you" value={notified ? cairoDateTime(notified.sentAt) : null} />
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <CandidateCvActions
        candidateId={candidate.id}
        candidateName={candidate.fullName}
        initialFiles={files}
        showPhoneNumbers={call.mine}
      />
        {/* The third answer, and the one the owner asked for on 2026-08-30: neither "Interview" nor
            "Not interested" is true of a good CV that simply is not needed this month. Filing writes
            to HIS shelf only - the recruitment team's pool does not move. */}
        <CandidateFolderControl
          areaOptions={areaOptions}
          candidate={candidate}
          filing={filing}
          onChanged={(next) => onFilingChanged(candidate.id, next)}
        />
      </div>

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      {/* ONE FIELD, NOT TWO. The owner, 2026-09-09: *"I have two fields for your answer and your
          comments — merge them into one field, no need two fields."* There is only one thing to
          type on a CV, which is what he found, so the answer buttons moved DOWN
          into the comment box rather than the box being duplicated above them. Skip sends whatever
          is in that box as the reason it has always required. */}
      {!awaitingAnswer ? (
        <div className="border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-500">
            You answered: {candidateStatusLabel(candidate.status)}
            {candidate.statusNote?.trim() ? ` — ${candidate.statusNote}` : ""}
          </p>
        </div>
      ) : null}

      {/* The same thread the managers above this one write into. It is HERE, on the card the manager
          holding the CV actually opens, because that is the only place a comment from above can do
          its job — a National Sales Manager's opinion filed somewhere only he can see is an opinion
          he may as well not have written. */}
      <CandidateCommentThread
        candidateId={candidate.id}
        composerActions={
          awaitingAnswer
            ? (draft, clearDraft) => (
                <CandidateCallControl
                  canAct
                  candidateId={candidate.id}
                  claim={call.claim}
                  hideReservation
                  onChanged={call.apply}
                  viewerHrId={viewerHrId}
                >
                  {/* The answer after the call, once he holds the reservation. The unavailable flag
                      is the safety valve: if a reservation cannot be recorded at all, this answer
                      would otherwise be unreachable and the recruiter would simply stop hearing
                      back — degrading towards MORE ability, never less. */}
                  {call.mine || call.unavailable ? (
                    <Button disabled={busy} onClick={() => void answer("interview", draft, clearDraft)} size="sm">
                      {hiringManagerDecisionLabels.interview}
                    </Button>
                  ) : null}
                  {/* The SAME decision route "Not interested" always took — owner: "if the manager
                      chooses skip then he is skipped normally". It now takes its required reason from
                      the one shared box instead of a second one of its own. */}
                  <Button
                    disabled={busy}
                    onClick={() => void answer("not_interested", draft, clearDraft)}
                    size="sm"
                    variant="destructive"
                  >
                    {hiringManagerDecisionLabels.not_interested}
                  </Button>
                </CandidateCallControl>
              )
            : undefined
        }
        viewerHrId={viewerHrId}
      />
    </Card>
  );
}

/**
 * The screen, wrapped once so every card below it — the sent list, the open positions and every
 * folder — can read who else has opened its CV without the map being passed through each of them.
 */
export function RecruitmentCandidatesPortal(props: Props) {
  return (
    <CandidateOpenersProvider openers={props.initialOpeners ?? {}}>
      <RecruitmentCandidatesPortalBody {...props} />
    </CandidateOpenersProvider>
  );
}

function RecruitmentCandidatesPortalBody({
  areaOptions,
  initialApplications,
  initialCallClaims: callClaims,
  initialDistrictBoards,
  initialFilings,
  initialFiles: files,
  initialSentToMe: sentToMe,
  initialTeam,
  initialUnseenIds,
  viewerHrId,
}: Props) {
  const [applications, setApplications] = useState(initialApplications);
  const [filings, setFilings] = useState<ManagerFolderFilings>(initialFilings);

  // The manager's own shelf, folded by the RECRUITER's own partition function so a folder means one
  // thing on both screens. `live` is what still needs him; `shelves` is what he kept for later.
  //
  // Note the order: the shelf split happens BEFORE the position grouping below, so a CV he has filed
  // leaves "Sent to you" entirely rather than sitting in a position folder AND in a shelf. A
  // candidate in two lists is a candidate answered twice.
  const {
    live: liveAndFoldered,
    shelves,
    filedCount,
  } = useMemo(() => partitionManagerCandidates(sentToMe, filings), [filings, sentToMe]);

  // THE FOLDERS ARE HIS SENDS, so a CV sitting in one of his folders is not listed a second time
  // under "Sent to you" — it is drawn once, by the same card, inside its folder. What stays in
  // "Sent to you" is a CV that fits no folder on his shelf at all (a manager with no seat on the
  // organogram has no folders, so for him this is every CV).
  const foldered = useMemo(() => {
    const ids = new Set<string>();
    for (const board of initialDistrictBoards) {
      for (const folder of board.folders) for (const candidate of folder.candidates) ids.add(candidate.id);
    }
    return ids;
  }, [initialDistrictBoards]);
  const liveSends = useMemo(
    () => liveAndFoldered.filter((candidate) => !foldered.has(candidate.id)),
    [foldered, liveAndFoldered],
  );
  const sentById = useMemo(() => new Map(sentToMe.map((candidate) => [candidate.id, candidate])), [sentToMe]);
  const unseenIds = useMemo(() => new Set(initialUnseenIds ?? []), [initialUnseenIds]);

  const onFilingChanged = (candidateId: string, filing: ManagerFolderFiling | null) => {
    setFilings((current) => withManagerFiling(current, candidateId, filing));
  };

  // ONE card renderer, used by the live list and by every folder. The two used to be one JSX literal
  // repeated three times, and adding the folder control to it would have meant adding it three times
  // — which is precisely how a card inside a folder ends up without the button that gets it out.
  const renderSentCard = (candidate: Candidate) => (
    <SentCandidateCard
      areaOptions={areaOptions}
      candidate={candidate}
      claim={callClaims[candidate.id] ?? null}
      filing={filings[candidate.id] ?? null}
      files={files[candidate.id] ?? []}
      key={candidate.id}
      onFilingChanged={onFilingChanged}
      viewerHrId={viewerHrId}
    />
  );

  // Folded on the SAME function the recruiter's screen and the tests use, so a folder cannot mean
  // one thing where it is created and another where it is read.
  const { folders: positionFolders, unfiled: unfiledSends } = useMemo(
    () => groupCandidatesByPosition(liveSends),
    [liveSends],
  );

  // One answer drives BOTH headings — see shouldShowGroupHeadings. They disagreed precisely because
  // they used to be two separate expressions.
  const showGroupHeadings = shouldShowGroupHeadings(positionFolders, unfiledSends);

  // Every board is now a shelf of area folders, whatever the seat — a regional or national sales
  // manager holds every area beneath him — so there is no separate "district manager applicants"
  // section any more: an application for a district manager post is just a CV that was sent.
  const areaBoards = initialDistrictBoards;

  const reload = async () => {
    try {
      const data = await getJson("/api/recruitment/hiring-manager/applications");
      const list = Array.isArray(data.applications) ? (data.applications as ApplicationWithContext[]) : [];
      setApplications(list.filter((application) => application.candidate && application.requisition));
    } catch {
      /* keep the current list on a transient reload failure */
    }
  };

  // The team and district checks belong in this condition, not only in the render below it. A
  // National Sales Manager with nothing sent to him personally still has districts to look through,
  // and without this he would be shown "No candidates yet" over a team holding ten CVs — and a
  // district manager would be shown it over his own area folders.
  if (
    applications.length === 0 &&
    sentToMe.length === 0 &&
    initialTeam.length === 0 &&
    initialDistrictBoards.length === 0
  ) {
    return (
      <Card className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <p className="text-base font-semibold text-slate-700">No candidates yet</p>
        <p className="mt-1 text-sm text-slate-400">
          CVs the recruitment team sends you, and candidates assigned to your open positions, will appear here.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Sent-to-you first, deliberately: this is the list the notification links to, and it is the
          one that needs an answer. The requisition-based applications below are the longer route
          and are already sitting in a workflow. */}
      {liveSends.length > 0 ? (
        <section className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Sent to you</h2>
            <p className="text-xs text-slate-500">
              CVs the recruitment team asked you to look at. A CV in one of your folders stays until it is taken back
              or you return it; any other CV goes back to the recruitment team after {MANAGER_HOLD_DAYS} days.
            </p>
          </div>
          {/* ── One folder per position ───────────────────────────────────────────────────────
              The owner, 2026-08-28: "he goes to a folder called Nasr City Medical Reps ... he can
              look at the same page when he wants a certain position." A manager filling a seat
              reads the CVs for that seat together, and a flat newest-first list interleaves five
              vacancies, so comparing two candidates for one job means scrolling past three for
              other ones.

              Headings appear only once there is more than one GROUP to separate — and the sends
              with no position count as one of those groups. A lone folder with nothing beside it
              is just a list, and a heading on it would separate nothing. */}
          {showGroupHeadings
            ? positionFolders.map((folder) => (
                <div className="space-y-3" key={folder.key}>
                  <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-1">
                    <h3 className="text-sm font-bold text-slate-800">{folder.label}</h3>
                    <span className="shrink-0 text-xs font-semibold text-slate-500">
                      {folder.candidates.length === 1 ? "1 CV" : `${folder.candidates.length} CVs`}
                    </span>
                  </div>
                  {folder.candidates.map((candidate) => (
                    renderSentCard(candidate)
                  ))}
                </div>
              ))
            : positionFolders.flatMap((folder) =>
                folder.candidates.map((candidate) => renderSentCard(candidate)),
              )}
          {/* Sent before a position could be chosen, or sent without one. Never hidden — each is a
              real person somebody was asked to review — but kept apart from the folders rather than
              filed under an invented heading that would read like a vacancy of its own. */}
          {unfiledSends.length > 0 ? (
            <div className="space-y-3">
              {showGroupHeadings ? (
                <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-1">
                  <h3 className="text-sm font-bold text-slate-800">No position given</h3>
                  <span className="shrink-0 text-xs font-semibold text-slate-500">
                    {unfiledSends.length === 1 ? "1 CV" : `${unfiledSends.length} CVs`}
                  </span>
                </div>
              ) : null}
              {unfiledSends.map((candidate) => (
                renderSentCard(candidate)
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* His shelf, immediately under the list it was filled from — a CV he "kept for later" has to
          be somewhere he can see he kept it, or the button reads as a delete. Renders nothing at all
          until the first CV is filed. */}
      <ManagerFoldersSection renderCandidate={renderSentCard} shelves={shelves} totalFiled={filedCount} />

      {/* His own areas, after the CVs he owes an answer on and before his team's. This is a place to
          go looking rather than a queue: nobody is waiting on him for anything in here, so it must
          not sit above the list that is. */}
      <DistrictFoldersSection
        boards={areaBoards}
        callClaims={callClaims}
        files={files}
        ownFolders
        renderOwnCard={(candidate) => renderSentCard(sentById.get(candidate.id) ?? candidate)}
        unseenIds={unseenIds}
        viewerHrId={viewerHrId}
      />

      {/* After the caller's own CVs, deliberately. The ones sent to HIM are the ones he still owes an
          answer on; his team's are for oversight and carry no obligation, so they must not push his
          own queue below the fold. */}
      <TeamCandidatesSection
        managers={initialTeam}
        viewerHrId={viewerHrId}
      />

      {applications.length > 0 ? (
        <section className="space-y-4">
          {sentToMe.length > 0 ? (
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Your open positions</h2>
              <p className="text-xs text-slate-500">Candidates assigned to a position you are the hiring manager for.</p>
            </div>
          ) : null}
          {applications.map((application) => (
            <CandidateCard
              application={application}
              claim={callClaims[application.candidate?.id ?? ""] ?? null}
              files={files[application.candidate?.id ?? ""] ?? []}
              key={application.id}
              onChanged={reload}
              viewerHrId={viewerHrId}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}
