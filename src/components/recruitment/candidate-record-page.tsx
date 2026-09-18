"use client";

// Recruitment / ATS — one candidate's own page: everything the system holds on them, in one place.
//
// The owner, 2026-09-18: "when I press on the name of the person, I am jumped to a new page which
// shows the full details on everything for this candidate." The name in the candidate pool and on
// WhatsApp Applicants opens this page in a new tab (candidate-page-link.ts).
//
// WHAT IT SHOWS, top to bottom: where they stand (status, star, field-force check, shelf, folders),
// the screening summary the screening page shows, how they reached us, every field on the record, the
// files, every send to a manager, applications and interviews, who has opened the CV, the history and
// the notes — with the CV itself open beside it on a wide screen and below it on a phone.
//
// READ-ONLY ON PURPOSE. This page never marks the CV read and never holds it for the viewer; see the
// header of candidate-record.ts for why. Decisions are one click away, on the screening page, which is
// where the screening rules and the undo live. The notes panel is the same one the screening page
// shows, without its note box.
//
// THE LOOK IS THE SCREENING PAGE'S OWN KIT (workstation-look.tsx, workstation-ui.tsx): square edges,
// hairlines, one display-type name, sections that fold with their summary still showing. Every value
// wraps — nothing is cut short with an ellipsis and nothing scrolls sideways.

import { ArrowLeft, Download, ExternalLink, ScanLine } from "lucide-react";
import { usePathname } from "next/navigation";
import type React from "react";

import { CandidateFactsSummary } from "@/components/recruitment/candidate-facts-summary";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import { WorkstationCvPane } from "@/components/recruitment/workstation/workstation-cv-pane";
import {
  WorkstationNotesTab,
  WorkstationTimelineTab,
} from "@/components/recruitment/workstation/workstation-history-tabs";
import { ActionLink, Band, BandSays, WorkHeader } from "@/components/recruitment/workstation/workstation-look";
import {
  cairoStamp,
  CollapsibleSection,
  EmptyNote,
  KeyValue,
} from "@/components/recruitment/workstation/workstation-ui";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { isBatchActor } from "@/lib/recruitment/batch-actor";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import {
  candidateFolderKindLabels,
  candidateFolderLabel,
  DUPLICATE_FOLDER_KIND,
  DUPLICATE_FOLDER_LABEL,
} from "@/lib/recruitment/candidate-folder";
import { recruitmentRootFromPathname } from "@/lib/recruitment/candidate-page-link";
import { candidateRatingLabels } from "@/lib/recruitment/candidate-rating";
import type { CandidateRecord, CandidateRecordPart } from "@/lib/recruitment/candidate-record";
import { candidateRecordSections, type CandidateRecordRow } from "@/lib/recruitment/candidate-record-fields";
import { candidateSourceChannel } from "@/lib/recruitment/candidate-source-context";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import { defaultCvPositionKey, getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import { applicationStageLabel, humanizeRecruitmentTerm } from "@/lib/recruitment/labels";
import { isStatedNonEgyptian, nonEgyptianFlagTitle } from "@/lib/recruitment/nationality";
import { managerLabel, UNNAMED_USER_LABEL } from "@/lib/recruitment/person-labels";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import { screeningHref } from "@/lib/recruitment/screening-link";
import { candidateDecisionTabOf } from "@/lib/recruitment/candidate-decision-tabs";
import type { ManagerSend } from "@/lib/recruitment/manager-sends";
import type { Candidate, RecruitmentFile } from "@/lib/recruitment/types";

/** What each part is called when it could not be read — in the reader's words, never a code. */
const PART_WORDS: Record<CandidateRecordPart, string> = {
  extraction: "the CV reader's last read",
  folders: "the folders this CV is in",
  questions: "the wording of the WhatsApp questions",
  sends: "the sends to managers",
  viewers: "who has opened this CV",
};

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
          <li className="border-l-2 border-phx-line pl-2" key={index}>
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
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-phx-line/70 px-3 py-2 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block break-all text-[13px] font-semibold leading-snug text-phx-ink">{file.fileName}</span>
        <span className="mt-0.5 block break-words text-[11px] leading-snug text-phx-ink-soft">{meta.join(" · ")}</span>
      </span>
      <span className="flex flex-wrap items-center gap-1.5">
        <ActionLink
          className="px-2 py-1 text-[11px]"
          href={`${downloadUrl}?disposition=inline`}
          rel="noreferrer"
          target="_blank"
          title="Open this file in its own browser tab"
        >
          <ExternalLink aria-hidden className="h-3 w-3" />
          Open
        </ActionLink>
        <ActionLink className="px-2 py-1 text-[11px]" href={downloadUrl} title="Save this file to your machine">
          <Download aria-hidden className="h-3 w-3" />
          Download
        </ActionLink>
      </span>
    </li>
  );
}

/** A short list inside a section: each item a heading line and quieter lines under it. */
function ListItem({ children, title }: { children?: React.ReactNode; title: React.ReactNode }) {
  return (
    <li className="border-b border-phx-line/70 px-3 py-2 last:border-b-0">
      <span className="block break-words text-[13px] font-semibold leading-snug text-phx-ink">{title}</span>
      {children ? <span className="mt-0.5 block break-words text-[12px] leading-snug text-phx-ink-soft">{children}</span> : null}
    </li>
  );
}

function Unreadable({ part }: { part: CandidateRecordPart }) {
  return (
    <p className="px-3 py-3 text-[13px] leading-relaxed text-phx-danger">
      {`Could not read ${PART_WORDS[part]}. Reload the page to try again.`}
    </p>
  );
}

export function CandidateRecordPage({ record }: { record: CandidateRecord }) {
  // The browser's own path decides which shell the links stay in: /hr/recruitment is rewritten onto
  // the admin page before the server sees it, so only the client can tell the HR shell apart.
  const root = recruitmentRootFromPathname(usePathname());
  const { cvFolders, extraction, people, profile, screeningQuestions, unavailable, viewers } = record;
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

  const arrivedOn = cairoStamp(candidate.createdAt, { dateOnly: true });
  const subtitle = [
    appliedFor.text ? `Applying for ${appliedFor.text}` : "Applying for: not stated",
    status,
    arrivedOn
      ? channel.key === "manual"
        ? `added in Phoenix ${arrivedOn}`
        : `arrived ${arrivedOn} by ${channel.label}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border border-phx-line bg-white">
      <WorkHeader
        controls={
          <>
            <ActionLink
              // On the CV's OWN decision tab, so "Screening list" on that page goes back to the pile
              // this person is actually in rather than to "Not decided yet", which may not hold them.
              href={screeningHref(root, { candidate: candidate.id, status: candidateDecisionTabOf(candidate.status) })}
              title="Open this CV on the screening page, where the decisions are made"
              tone="primary"
            >
              <ScanLine aria-hidden className="h-3.5 w-3.5" />
              Open in screening
            </ActionLink>
            {/* Book the interview from the record itself — no trip through screening first (owner,
                2026-09-18). Draws nothing for anyone the interview calendar is not shared with as an
                editor. */}
            <ScheduleInterviewButton
              candidate={{ id: candidate.id, jobTitle: appliedFor.text, name: displayName }}
            />
            <ActionLink href={root} title="Back to the candidate pool" tone="ghost">
              <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
              Recruitment
            </ActionLink>
          </>
        }
        subtitle={subtitle}
        title={displayName}
      />

      {isStatedNonEgyptian(candidate.nationality) ? (
        <Band tone="warn">
          <BandSays>{nonEgyptianFlagTitle(candidate.nationality)}</BandSays>
        </Band>
      ) : null}
      {shelf ? (
        <Band footnote="A filed CV is kept off the main pool and the screening queue. It is still in the system." tone="quiet">
          <BandSays>{`Filed: ${shelf}`}</BandSays>
        </Band>
      ) : null}
      {unavailable.length > 0 ? (
        <Band footnote="Everything else on this page was read. Reload the page to try again." tone="warn">
          <BandSays>{`Could not read ${unavailable.map((part) => PART_WORDS[part]).join(", ")}.`}</BandSays>
        </Band>
      ) : null}

      {/* Two columns from xl up — the record, and the CV beside it. Below xl the CV follows the record,
          full width. `minmax(0,1fr)` lets both columns shrink below their content, which is what keeps
          a long file name or address from pushing the page sideways. */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 xl:border-r xl:border-phx-line">
          <CollapsibleSection right={status} storageKey={`${FOLD_KEY}:standing`} title="Where they stand">
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
            <KeyValue label="Managers">
              {failed("sends") ? (
                <span className="text-phx-danger">Could not be read</span>
              ) : sends.length === 0 ? (
                <span className="text-phx-ink-soft">Not sent to any manager</span>
              ) : (
                `Sent to ${sends.length === 1 ? "1 manager" : `${sends.length} managers`} — last ${cairoStamp(sends[0].sentAt)}`
              )}
            </KeyValue>
          </CollapsibleSection>

          <CollapsibleSection storageKey={`${FOLD_KEY}:summary`} title="Screening summary">
            {failed("extraction") ? <Unreadable part="extraction" /> : null}
            <CandidateFactsSummary
              candidate={candidate}
              className="px-3 py-2"
              columns={2}
              extraction={extraction}
              frame="flat"
              screeningQuestions={screeningQuestions}
              showScreeningChecks
            />
          </CollapsibleSection>

          <CollapsibleSection right={channel.label} storageKey={`${FOLD_KEY}:arrival`} title="How they reached us">
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
          </CollapsibleSection>

          <CollapsibleSection
            right={recordSections.length === 0 ? "nothing on file" : undefined}
            storageKey={`${FOLD_KEY}:record`}
            title="Everything on the record"
          >
            {recordSections.length === 0 ? (
              <EmptyNote>Nothing has been saved on this candidate beyond their name.</EmptyNote>
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
          </CollapsibleSection>

          <CollapsibleSection right={`${profile.files.length}`} storageKey={`${FOLD_KEY}:files`} title="Files">
            {profile.files.length === 0 ? (
              <EmptyNote>No file is attached to this candidate.</EmptyNote>
            ) : (
              <ul>
                {profile.files.map((file) => (
                  <FileRow file={file} key={file.id} uploadedBy={personName(people, file.uploadedByHrId)} />
                ))}
              </ul>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            right={failed("sends") ? undefined : `${sends.length}`}
            storageKey={`${FOLD_KEY}:sends`}
            title="Sent to managers"
          >
            {failed("sends") ? (
              <Unreadable part="sends" />
            ) : sends.length === 0 ? (
              <EmptyNote>This CV has not been sent to any manager.</EmptyNote>
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
          </CollapsibleSection>

          <CollapsibleSection
            right={`${applicationCount}`}
            storageKey={`${FOLD_KEY}:applications`}
            title="Applications and interviews"
          >
            {applicationCount === 0 ? (
              <EmptyNote>Not put forward for a vacancy, and no interview on file.</EmptyNote>
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
          </CollapsibleSection>

          <CollapsibleSection
            right={failed("viewers") ? undefined : `${viewers.length}`}
            storageKey={`${FOLD_KEY}:viewers`}
            title="Opened by"
          >
            {failed("viewers") ? (
              <Unreadable part="viewers" />
            ) : viewers.length === 0 ? (
              <EmptyNote>Nobody has opened this CV yet.</EmptyNote>
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
          </CollapsibleSection>

          <CollapsibleSection storageKey={`${FOLD_KEY}:history`} title="History">
            <WorkstationTimelineTab candidateId={candidate.id} />
          </CollapsibleSection>

          <CollapsibleSection storageKey={`${FOLD_KEY}:notes`} title="Notes">
            {/* Read-only here. Notes are written on the screening page, beside the decision. */}
            <WorkstationNotesTab canWrite={false} candidateId={candidate.id} />
          </CollapsibleSection>
        </div>

        <div className="min-w-0 border-t border-phx-line xl:border-t-0">
          {/* The CV needs a box of its own height: the pane fills its parent and scrolls inside. On a
              wide screen it stays in view while the record scrolls past it. */}
          <div className="h-[80vh] min-h-[28rem] xl:sticky xl:top-0">
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
