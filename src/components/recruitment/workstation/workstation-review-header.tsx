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
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  Mail,
  MapPin,
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
import { ManagerPicker, type ManagerPickerOption } from "@/components/recruitment/manager-picker";
import { Pill, relativeDays, useSectionFold } from "@/components/recruitment/workstation/workstation-ui";
import {
  composeRejectionNote,
  rejectionReasonLabels,
  rejectionReasons,
  type RejectionReason,
} from "@/lib/recruitment/rejection-reasons";
import { roleFitVerdictLabels } from "@/lib/recruitment/role-fit";
import type { WorkspaceCandidateRow, WorkspaceVacancy } from "@/lib/recruitment/screening-workspace-types";
import { FREE_POSITION, NO_POSITION, VacancyPicker } from "@/components/recruitment/vacancy-picker";
import { cn } from "@/lib/utils";

export type SendState = {
  managerHrIds: string[];
  position: string;
  freeAreaName: string;
  freeJobTitle: string;
};

export function WorkstationReviewHeader({
  busy,
  canSend,
  decided,
  error,
  focus,
  hiringManagers,
  onDecide,
  onNext,
  onSend,
  onSendStateChange,
  onToggleFocus,
  positionSuggestions,
  row,
  sendState,
  sentConfirmation,
  suggestedVacancyIds,
  vacancies,
}: {
  busy: boolean;
  canSend: boolean;
  /** What THIS session decided, which outranks the stored status until the page is reloaded. */
  decided: CandidateStatus | null;
  error: string | null;
  /** The whole screen is the document. This band answers by becoming one line. */
  focus: boolean;
  hiringManagers: readonly ManagerPickerOption[];
  onDecide: (status: CandidateStatus, note: string | null) => void;
  onNext: () => void;
  onSend: () => void;
  onSendStateChange: (next: SendState) => void;
  onToggleFocus: () => void;
  /** Areas and job titles already in use, offered behind the free-typed position. */
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  row: WorkspaceCandidateRow;
  sendState: SendState;
  sentConfirmation: string | null;
  suggestedVacancyIds: readonly number[];
  vacancies: readonly WorkspaceVacancy[];
}) {
  const [rejecting, setRejecting] = useState(false);
  const [sending, setSending] = useState(false);
  // BOTH BANDS FOLD, and each remembers its answer for the session, so it is done once rather than
  // per candidate. Folding the identity hands roughly 60px of a laptop screen back to the document,
  // which on a two-page CV is the difference between reading and scrolling; what survives that fold
  // is the name, the SEAT and the status — enough to be sure the buttons belong to the person on
  // screen, which is the one thing a decision bar must never get wrong.
  const [whoOpen, toggleWho] = useSectionFold("review:who");
  // THE DECISION BAND FOLDS TOO. It did not, and the owner asked for the opposite in plain words:
  // he reads a CV at full screen. Its control sits in the identity line above rather than in the
  // band itself, so the band can leave the screen entirely rather than leave a handle behind that
  // is just a thinner bar.
  const [actionsOpen, toggleActions] = useSectionFold("review:actions");
  const status = decided ?? row.status ?? "new";
  const statusPill = (
    <Pill tone={status === "rejected" ? "danger" : status === "new" ? "accent" : "ok"}>
      {candidateStatusLabel(status)}
    </Pill>
  );
  const decisions = (
    <>
      <DecisionButton
        disabled={busy}
        icon={<ThumbsUp className="h-3.5 w-3.5" />}
        label="Shortlist"
        onClick={() => onDecide("shortlisted", null)}
        tone="ok"
      />
      <DecisionButton
        disabled={busy}
        icon={<ThumbsDown className="h-3.5 w-3.5" />}
        label="Reject"
        onClick={() => setRejecting((open) => !open)}
        pressed={rejecting}
        tone="danger"
      />
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

      <DecisionButton
        disabled={busy}
        icon={<SkipForward className="h-3.5 w-3.5" />}
        label="Next candidate"
        onClick={onNext}
        tone="accent"
      />
    </>
  );
  const afterBands = (
    <>
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
      {rejecting ? (
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
  if (focus) {
    return (
      <div className="shrink-0 border-b border-phx-line bg-white">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-phx-surface-2 px-3 py-1">
          <button
            aria-label="Leave full-screen reading"
            className="shrink-0 border border-phx-line bg-white p-1 text-phx-ink-2 transition-colors hover:border-phx-accent-line hover:text-phx-accent-press"
            onClick={onToggleFocus}
            title="Leave full-screen reading"
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

  return (
    <div className="shrink-0 border-b border-phx-line bg-white">
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

function DecisionButton({
  disabled,
  icon,
  label,
  onClick,
  pressed,
  tone,
}: {
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone: "ok" | "danger" | "info" | "accent";
}) {
  const toneClass =
    tone === "ok"
      ? "border-phx-ok-line bg-phx-ok-bg text-phx-ok hover:bg-phx-ok hover:text-white"
      : tone === "danger"
        ? "border-phx-danger-line bg-phx-danger-bg text-phx-danger hover:bg-phx-danger hover:text-white"
        : tone === "info"
          ? "border-phx-info-line bg-phx-info-bg text-phx-info hover:bg-phx-info hover:text-white"
          : "border-phx-accent-line bg-phx-accent text-white hover:bg-phx-accent-press";
  return (
    <button
      aria-pressed={pressed}
      className={cn(
        "inline-flex items-center gap-1.5 border px-3 py-1.5 text-[13px] font-bold transition disabled:opacity-45",
        toneClass,
        pressed ? "ring-1 ring-phx-ink/20" : null,
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
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
    <div className="border-t border-phx-line bg-phx-paper px-4 py-2.5">
      <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-phx-ink-2">Why are they not going forward?</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {rejectionReasons.map((key) => (
          <button
            aria-pressed={reason === key}
            className={cn(
              "border px-2 py-1 text-[12px] font-semibold transition",
              reason === key
                ? "border-phx-danger-line bg-phx-danger text-white"
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
          className="min-w-0 flex-1 border border-phx-line bg-white px-2 py-1.5 text-[13px] text-phx-ink outline-none focus:border-phx-accent-line"
          maxLength={CANDIDATE_STATUS_NOTE_MAX_LENGTH}
          onChange={(event) => setDetail(event.target.value)}
          placeholder="Note — optional, kept in the candidate's history"
          value={detail}
        />
        <button
          className="border border-phx-line bg-white px-3 py-1.5 text-[13px] font-semibold text-phx-ink-2 transition hover:bg-phx-paper"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="border border-phx-danger-line bg-phx-danger px-3 py-1.5 text-[13px] font-bold text-white transition hover:bg-phx-danger/90 disabled:opacity-45"
          /* A reason is required and the button says so by staying off — the whole point of the
             list is that the archive can be counted, and an unlabelled rejection is the state this
             replaces. */
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
    <div className="border-t border-phx-line bg-phx-paper px-4 py-2.5">
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
            className="min-w-[180px] flex-1 border border-phx-line bg-white px-2 py-1.5 text-[13px] outline-none focus:border-phx-accent-line"
            list="workstation-position-titles"
            onChange={(event) => onChange({ ...state, freeJobTitle: event.target.value })}
            placeholder="Job title"
            value={state.freeJobTitle}
          />
          <input
            aria-label="Area"
            className="min-w-[180px] flex-1 border border-phx-line bg-white px-2 py-1.5 text-[13px] outline-none focus:border-phx-accent-line"
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
        <button
          className="inline-flex items-center gap-1.5 border border-phx-info-line bg-phx-info px-3 py-1.5 text-[13px] font-bold text-white transition hover:opacity-90 disabled:opacity-45"
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
