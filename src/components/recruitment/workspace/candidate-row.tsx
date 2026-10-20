"use client";

// Recruitment workspace — one candidate as two lines (owner, 20 Oct 2026).
//
//   Line 1: the name, the source and when the CV arrived, then the flags — "5 of 6 answered",
//           overdue, a possible duplicate, the latest call, "Returned by {manager}: {reason}", the
//           interview outcome, where else this person applied.
//   Line 2: every WhatsApp answer as a labelled chip, Medical Rep's six first and larger. The chips
//           WRAP — the owner's no-horizontal-scroll rule — so a long answer takes a second line
//           instead of pushing the page sideways.
//
// The status is the 3px left edge, in the Interview Calendar's colour language, so a glance down
// the list reads the pile without reading a word.
//
// The same row serves the manager portal (`mode="manager"`): no tick box, no editing, and the
// manager's own flags passed in — what HR sees and what a manager sees stay one design.

import { AlertTriangle, CheckCircle2, ChevronDown, Copy, FolderOpen, PhoneCall, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

import { adminChipDepthClassName } from "@/components/admin/admin-design-tokens";
import { phxCheckInputClassName } from "@/components/ui/form-tokens";
import { AnswerChip, type AnswerOption } from "@/components/recruitment/workspace/answer-chip";
import {
  cairoDayLabel,
  cairoStamp,
  chipToneClassName,
  completenessLabel,
  interviewChip,
  otherPlacements,
  placementLabel,
  statusEdgeClassName,
  statusTone,
} from "@/components/recruitment/workspace/workspace-format";
import { candidateStatusLabels } from "@/lib/recruitment/candidate-status";
import type { RecruitmentPillTone } from "@/components/recruitment/recruitment-premium";
import {
  callResultLabels,
  candidateSourceLabels,
  districtReturnReasonLabels,
  rejectionReasonLabels,
  returnSourceLabels,
} from "@/lib/recruitment/workspace/vocabulary";
import type { WorkspaceAnswerChip, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import { cn } from "@/lib/utils";

/** A small flag on line 1: hairline, tinted, 11px, never cut short. */
export function RowFlag({ children, icon, title, tone }: { children: ReactNode; icon?: ReactNode; title?: string; tone: RecruitmentPillTone }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-1 border px-1.5 py-px text-phx-xs font-bold",
        chipToneClassName[tone],
        adminChipDepthClassName,
      )}
      title={title}
    >
      {icon}
      <span className="break-words" dir="auto">
        {children}
      </span>
    </span>
  );
}

function ignoreChange() {
  // The tick is handled on click (see the checkbox); a controlled input still needs this to exist.
}

function returnedText(returned: NonNullable<WorkspaceRow["returned"]>): string {
  const who = returned.byName ? `Returned by ${returned.byName}` : returnSourceLabels[returned.source] ?? "Returned by a manager";
  const reason = returned.reasonCode ? districtReturnReasonLabels[returned.reasonCode] ?? returned.reasonCode : null;
  const why = [reason, returned.note].filter(Boolean).join(" — ");
  return why ? `${who}: ${why}` : who;
}

/**
 * A row's flags — "5 of 6 answered", overdue, a possible duplicate, the latest call, returned by a
 * manager, the interview, rejected, sent to, archived, folders, also applied for, needs placing — in
 * one place, so the table's Candidate cell and the phone card can never show two different sets.
 */
export function RowFlags({
  extraFlags,
  mode = "hr",
  row,
  showEveryPlacement = false,
  today,
  viewingTab,
}: {
  extraFlags?: ReactNode;
  mode?: "hr" | "manager";
  row: WorkspaceRow;
  showEveryPlacement?: boolean;
  today: string;
  viewingTab: string | null;
}) {
  const completeness = completenessLabel(row.completeness);
  const missing = row.completeness ? row.completeness.expected - row.completeness.given : 0;
  const interview = interviewChip(row.interview, today);
  const elsewhere = showEveryPlacement ? row.placements : otherPlacements(row, viewingTab);
  return (
    <>
      {completeness ? (
        <RowFlag
          icon={missing > 0 ? <AlertTriangle aria-hidden className="h-3 w-3" /> : <CheckCircle2 aria-hidden className="h-3 w-3" />}
          tone={missing > 0 ? "amber" : "emerald"}
        >
          {completeness}
        </RowFlag>
      ) : null}
      {row.overdue ? (
        <RowFlag tone="rose">
          {row.overdue.kind === "shortlisted"
            ? `Overdue · shortlisted ${row.overdue.days} days, no action`
            : `Overdue · with the manager ${row.overdue.days} days, no reply`}
        </RowFlag>
      ) : null}
      {row.duplicate ? (
        <RowFlag icon={<Copy aria-hidden className="h-3 w-3" />} title={row.duplicate.reason} tone="amber">
          Possible duplicate
        </RowFlag>
      ) : null}
      {row.latestCall ? (
        <RowFlag
          icon={<PhoneCall aria-hidden className="h-3 w-3" />}
          title={row.latestCall.note ?? undefined}
          tone={row.latestCall.result === "interested" ? "emerald" : row.latestCall.result === "not_interested" ? "rose" : "slate"}
        >
          {`${callResultLabels[row.latestCall.result]} · ${cairoDayLabel(row.latestCall.at, today)}`}
        </RowFlag>
      ) : null}
      {row.returned ? (
        <RowFlag icon={<Undo2 aria-hidden className="h-3 w-3" />} tone="orange">
          {returnedText(row.returned)}
        </RowFlag>
      ) : null}
      {interview ? <RowFlag tone={interview.tone}>{interview.label}</RowFlag> : null}
      {row.status === "rejected" && row.rejection?.reason ? (
        <RowFlag title={row.rejection.note ?? undefined} tone="rose">
          {`Rejected · ${rejectionReasonLabels[row.rejection.reason]}${row.rejection.note ? ` — ${row.rejection.note}` : ""}`}
        </RowFlag>
      ) : null}
      {row.latestSend && mode === "hr" ? (
        <RowFlag tone="orange">{`Sent to ${row.latestSend.managerName ?? "a manager"} · ${cairoDayLabel(row.latestSend.sentAt, today)}`}</RowFlag>
      ) : null}
      {row.archivedAt ? <RowFlag tone="slate">{`Archived · ${cairoDayLabel(row.archivedAt, today)}`}</RowFlag> : null}
      {row.folders.length > 0 && mode === "hr" ? (
        <RowFlag icon={<FolderOpen aria-hidden className="h-3 w-3" />} tone="slate">
          {row.folders.map((folder) => folder.name).join(", ")}
        </RowFlag>
      ) : null}
      {elsewhere.length > 0 && mode === "hr" ? (
        <RowFlag tone="sky">
          {`${showEveryPlacement ? "In" : "Also applied for"} ${elsewhere.map(placementLabel).join(" · ")}`}
        </RowFlag>
      ) : null}
      {row.placements.length === 0 && mode === "hr" ? <RowFlag tone="amber">Needs placing</RowFlag> : null}
      {extraFlags}
    </>
  );
}

export function CandidateRow({
  anchorId,
  answerOptions,
  canEdit,
  extraFlags,
  mode = "hr",
  onSaveAnswer,
  onSelect,
  onToggle,
  opened,
  row,
  selected = false,
  showEveryPlacement = false,
  today,
  viewingTab,
}: {
  /** The row's element id, for scrolling it into view; `ws-row-<id>` unless the caller has its own. */
  anchorId?: string;
  /** Options per answer key, so a choice question edits as a choice. */
  answerOptions?: Readonly<Record<string, readonly AnswerOption[]>>;
  canEdit: boolean;
  /** The manager portal's own flags (sent on, waiting on you). */
  extraFlags?: ReactNode;
  mode?: "hr" | "manager";
  onSaveAnswer?: (row: WorkspaceRow, chip: WorkspaceAnswerChip, value: string | null) => Promise<void>;
  onSelect?: (id: string, checked: boolean, withShift: boolean) => void;
  onToggle: (id: string) => void;
  opened: boolean;
  row: WorkspaceRow;
  selected?: boolean;
  /** A search across tabs: say every tab this person sits in, not only the others. */
  showEveryPlacement?: boolean;
  today: string;
  viewingTab: string | null;
}) {
  const lead = row.answers.filter((chip) => chip.lead);
  const rest = row.answers.filter((chip) => !chip.lead);
  const saveAnswer = onSaveAnswer ? (chip: WorkspaceAnswerChip, value: string | null) => onSaveAnswer(row, chip, value) : undefined;

  return (
    <article
      aria-label={row.name}
      className={cn(
        "relative border-b border-slate-200 py-3 pl-4 pr-3 transition-colors sm:pl-5",
        opened ? "bg-orange-50/70" : selected ? "bg-sky-50/50" : "bg-white hover:bg-slate-50/70",
        row.archivedAt ? "opacity-80" : null,
      )}
      data-candidate-row={row.id}
      id={anchorId ?? `ws-row-${row.id}`}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", statusEdgeClassName[row.status])} />
      {opened ? <span aria-hidden className="absolute inset-y-0 right-0 w-[3px] bg-orange-500" /> : null}
      <div className="flex min-w-0 items-start gap-3">
        {mode === "hr" && onSelect ? (
          <input
            aria-label={`Tick ${row.name}`}
            checked={selected}
            className={cn(phxCheckInputClassName, "mt-1")}
            // A click, not a change, carries the Shift key — Shift-click ticks the run between two rows.
            // Space on a focused box fires a click too, so the keyboard ticks exactly as the mouse does.
            onChange={ignoreChange}
            onClick={(event) => onSelect(row.id, event.currentTarget.checked, event.shiftKey)}
            type="checkbox"
          />
        ) : null}
        <div className="min-w-0 grow space-y-2">
          {/* Line 1 */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <button
              aria-controls="ws-opened-cv"
              aria-expanded={opened}
              className="group inline-flex max-w-full items-center gap-1 text-left text-[15px] font-black leading-5 tracking-tight text-slate-950 transition hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
              onClick={() => onToggle(row.id)}
              type="button"
            >
              <span className="break-words" dir="auto">
                {row.name}
              </span>
              <ChevronDown
                aria-hidden
                className={cn("h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-orange-600", opened ? "rotate-180 text-orange-600" : null)}
              />
            </button>
            <span
              className={cn(
                "inline-flex items-center border px-1.5 py-px text-phx-xs font-black uppercase tracking-[0.06em]",
                chipToneClassName[statusTone[row.status]],
              )}
            >
              {candidateStatusLabels[row.status]}
            </span>
            <span className="text-xs font-semibold text-slate-600">{candidateSourceLabels[row.source] ?? row.source}</span>
            <span aria-hidden className="text-slate-300">
              ·
            </span>
            <time className="text-xs font-semibold tabular-nums text-slate-600" dateTime={row.receivedAt}>
              {cairoStamp(row.receivedAt, today)}
            </time>
            <RowFlags extraFlags={extraFlags} mode={mode} row={row} showEveryPlacement={showEveryPlacement} today={today} viewingTab={viewingTab} />
          </div>

          {/* Line 2 */}
          {row.answers.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-start gap-1.5">
              {[...lead, ...rest].map((chip) => (
                <AnswerChip
                  canEdit={canEdit}
                  chip={chip}
                  key={chip.key}
                  onSave={saveAnswer}
                  options={answerOptions?.[chip.key]}
                  today={today}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs font-medium text-slate-500">
              {mode === "hr" ? "No WhatsApp answers on this CV yet." : "No answers on this CV."}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
