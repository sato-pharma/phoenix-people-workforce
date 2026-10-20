"use client";

// Recruitment workspace — the opened CV (owner, 20 Oct 2026).
//
// Pressing a name opens the CV IN PLACE, beside the data; pressing it again closes it; one is open at
// a time; Next and Previous (or the arrow keys) walk the tab. On a wide container it is the right
// 60% of a 40/60 split; on a phone it is a full-screen sheet with Back. Which of the two is decided
// by the caller from the container's own measured width, never the viewport's.
//
// Inside: the CV file itself (the house `CvDocumentView` — thumbnails, zoom, download), every answer
// editable, the one-tap call results, a merge button when a duplicate is flagged, the applicant's
// WhatsApp chat with the reply box under it, the notes and the timeline, and every action.
//
// THE CEO READS (`canWork` false in HR mode). He gets what the workspace itself handed him — the
// answers, the flags and the placements — and nothing that would only fetch a refusal: the CV file,
// the notes and the timeline sit behind `candidates: read`, which he does not hold, and the chat
// behind the inbox's own gate. Those parts are not drawn at all; one quiet line says why.
//
// THE SAME CARD SERVES THE MANAGER PORTAL (`mode="manager"`). There, the CV document and the
// manager's own controls are handed in by the portal — its "I will call" gate decides when a phone
// and a download appear — and nothing here reaches an HR-only route.

import { ArrowLeft, ChevronDown, ChevronUp, Eye, FileText, GitMerge, Mail, Phone, PhoneCall, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { adminChipDepthClassName, adminPanelHeaderClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { CvDocumentView } from "@/components/recruitment/cv-preview-modal";
import { getJson } from "@/components/recruitment/recruitment-fetch";
import { RecruitmentTabBar } from "@/components/recruitment/recruitment-premium";
import { WhatsAppReplyBox } from "@/components/recruitment/whatsapp-reply-box";
import { CandidateStars } from "@/components/recruitment/workstation/candidate-stars";
import { WorkstationNotesTab, WorkstationTimelineTab } from "@/components/recruitment/workstation/workstation-history-tabs";
import { AnswerChip, type AnswerOption } from "@/components/recruitment/workspace/answer-chip";
import { CandidateChat } from "@/components/recruitment/workspace/candidate-chat";
import { CvActions, saveRating, type CvPanel } from "@/components/recruitment/workspace/cv-actions";
import { RowFlag } from "@/components/recruitment/workspace/candidate-row";
import type { WorkspaceActions } from "@/components/recruitment/workspace/use-workspace-actions";
import {
  cairoDayLabel,
  cairoStamp,
  chipToneClassName,
  errorText,
  placedByLabel,
  placementLabel,
  statusTone,
} from "@/components/recruitment/workspace/workspace-format";
import type { ManagerPickerOption } from "@/components/recruitment/manager-picker";
import type { CandidateRating } from "@/lib/recruitment/candidate-rating";
import { candidateStatusLabels } from "@/lib/recruitment/candidate-status";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import type { CvFolderNode } from "@/lib/recruitment/cv-folder-tree";
import type { RecruitmentFile } from "@/lib/recruitment/types";
import type { WorkspaceRoleTab, WorkspaceTabKey } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceAnswerChip, WorkspaceRow } from "@/lib/recruitment/workspace/types";
import { callResultLabels, callResults, candidateSourceLabels } from "@/lib/recruitment/workspace/vocabulary";
import { cn } from "@/lib/utils";

type Section = "cv" | "answers" | "whatsapp" | "notes" | "timeline";

type ProfileState =
  | { phase: "loading" }
  | { phase: "ready"; files: RecruitmentFile[] }
  | { phase: "failed"; message: string };

/**
 * The CV file, read from the candidate's own record. HR mode only.
 *
 * `readOnly` is the CEO (owner, 2026-10-20: "answers and optional the cv file"): the file comes
 * through the workspace's own narrow read-only route — the files and nothing else — never the
 * recruitment team's candidate route, which carries notes he does not hold the grant for.
 */
function CvFileSection({ candidateId, canRate, readOnly = false }: { candidateId: string; canRate: boolean; readOnly?: boolean }) {
  const [state, setState] = useState<ProfileState>({ phase: "loading" });
  const [rating, setRating] = useState<CandidateRating | null>(null);
  const [ratingBusy, setRatingBusy] = useState(false);
  const fileUrl = (fileId: string) =>
    readOnly ? `/api/recruitment/workspace/cv/${candidateId}?file=${encodeURIComponent(fileId)}` : `/api/recruitment/files/${fileId}/download`;

  useEffect(() => {
    let active = true;
    getJson(readOnly ? `/api/recruitment/workspace/cv/${candidateId}` : `/api/recruitment/candidates/${candidateId}`)
      .then((data) => {
        if (!active) return;
        if (readOnly) {
          setState({ files: Array.isArray(data.files) ? (data.files as RecruitmentFile[]) : [], phase: "ready" });
          return;
        }
        const profile = (data.profile ?? {}) as { files?: RecruitmentFile[]; candidate?: { rating?: CandidateRating | null } };
        const value = profile.candidate?.rating ?? null;
        setRating(value);
        setState({ files: profile.files ?? [], phase: "ready" });
      })
      .catch((error: unknown) => {
        if (active) setState({ message: errorText(error, "The CV could not be loaded."), phase: "failed" });
      });
    return () => {
      active = false;
    };
  }, [candidateId, readOnly]);

  if (state.phase === "loading") {
    return <div aria-busy="true" className="h-[32rem] animate-pulse bg-slate-100" role="status" />;
  }
  if (state.phase === "failed") {
    return (
      <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800" dir="auto" role="alert">
        {state.message}
      </p>
    );
  }
  const file = primaryCvFile(state.files);
  const others = state.files.filter((item) => item.id !== file?.id);
  return (
    <div className="space-y-2.5">
      {canRate ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-phx-xs font-black uppercase tracking-wide text-slate-500">Your star</span>
          <CandidateStars
            busy={ratingBusy}
            onRate={(next) => {
              const previous = rating;
              setRating(next);
              setRatingBusy(true);
              saveRating(candidateId, next)
                .catch(() => setRating(previous))
                .finally(() => setRatingBusy(false));
            }}
            rating={rating}
          />
        </div>
      ) : null}
      {file ? (
        <div className={`min-h-[28rem] border border-slate-200 bg-slate-50 ${adminRecessedDepthClassName}`}>
          <CvDocumentView
            allowDownload
            downloadUrl={fileUrl(file.id)}
            fileName={file.fileName}
            mimeType={file.mimeType}
          />
        </div>
      ) : (
        <p className={`flex items-center gap-2 border border-dashed border-slate-300 bg-white px-3 py-6 text-sm font-semibold text-slate-600`}>
          <FileText aria-hidden className="h-4 w-4 text-slate-400" />
          No readable CV is attached. The answers below are what the applicant told the bot.
        </p>
      )}
      {others.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-phx-xs font-black uppercase tracking-wide text-slate-500">Other files</span>
          {others.map((item) => (
            <a
              className={`inline-flex items-center gap-1 border border-slate-200 bg-white px-2 py-0.5 text-xs font-bold text-slate-700 hover:border-orange-300 ${adminChipDepthClassName}`}
              href={fileUrl(item.id)}
              key={item.id}
            >
              <FileText aria-hidden className="h-3 w-3" />
              <span className="break-words" dir="auto">
                {item.fileName}
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AnswersSection({
  answerOptions,
  canEdit,
  onSaveAnswer,
  row,
  today,
}: {
  answerOptions?: Readonly<Record<string, readonly AnswerOption[]>>;
  canEdit: boolean;
  onSaveAnswer?: (row: WorkspaceRow, chip: WorkspaceAnswerChip, value: string | null) => Promise<void>;
  row: WorkspaceRow;
  today: string;
}) {
  if (row.answers.length === 0) {
    return <p className="text-sm font-medium text-slate-600">This tab asks no questions this CV has answered yet.</p>;
  }
  const save = onSaveAnswer ? (chip: WorkspaceAnswerChip, value: string | null) => onSaveAnswer(row, chip, value) : undefined;
  return (
    <ul className="divide-y divide-slate-100 border border-slate-200">
      {row.answers.map((chip) => (
        <li className="flex flex-wrap items-center justify-between gap-2 bg-white px-3 py-2" key={chip.key}>
          <span className={cn("text-xs font-black uppercase tracking-wide", chip.value === null ? "text-amber-800" : "text-slate-500")}>{chip.label}</span>
          <AnswerChip canEdit={canEdit} chip={chip} onSave={save} options={answerOptions?.[chip.key]} today={today} />
        </li>
      ))}
    </ul>
  );
}

export function OpenedCv({
  actions,
  answerOptions,
  canDelete = false,
  canHire = false,
  canWork,
  cvDocument,
  folders = [],
  hasNext,
  hasPrevious,
  layout,
  managerSlot,
  managers = [],
  mode = "hr",
  onClose,
  onNext,
  onPanel,
  onPrevious,
  panel = null,
  position,
  roleTabs = [],
  row,
  today,
  viewerName = null,
  viewingTab,
}: {
  actions?: WorkspaceActions;
  answerOptions?: Readonly<Record<string, readonly AnswerOption[]>>;
  canDelete?: boolean;
  canHire?: boolean;
  canWork: boolean;
  /** The manager portal hands its own document view (its download gate lives there). */
  cvDocument?: ReactNode;
  folders?: readonly CvFolderNode[];
  hasNext: boolean;
  hasPrevious: boolean;
  layout: "split" | "sheet";
  /** The manager portal's own controls: the call gate, comments, outcome, return. */
  managerSlot?: ReactNode;
  managers?: readonly ManagerPickerOption[];
  mode?: "hr" | "manager";
  onClose: () => void;
  onNext: () => void;
  onPanel?: (panel: CvPanel | null) => void;
  onPrevious: () => void;
  panel?: CvPanel | null;
  /** "3 of 50" — where this CV sits in the list. */
  position: string | null;
  roleTabs?: readonly WorkspaceRoleTab[];
  row: WorkspaceRow;
  today: string;
  /** The reader's own name, for an answer they add ("added by HR · Mona"). */
  viewerName?: string | null;
  viewingTab: WorkspaceTabKey | null;
}) {
  const hr = mode === "hr";
  /** The CEO: HR mode without the right to work it. Only the parts the workspace gave him are drawn. */
  const readOnly = hr && !canWork;
  const [section, setSection] = useState<Section>(readOnly ? "answers" : "cv");
  const canEdit = hr && canWork && Boolean(actions);
  // The CEO: his answers first, and the CV file one press away (owner, 2026-10-20: "answers and
  // optional the cv file"). Notes, chat and timeline stay with the recruitment team.
  const sections: { key: Section; label: string }[] = readOnly
    ? [
        { key: "answers", label: "Answers" },
        { key: "cv", label: "CV file" },
      ]
    : hr
    ? [
        { key: "cv", label: "CV" },
        { key: "answers", label: "Answers" },
        { key: "whatsapp", label: "WhatsApp" },
        { key: "notes", label: "Notes" },
        { key: "timeline", label: "Timeline" },
      ]
    : [
        { key: "cv", label: "CV" },
        { key: "answers", label: "Answers" },
      ];
  const onSaveAnswer =
    canEdit && actions ? (target: WorkspaceRow, chip: WorkspaceAnswerChip, value: string | null) => actions.saveAnswer(target, chip, value, viewerName) : undefined;

  return (
    <section aria-label={`CV of ${row.name}`} className="min-w-0 bg-white" id="ws-opened-cv">
      <div className={cn("px-3 py-2.5 text-white sm:px-4", adminPanelHeaderClassName, layout === "sheet" ? "sticky top-0 z-10" : null)}>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 grow basis-56 items-start gap-2">
            {layout === "sheet" ? (
              <button
                className="mt-0.5 inline-flex shrink-0 items-center gap-1 border border-white/20 bg-white/10 px-2 py-1 text-xs font-bold text-white transition hover:bg-white/20"
                onClick={onClose}
                type="button"
              >
                <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
                Back
              </button>
            ) : null}
            <div className="min-w-0">
              <h2 className="break-words text-lg font-black leading-6 tracking-tight text-white" dir="auto">
                {row.name}
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-slate-300">
                <span className={cn("border px-1.5 py-px text-phx-xs font-black uppercase tracking-[0.06em]", chipToneClassName[statusTone[row.status]])}>
                  {candidateStatusLabels[row.status]}
                </span>
                <span>{candidateSourceLabels[row.source] ?? row.source}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{`Received ${cairoStamp(row.receivedAt, today)}`}</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {position ? <span className="pr-1 text-xs font-bold tabular-nums text-slate-300">{position}</span> : null}
            {/* Previous and Next only where there is a list to walk — a CV opened on its own has none. */}
            {hasNext || hasPrevious ? (
              <>
                <button
                  aria-label="Previous CV"
                  className="inline-flex h-8 w-8 items-center justify-center border border-white/20 bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-30"
                  disabled={!hasPrevious}
                  onClick={onPrevious}
                  title="Previous (↑ or K)"
                  type="button"
                >
                  <ChevronUp aria-hidden className="h-4 w-4" />
                </button>
                <button
                  aria-label="Next CV"
                  className="inline-flex h-8 w-8 items-center justify-center border border-white/20 bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-30"
                  disabled={!hasNext}
                  onClick={onNext}
                  title="Next (↓ or J)"
                  type="button"
                >
                  <ChevronDown aria-hidden className="h-4 w-4" />
                </button>
              </>
            ) : null}
            {layout === "split" ? (
              <button
                aria-label="Close the CV"
                className="inline-flex h-8 w-8 items-center justify-center border border-white/20 bg-white/10 text-white transition hover:bg-white/20"
                onClick={onClose}
                title="Close (Esc)"
                type="button"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-3 p-3 sm:p-4">
        {readOnly ? (
          <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
            <Eye aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            Read only — notes and the WhatsApp chat stay with the recruitment team.
          </p>
        ) : null}
        {hr && canWork && actions ? (
          <CvActions
            actions={actions}
            canDelete={canDelete}
            canHire={canHire}
            canWork={canWork}
            folders={folders}
            managers={managers}
            onCompleteMissing={() => setSection("answers")}
            onPanel={onPanel ?? (() => undefined)}
            panel={panel}
            roleTabs={roleTabs}
            row={row}
            viewingTab={viewingTab}
          />
        ) : null}
        {!hr && managerSlot ? <div className="space-y-3">{managerSlot}</div> : null}

        {hr && canWork && actions ? (
          <div className={`flex flex-wrap items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-2 ${adminRecessedDepthClassName}`}>
            <span className="inline-flex items-center gap-1 pr-1 text-phx-xs font-black uppercase tracking-wide text-slate-600">
              <PhoneCall aria-hidden className="h-3.5 w-3.5 text-orange-600" />
              Call
            </span>
            {callResults.map((result) => (
              <button
                aria-pressed={row.latestCall?.result === result}
                className={cn(
                  "border px-2 py-1 text-xs font-bold transition",
                  row.latestCall?.result === result ? "border-orange-400 bg-orange-50 text-orange-900" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400",
                )}
                key={result}
                onClick={() => actions.callResult(row.id, result, null, viewerName)}
                type="button"
              >
                {callResultLabels[result]}
              </button>
            ))}
            {row.latestCall ? (
              <span className="text-xs font-semibold text-slate-500">
                {`Last: ${callResultLabels[row.latestCall.result]} · ${cairoStamp(row.latestCall.at, today)}${row.latestCall.byName ? ` · ${row.latestCall.byName}` : ""}`}
              </span>
            ) : null}
          </div>
        ) : null}

        {row.duplicate && hr ? (
          <div className="flex flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <GitMerge aria-hidden className="h-4 w-4 shrink-0" />
            <span className="min-w-0 grow break-words font-semibold" dir="auto">
              {`Looks like the same person as ${row.duplicate.otherCandidateIds.length === 1 ? "another record" : `${row.duplicate.otherCandidateIds.length} other records`} — ${row.duplicate.reason}`}
            </span>
            {canWork && actions
              ? row.duplicate.otherCandidateIds.map((otherId, index) => (
                  <button
                    className="inline-flex h-8 items-center gap-1 border border-amber-500 bg-white px-2.5 text-xs font-bold text-amber-900 transition hover:bg-amber-100"
                    key={otherId}
                    onClick={() => actions.merge(row.id, otherId)}
                    type="button"
                  >
                    <GitMerge aria-hidden className="h-3.5 w-3.5" />
                    {row.duplicate && row.duplicate.otherCandidateIds.length > 1 ? `Merge record ${index + 1} into this one` : "Merge it into this one"}
                  </button>
                ))
              : null}
          </div>
        ) : null}

        {hr && (row.phone || row.email || row.placements.length > 0) ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {row.phone ? (
              <a className="inline-flex items-center gap-1 font-bold text-slate-800 hover:text-orange-700" dir="ltr" href={`tel:${row.phone}`}>
                <Phone aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                <span className="tabular-nums">{row.phone}</span>
              </a>
            ) : null}
            {row.email ? (
              <a className="inline-flex items-center gap-1 break-all font-bold text-slate-800 hover:text-orange-700" href={`mailto:${row.email}`}>
                <Mail aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                {row.email}
              </a>
            ) : null}
            {row.placements.map((placement) => (
              <RowFlag key={placement.tab} title={placedByLabel(placement)} tone="sky">
                {`${placementLabel(placement)} · ${placedByLabel(placement)} · ${cairoDayLabel(placement.placedAt, today)}`}
              </RowFlag>
            ))}
          </div>
        ) : null}

        {sections.length > 1 ? <RecruitmentTabBar label="Parts of this CV" onChange={setSection} tabs={sections} value={section} /> : null}

        <div className="min-w-0">
          {section === "cv" && readOnly ? <CvFileSection canRate={false} candidateId={row.id} key={`ceo-${row.id}`} readOnly /> : null}
          {section === "cv" && !readOnly ? (
            cvDocument ?? (hr ? <CvFileSection canRate={canWork} candidateId={row.id} key={row.id} /> : null)
          ) : null}
          {section === "answers" ? (
            <AnswersSection answerOptions={answerOptions} canEdit={canEdit} onSaveAnswer={onSaveAnswer} row={row} today={today} />
          ) : null}
          {section === "whatsapp" && hr && !readOnly ? (
            <div className="space-y-2.5">
              <CandidateChat candidateId={row.id} key={row.id} name={row.name} phone={row.phone} today={today} />
              <p className="text-xs font-medium text-slate-500">
                Replies go out on the recruitment WhatsApp line, inside WhatsApp&apos;s 24-hour window.
              </p>
              <WhatsAppReplyBox candidateId={row.id} key={`reply-${row.id}`} />
            </div>
          ) : null}
          {section === "notes" && hr && !readOnly ? <WorkstationNotesTab canWrite={canWork} candidateId={row.id} /> : null}
          {section === "timeline" && hr && !readOnly ? <WorkstationTimelineTab candidateId={row.id} /> : null}
        </div>
      </div>
    </section>
  );
}
