"use client";

// Recruitment / ATS — AREA 3: who is on screen, and what can be done about them.
//
// TWO BANDS, and the order matters. The identity band answers "who am I looking at and what did
// they apply for"; the decision band underneath it is the four things a recruiter does and the one
// button that moves on. They are stacked rather than merged because the identity is read once and
// the decisions are pressed repeatedly — a decision bar that moves as the name above it wraps is a
// decision bar you have to re-find on every candidate.
//
// EXCEPT IN FOCUS, where the two ARE merged into one line. That is the trade the owner asked for by
// name: at full screen the document is what matters, and one row of chrome is the most this screen
// is allowed to keep. It stays a deliberate exception rather than the default, because the merged
// row is exactly the thing the paragraph above warns about — acceptable when the point is to read,
// wrong when the point is to work down a list.
//
// THE DECISIONS ARE NOT SYMMETRICAL, and the buttons say so.
//
//   • SHORTLIST is one press. It is reversible, it notifies nobody, and it is the commonest thing a
//     recruiter does. Making it cost a dialog would be the tax this rebuild exists to remove.
//   • REJECT asks for a REASON. Not to slow it down — it is still two presses — but because the
//     free-text note is empty on most production rejections, so "why did we turn these people down"
//     is currently unanswerable. A ten-item list makes the answer countable at no cost to the
//     recruiter, and the free text stays underneath for the half a list cannot hold.
//   • SEND TO MANAGER reaches ANOTHER HUMAN'S notifications and cannot be recalled, so it opens a
//     panel and requires a deliberate press. Every other action on this screen is reversible from
//     this screen; this one is not.
//   • NEXT CANDIDATE never decides anything. Skipping is a legitimate act — "I want to come back to
//     this one" — and folding it into a decision would force a verdict a reader has not reached.
//
// NOTHING HERE DELETES ANYTHING. Rejecting writes a status and a history line; the candidate, the
// CV and every note stay readable and the decision stays reversible from the red pile. That is a
// deliberate constraint on this rebuild, not an omission.

import { useState } from "react";
import {
  CalendarPlus,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Minimize2,
  Phone,
  Send,
  SkipForward,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";

import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  candidateStatusLabel,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import { ManagerPicker, type ManagerPickerOption } from "@/components/recruitment/manager-picker";
import { CandidateApplicationActions } from "@/components/recruitment/candidate-application-actions";
import { WhatsAppReplyBox } from "@/components/recruitment/whatsapp-reply-box";
import { WhatsAppSendDialog } from "@/components/recruitment/whatsapp-send-dialog";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import { relativeDays, useSectionFold } from "@/components/recruitment/workstation/workstation-ui";
import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPill } from "@/components/recruitment/recruitment-premium";
import { phxWhatsAppShareButtonClassName } from "@/components/ui/brand-tokens";
import {
  composeRejectionNote,
  rejectionReasonLabels,
  rejectionReasons,
  type RejectionReason,
} from "@/lib/recruitment/rejection-reasons";
import { normalizeJobTitle } from "@/lib/recruitment/candidate-role-family";
import { roleFitVerdictLabels } from "@/lib/recruitment/role-fit";
import type { WorkspaceCandidateRow, WorkspaceVacancy } from "@/lib/recruitment/screening-workspace-types";
import { FREE_POSITION, NO_POSITION, VacancyPicker } from "@/components/recruitment/vacancy-picker";
import { CandidateStars } from "@/components/recruitment/workstation/candidate-stars";
import { RequisitionRecommendationBand } from "@/components/recruitment/workstation/requisition-recommendation-band";
import type { CandidateRating } from "@/lib/recruitment/candidate-rating";
import { cn } from "@/lib/utils";
import {
  phxButtonAccentClassName,
  phxButtonApproveDenseClassName,
  phxButtonDangerClassName,
  phxButtonDangerDenseClassName,
  phxFieldClassName,
} from "@/components/ui/form-tokens";

export type SendState = {
  managerHrIds: string[];
  position: string;
  freeAreaName: string;
  freeJobTitle: string;
};

export function WorkstationReviewHeader({
  attachedTo,
  busy,
  canDecide,
  canRate,
  canReply,
  canSend,
  decided,
  error,
  focus,
  hiringManagers,
  onAttach,
  onDecide,
  onNext,
  onRate,
  onSend,
  onSendStateChange,
  onToggleFocus,
  positionSuggestions,
  rating,
  row,
  sendState,
  sentConfirmation,
  suggestedVacancyIds,
  vacancies,
}: {
  /** The requisition this sitting attached the CV to, or null. Replaces the recommendation band. */
  attachedTo: string | null;
  busy: boolean;
  /**
   * May this reader shortlist or reject this CV?
   *
   * The same `candidates:update` the status route enforces. Until 2026-09-18 the Shortlist and
   * Reject buttons here were drawn for every reader of the page whatever this said — only the S
   * hotkey and the bulk marks honoured it — so a reader without the grant would have been shown two
   * verdicts that answer 403. Absent, not disabled, like every other control this strip withholds.
   */
  canDecide: boolean;
  /**
   * May this reader put a star on a CV?
   *
   * The same `candidates:update` the rating route enforces — which is also what gates the
   * verdict buttons, since a star reorders the shared queue for everybody who screens and so is
   * a change to the record. A reader without it is shown no stars to press rather than three
   * that answer 403.
   */
  canRate: boolean;
  /**
   * May this reader answer an applicant on WhatsApp in their own words?
   *
   * The same `recruitment:update` the route itself enforces, so a reader who cannot send is never
   * shown a box that would refuse them. Not folded into `canSend`: that one is about pushing a CV
   * to a hiring manager, which is a different permission and a different act.
   */
  canReply: boolean;
  canSend: boolean;
  /** What THIS session decided, which outranks the stored status until the page is reloaded. */
  decided: CandidateStatus | null;
  error: string | null;
  /** The whole screen is the document. This band answers by becoming one line. */
  focus: boolean;
  hiringManagers: readonly ManagerPickerOption[];
  /** The one press on the recommendation band (owner, 2026-10-16) — see requisition-recommendation-band.tsx. */
  onAttach: (requisitionId: string) => void;
  onDecide: (status: CandidateStatus, note: string | null) => void;
  /**
   * Null on a CV's OWN page — the tab a press in the list opens. There is no queue in that tab to
   * move along (the list stays in the tab it was opened from), so the button would do nothing and
   * Shortlist's promise to move on would be false. Both go rather than lie.
   */
  onNext: (() => void) | null;
  /** `null` takes the star off. Never 0 — see candidate-rating.ts. */
  onRate: (next: CandidateRating | null) => void;
  onSend: () => void;
  onSendStateChange: (next: SendState) => void;
  onToggleFocus: () => void;
  /** Areas and job titles already in use, offered behind the free-typed position. */
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  /** The star as the reader sees it now — this sitting's if there is one, else the stored one. */
  rating: CandidateRating | null;
  row: WorkspaceCandidateRow;
  sendState: SendState;
  sentConfirmation: string | null;
  suggestedVacancyIds: readonly number[];
  vacancies: readonly WorkspaceVacancy[];
}) {
  const [rejecting, setRejecting] = useState(false);
  const [sending, setSending] = useState(false);
  // WhatsApp is a THIRD panel, and unlike the two above it opens a modal rather than an inline band.
  // Deliberate: the message form is too tall for this bar, and the recruiter is leaving the screen
  // for WhatsApp anyway — an inline band would push the CV itself off the page to do it.
  const [whatsAppOpen, setWhatsAppOpen] = useState(false);
  // BOTH BANDS FOLD, and each remembers its answer for the session, so it is done once rather than
  // per candidate. Folding the identity hands roughly 60px of a laptop screen back to the document,
  // which on a two-page CV is the difference between reading and scrolling; what survives that fold
  // is the name, the SEAT and the status — enough to be sure the buttons belong to the person on
  // screen, which is the one thing a decision bar must never get wrong.
  const [whoOpen, toggleWho] = useSectionFold("review:who");
  // `normalizeJobTitle` rather than a string compare, so "MEDICAL REPRESENTATIVE" and "Medical
  // Representative" are the same words and do not earn a line that repeats the seat above.
  const currentRoleLine =
    row.currentRole && normalizeJobTitle(row.currentRole.value) !== normalizeJobTitle(row.appliedForText)
      ? row.currentRole.value
      : null;
  // THE DECISION BAND FOLDS TOO. It did not, and the owner asked for the opposite in plain words:
  // he reads a CV at full screen. Its control sits in the identity line above rather than in the
  // band itself, so the band can leave the screen entirely rather than leave a handle behind that
  // is just a thinner bar.
  const [actionsOpen, toggleActions] = useSectionFold("review:actions");
  const status = decided ?? row.status ?? "new";
  // THE STAGE, in the recruitment kit's own pill — the same chip, in the same colour, that names a
  // stage on the pool, the folders and the interview calendar.
  const statusPill = (
    <RecruitmentPill tone={status === "rejected" ? "rose" : status === "new" ? "orange" : "emerald"}>
      {candidateStatusLabel(status)}
    </RecruitmentPill>
  );
  const decisions = (
    <>
      {/* ── THE STARS COME FIRST ──────────────────────────────────────────
          At the head of the strip because a star is the CHEAPEST thing on it and the only one that
          is not a commitment: it notifies nobody, decides nothing, moves nobody on, and is undone by
          pressing it again. Everything to its right leaves a mark somebody else will see.

          It is also not a button, which is why it does not wear the DecisionButton shape. Three of
          those in a row would read as three more verdicts to weigh up on a strip whose whole design
          note is that it had become a stripe of equal-weight rectangles. This is one control with
          three rungs, and it looks like one. */}
      {canRate ? <CandidateStars busy={busy} onRate={onRate} rating={rating} /> : null}
      {/* WHATSAPP SITS FIRST, and it is not a decision — it decides nothing and notifies nobody
          until the recruiter presses send inside WhatsApp itself. It lives in this group because
          this group is what renders on EVERY candidate in both the folded and full bands, which is
          what "on every CV" means. Rendered here rather than at the top level for the same reason:
          only one of the two bands is ever mounted, so exactly one dialog exists. */}
      <DecisionButton
        disabled={busy}
        icon={<MessageCircle className="h-3.5 w-3.5" />}
        label="WhatsApp"
        onClick={() => setWhatsAppOpen(true)}
        pressed={whatsAppOpen}
        tone="whatsapp"
      />
      {whatsAppOpen ? (
        <WhatsAppSendDialog
          candidateId={row.id}
          candidateName={row.fullName}
          onClose={() => setWhatsAppOpen(false)}
        />
      ) : null}
      {/* ── ANSWERING IN YOUR OWN WORDS, AT FULL SCREEN ─────────────────────────────────
          `&& focus` is what stops this being the SECOND copy on the ordinary layout, where the box
          already sits under the phone number it would send from — which is where it belongs when
          there is room for it. At full screen there is no identity block at all: the two bands
          collapse into this one row, so without this the only way to answer somebody you were
          reading was to leave full screen first. That is the press this whole mode exists to avoid.
          The two are never mounted together, so there is no second fetch and no second window check.

          It sits beside the template button because they are the same errand told apart by one fact:
          a template goes whenever, free text only inside WhatsApp’s 24-hour window.

          IT DOES NOT COST THE ROW. Idle it is one button, so the strip stays the single line the
          owner asked for; opened, its panel is `w-full`, which in this wrapping row puts it on its
          own line underneath and takes the space back the moment it is closed. */}
      {canReply && focus ? <WhatsAppReplyBox candidateId={row.id} /> : null}
      {/* ── LINKEDIN, WHEN THE CV GAVE ONE ──────────────────────────────────────────────────────
          Beside WhatsApp because it is the same kind of press: it reaches the PERSON and decides
          nothing, so it sits with the other way of reaching them and before the verdicts. That is
          where the owner asked for it (2026-09-18): beside WhatsApp, Shortlist and Reject.

          A LINK, NOT A BUTTON, and it opens a NEW TAB. The recruiter is mid-queue with a CV open;
          leaving the page to look somebody up would throw away the place in the queue, the open
          panels and the half-typed rejection reason. `noopener noreferrer` so LinkedIn's page gets
          no handle on this one and is not told which candidate record sent it.

          Absent, not disabled, when there is no profile: a greyed LinkedIn button on every CV that
          never gave one would be a control that can never be pressed.
          `row.linkedinUrl` is already the checked https://www.linkedin.com/in/ address — the
          server resolved it through linkedInProfileHref, so nothing the column holds reaches an href
          raw. */}
      {row.linkedinUrl ? (
        <DecisionLink
          href={row.linkedinUrl}
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          label="LinkedIn"
          title="Open this applicant's LinkedIn profile in a new tab."
        />
      ) : null}
      {/* ── SCHEDULE AN INTERVIEW, FROM THE CV ITSELF ───────────────────────────────────────────
          The owner's words (2026-09-18): "on the CV without any steps … from any screen, any CV".
          With the ways of reaching the person, before the verdicts: booking a slot decides nothing
          about the application and tells the candidate nothing — it only puts a name on the
          interview calendar. Drawn in this strip's own kit; the gate lives in the button, so it is
          absent for anyone the calendar's owner has not made an editor. */}
      <ScheduleInterviewButton
        candidate={{ id: row.id, jobTitle: row.appliedForText, name: row.fullName }}
        renderTrigger={({ open, pressed, title }) => (
          <DecisionButton
            disabled={busy}
            icon={<CalendarPlus className="h-3.5 w-3.5" />}
            label="Schedule interview"
            onClick={open}
            pressed={pressed}
            title={title}
            tone="info"
          />
        )}
      />
      {/* ── DOWNLOAD / PRINT THE APPLICATION, ON EVERY CV ───────────────────────────────────────────
          The owner, 2026-09-26: the WhatsApp Applicants' "Download application" / "Print application",
          "not only shortlisted, any CV in screening page". Keyed by the CANDIDATE, so it is on EVERY CV,
          not only the people who applied on WhatsApp: where they did, the file carries their questions and
          answers; where they did not, it is the CV plus the Job application form filled from the record.
          With the other ways of reaching the person and before the verdicts, because it produces a
          document and decides nothing. The route behind it is gated exactly like the file itself. */}
      <CandidateApplicationActions applicantName={row.fullName} candidateId={row.id} />
      {canDecide ? (
        <>
          <DecisionButton
            disabled={busy}
            hotkey="S"
            icon={<ThumbsUp className="h-3.5 w-3.5" />}
            label="Shortlist"
            onClick={() => onDecide("shortlisted", null)}
            title={
              onNext
                ? "Keep this one — press S. The queue moves to the next CV on its own."
                : "Keep this one — press S."
            }
            tone="ok"
          />
          <DecisionButton
            disabled={busy}
            icon={<ThumbsDown className="h-3.5 w-3.5" />}
            label="Reject"
            onClick={() => setRejecting((open) => !open)}
            pressed={rejecting}
            title="Turn this one down. No keyboard shortcut on purpose — it asks you for a reason first."
            tone="danger"
          />
        </>
      ) : null}
      {canSend ? (
        <DecisionButton
          disabled={busy}
          icon={<Send className="h-3.5 w-3.5" />}
          label="Send to manager"
          onClick={() => setSending((open) => !open)}
          pressed={sending}
          tone="info"
        />
      ) : null}

      <span className="flex-1" />

      {busy ? (
        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-phx-ink-soft">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving
        </span>
      ) : null}

      {onNext ? (
        <DecisionButton
          disabled={busy}
          hotkey="J"
          icon={<SkipForward className="h-3.5 w-3.5" />}
          label="Next candidate"
          onClick={onNext}
          title="The next CV in the queue — press J or the down arrow. K or the up arrow goes back one."
          tone="accent"
        />
      ) : null}
    </>
  );
  const afterBands = (
    <>
      {/* The recommendation is present only for Admin and Talent Acquisition — the loader leaves it
          null for everybody else — and only while the CV is still the screen's to place. */}
      {canDecide && row.requisitionRecommendation ? (
        <RequisitionRecommendationBand
          attachedTo={attachedTo}
          busy={busy}
          key={row.id}
          onAttach={onAttach}
          recommendation={row.requisitionRecommendation}
        />
      ) : null}
      {error ? (
        <p className="border-t border-phx-danger-line bg-phx-danger-bg px-4 py-1.5 text-[12px] font-semibold text-phx-danger">
          {error}
        </p>
      ) : null}
      {sentConfirmation ? (
        <p className="border-t border-phx-ok-line bg-phx-ok-bg px-4 py-1.5 text-[12px] font-semibold text-phx-ok">
          Sent to {sentConfirmation}.
        </p>
      ) : null}
      {rejecting && canDecide ? (
        <RejectPanel
          busy={busy}
          onCancel={() => setRejecting(false)}
          onConfirm={(note) => {
            setRejecting(false);
            onDecide("rejected", note);
          }}
        />
      ) : null}
      {sending && canSend ? (
        <SendPanel
          busy={busy}
          hiringManagers={hiringManagers}
          onChange={onSendStateChange}
          positionSuggestions={positionSuggestions}
          onSend={onSend}
          state={sendState}
          suggestedVacancyIds={suggestedVacancyIds}
          vacancies={vacancies}
        />
      ) : null}
    </>
  );

  // THE FOCUS STRIP. Two bands become one line: who it is, and what can be done. Nothing is taken
  // away - a decision taken at full screen is the same decision - and the way back is the FIRST
  // control on the row, where a reader looks for it, rather than a key he has to have been told.
  //
  // "Nothing is taken away" was not quite true until 2026-09-12: the WhatsApp REPLY box lived in the
  // identity block, and the identity block does not exist here, so answering an applicant meant
  // leaving full screen. It travels with `decisions` now - see the `&& focus` guard there.
  if (focus) {
    return (
      <div className="shrink-0 border-b border-phx-line bg-white">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-phx-surface-2 px-3 py-1">
          <button
            aria-label="Leave full-screen reading"
            className={`shrink-0 border border-phx-line bg-white p-1 text-phx-ink-2 transition-colors hover:border-phx-accent-line hover:text-phx-accent-press ${adminControlDepthClassName}`}
            onClick={onToggleFocus}
            title="Leave full-screen reading — or press Escape"
            type="button"
          >
            <Minimize2 aria-hidden className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-0 break-words text-[13px] font-black leading-tight text-phx-ink">
            {row.fullName}
          </span>
          <span className="min-w-0 flex-1 break-words text-[12px] font-bold leading-tight text-phx-accent-press">
            {row.appliedForText ?? "No job named on the application"}
          </span>
          {statusPill}
          {decisions}
        </div>
        {afterBands}
      </div>
    );
  }

  const actionsToggle = (
    <button
      aria-expanded={actionsOpen}
      aria-label={actionsOpen ? "Hide the decision bar" : "Show the decision bar"}
      className="shrink-0 text-phx-ink-faint transition-colors hover:text-phx-accent-press"
      onClick={toggleActions}
      title={actionsOpen ? "Hide the decision bar" : "Show the decision bar"}
      type="button"
    >
      {actionsOpen ? (
        <ChevronUp aria-hidden className="h-4 w-4" />
      ) : (
        <ChevronDown aria-hidden className="h-4 w-4" />
      )}
    </button>
  );

  // NO EDGE OF ITS OWN since 2026-10-19: the cockpit wraps this block and the duplicate line under it
  // in ONE lifted card — the focal surface of the page — so the hairline and the depth are the
  // card's, and an edge here would draw a second line along the card's own.
  return (
    <div className="shrink-0 bg-white">
      {/* ── Who ───────────────────────────────────────────────────────────── */}
      {!whoOpen ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
          <button
            aria-expanded={false}
            aria-label="Show the candidate's contact details"
            className="shrink-0 text-phx-ink-faint transition-colors hover:text-phx-accent-press"
            onClick={toggleWho}
            title="Show the candidate's contact details"
            type="button"
          >
            <ChevronRight aria-hidden className="h-4 w-4" />
          </button>
          <h2 className="min-w-0 break-words text-[15px] font-black leading-tight text-phx-ink">{row.fullName}</h2>
          <p className="min-w-0 flex-1 break-words text-[13px] font-bold leading-tight text-phx-accent-press">
            {row.appliedForText ?? "No job named on the application"}
          </p>
          {statusPill}
          {actionsToggle}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-2.5">
          <button
            aria-expanded
            aria-label="Hide the candidate's contact details"
            className="mt-1 shrink-0 text-phx-ink-faint transition-colors hover:text-phx-accent-press"
            onClick={toggleWho}
            title="Hide the candidate's contact details"
            type="button"
          >
            <ChevronDown aria-hidden className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-[20px] font-black leading-tight text-phx-ink">{row.fullName}</h2>
            {/* The SEAT, immediately under the name and heavier than the current job title — the same
                inversion the list uses, because a recruiter is filling a vacancy, not browsing people. */}
            <p className="mt-0.5 break-words text-[14px] font-bold leading-tight text-phx-accent-press">
              {row.appliedForText ?? "No job named on the application"}
            </p>
            {/* WHAT THEY DO NOW, directly under the seat, and only when it is a different job.
                The list row has carried this line since it was built; this pane did not — so a
                senior medical rep applying for a district manager seat read here as a plain
                "District Manager", with nothing saying the CV underneath is a medical rep's. That
                mismatch IS the screening fact on such a CV: it is the difference between reading
                somebody for the job they hold and reading them for a promotion. Measured on production
                2026-09-18: 55 candidates had asked for a district manager seat off a title that says
                something else. Suppressed when the two name the same job, so an ordinary CV pays no
                line for it. */}
            {currentRoleLine ? (
              <p
                className={cn(
                  "mt-0.5 break-words text-[12px] leading-tight",
                  row.currentRole?.confirmed ? "text-phx-ink-2" : "italic text-phx-ink-faint",
                )}
                title={row.currentRole?.confirmed ? undefined : "Read off the CV, but the reader was not confident."}
              >
                Currently {currentRoleLine}
              </p>
            ) : null}
            {/* The same sentence the list row carries, repeated here on purpose: the reader spends
                the minute that matters looking at THIS pane, and "why am I being shown this person
                for this seat" must be answerable without going back to the list. */}
            {row.seatReason ? (
              <p className="mt-0.5 break-words text-[12px] leading-tight text-phx-ink-soft">{row.seatReason}</p>
            ) : null}
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-phx-ink-soft">
              {row.locationLabel ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin aria-hidden className="h-3 w-3" />
                  {row.locationLabel}
                </span>
              ) : null}
              {row.phone ? (
                <a className="inline-flex items-center gap-1 hover:text-phx-ink" href={`tel:${row.phone}`}>
                  <Phone aria-hidden className="h-3 w-3" />
                  {row.phone}
                </a>
              ) : null}
              {row.email ? (
                <a className="inline-flex items-center gap-1 break-all hover:text-phx-ink" href={`mailto:${row.email}`}>
                  <Mail aria-hidden className="h-3 w-3" />
                  {row.email}
                </a>
              ) : null}
              <span>Arrived {relativeDays(row.createdAt)}</span>
              {row.source ? <span>via {row.source}</span> : null}
            </p>
            {/* ── ANSWERING THEM, ON THE SCREEN WHERE THEY ARE READ ─────────────────────────────
                Directly under the number it would be sent from, which is the only place it means
                anything. The WhatsApp button in the decision bar sends an approved TEMPLATE and works
                whenever; this sends free text and only works inside WhatsApp’s 24-hour window, so the
                two are deliberately not the same control — the box checks the window before it offers
                a field to type in, rather than letting Meta refuse the message afterwards.

                It draws as one quiet button until somebody asks for it, so a reader who never replies
                pays nothing for it being here. Folded away with the rest of this block. */}
            {canReply ? (
              <div className="mt-2">
                <WhatsAppReplyBox candidateId={row.id} />
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="flex items-center gap-1.5">
              {statusPill}
              {actionsToggle}
            </span>
            {/* The fit read, spelled out here rather than abbreviated as it is in the list — this is
                where there is room to say what the number actually means. */}
            <span
              className="text-right text-[11px] leading-tight text-phx-ink-soft"
              title="How many of the checks for this job the record answers. Not an AI score."
            >
              {row.fitScore === null ? (
                "Not enough on file to read a fit"
              ) : (
                <>
                  <span className="text-[14px] font-black text-phx-ink">{row.fitScore}</span>
                  {` / 100 · ${roleFitVerdictLabels[row.fitVerdict]}`}
                </>
              )}
            </span>
          </div>
        </div>
      )}

      {/* ── What can be done ──────────────────────────────────────────────── */}
      {actionsOpen ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-phx-line bg-phx-surface-2 px-4 py-1.5">
          {decisions}
        </div>
      ) : null}

      {afterBands}
    </div>
  );
}

type DecisionTone = "ok" | "danger" | "info" | "accent" | "whatsapp";

/**
 * Every press on the strip is this size and weight — a button and a link alike — and carries the
 * house control depth, dropped while it is disabled (a greyed control still floating reads as one
 * that will answer).
 */
const DECISION_SHAPE = `inline-flex items-center gap-1.5 border px-3 py-1.5 text-[13px] font-bold leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${adminControlDepthClassName} disabled:shadow-none`;

/**
 * A press at rest.
 *
 * SHORTLIST AND REJECT ARE THE HOUSE DECISION PAIR (2026-10-19, the owner's full premium sweep): the
 * approve green and the reject rose every other decision pair in Phoenix wears, from the form kit's
 * DENSE pair — colour only, so the strip's own shape above still sets their size and they stay the
 * same height as everything beside them. WhatsApp wears the WhatsApp brand button, like every
 * WhatsApp press in the app; the shape is applied after it, so it takes the strip's geometry and
 * keeps the brand's colours. The ways of reaching a person stay white with the meaning in the ink.
 */
function decisionRest(tone: DecisionTone): string {
  return tone === "ok"
    ? phxButtonApproveDenseClassName
    : tone === "danger"
      ? phxButtonDangerDenseClassName
      : tone === "info"
        ? "border-phx-line bg-white text-phx-info hover:border-phx-info-line hover:bg-phx-info-bg"
        : tone === "whatsapp"
          ? phxWhatsAppShareButtonClassName
          : "border-phx-accent-press bg-phx-accent text-phx-accent-ink hover:bg-phx-accent-hover";
}

function DecisionButton({
  disabled,
  hotkey,
  icon,
  label,
  onClick,
  pressed,
  title,
  tone,
}: {
  disabled: boolean;
  /**
   * The single key that does this, printed ON the button.
   *
   * THE SHORTCUTS WERE INVISIBLE UNTIL 2026-09-18. `screening-workstation.tsx` has bound J/K, S and
   * 0-3 since the day this screen shipped, with a comment reading "for the reader who is doing this
   * two hundred times" — and nothing anywhere on the screen said so. Seven of the eight keys could
   * only be found by reading the source, so a screener doing a thousand CVs a day did every one of
   * them with the mouse. The owner's verdict on the result was "zero functionality".
   *
   * The mark is the one this module's own predecessor already uses — candidate-screening-session.tsx
   * prints `<kbd>S</kbd>` inside the Shortlist button and names the key in the tooltip. This is that
   * pattern, not a new one: same element, same 10px, same place. The one difference is spelling:
   * that file writes `text-phx-2xs`, this one must write `text-[10px]`, because this file is pinned
   * against named font sizes — see the render below.
   *
   * OMITTED MEANS THERE IS NO KEY, and that is load-bearing. Reject opens a panel to ask for a
   * reason and is deliberately unbound; a `kbd` on it would promise a keystroke that does not exist.
   */
  hotkey?: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  /** Says what the press does, and names the key — or says why this one has none. */
  title?: string;
  tone: DecisionTone;
}) {
  // ── THE LOUD VOLUME IS SPENT ON THE VERDICTS AND ON MOVING ON — NOWHERE ELSE ──────────────────
  //
  // Until 2026-09-12 all five of these were filled blocks — green, red, blue, blue, orange, side by
  // side at the same size and the same weight. Five tinted rectangles in a row is not five
  // affordances, it is a stripe: nothing in it can be more important than anything else, and the
  // owner's word for the screen that resulted was "noisy". So the colour moved into the ink, and only
  // "Next candidate" kept a solid ground.
  //
  // 2026-10-19, THE OWNER'S FULL PREMIUM SWEEP: Shortlist and Reject wear the house decision pair —
  // solid approve-green and reject-rose, the pair every other verdict in Phoenix wears — and WhatsApp
  // wears its brand button. That is still not the stripe: the ways of reaching the person (LinkedIn,
  // the interview, the application, Send to manager) stay white with the meaning in the ink, so the
  // filled grounds are exactly the two verdicts, the brand press and the one that moves the work on.
  //
  // A PRESSED BUTTON HAS A PANEL OPEN UNDERNEATH IT, so it wears its darker fill and an inset
  // shadow — pushed in, not glowing. The old `ring-1` read as a halo, which is the one ornament this
  // design system does not own.
  const rest = tone === "whatsapp" ? null : decisionRest(tone);
  const held =
    tone === "ok"
      ? "border-emerald-700 bg-emerald-700 text-white"
      : tone === "danger"
        ? "border-rose-700 bg-rose-700 text-white"
        : tone === "info"
          ? "border-phx-info-line bg-phx-info-bg text-phx-info"
          : tone === "whatsapp"
            ? "border-[#1DA851] bg-[#1DA851] text-slate-900"
            : "border-phx-accent-press bg-phx-accent-hover text-phx-accent-ink";
  return (
    <button
      aria-pressed={pressed}
      className={cn(
        // The WhatsApp brand button goes FIRST, so the strip's shape after it wins the geometry and
        // the brand keeps its colours.
        tone === "whatsapp" ? phxWhatsAppShareButtonClassName : null,
        DECISION_SHAPE,
        pressed
          ? cn(held, "shadow-[inset_0_1px_2px_rgba(13,16,21,0.14)] hover:shadow-[inset_0_1px_2px_rgba(13,16,21,0.14)]")
          : rest,
      )}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {icon}
      {label}
      {/* `text-[10px]`, NOT `text-phx-2xs`, though the predecessor screen writes the named token and
          the two are the same 10px (tokens.css `--phx-fs-2xs`). tailwind-merge silently DROPS a
          custom named font size — it compiles away and the element inherits, visible only through
          getComputedStyle in a real browser — and this file is pinned against the named form by
          runRecruitmentScreeningWorkstationTests for exactly that reason. It caught this on the
          first push. The bracket literal is the always-safe spelling. */}
      {hotkey ? <kbd className="text-[10px] font-normal opacity-70">{hotkey}</kbd> : null}
    </button>
  );
}

/**
 * A press on the strip that GOES somewhere rather than does something — the LinkedIn profile.
 *
 * Wears exactly the DecisionButton shape in the info ink, so it reads as a sibling of WhatsApp and
 * not as a stray hyperlink in a row of controls. It has no pressed state and no hotkey: it opens a
 * page in another tab and leaves nothing open here to be held.
 */
function DecisionLink({
  href,
  icon,
  label,
  title,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  return (
    <a className={cn(DECISION_SHAPE, decisionRest("info"))} href={href} rel="noopener noreferrer" target="_blank" title={title}>
      {icon}
      {label}
    </a>
  );
}

/**
 * Why this one is being turned down.
 *
 * NOT A MODAL. It opens under the bar that summoned it, so the CV stays on screen — the reason a
 * recruiter is rejecting somebody is usually a line they are looking at, and a dialog that covers
 * the document makes them recall it instead of read it.
 */
function RejectPanel({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string | null) => void;
}) {
  const [reason, setReason] = useState<RejectionReason | null>(null);
  const [detail, setDetail] = useState("");

  return (
    <div className={cn("border-t border-phx-line bg-phx-paper px-4 py-2.5", adminRecessedDepthClassName)}>
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-phx-ink-2">Why are they not going forward?</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {rejectionReasons.map((key) => (
          <button
            aria-pressed={reason === key}
            className={cn(
              "border px-2 py-1 text-[12px] font-semibold leading-none transition-colors",
              reason === key
                ? "border-phx-danger-line bg-phx-danger text-white shadow-[inset_0_1px_2px_rgba(13,16,21,0.18)]"
                : "border-phx-line bg-white text-phx-ink-2 hover:border-phx-danger-line hover:text-phx-danger",
            )}
            key={key}
            onClick={() => setReason(key)}
            type="button"
          >
            {rejectionReasonLabels[key]}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          aria-label="Note"
          className={`${phxFieldClassName} min-w-0 flex-1`}
          maxLength={CANDIDATE_STATUS_NOTE_MAX_LENGTH}
          onChange={(event) => setDetail(event.target.value)}
          placeholder="Note — optional, kept in the candidate's history"
          value={detail}
        />
        {/* Backing out is the quietest thing in the panel. It was the same size and weight as the
            rejection beside it, which is the one pairing where "they look alike" costs something
            real. */}
        <Action onClick={onCancel} size="md" tone="ghost">
          Cancel
        </Action>
        <button
          className={cn(
            phxButtonDangerClassName,
            "px-3 py-2 text-[13px] leading-none disabled:cursor-not-allowed disabled:opacity-45",
            adminControlDepthClassName,
            "disabled:shadow-none",
          )}
          /* A reason is required and the button says so by staying off — the whole point of the
             list is that the archive can be counted, and an unlabelled rejection is the state this
             replaces.

             The one control on this page that is NOT built from the Action kit, and deliberately:
             the kit has three volumes and the loudest of them is the accent, which is the page's
             "carry on" colour. This is the single irreversible-feeling act on the screen and it has
             to be unmistakably its own thing — so it wears the house's reject token (2026-10-19), the
             same rose as the Reject that opened this panel, at the panel's own size. */
          disabled={busy || reason === null}
          onClick={() => {
            if (!reason) return;
            onConfirm(composeRejectionNote(reason, detail));
          }}
          type="button"
        >
          Confirm rejection
        </button>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-phx-ink-soft">
        Nothing is deleted. The candidate, their CV and every note stay on file, and the rejection can be undone from
        the rejected pile.
      </p>
    </div>
  );
}

/**
 * Where this CV is going, and to whom.
 *
 * The vacancy picker fills the manager picker, because the organogram already knows who owns the
 * seat and choosing the wrong manager is how a CV lands where nobody is looking. It only ever FILLS
 * an empty choice — a recruiter who deliberately picked the National Sales Manager keeps them.
 */
function SendPanel({
  busy,
  hiringManagers,
  onChange,
  onSend,
  positionSuggestions,
  state,
  suggestedVacancyIds,
  vacancies,
}: {
  busy: boolean;
  hiringManagers: readonly ManagerPickerOption[];
  onChange: (next: SendState) => void;
  onSend: () => void;
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  state: SendState;
  suggestedVacancyIds: readonly number[];
  vacancies: readonly WorkspaceVacancy[];
}) {
  const choosePosition = (value: string) => {
    const next: SendState = { ...state, position: value };
    if (value !== FREE_POSITION && value !== NO_POSITION && value) {
      const vacancy = vacancies.find((option) => String(option.id) === value);
      const managerHrId = vacancy?.managerHrId;
      if (managerHrId && hiringManagers.some((manager) => manager.hrId === managerHrId)) {
        // REPLACES rather than appends: picking a different seat is a change of mind about who this
        // CV is for, not a second recipient.
        next.managerHrIds = [managerHrId];
      }
    }
    onChange(next);
  };

  return (
    <div className={cn("border-t border-phx-line bg-phx-paper px-4 py-2.5", adminRecessedDepthClassName)}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[240px] flex-1">
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-phx-ink-soft">
            For which seat
          </label>
          <VacancyPicker
            disabled={busy}
            offerNoPosition={suggestedVacancyIds.length > 0}
            onChange={choosePosition}
            panelId="workstation-vacancy-picker"
            suggestedIds={[...suggestedVacancyIds]}
            suggestionLabel={suggestedVacancyIds.length > 1 ? "Looks like one of these" : "Looks like this one"}
            vacancies={[...vacancies]}
            value={state.position}
          />
        </div>
        <div className="min-w-[240px] flex-1">
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-[0.06em] text-phx-ink-soft">
            To which manager
          </label>
          <ManagerPicker
            disabled={busy}
            multiple
            onChange={(hrIds) => onChange({ ...state, managerHrIds: hrIds })}
            options={[...hiringManagers]}
            panelId="workstation-manager-picker"
            value={state.managerHrIds}
          />
        </div>
      </div>

      {state.position === FREE_POSITION ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {/* SUGGESTIONS, NOT A CLOSED LIST — the whole point of this option is that the position
              need not be an open seat yet, so the field stays free text and the datalist only
              offers what has already been used. Without it a second "Marketing Exec." opens a
              folder that reads almost exactly like the first one, and neither is findable by the
              other's name. Carried over from the screen this replaced rather than reinvented. */}
          <input
            aria-label="Job title"
            className={`${phxFieldClassName} min-w-[180px] flex-1`}
            list="workstation-position-titles"
            onChange={(event) => onChange({ ...state, freeJobTitle: event.target.value })}
            placeholder="Job title"
            value={state.freeJobTitle}
          />
          <input
            aria-label="Area"
            className={`${phxFieldClassName} min-w-[180px] flex-1`}
            list="workstation-position-areas"
            onChange={(event) => onChange({ ...state, freeAreaName: event.target.value })}
            placeholder="Area"
            value={state.freeAreaName}
          />
          <datalist id="workstation-position-titles">
            {positionSuggestions.jobTitles.map((title) => (
              <option key={title} value={title} />
            ))}
          </datalist>
          <datalist id="workstation-position-areas">
            {positionSuggestions.areas.map((area) => (
              <option key={area} value={area} />
            ))}
          </datalist>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* The panel's one commit, so it wears the form kit's terminal commit at the strip's size. */}
        <button
          className={cn(
            phxButtonAccentClassName,
            "px-3 py-1.5 text-[13px]",
            adminControlDepthClassName,
            "disabled:shadow-none",
          )}
          disabled={busy || state.managerHrIds.length === 0}
          onClick={onSend}
          type="button"
        >
          <Send className="h-3.5 w-3.5" />
          Send the CV
        </button>
        <p className="text-[11px] leading-relaxed text-phx-ink-soft">
          {/* Said plainly, because it is the one thing on this screen that cannot be taken back. */}
          This notifies the manager. It does not shortlist or reject — the verdict stays yours.
        </p>
      </div>
    </div>
  );
}
