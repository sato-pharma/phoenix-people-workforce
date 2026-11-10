"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BriefcaseBusiness, CalendarClock, CheckCircle2, ClipboardCheck, Folder, Inbox, PhoneCall, SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  RecruitmentEmptyState,
  RecruitmentPanel,
  RecruitmentPill,
  type RecruitmentPillTone,
} from "@/components/recruitment/recruitment-premium";
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
import { ManagerCvList, ManagerCvListContext } from "@/components/employee-portal/manager-cv-list";
import { ManagerFoldersSection } from "@/components/employee-portal/manager-folders-section";
import { MyCandidatesFindBar } from "@/components/employee-portal/my-candidates-find-bar";
import { TeamCandidatesSection, type TeamManagerOption } from "@/components/employee-portal/team-candidates-section";
import { CandidateRow, RowFlag } from "@/components/recruitment/workspace/candidate-row";
import { managerWorkspaceRow } from "@/components/recruitment/workspace/manager-row";
import { OpenedCv } from "@/components/recruitment/workspace/opened-cv";
import { cairoDayLabel } from "@/components/recruitment/workspace/workspace-format";
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
import {
  countMyCandidatesViews,
  findTokens,
  isAwaitingManagerAnswer,
  isFindActive,
  matchesMyCandidatesFind,
  narrowBoards,
  type MyCandidatesEntry,
  type MyCandidatesFind,
  type MyCandidatesView,
} from "@/lib/recruitment/my-candidates-find";
import { requisitionRoleLabel, type RequisitionPlaces } from "@/lib/recruitment/my-candidates-tidy";
import { groupCandidatesByPosition, shouldShowGroupHeadings } from "@/lib/recruitment/position-folder";
import type { Candidate, Interview, TeamCandidateFile } from "@/lib/recruitment/types";
import type { WorkspaceAnswerChip } from "@/lib/recruitment/workspace/types";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { adminPanelDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";

type Props = {
  /**
   * Every active area with its RECRUITMENT region, for the folder picker. Loaded on the server
   * because it reads the org chart — see candidate-folder-options.ts, and note that a Sharkia area
   * files under Delta (3) here while the sales geography deliberately still says Delta (2).
   */
  areaOptions: CandidateFolderAreaOption[];
  initialApplications: ApplicationWithContext[];
  /**
   * Area and line names for the requisitions on the cards, so a position reads as its role and area
   * and never as the request code (owner, 2026-10-26). Absent = the role alone.
   */
  requisitionPlaces?: RequisitionPlaces;
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
  /**
   * Every CV's answers as the workspace's labelled chips, keyed by candidate id — built on the server
   * from the applicant's own replies, with the same labels HR reads ("one question, one name").
   * Absent for a CV means its row says it holds no answers, never a guess from the CV.
   */
  initialAnswerChips?: Record<string, WorkspaceAnswerChip[]>;
  /** The CV a notification linked to (`?candidate=`), opened on arrival. */
  initialOpenId?: string | null;
  /**
   * Today in Cairo, from the server — a render never reads the clock (hydration). Only its YEAR is
   * read: a date in another year prints its year. Absent, every date prints its year, which is
   * still true and never differs between the server and the browser.
   */
  today?: string;
};

/**
 * ONE CV OPEN AT A TIME, across every list on this screen (owner, 20 Oct 2026: the workspace's
 * "pressing a name opens the CV in place; pressing it again closes it; one is open at a time").
 * Every card reads it, so the sent list, the position cards and the folders behave as one list.
 */
type ManagerOpenState = {
  chips: Record<string, WorkspaceAnswerChip[]>;
  openId: string | null;
  today: string;
  toggle: (candidateId: string) => void;
};

const ManagerOpenContext = createContext<ManagerOpenState>({ chips: {}, openId: null, today: "", toggle: () => undefined });

function stayPut() {
  // A CV opened outside any list has nothing to walk; Previous and Next are not drawn.
}

/** A key pressed while the reader is typing belongs to what he is typing in. */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName)));
}

/** Open a neighbouring CV and bring its row to the top — after it has opened, so the scroll lands on it. */
function openAndReveal(toggle: (candidateId: string) => void, candidateId: string) {
  toggle(candidateId);
  requestAnimationFrame(() => document.getElementById(`candidate-${candidateId}`)?.scrollIntoView({ block: "start" }));
}

/**
 * One CV on this screen: the workspace's two-line row, and under it — when pressed — the opened CV
 * with the manager's own controls. The frame is square and lifted, like every list on the portal.
 *
 * PREVIOUS AND NEXT WALK THE LIST THE CV SITS IN (owner, 2026-11-10: "god mode enhancements"). The
 * workspace's opened CV always had the two buttons and the "3 of 12"; this screen drew them dead. Now
 * the nearest `ManagerCvList` names the order, the buttons open the neighbour in place and bring it
 * into view, and J/K (or ↓/↑) do the same from the keyboard — the keys the workspace already uses.
 */
function ManagerCvFrame({
  candidate,
  cvDocument,
  files,
  flags,
  slot,
}: {
  candidate: Candidate;
  cvDocument: ReactNode;
  files: TeamCandidateFile[];
  flags: ReactNode;
  slot: ReactNode;
}) {
  const { chips, openId, today, toggle } = useContext(ManagerOpenContext);
  const list = useContext(ManagerCvListContext);
  const opened = openId === candidate.id;
  const row = managerWorkspaceRow(candidate, { answers: chips[candidate.id], hasCvFile: files.length > 0 });
  const index = list ? list.indexOf(candidate.id) : -1;
  const previousId = list && index > 0 ? (list[index - 1] ?? null) : null;
  const nextId = list && index >= 0 && index < list.length - 1 ? (list[index + 1] ?? null) : null;
  const position = list && index >= 0 && list.length > 1 ? `${index + 1} of ${list.length}` : null;

  useEffect(() => {
    if (!opened) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const target = key === "j" || key === "ArrowDown" ? nextId : key === "k" || key === "ArrowUp" ? previousId : null;
      if (!target) return;
      event.preventDefault();
      openAndReveal(toggle, target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextId, opened, previousId, toggle]);

  const goTo = (candidateId: string) => openAndReveal(toggle, candidateId);
  return (
    <div className={`scroll-mt-24 border-x border-t border-slate-200 bg-white ${adminPanelDepthClassName}`} id={`candidate-${candidate.id}`}>
      <CandidateRow canEdit={false} extraFlags={flags} mode="manager" onToggle={toggle} opened={opened} row={row} today={today} viewingTab={null} />
      {opened ? (
        <div className="border-b border-slate-200">
          <OpenedCv
            canWork={false}
            cvDocument={cvDocument}
            hasNext={nextId !== null}
            hasPrevious={previousId !== null}
            layout="split"
            managerSlot={slot}
            mode="manager"
            onClose={() => toggle(candidate.id)}
            onNext={nextId ? () => goTo(nextId) : stayPut}
            onPrevious={previousId ? () => goTo(previousId) : stayPut}
            position={position}
            row={row}
            today={today}
            viewingTab={null}
          />
        </div>
      ) : null}
    </div>
  );
}

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
const stageLabels: Record<string, { label: string; tone: RecruitmentPillTone }> = {
  application_rejected: { label: "Not qualified", tone: "rose" },
  application_withdrawn: { label: "Withdrawn", tone: "slate" },
  final_selection: { label: "Final selection (recruitment)", tone: "emerald" },
  hired: { label: "Hired", tone: "emerald" },
  hiring_manager_interview: { label: "Ready for your interview", tone: "amber" },
  manager_interview_completed: { label: "Passed to recruitment", tone: "emerald" },
};

function stageBadge(stage: string): { label: string; tone: RecruitmentPillTone } {
  return stageLabels[stage] ?? { label: "With recruitment", tone: "slate" };
}

/** A heading inside a card: a small icon, then the words, in the module's uppercase label style. */
function CardSectionHeading({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] text-slate-600">
      <span aria-hidden="true" className="text-orange-500">
        {icon}
      </span>
      {children}
    </p>
  );
}

/**
 * The heading over one position folder in "Sent to you" — the folder mark, its name, and how many
 * CVs it holds as a chip. Wraps on a phone: a long position name is the one a manager most needs
 * to read in full.
 */
function PositionFolderHeading({ count, label }: { count: number; label: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-200 pb-1.5">
      <Folder aria-hidden="true" className="h-4 w-4 flex-none text-amber-500" />
      <h3 className="min-w-0 break-words text-sm font-black text-slate-900">{label}</h3>
      <RecruitmentPill tone="slate">{count === 1 ? "1 CV" : `${count} CVs`}</RecruitmentPill>
    </div>
  );
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
    <div className="min-w-0">
      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-0.5 break-words font-semibold text-slate-800" dir="auto">
        {value?.trim() ? value : "—"}
      </p>
    </div>
  );
}

/** The card's facts, in one recessed well so they read as a block apart from the actions below. */
const factsWellClassName = `grid grid-cols-1 gap-3 border border-slate-200 bg-slate-50/60 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3 ${adminRecessedDepthClassName}`;

function CandidateCard({
  application,
  claim,
  files,
  onChanged,
  places,
  viewerHrId,
}: {
  application: ApplicationWithContext;
  /** Who has said they will call this candidate — the only thing that reveals the phone number. */
  claim: CandidateCallClaim | null;
  /** Loaded with the page, for the same reason as the sent-to-you cards. */
  files: TeamCandidateFile[];
  onChanged: () => void;
  /** Area and line names for the position label. */
  places?: RequisitionPlaces;
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

  const { today } = useContext(ManagerOpenContext);
  const flags = (
    <>
      <RowFlag icon={<BriefcaseBusiness aria-hidden="true" className="h-3 w-3" />} tone="slate">
        {requisitionRoleLabel(requisition, places)}
      </RowFlag>
      <RowFlag tone={badge.tone}>{badge.label}</RowFlag>
      {canAct ? <RowFlag tone="orange">Waiting on you</RowFlag> : null}
      {hmInterview?.scheduledAt ? <RowFlag tone="sky">{`Your interview · ${cairoDayLabel(hmInterview.scheduledAt, today)}`}</RowFlag> : null}
    </>
  );

  const slot = (
    <>
      <CandidateCallNotice claim={call.claim} viewerHrId={viewerHrId} />
      <CandidateOpenedNotice candidateId={candidate.id} />

      <div className={factsWellClassName}>
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

      <CandidateCallControl
        canAct={canAct}
        candidateId={candidate.id}
        claim={call.claim}
        onChanged={call.apply}
        viewerHrId={viewerHrId}
      />

      <CandidateCommentThread candidateId={candidate.id} viewerHrId={viewerHrId} />

      {error ? (
        <p className="text-xs font-semibold text-rose-700" dir="auto" role="alert">
          {error}
        </p>
      ) : null}

      {canAct && !hmInterview ? (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <CardSectionHeading icon={<CalendarClock className="h-3.5 w-3.5" />}>Schedule your interview</CardSectionHeading>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              aria-label="Interview date and time"
              className={phxFieldClassName}
              onChange={(event) => setScheduledAt(event.target.value)}
              type="datetime-local"
              value={scheduledAt}
            />
            <input
              aria-label="Location"
              className={phxFieldClassName}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Location (or phone/video)"
              value={location}
            />
            <input
              aria-label="Meeting link"
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
          <CardSectionHeading icon={<ClipboardCheck className="h-3.5 w-3.5" />}>
            Interview{hmInterview.scheduledAt ? ` on ${cairoDateTime(hmInterview.scheduledAt)}` : ""} — record your feedback
          </CardSectionHeading>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {hiringManagerCriteria.map((criterion) => (
              <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600" key={criterion.key}>
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
            aria-label="Feedback notes"
            className={phxTextareaClassName}
            dir="auto"
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
    </>
  );

  return (
    <ManagerCvFrame
      candidate={candidate}
      cvDocument={
        <CandidateCvActions
          candidateId={candidate.id}
          candidateName={candidate.fullName}
          initialFiles={files}
          showPhoneNumbers={call.mine}
        />
      }
      files={files}
      flags={flags}
      slot={slot}
    />
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
  const [hidden, setHidden] = useState(false);
  // A CV sent to this manager is fully his — number, file, everything (owner, 2026-10-16).
  const call = useCandidateCall(initial, initialClaim, viewerHrId, true);
  const { today } = useContext(ManagerOpenContext);

  /**
   * Hide this CV from HIS folders — one press, no reason (owner, 2026-10-16: "make district manager
   * able to hide the CV if he received him"). The server ends his hold, so the CV also leaves his
   * "Sent to you" list and the hourly reminder; Talent Acquisition keeps it and can send it again.
   */
  const hide = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendJson(`/api/recruitment/hiring-manager/candidates/${candidate.id}/hide`, "POST", {});
      setHidden(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to hide that CV.");
    } finally {
      setBusy(false);
    }
  };

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

  if (hidden) {
    return (
      <div
        className={`scroll-mt-24 border border-slate-200 border-l-4 border-l-slate-300 bg-slate-50/60 px-4 py-3 text-sm text-slate-500 ${adminRecessedDepthClassName}`}
        id={`candidate-${candidate.id}`}
      >
        {candidate.fullName} is hidden from your folders. The recruitment team still has the CV.
      </div>
    );
  }

  const appliedFor = candidateRowAppliedFor(candidate);
  const flags = (
    <>
      {awaitingAnswer ? <RowFlag tone="orange">Waiting on you</RowFlag> : null}
      {notified ? <RowFlag tone="slate">{`Sent to you · ${cairoDayLabel(notified.sentAt, today)}`}</RowFlag> : null}
      {call.claim ? (
        <RowFlag icon={<PhoneCall aria-hidden="true" className="h-3 w-3" />} tone={call.mine ? "emerald" : "amber"}>
          {call.mine ? "You will call" : `${call.claim.managerName ?? "Another manager"} will call`}
        </RowFlag>
      ) : null}
    </>
  );

  const slot = (
    <>
      {/* Who has taken this CV, at the TOP of the card. A manager must know it is somebody else's
          before he reads a word of it, not after he has formed an opinion at the foot of the card. */}
      <CandidateCallNotice claim={call.claim} viewerHrId={viewerHrId} />
      {/* Who ELSE has read this CV, right under who has taken it. Same reason, same place: a manager
          must know a colleague has already looked before he reads a word of it. */}
      <CandidateOpenedNotice candidateId={candidate.id} />

      {/* The one question a manager opens this card to answer. Read through the same evidence
          ladder the pool table uses, because `applied_for_job_title` is filled on 15 of the 555
          production rows — reading only that made this line say "no role stated" on 540 CVs.
          The source is named in the hover text, so a derived role never reads as a stated one. */}
      <p
        className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-700"
        title={appliedFor.source ? `${APPLIED_FOR_SOURCE_LABEL[appliedFor.source]}: ${appliedFor.evidence}` : undefined}
      >
        <BriefcaseBusiness aria-hidden="true" className="h-4 w-4 text-orange-500" />
        <span className="min-w-0 break-words" dir="auto">
          {appliedFor.text ? `Applying for ${appliedFor.text}` : "No role stated on the application"}
        </span>
      </p>

      <div className={factsWellClassName}>
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
        {/* The third answer, and the one the owner asked for on 2026-08-30: neither "Interview" nor
            "Not interested" is true of a good CV that simply is not needed this month. Filing writes
            to HIS shelf only - the recruitment team's pool does not move. */}
        <CandidateFolderControl
          areaOptions={areaOptions}
          candidate={candidate}
          filing={filing}
          onChanged={(next) => onFilingChanged(candidate.id, next)}
        />
        {/* Hide: the CV leaves HIS folders and stops reminding him, with no reason asked. It is not
            an answer to the recruiter (that is Skip) and it rejects nobody. */}
        <Button disabled={busy} onClick={() => void hide()} size="sm" variant="outline">
          Hide
        </Button>
      </div>

      {error ? (
        <p className="text-xs font-semibold text-rose-700" dir="auto" role="alert">
          {error}
        </p>
      ) : null}

      {/* ONE FIELD, NOT TWO. The owner, 2026-09-09: *"I have two fields for your answer and your
          comments — merge them into one field, no need two fields."* There is only one thing to
          type on a CV, which is what he found, so the answer buttons moved DOWN
          into the comment box rather than the box being duplicated above them. Skip sends whatever
          is in that box as the reason it has always required. */}
      {!awaitingAnswer ? (
        <div className="border-t border-slate-100 pt-3">
          <p className="flex flex-wrap items-start gap-1.5 break-words text-xs text-slate-500">
            <CheckCircle2 aria-hidden="true" className="mt-px h-3.5 w-3.5 flex-none text-emerald-600" />
            <span className="min-w-0" dir="auto">
              You answered: {candidateStatusLabel(candidate.status)}
              {candidate.statusNote?.trim() ? ` — ${candidate.statusNote}` : ""}
            </span>
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
    </>
  );

  return (
    <ManagerCvFrame
      candidate={candidate}
      cvDocument={
        <CandidateCvActions
          candidateId={candidate.id}
          candidateName={candidate.fullName}
          initialFiles={files}
          showPhoneNumbers={call.mine}
        />
      }
      files={files}
      flags={flags}
      slot={slot}
    />
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
  initialAnswerChips,
  initialApplications,
  initialCallClaims: callClaims,
  initialDistrictBoards,
  initialFilings,
  initialFiles: files,
  initialOpenId,
  initialSentToMe: sentToMe,
  initialTeam,
  initialUnseenIds,
  requisitionPlaces,
  today,
  viewerHrId,
}: Props) {
  const [applications, setApplications] = useState(initialApplications);
  const [filings, setFilings] = useState<ManagerFolderFilings>(initialFilings);
  // The CV a notification named opens on arrival; after that one press opens, the same press closes.
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const toggle = useCallback((candidateId: string) => setOpenId((current) => (current === candidateId ? null : candidateId)), []);
  const openState = useMemo(
    () => ({ chips: initialAnswerChips ?? {}, openId, today: today ?? "", toggle }),
    [initialAnswerChips, openId, today, toggle],
  );

  // Bring the linked CV into view once, on arrival. A DOM call, not state: nothing re-renders.
  useEffect(() => {
    if (initialOpenId) document.getElementById(`candidate-${initialOpenId}`)?.scrollIntoView({ block: "start" });
  }, [initialOpenId]);

  const sentById = useMemo(() => new Map(sentToMe.map((candidate) => [candidate.id, candidate])), [sentToMe]);
  const unseenIds = useMemo(() => new Set(initialUnseenIds ?? []), [initialUnseenIds]);

  // ── FIND: one search and four quick views over every list of his own (owner, 2026-11-10) ───────
  //
  // The lists are narrowed HERE, before any section sees them, so the sent list, his shelf, his area
  // folders and his open positions all answer the same question at once. A folder CV is judged on
  // the sent copy when there is one — the same copy its card draws. His team's CVs are not narrowed:
  // that section reads its own data for the manager he picks, and it carries no obligation.
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MyCandidatesView>("all");
  const find = useMemo<MyCandidatesFind>(
    () => ({ claims: callClaims, tokens: findTokens(query), unseenIds, view, viewerHrId }),
    [callClaims, query, unseenIds, view, viewerHrId],
  );
  const narrowing = isFindActive(find);
  // What the folders are narrowed by, so a folder can open its first match on a new search — "" is everything.
  const narrowKey = narrowing ? `${view}|${find.tokens.join(" ")}` : "";
  const keepSent = useCallback(
    (candidate: Candidate) => matchesMyCandidatesFind(candidate, isAwaitingManagerAnswer(candidate.status), find),
    [find],
  );
  const shownSentToMe = useMemo(() => (narrowing ? sentToMe.filter(keepSent) : sentToMe), [keepSent, narrowing, sentToMe]);
  const shownBoards = useMemo(
    () => (narrowing ? narrowBoards(initialDistrictBoards, (candidate) => keepSent(sentById.get(candidate.id) ?? candidate)) : initialDistrictBoards),
    [initialDistrictBoards, keepSent, narrowing, sentById],
  );
  const shownApplications = useMemo(
    () =>
      narrowing
        ? applications.filter((application) =>
            application.candidate ? matchesMyCandidatesFind(application.candidate, application.stage === "hiring_manager_interview", find) : false,
          )
        : applications,
    [applications, find, narrowing],
  );
  // Every person on his own lists once, with whether he still owes them an answer — the tab counts.
  const findEntries = useMemo<MyCandidatesEntry[]>(
    () => [
      ...sentToMe.map((candidate) => ({ awaiting: isAwaitingManagerAnswer(candidate.status), candidate })),
      ...initialDistrictBoards.flatMap((board) =>
        board.folders.flatMap((folder) =>
          folder.candidates.map((folderCandidate) => {
            const candidate = sentById.get(folderCandidate.id) ?? folderCandidate;
            return { awaiting: isAwaitingManagerAnswer(candidate.status), candidate };
          }),
        ),
      ),
      ...applications.flatMap((application) =>
        application.candidate ? [{ awaiting: application.stage === "hiring_manager_interview", candidate: application.candidate }] : [],
      ),
    ],
    [applications, initialDistrictBoards, sentById, sentToMe],
  );
  const viewCounts = useMemo(
    () => countMyCandidatesViews(findEntries, { claims: callClaims, tokens: find.tokens, unseenIds, viewerHrId }),
    [callClaims, find.tokens, findEntries, unseenIds, viewerHrId],
  );
  const peopleOnLists = useMemo(
    () => countMyCandidatesViews(findEntries, { claims: callClaims, tokens: [], unseenIds, viewerHrId }).all,
    [callClaims, findEntries, unseenIds, viewerHrId],
  );
  const nothingMatches = narrowing && viewCounts[view] === 0;

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
  } = useMemo(() => partitionManagerCandidates(shownSentToMe, filings), [filings, shownSentToMe]);

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
  const areaBoards = shownBoards;
  // The order the sent list is drawn in, for Previous and Next: the position folders, then the CVs
  // with no position — the same order whether or not the headings are shown.
  const liveSendOrder = useMemo(
    () => [...positionFolders.flatMap((folder) => folder.candidates.map((candidate) => candidate.id)), ...unfiledSends.map((candidate) => candidate.id)],
    [positionFolders, unfiledSends],
  );
  const applicationOrder = useMemo(
    () => shownApplications.flatMap((application) => (application.candidate ? [application.candidate.id] : [])),
    [shownApplications],
  );
  const showEverything = () => {
    setQuery("");
    setView("all");
  };

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
      <div className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
        <RecruitmentEmptyState
          icon={<Inbox aria-hidden="true" className="h-5 w-5" />}
          message="CVs the recruitment team sends you, and candidates assigned to your open positions, will appear here."
          title="No candidates yet"
        />
      </div>
    );
  }

  return (
    <ManagerOpenContext.Provider value={openState}>
      <div className="space-y-6">
        {/* The find tray, over his own lists and only when he has some: a National Sales Manager whose
            page is only his team's folders has nothing here for it to narrow. */}
        {peopleOnLists > 0 ? (
          <MyCandidatesFindBar
            counts={viewCounts}
            onQueryChange={setQuery}
            onViewChange={setView}
            query={query}
            shown={viewCounts[view]}
            total={peopleOnLists}
            view={view}
          />
        ) : null}

        {/* Nothing matched: said once, in words, with the way back — never a page of empty folders,
            each of which would claim that nothing was ever sent for its area. */}
        {nothingMatches ? (
          <div className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
            <RecruitmentEmptyState
              action={
                <Button onClick={showEverything} size="sm" variant="outline">
                  Show everything
                </Button>
              }
              icon={<SearchX aria-hidden="true" className="h-5 w-5" />}
              message={
                query.trim()
                  ? `No CV on your lists matches “${query.trim()}”${view === "all" ? "" : " in this view"}. Try fewer words, or part of a name or number.`
                  : "No CV on your lists is in this view right now."
              }
              title="Nothing matches"
            />
          </div>
        ) : null}

        {/* Sent-to-you first, deliberately: this is the list the notification links to, and it is the
            one that needs an answer. The requisition-based applications below are the longer route
            and are already sitting in a workflow. */}
        {!nothingMatches && liveSends.length > 0 ? (
          <RecruitmentPanel
            bodyClassName="space-y-4 bg-slate-50/60 p-3 sm:p-4"
            count={liveSends.length}
            description={
              <>
                CVs the recruitment team asked you to look at. A CV in one of your folders stays until it is taken back
                or you return it; any other CV goes back to the recruitment team after {MANAGER_HOLD_DAYS} days.
              </>
            }
            icon={<Inbox aria-hidden="true" className="h-4 w-4" />}
            title="Sent to you"
          >
            <ManagerCvList ids={liveSendOrder}>
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
                      <PositionFolderHeading count={folder.candidates.length} label={folder.label} />
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
                  {showGroupHeadings ? <PositionFolderHeading count={unfiledSends.length} label="No position given" /> : null}
                  {unfiledSends.map((candidate) => (
                    renderSentCard(candidate)
                  ))}
                </div>
              ) : null}
            </ManagerCvList>
          </RecruitmentPanel>
        ) : null}

        {/* His shelf, immediately under the list it was filled from — a CV he "kept for later" has to
            be somewhere he can see he kept it, or the button reads as a delete. Renders nothing at all
            until the first CV is filed. */}
        {nothingMatches ? null : (
          <ManagerFoldersSection narrowKey={narrowKey} renderCandidate={renderSentCard} shelves={shelves} totalFiled={filedCount} />
        )}

        {/* His own areas, after the CVs he owes an answer on and before his team's. This is a place to
            go looking rather than a queue: nobody is waiting on him for anything in here, so it must
            not sit above the list that is. */}
        {nothingMatches ? null : (
          <DistrictFoldersSection
            boards={areaBoards}
            callClaims={callClaims}
            files={files}
            narrowKey={narrowKey}
            ownFolders
            renderOwnCard={(candidate) => renderSentCard(sentById.get(candidate.id) ?? candidate)}
            unseenIds={unseenIds}
            viewerHrId={viewerHrId}
          />
        )}

        {/* After the caller's own CVs, deliberately. The ones sent to HIM are the ones he still owes an
            answer on; his team's are for oversight and carry no obligation, so they must not push his
            own queue below the fold. */}
        <TeamCandidatesSection
          managers={initialTeam}
          viewerHrId={viewerHrId}
        />

        {/* His open positions, in the same panel every other list on this page wears — it used to be
            a bare heading that appeared only when something had also been sent to him. */}
        {!nothingMatches && shownApplications.length > 0 ? (
          <RecruitmentPanel
            bodyClassName="space-y-3 bg-slate-50/60 p-3 sm:p-4"
            count={shownApplications.length}
            description="Candidates assigned to a position you are the hiring manager for."
            icon={<BriefcaseBusiness aria-hidden="true" className="h-4 w-4" />}
            title="Your open positions"
          >
            <ManagerCvList ids={applicationOrder}>
              {shownApplications.map((application) => (
                <CandidateCard
                  application={application}
                  claim={callClaims[application.candidate?.id ?? ""] ?? null}
                  files={files[application.candidate?.id ?? ""] ?? []}
                  key={application.id}
                  onChanged={reload}
                  places={requisitionPlaces}
                  viewerHrId={viewerHrId}
                />
              ))}
            </ManagerCvList>
          </RecruitmentPanel>
        ) : null}
      </div>
    </ManagerOpenContext.Provider>
  );
}
