"use client";

// Recruitment / ATS — one candidate's own page: everything the system holds on them, in one place.
//
// The owner, 2026-09-18: "when I press on the name of the person, I am jumped to a new page which
// shows the full details on everything for this candidate." The name in the candidate pool and on
// WhatsApp Applicants opens this page in a new tab (candidate-page-link.ts).
//
// WHAT IT SHOWS: where they stand (status, star, field-force check, shelf, folders), the screening
// summary the screening page shows, how they reached us, every field on the record, the files, every
// send to a manager, applications and interviews, who has opened the CV, the history and the notes —
// with the CV itself open beside it on a wide screen and below it on a phone.
//
// READ-ONLY ON PURPOSE. This page never marks the CV read and never holds it for the viewer; see the
// header of candidate-record.ts for why. Decisions are one click away, on the screening page, which is
// where the screening rules and the undo live. The notes panel is the same one the screening page
// shows, without its note box.
//
// THE LOOK IS THE MODULE'S PREMIUM DOSSIER (2026-10-19 sweep, recruitment-premium.tsx): the module's
// page header carries the person — name, what they applied for, their stage, the channel they came
// by and the day they arrived — and every section is a panel with the house's dark band, folding with
// its count still showing. From xl up it is two columns: the record on the left, and on the right
// where they stand with the CV under it, held in view while the record scrolls past. Square edges,
// and every value wraps — nothing is cut short with an ellipsis and nothing scrolls sideways.

import {
  ArrowLeft,
  BadgeCheck,
  Briefcase,
  CalendarDays,
  CalendarPlus,
  ChevronDown,
  ClipboardCheck,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileText,
  History,
  IdCard,
  Inbox,
  Mail,
  MessageCircle,
  NotebookPen,
  Paperclip,
  Printer,
  ScanLine,
  Send,
  Star,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type React from "react";

import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminPanelDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { CandidateFactsSummary } from "@/components/recruitment/candidate-facts-summary";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import {
  RECRUITMENT_EYEBROW,
  RecruitmentEmptyState,
  RecruitmentPageHeader,
  RecruitmentPanel,
  RecruitmentPill,
  type RecruitmentPillTone,
} from "@/components/recruitment/recruitment-premium";
import { WorkstationCvPane } from "@/components/recruitment/workstation/workstation-cv-pane";
import {
  WorkstationNotesTab,
  WorkstationTimelineTab,
} from "@/components/recruitment/workstation/workstation-history-tabs";
import {
  cairoStamp,
  CollapsibleSection,
  KeyValue,
  useSectionFold,
} from "@/components/recruitment/workstation/workstation-ui";
import { phxButtonAccentClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { isBatchActor } from "@/lib/recruitment/batch-actor";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import {
  candidateFolderKindLabels,
  candidateFolderLabel,
  DUPLICATE_FOLDER_KIND,
  DUPLICATE_FOLDER_LABEL,
} from "@/lib/recruitment/candidate-folder";
import { candidateRecordPrintHref, recruitmentRootFromPathname } from "@/lib/recruitment/candidate-page-link";
import { candidateRatingLabels } from "@/lib/recruitment/candidate-rating";
import type { CandidateRecord, CandidateRecordPart } from "@/lib/recruitment/candidate-record";
import { candidateRecordSections, type CandidateRecordRow } from "@/lib/recruitment/candidate-record-fields";
import { candidateSourceChannel, type CandidateSourceChannelKey } from "@/lib/recruitment/candidate-source-context";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import { defaultCvPositionKey, getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import { applicationStageLabel, humanizeRecruitmentTerm } from "@/lib/recruitment/labels";
// The one rule for "may this letter still give a first working day" — read, never re-implemented. It
// lives in a module of its own precisely so this CLIENT component can read it without dragging the
// database client and the offers service into the browser bundle.
import { offerCanGiveAStartDate } from "@/lib/recruitment/offer-start-date-rule";
import { isStatedNonEgyptian, nonEgyptianFlagTitle } from "@/lib/recruitment/nationality";
import { managerLabel, UNNAMED_USER_LABEL } from "@/lib/recruitment/person-labels";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import { screeningHref } from "@/lib/recruitment/screening-link";
import { candidateDecisionTabOf, type CandidateDecisionTab } from "@/lib/recruitment/candidate-decision-tabs";
import type { ManagerSend } from "@/lib/recruitment/manager-sends";
import type { Candidate, RecruitmentFile } from "@/lib/recruitment/types";

/** What each part is called when it could not be read — in the reader's words, never a code. */
const PART_WORDS: Record<CandidateRecordPart, string> = {
  extraction: "the CV reader's last read",
  folders: "the folders this CV is in",
  offer: "the job offer letter",
  questions: "the wording of the WhatsApp questions",
  sends: "the sends to managers",
  viewers: "who has opened this CV",
};

/**
 * The colour of the stage pill in the header — the decision pile the CV sits in, in the module's one
 * pill palette: a new CV sky, a kept one emerald, a reserve amber, one with a manager orange, a
 * rejection rose.
 */
const STAGE_TONE: Record<CandidateDecisionTab, RecruitmentPillTone> = {
  all: "slate",
  backup: "amber",
  hired: "emerald",
  new: "sky",
  rejected: "rose",
  sent_to_manager: "orange",
  shortlisted: "emerald",
};

/** The mark beside the channel a CV came in by. */
const CHANNEL_ICON: Record<CandidateSourceChannelKey, React.ReactNode> = {
  email: <Mail aria-hidden className="h-3 w-3" />,
  manual: <UserPlus aria-hidden className="h-3 w-3" />,
  other: <Inbox aria-hidden className="h-3 w-3" />,
  whatsapp: <MessageCircle aria-hidden className="h-3 w-3" />,
};

/** The small square link each file row carries — a hairline control with the house's lift. */
const fileLinkClassName = `inline-flex items-center gap-1 border border-slate-300 bg-white px-2 py-1 text-[11px] font-bold text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-800 ${adminControlDepthClassName}`;

/**
 * "Accepted · starts 01 October 2026" — where an offer letter stands, for the hint under the row.
 *
 * 🔒 A DEAD LETTER SHOWS NO START DATE HERE EITHER, and it reads the same rule the send screen reads
 * (`offerCanGiveAStartDate`, the owner's ruling of 2026-09-28) rather than a second copy of it. A
 * declined letter still carries whatever day it was written for, and printing that beside the word
 * "Declined" reads as a date somebody is expected — which is exactly the confusion the send-screen
 * rule exists to prevent. The letter's state is still shown; only its day is withheld.
 */
function offerStandingLine(offer: { startDate: string; status: string }): string {
  const standing = humanizeRecruitmentTerm(offer.status);
  if (!offer.startDate || !offerCanGiveAStartDate(offer.status)) return standing;
  return `${standing} · starts ${offer.startDate}`;
}

/** Session fold memory is keyed per section, so every candidate page opens the way you last left it. */
const FOLD_KEY = "candidate-page";

/**
 * The name to print for an HR id on this record.
 *
 * Null means the record names nobody, and the caller leaves the line out. An id that matched no
 * employee reads "Unnamed user" — the id itself is never printed (names, never codes).
 */
function personName(people: Record<string, string>, hrId: string | null | undefined): string | null {
  const id = typeof hrId === "string" ? hrId.trim() : "";
  if (!id) return null;
  if (isBatchActor(id)) return "An automated batch";
  return people[id] ?? UNNAMED_USER_LABEL;
}

/** "Omar Gawish · 18 Sept 2026, 15:53", either half alone, or null when there is neither. */
function byLine(name: string | null, at: string | null | undefined): string | null {
  const when = cairoStamp(at);
  if (name && when) return `${name} · ${when}`;
  return name ?? (when || null);
}

/** A file size a person reads. Plain arithmetic, so the server and the browser print the same thing. */
function fileSize(bytes: number | null): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKindLabel(kind: string): string {
  return kind.trim().toLowerCase() === "cv" ? "CV" : humanizeRecruitmentTerm(kind) || "File";
}

/** The field-force degree check, in words. */
function backgroundOutcomeLabel(outcome: string): string {
  if (outcome === "eligible") return "Eligible — a field-force degree";
  if (outcome === "paramedical") return "Paramedical — outside the field-force degrees";
  return humanizeRecruitmentTerm(outcome);
}

/** Where the CV is filed on the shelves, in words, or null when it is in the main pool. */
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

/**
 * One section of the record: the module's panel, folding away with its count still on the band.
 *
 * THE COUNT SURVIVES THE FOLD, which is why it rides on the band rather than in the body: a section
 * that hid its own count when shut would make the reader open it just to learn whether it was worth
 * opening. The fold is remembered for the session per section (`useSectionFold`), so every candidate
 * page opens the way the last one was left.
 *
 * `title` is a plain string and is written FIRST at every call site: the paper's section list is read
 * off this page's own titles (tests/candidate-record-print.test.ts), and that reader stops at the
 * first `>` inside a tag.
 */
function RecordPanel({
  children,
  className,
  count,
  icon,
  storageKey,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  count?: React.ReactNode;
  icon: React.ReactNode;
  storageKey: string;
  title: string;
}) {
  const [open, toggle] = useSectionFold(storageKey, true);
  return (
    <RecruitmentPanel
      actions={
        <button
          aria-expanded={open}
          aria-label={open ? `Fold ${title}` : `Open ${title}`}
          className="flex h-8 w-8 items-center justify-center border border-white/15 bg-white/5 text-slate-200 transition hover:border-white/30 hover:bg-white/15 hover:text-white"
          onClick={toggle}
          title={open ? "Fold this section" : "Open this section"}
          type="button"
        >
          <ChevronDown
            aria-hidden
            className={open ? "h-4 w-4 rotate-180 transition-transform duration-200" : "h-4 w-4 transition-transform duration-200"}
          />
        </button>
      }
      className={className}
      count={count}
      icon={icon}
      title={title}
    >
      {open ? children : null}
    </RecruitmentPanel>
  );
}

/** A notice at the top of the page: a hairline box with a 3px rule down its leading edge, lifted. */
function RecordNotice({
  footnote,
  says,
  tone,
}: {
  footnote?: string;
  says: string;
  tone: "quiet" | "warn";
}) {
  return (
    <div
      className={
        tone === "warn"
          ? `flex items-start gap-3 border border-amber-200 border-l-[3px] border-l-amber-500 bg-amber-50/80 px-4 py-3 ${adminSoftDepthClassName}`
          : `flex items-start gap-3 border border-slate-200 border-l-[3px] border-l-slate-400 bg-white px-4 py-3 ${adminSoftDepthClassName}`
      }
    >
      {tone === "warn" ? (
        <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      ) : (
        <BadgeCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
      )}
      <div className="min-w-0">
        <p className={tone === "warn" ? "break-words text-sm font-bold text-amber-950" : "break-words text-sm font-bold text-slate-900"}>
          {says}
        </p>
        {footnote ? (
          <p className={tone === "warn" ? "mt-0.5 break-words text-xs text-amber-900" : "mt-0.5 break-words text-xs text-slate-500"}>
            {footnote}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** One field of the record: plain text, "Irrelevant", or the entries of a repeating block. */
function RecordRow({ row }: { row: CandidateRecordRow }) {
  if (row.kind === "irrelevant") {
    return (
      <KeyValue label={row.label}>
        <span className="text-phx-ink-soft">Irrelevant</span>
      </KeyValue>
    );
  }
  if (row.kind === "text") {
    return (
      <KeyValue label={row.label}>
        {/* Free text, and some of it Arabic: direction per value, and line breaks kept. */}
        <span className="block whitespace-pre-line" dir="auto">
          {row.text}
        </span>
      </KeyValue>
    );
  }
  return (
    <KeyValue label={row.label}>
      <ol className="space-y-1.5">
        {row.entries.map((lines, index) => (
          <li className="border-l-2 border-orange-200 pl-2" key={index}>
            {lines.map((line) => (
              <span className="block break-words" key={line.label}>
                <span className="text-[11px] font-semibold text-phx-ink-soft">{line.label}: </span>
                <span dir="auto">{line.text}</span>
              </span>
            ))}
          </li>
        ))}
      </ol>
    </KeyValue>
  );
}

/** One file on the record, with the two ways to open it. */
function FileRow({ file, uploadedBy }: { file: RecruitmentFile; uploadedBy: string | null }) {
  const downloadUrl = `/api/recruitment/files/${encodeURIComponent(file.id)}/download`;
  const meta = [
    fileKindLabel(file.kind),
    fileSize(file.sizeBytes),
    file.createdAt ? `added ${cairoStamp(file.createdAt)}` : null,
    uploadedBy ? `by ${uploadedBy}` : null,
  ].filter(Boolean);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-3 transition-colors last:border-b-0 hover:bg-slate-50/70">
      <span className="flex min-w-0 flex-1 items-start gap-2.5">
        <span
          aria-hidden
          className={`flex h-8 w-8 shrink-0 items-center justify-center border border-orange-200 bg-orange-50 text-orange-600 ${adminChipDepthClassName}`}
        >
          <FileText className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block break-all text-[13px] font-semibold leading-snug text-slate-950">{file.fileName}</span>
          <span className="mt-0.5 block break-words text-[11px] leading-snug text-slate-500">{meta.join(" · ")}</span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <a
          className={fileLinkClassName}
          href={`${downloadUrl}?disposition=inline`}
          rel="noreferrer"
          target="_blank"
          title="Open this file in its own browser tab"
        >
          <ExternalLink aria-hidden className="h-3 w-3" />
          Open
        </a>
        <a className={fileLinkClassName} href={downloadUrl} title="Save this file to your machine">
          <Download aria-hidden className="h-3 w-3" />
          Download
        </a>
      </span>
    </li>
  );
}

/** A short list inside a section: each item a heading line and quieter lines under it. */
function ListItem({ children, title }: { children?: React.ReactNode; title: React.ReactNode }) {
  return (
    <li className="border-b border-slate-100 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-slate-50/70">
      <span className="block break-words text-[13px] font-semibold leading-snug text-slate-950">{title}</span>
      {children ? <span className="mt-0.5 block break-words text-[12px] leading-snug text-slate-500">{children}</span> : null}
    </li>
  );
}

function Unreadable({ part }: { part: CandidateRecordPart }) {
  return (
    <p className="flex items-start gap-2 border-b border-rose-200 border-l-[3px] border-l-rose-500 bg-rose-50 px-4 py-2.5 text-[13px] leading-relaxed text-rose-800">
      <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{`Could not read ${PART_WORDS[part]}. Reload the page to try again.`}</span>
    </p>
  );
}

export function CandidateRecordPage({ record }: { record: CandidateRecord }) {
  // The browser's own path decides which shell the links stay in: /hr/recruitment is rewritten onto
  // the admin page before the server sees it, so only the client can tell the HR shell apart.
  const root = recruitmentRootFromPathname(usePathname());
  const { cvFolders, extraction, linkedOffer, people, profile, screeningQuestions, unavailable, viewers } = record;
  const { candidate } = profile;
  const failed = (part: CandidateRecordPart) => unavailable.includes(part);

  const displayName = candidateDisplayName(candidate.fullName) || "Unnamed candidate";
  const status = candidateStatusLabel(candidate.status);
  const appliedFor = candidateRowAppliedFor(candidate);
  const channel = candidateSourceChannel(candidate.source, candidate.sourceContext);
  const cvFile = primaryCvFile(profile.files);
  const sends = sendsToShow(record);
  const schema = getCvPositionSchema(defaultCvPositionKey);
  const recordSections = schema ? candidateRecordSections(candidate, schema) : [];
  const shelf = shelfLabel(candidate.folder);
  const addedBy = personName(people, candidate.createdBy);
  const sourceLines = candidate.sourceContext?.detailLines.filter((line) => line.trim()) ?? [];
  const sourceSubject = candidate.sourceContext?.shortLabel?.trim() || null;
  const applicationCount = profile.applications.length + profile.interviews.length + profile.rejectionHistory.length;

  // The header says the four things a reader checks first: what they applied for (the line under the
  // name), the stage they are at, the channel they came by and the day they arrived (the pills).
  const arrivedOn = cairoStamp(candidate.createdAt, { dateOnly: true });
  const appliedLine = appliedFor.text ? `Applying for ${appliedFor.text}` : "Applying for: not stated";
  const arrivalLine = arrivedOn ? (channel.key === "manual" ? `Added in Phoenix ${arrivedOn}` : `Arrived ${arrivedOn}`) : null;

  return (
    <div className="min-w-0 space-y-4">
      <RecruitmentPageHeader
        actions={
          <>
            <a
              className={`${phxButtonAccentClassName} ${adminControlDepthClassName}`}
              // On the CV's OWN decision tab, so "Screening list" on that page goes back to the pile
              // this person is actually in rather than to "Not decided yet", which may not hold them.
              href={screeningHref(root, { candidate: candidate.id, status: candidateDecisionTabOf(candidate.status) })}
              title="Open this CV on the screening page, where the decisions are made"
            >
              <ScanLine aria-hidden className="h-3.5 w-3.5" />
              Open in screening
            </a>
            {/* Book the interview from the record itself — no trip through screening first (owner,
                2026-09-18). Draws nothing for anyone the interview calendar is not shared with as an
                editor. */}
            <ScheduleInterviewButton
              candidate={{ id: candidate.id, jobTitle: appliedFor.text, name: displayName }}
              renderTrigger={({ open, title }) => (
                <button
                  className={`${phxButtonGhostClassName} ${adminControlDepthClassName}`}
                  onClick={open}
                  title={title}
                  type="button"
                >
                  <CalendarPlus aria-hidden className="h-3.5 w-3.5 text-orange-600" />
                  Schedule interview
                </button>
              )}
            />
            {/* Every section of this page as a sheet of paper (owner, 2026-09-19: "all data appearing
                here I want it printed"). A new tab, outside the shell, so the paper holds the record and
                nothing else. The CV is not on it: it prints from its own pane. */}
            <a
              className={`${phxButtonGhostClassName} ${adminControlDepthClassName}`}
              href={candidateRecordPrintHref(candidate.id)}
              rel="noopener noreferrer"
              target="_blank"
              title="Print everything on this page — the data, not the CV, which prints from its own pane"
            >
              <Printer aria-hidden className="h-3.5 w-3.5" />
              Print record
            </a>
            <a
              className="inline-flex items-center gap-1.5 px-2 py-2 text-sm font-bold text-slate-600 underline-offset-4 transition hover:text-slate-950 hover:underline"
              href={root}
              title="Back to the candidate pool"
            >
              <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
              Recruitment
            </a>
          </>
        }
        badges={
          <>
            <RecruitmentPill tone={STAGE_TONE[candidateDecisionTabOf(candidate.status)]}>{status}</RecruitmentPill>
            <span title={channel.title}>
              <RecruitmentPill tone="sky">
                {CHANNEL_ICON[channel.key]}
                {channel.label}
              </RecruitmentPill>
            </span>
            {arrivalLine ? (
              <RecruitmentPill tone="slate">
                <CalendarDays aria-hidden className="h-3 w-3" />
                {arrivalLine}
              </RecruitmentPill>
            ) : null}
            {candidate.rating ? (
              <RecruitmentPill tone="amber">
                <Star aria-hidden className="h-3 w-3 fill-current" />
                {candidateRatingLabels[candidate.rating]}
              </RecruitmentPill>
            ) : null}
          </>
        }
        description={appliedLine}
        eyebrow={`${RECRUITMENT_EYEBROW} · Candidate`}
        icon={<IdCard aria-hidden className="h-3.5 w-3.5" />}
        title={displayName}
      />

      {isStatedNonEgyptian(candidate.nationality) ? (
        <RecordNotice says={nonEgyptianFlagTitle(candidate.nationality)} tone="warn" />
      ) : null}
      {shelf ? (
        <RecordNotice
          footnote="A filed CV is kept off the main pool and the screening queue. It is still in the system."
          says={`Filed: ${shelf}`}
          tone="quiet"
        />
      ) : null}
      {unavailable.length > 0 ? (
        <RecordNotice
          footnote="Everything else on this page was read. Reload the page to try again."
          says={`Could not read ${unavailable.map((part) => PART_WORDS[part]).join(", ")}.`}
          tone="warn"
        />
      ) : null}

      {/* Two columns from xl up. The RECORD runs down the left; WHERE THEY STAND heads the right with
          the CV under it, the CV held in view while the record scrolls past. Below xl it is one
          column — where they stand, then the record, then the CV, full width. The grid places the
          three blocks so the source keeps the record's sections in the paper's order (the print
          page reads them from here). `minmax(0,1fr)` lets both columns shrink below their content,
          which is what keeps a long file name or address from pushing the page sideways. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-rows-[auto_1fr] xl:items-start">
        <div className="min-w-0 xl:col-start-2 xl:row-start-1">
          <RecordPanel title="Where they stand" count={status} icon={<BadgeCheck aria-hidden className="h-4 w-4" />} storageKey={`${FOLD_KEY}:standing`}>
            <KeyValue
              hint={candidate.statusNote ? <span dir="auto">{candidate.statusNote}</span> : undefined}
              label="Status"
            >
              {status}
            </KeyValue>
            {candidate.statusChangedAt || candidate.statusChangedByHrId ? (
              <KeyValue label="Decided">
                {byLine(personName(people, candidate.statusChangedByHrId), candidate.statusChangedAt)}
              </KeyValue>
            ) : null}
            <KeyValue
              hint={candidate.rating ? byLine(personName(people, candidate.ratedByHrId), candidate.ratedAt) : undefined}
              label="Star"
            >
              {candidate.rating ? (
                <>
                  <span aria-hidden className="text-phx-accent">
                    {"★".repeat(candidate.rating)}
                  </span>{" "}
                  {candidateRatingLabels[candidate.rating]}
                </>
              ) : (
                <span className="text-phx-ink-soft">No star</span>
              )}
            </KeyValue>
            {candidate.backgroundConfirmedOutcome ? (
              <KeyValue
                hint={byLine(personName(people, candidate.backgroundConfirmedByHrId), candidate.backgroundConfirmedAt)}
                label="Degree check"
              >
                {backgroundOutcomeLabel(candidate.backgroundConfirmedOutcome)}
              </KeyValue>
            ) : null}
            <KeyValue
              hint={
                candidate.folder
                  ? byLine(personName(people, candidate.folder.filedByHrId), candidate.folder.filedAt)
                  : undefined
              }
              label="Shelf"
            >
              {shelf ?? <span className="text-phx-ink-soft">In the main pool</span>}
            </KeyValue>
            <KeyValue label="Folders">
              {failed("folders") ? (
                <span className="text-phx-danger">Could not be read</span>
              ) : cvFolders.length === 0 ? (
                <span className="text-phx-ink-soft">In no folder</span>
              ) : (
                <ul className="space-y-1">
                  {cvFolders.map((folder) => {
                    const filed = byLine(personName(people, folder.filedByHrId), folder.filedAt);
                    return (
                      <li key={folder.folderId}>
                        <span className="block break-words">{folder.path.join(" › ")}</span>
                        {filed ? <span className="block text-[11px] text-phx-ink-soft">{`Filed ${filed}`}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </KeyValue>
            {/* The offer letter written for this person — the first screen that shows the pointer at
                all. It is ABSENT, not empty, for a viewer who may not see offer letters: the loader
                only reads it for `offers: read`, so this row renders "No offer letter" for them, the
                same as for somebody who genuinely has none. That is deliberate — a row reading
                "hidden" would tell a reader an offer exists, which is half the leak.

                NO MONEY HERE. The letter carries a salary; `LinkedOfferSummary` does not, so there is
                nothing on this row to infer one from. */}
            <KeyValue
              hint={linkedOffer ? offerStandingLine(linkedOffer) : undefined}
              label="Job offer"
            >
              {failed("offer") ? (
                <span className="text-phx-danger">Could not be read</span>
              ) : linkedOffer ? (
                <span className="block break-words">
                  {[linkedOffer.title, linkedOffer.territory].filter(Boolean).join(" · ")}
                </span>
              ) : (
                <span className="text-phx-ink-soft">No offer letter</span>
              )}
            </KeyValue>
            <KeyValue label="Managers">
              {failed("sends") ? (
                <span className="text-phx-danger">Could not be read</span>
              ) : sends.length === 0 ? (
                <span className="text-phx-ink-soft">Not sent to any manager</span>
              ) : (
                `Sent to ${sends.length === 1 ? "1 manager" : `${sends.length} managers`} — last ${cairoStamp(sends[0].sentAt)}`
              )}
            </KeyValue>
          </RecordPanel>
        </div>

        <div className="min-w-0 space-y-4 xl:col-start-1 xl:row-span-2 xl:row-start-1">
          <RecordPanel title="Screening summary" icon={<ClipboardCheck aria-hidden className="h-4 w-4" />} storageKey={`${FOLD_KEY}:summary`}>
            {failed("extraction") ? <Unreadable part="extraction" /> : null}
            <CandidateFactsSummary
              candidate={candidate}
              className="px-4 py-3"
              columns={2}
              extraction={extraction}
              frame="flat"
              screeningQuestions={screeningQuestions}
              showScreeningChecks
            />
          </RecordPanel>

          <RecordPanel title="How they reached us" count={channel.label} icon={<Inbox aria-hidden className="h-4 w-4" />} storageKey={`${FOLD_KEY}:arrival`}>
            <KeyValue hint={channel.title} label="Came in by">
              {channel.label}
            </KeyValue>
            {candidate.createdAt ? <KeyValue label="Arrived">{cairoStamp(candidate.createdAt)}</KeyValue> : null}
            {addedBy ? <KeyValue label="Added by">{addedBy}</KeyValue> : null}
            <KeyValue
              hint={
                appliedFor.source ? (
                  <>
                    {APPLIED_FOR_SOURCE_LABEL[appliedFor.source]}
                    {appliedFor.evidence && appliedFor.evidence !== appliedFor.text ? (
                      <span className="block" dir="auto">{`“${appliedFor.evidence}”`}</span>
                    ) : null}
                  </>
                ) : undefined
              }
              label="Applying for"
            >
              {appliedFor.text ?? <span className="text-phx-ink-soft">Not stated</span>}
            </KeyValue>
            {sourceSubject ? (
              <KeyValue label={candidate.sourceContext?.channel === "email" ? "Subject" : "Message"}>
                <span className="block" dir="auto">
                  {sourceSubject}
                </span>
              </KeyValue>
            ) : null}
            {sourceLines.length > 0 ? (
              <KeyValue label={candidate.sourceContext?.channel === "whatsapp" ? "First messages" : "Message"}>
                {/* One line per message, each with its own direction: an Arabic line and an English
                    one in the same block must each read from their own side. */}
                {sourceLines.map((line, index) => (
                  <span className="block whitespace-pre-line" dir="auto" key={index}>
                    {line}
                  </span>
                ))}
              </KeyValue>
            ) : null}
            {candidate.cvReferenceName ? (
              <KeyValue label="CV reference">
                <span className="break-all">{candidate.cvReferenceName}</span>
              </KeyValue>
            ) : null}
            {candidate.cvExternalUrl ? (
              <KeyValue label="CV link">
                <a
                  className="break-all text-phx-accent-press underline underline-offset-2"
                  href={candidate.cvExternalUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {candidate.cvExternalUrl}
                </a>
              </KeyValue>
            ) : null}
            {candidate.notes ? (
              <KeyValue label="Notes on file">
                <span className="block whitespace-pre-line" dir="auto">
                  {candidate.notes}
                </span>
              </KeyValue>
            ) : null}
            {candidate.updatedAt ? <KeyValue label="Last changed">{cairoStamp(candidate.updatedAt)}</KeyValue> : null}
          </RecordPanel>

          <RecordPanel
            title="Everything on the record"
            count={recordSections.length === 0 ? "nothing on file" : undefined}
            icon={<Database aria-hidden className="h-4 w-4" />}
            storageKey={`${FOLD_KEY}:record`}
          >
            {recordSections.length === 0 ? (
              <RecruitmentEmptyState
                icon={<Database aria-hidden className="h-5 w-5" />}
                message="Nothing has been saved on this candidate beyond their name."
                title="Nothing on the record"
              />
            ) : (
              recordSections.map((section) => (
                <CollapsibleSection
                  key={section.key}
                  right={`${section.rows.length}`}
                  storageKey={`${FOLD_KEY}:record:${section.key}`}
                  title={section.label}
                  tone="quiet"
                >
                  {section.rows.map((row) => (
                    <RecordRow key={row.key} row={row} />
                  ))}
                </CollapsibleSection>
              ))
            )}
          </RecordPanel>

          <RecordPanel title="Files" count={`${profile.files.length}`} icon={<Paperclip aria-hidden className="h-4 w-4" />} storageKey={`${FOLD_KEY}:files`}>
            {profile.files.length === 0 ? (
              <RecruitmentEmptyState
                icon={<Paperclip aria-hidden className="h-5 w-5" />}
                message="No file is attached to this candidate."
                title="No files"
              />
            ) : (
              <ul>
                {profile.files.map((file) => (
                  <FileRow file={file} key={file.id} uploadedBy={personName(people, file.uploadedByHrId)} />
                ))}
              </ul>
            )}
          </RecordPanel>

          <RecordPanel
            title="Sent to managers"
            count={failed("sends") ? undefined : `${sends.length}`}
            icon={<Send aria-hidden className="h-4 w-4" />}
            storageKey={`${FOLD_KEY}:sends`}
          >
            {failed("sends") ? (
              <Unreadable part="sends" />
            ) : sends.length === 0 ? (
              <RecruitmentEmptyState
                icon={<Send aria-hidden className="h-5 w-5" />}
                message="This CV has not been sent to any manager."
                title="Not sent yet"
              />
            ) : (
              <ul>
                {sends.map((send, index) => {
                  const seat = [send.managerJobTitle, send.managerArea, send.managerRegion].filter(Boolean).join(" · ");
                  return (
                    <ListItem key={`${send.managerHrId}-${send.sentAt}-${index}`} title={managerLabel(send.managerName)}>
                      {seat ? <span className="block">{seat}</span> : null}
                      {send.position ? <span className="block">{`For: ${positionFolderLabel(send.position)}`}</span> : null}
                      <span className="block">{`Sent ${cairoStamp(send.sentAt)}`}</span>
                    </ListItem>
                  );
                })}
              </ul>
            )}
          </RecordPanel>

          <RecordPanel
            title="Applications and interviews"
            count={`${applicationCount}`}
            icon={<Briefcase aria-hidden className="h-4 w-4" />}
            storageKey={`${FOLD_KEY}:applications`}
          >
            {applicationCount === 0 ? (
              <RecruitmentEmptyState
                icon={<Briefcase aria-hidden className="h-5 w-5" />}
                message="Not put forward for a vacancy, and no interview on file."
                title="Nothing on file"
              />
            ) : (
              <ul>
                {profile.applications.map(({ application, jobTitle }) => {
                  const owner = personName(people, application.currentOwnerHrId);
                  return (
                    <ListItem
                      key={application.id}
                      title={`${jobTitle?.trim() || "A vacancy with no title"} — ${applicationStageLabel(application.stage)}`}
                    >
                      {application.lastStageChangedAt ? (
                        <span className="block">{`At this stage since ${cairoStamp(application.lastStageChangedAt)}`}</span>
                      ) : null}
                      {owner ? <span className="block">{`With ${owner}`}</span> : null}
                      {application.rejectedReason ? (
                        <span className="block" dir="auto">{`Rejected: ${application.rejectedReason}`}</span>
                      ) : null}
                      {application.decisionReason ? (
                        <span className="block" dir="auto">{`Decision: ${application.decisionReason}`}</span>
                      ) : null}
                    </ListItem>
                  );
                })}
                {profile.interviews.map(({ interview, summary }) => {
                  const interviewer = personName(people, interview.interviewerHrId);
                  return (
                    <ListItem
                      key={interview.id}
                      title={`${humanizeRecruitmentTerm(interview.interviewType)} interview${
                        interview.outcome ? ` — ${humanizeRecruitmentTerm(interview.outcome)}` : ""
                      }`}
                    >
                      {interview.scheduledAt ? <span className="block">{`Scheduled ${cairoStamp(interview.scheduledAt)}`}</span> : null}
                      {interviewer ? <span className="block">{`Interviewer: ${interviewer}`}</span> : null}
                      {summary.average !== null ? (
                        <span className="block">{`Score ${summary.average} · ${summary.ratedCount} of ${summary.totalCriteria} rated`}</span>
                      ) : null}
                      {interview.notes ? (
                        <span className="block whitespace-pre-line" dir="auto">
                          {interview.notes}
                        </span>
                      ) : null}
                    </ListItem>
                  );
                })}
                {profile.rejectionHistory.map((event) => {
                  const actor = byLine(personName(people, event.actorHrId), event.createdAt);
                  return (
                    <ListItem key={event.id} title={event.action === "app_withdraw" ? "Withdrew" : "Rejected"}>
                      {event.reason ? <span className="block" dir="auto">{event.reason}</span> : null}
                      {actor ? <span className="block">{actor}</span> : null}
                    </ListItem>
                  );
                })}
              </ul>
            )}
          </RecordPanel>

          <RecordPanel
            title="Opened by"
            count={failed("viewers") ? undefined : `${viewers.length}`}
            icon={<Eye aria-hidden className="h-4 w-4" />}
            storageKey={`${FOLD_KEY}:viewers`}
          >
            {failed("viewers") ? (
              <Unreadable part="viewers" />
            ) : viewers.length === 0 ? (
              <RecruitmentEmptyState
                icon={<Eye aria-hidden className="h-5 w-5" />}
                message="Nobody has opened this CV yet."
                title="Not opened yet"
              />
            ) : (
              <ul>
                {viewers.map((viewer, index) => (
                  <ListItem key={`${viewer.name ?? "unnamed"}-${index}`} title={viewer.name ?? UNNAMED_USER_LABEL}>
                    <span className="block">{`First opened ${cairoStamp(viewer.firstSeenAt)}`}</span>
                    <span className="block">
                      {`Last opened ${cairoStamp(viewer.lastSeenAt)} · ${
                        viewer.viewCount === 1 ? "once" : `${viewer.viewCount} times`
                      }`}
                    </span>
                  </ListItem>
                ))}
              </ul>
            )}
          </RecordPanel>

          <RecordPanel title="History" icon={<History aria-hidden className="h-4 w-4" />} storageKey={`${FOLD_KEY}:history`}>
            <WorkstationTimelineTab candidateId={candidate.id} />
          </RecordPanel>

          <RecordPanel title="Notes" icon={<NotebookPen aria-hidden className="h-4 w-4" />} storageKey={`${FOLD_KEY}:notes`}>
            {/* Read-only here. Notes are written on the screening page, beside the decision. */}
            <WorkstationNotesTab canWrite={false} candidateId={candidate.id} />
          </RecordPanel>
        </div>

        {/* The CV. It stretches down the right column on a wide screen so the pane can stay in view
            while the record scrolls past; the pane itself needs a box of its own height, since it
            fills its parent and scrolls inside. The pane carries its own "CV" head, so the box around
            it is a plain lifted frame rather than a second titled panel. */}
        <div className="min-w-0 xl:col-start-2 xl:row-start-2 xl:self-stretch">
          <div
            className={`h-[80vh] min-h-[28rem] overflow-hidden border border-slate-200 bg-white xl:sticky xl:top-4 ${adminPanelDepthClassName}`}
          >
            <WorkstationCvPane
              attachedCount={profile.files.length}
              error={null}
              file={cvFile ? { fileName: cvFile.fileName, id: cvFile.id, mimeType: cvFile.mimeType } : null}
              loading={false}
              notACv={extraction?.isCv === false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
