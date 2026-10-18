"use client";

// Recruitment / ATS — the CV shelf, as a screen.
//
// Three shelves, each holding folders, each folder holding the CVs somebody parked there. The owner
// asked for it in these words on 2026-08-30: *"if this CV is good, but I'm not needing it now, I
// push the CV to the folder, and then I have every single archive"* — and, the part that shapes this
// component, *"the CV that I push to a folder ... it is not appearing now on the main page."*
//
// THE DANGER THIS SCREEN EXISTS TO ANSWER. Hiding 300 CVs is how a good CV is lost forever, so
// everything here is built to make the shelf loud rather than quiet: every shelf renders even when
// empty, every folder shows its count, every CV shows who filed it and when, and returning one to
// the pool is a single click that changes nothing else about the candidate. A shelf you cannot see
// into is a delete button with better manners.
//
// Reads the SAME `partitionCandidatesByFolder` the pool does, over the same array. That is
// deliberate and it is the one invariant that matters: a CV is in exactly one of the two halves by
// construction, so the pool and this screen can never both hide the same person.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Copy,
  FileText,
  FolderInput,
  FolderOpen,
  IdCard,
  Loader2,
  MessageSquareText,
  Undo2,
} from "lucide-react";

import { BackgroundReviewPanel } from "@/components/recruitment/background-review-panel";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { ScheduleInterviewButton } from "@/components/recruitment/interview-calendar/schedule-interview-button";
import { CvFolderCabinet, type CvFolderCabinetData } from "@/components/recruitment/cv-folder-cabinet";
import { deleteRequest, getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { personLabel, UNNAMED_FILER_LABEL } from "@/lib/recruitment/person-labels";
import {
  partitionCandidatesByFolder,
  type CandidateFolder,
  type CandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import {
  collectSuggestedFilings,
  groupUnplacedFilings,
  type SuggestedFiling,
} from "@/lib/recruitment/candidate-folder-suggestion";
import type { CandidateFolderAreaOption } from "@/lib/recruitment/candidate-folder-options";
import type { Candidate } from "@/lib/recruitment/types";
import { cn } from "@/lib/utils";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminHeroActionSecondaryClassName,
} from "@/components/admin/admin-design-tokens";
import { RecruitmentEmptyState, RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
import { phxButtonAccentClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";

/**
 * The small square action every row on this tab uses — "Put back in the pool", "Open profile". A
 * hairline control lifted by the house control shadow; it drops the shadow when it is disabled, so a
 * greyed button never still reads as pressable.
 */
const rowActionClassName = `inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-800 disabled:pointer-events-none disabled:opacity-50 ${adminControlDepthClassName} disabled:shadow-none`;

/** The error line under a panel's band: a rose rule, an icon, and words that wrap. */
function PanelError({ children }: { children: string }) {
  return (
    <p
      className="flex items-start gap-2 border-b border-rose-200 border-l-[3px] border-l-rose-500 bg-rose-50 px-4 py-2.5 text-xs font-semibold text-rose-800"
      role="alert"
    >
      <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/**
 * Cairo, always — the owner's standing rule, and the same helper shape the workspace uses. A filing
 * stamp read in UTC is an hour or two wrong for every person who will ever look at it.
 */
function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return formatStableEnGb(parsed, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

export function CandidateFoldersTab({
  areaOptions,
  canFileCandidates,
  candidates,
  cvFolderCabinet,
  onOpenCandidate,
}: {
  /** The live areas — passed straight to the declared-filings preview, which must not suggest a
   * medical-rep folder for a typed area that is not one of these. See DeclaredFilingsPanel. */
  areaOptions: CandidateFolderAreaOption[];
  /** `candidates: update`. Without it the hand-built tree is readable and every button is absent. */
  canFileCandidates: boolean;
  candidates: Candidate[];
  /**
   * The folders a recruiter built by hand, which sit ABOVE the four automatic shelves.
   *
   * One tab, two mechanisms, in the order the owner asked for them on 2026-09-12: his own folders
   * first, because they are the ones he maintains, and the derived shelves under them. Splitting
   * them across two tabs would mean two answers to "where is that CV filed?", which is the question
   * this whole screen exists to answer once.
   */
  cvFolderCabinet: CvFolderCabinetData;
  /**
   * Open one filed candidate's full PROFILE — which means leaving this screen, because the panel
   * renders in the pool tab. Reached from the row's Profile button and from the background-review
   * panel, no longer from the name: reading the CV is the common case and it now happens in place
   * (see FiledCvName), so the redirect is reserved for the times the reader wants the record.
   *
   * Handed in rather than implemented here on purpose: the profile panel, its fetch and its
   * scroll-restore all live in the pool tab, and a second copy on this screen would be a second
   * thing to keep in step. This routes into the SAME opener the inbound-CV notification uses.
   */
  onOpenCandidate: (candidateId: string) => void;
}) {
  const router = useRouter();
  const { archived, shelves, filedCount, pool } = partitionCandidatesByFolder(candidates);
  // Which folder is open, as "kind/key". Null shows the shelves themselves — the filing cabinet
  // closed, which is the right first view when there are more folders than fit on a screen.
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const returnToPool = async (candidate: Candidate) => {
    setBusyId(candidate.id);
    setError(null);
    try {
      await deleteRequest(`/api/recruitment/candidates/${candidate.id}/folder`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to return this CV to the pool.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* The one number that says whether this feature is being used, and the one that says the pool
          is not silently draining into it. Both, side by side, on purpose. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-l-[3px] border-l-orange-500 pl-3">
        <div className="min-w-0 grow basis-72">
          <h2 className="flex items-center gap-2 text-base font-black tracking-tight text-slate-950">
            <FolderOpen aria-hidden className="h-4 w-4 text-orange-600" />
            Folders
          </h2>
          <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">
            Good CVs kept for later. Filed CVs are off the main pool and nowhere else — they still show
            in search and still count against duplicates.
          </p>
        </div>
        <span
          className={`whitespace-nowrap border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-black tabular-nums text-orange-800 ${adminChipDepthClassName}`}
        >
          {filedCount} filed · {pool.length} in the pool
        </span>
      </div>

      {error ? (
        <p
          className="flex items-start gap-2 border border-rose-200 border-l-[3px] border-l-rose-500 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800"
          role="alert"
        >
          <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}

      {/* The recruiter's OWN folders, first — the only ones on this screen anybody has to maintain,
          and the only ones that nest. Everything below is derived and cannot be created. */}
      <CvFolderCabinet
        cabinet={cvFolderCabinet}
        canManage={canFileCandidates}
        candidates={candidates}
        onOpenCandidate={onOpenCandidate}
      />

      {/* ── THE ARCHIVE, AND THE WAY BACK OUT ────────────────────────────────────────────────────
          Records archived as duplicates from the screening queue. It is listed rather than hidden
          because the evidence behind a duplicate is never proof — candidate-matching.ts keeps the
          identity rule LOCKED to national ID then email, and neither has a single collision in
          production, so everything here was archived on a shared number or a shared name. A person
          pressed the button; a person must be able to undo it, and "reversible" is only true if
          there is a screen that shows what to reverse. */}
      {archived.length > 0 ? (
        <RecruitmentPanel
          count={<span className="whitespace-nowrap">{archived.length} archived</span>}
          description="Archived as the same person as another record. Out of the pool, nothing merged, nothing deleted."
          icon={<Copy aria-hidden className="h-4 w-4" />}
          title="Duplicates"
        >
          <ul className="divide-y divide-slate-100">
            {archived.map((candidate) => (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 transition-colors hover:bg-slate-50/70"
                key={candidate.id}
              >
                <button
                  className="min-w-0 break-words text-left text-[13px] font-bold text-slate-950 underline-offset-2 hover:text-orange-700 hover:underline"
                  onClick={() => onOpenCandidate(candidate.id)}
                  type="button"
                >
                  {candidate.fullName}
                </button>
                <span className="min-w-0 break-all text-[12px] tabular-nums text-slate-500">
                  {candidate.phone ?? candidate.email ?? ""}
                </span>
                <button
                  className={`ml-auto ${rowActionClassName}`}
                  disabled={busyId === candidate.id}
                  onClick={() => void returnToPool(candidate)}
                  type="button"
                >
                  {busyId === candidate.id ? (
                    <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Undo2 aria-hidden className="h-3.5 w-3.5" />
                  )}
                  {busyId === candidate.id ? "Putting back..." : "Put back in the pool"}
                </button>
              </li>
            ))}
          </ul>
        </RecruitmentPanel>
      ) : null}

      <DeclaredFilingsPanel
        areaOptions={areaOptions}
        candidates={candidates}
        onOpenCandidate={onOpenCandidate}
      />

      {/* Above the shelves and below the one-press panel, in the order the two decisions happen: the
          people who told us where they belong are filed first, and what is left is the queue of
          degrees somebody has to read. Both sit on the Folders tab because both END in a folder. */}
      <BackgroundReviewPanel candidates={candidates} onOpenCandidate={onOpenCandidate} />

      {shelves.map((shelf) => (
        // The DESCRIPTION wraps, unlike the label and the count beside it. Measured at 375px on
        // 2026-09-02: held at `whitespace-nowrap` this sentence laid out 441px wide inside a 325px
        // box and the tail was simply painted off the side of the phone, unreadable and unreachable —
        // the page does not scroll sideways, so nothing gets you to it. The fits-the-screen golden
        // rule supersedes the no-wrap habit exactly here: wrapping is the permitted answer, and the
        // ellipsis ban is untouched because nothing is cut. It now sits under the band's title as the
        // panel's description, which wraps by construction.
        <RecruitmentPanel
          count={
            <span className="whitespace-nowrap">
              {shelf.candidateCount} {shelf.candidateCount === 1 ? "CV" : "CVs"}
            </span>
          }
          description={shelf.description}
          icon={<FolderOpen aria-hidden className="h-4 w-4" />}
          key={shelf.kind}
          title={<span className="whitespace-nowrap">{shelf.label}</span>}
        >
          {shelf.folders.length === 0 ? (
            // An empty shelf says so in words rather than vanishing. A section that disappears when
            // it empties is one that reads as a bug the first day somebody uses it.
            <RecruitmentEmptyState
              icon={<FolderOpen aria-hidden className="h-5 w-5" />}
              message="Use “File to folder” on a CV in the pool."
              title="Nothing filed here yet."
            />
          ) : (
            <div className="flex flex-wrap gap-2 p-4">
              {shelf.folders.map((folder) => (
                <FolderChip
                  folder={folder}
                  isOpen={openFolder === folderId(shelf.kind, folder.key)}
                  key={folder.key}
                  onToggle={() =>
                    setOpenFolder((current) =>
                      current === folderId(shelf.kind, folder.key) ? null : folderId(shelf.kind, folder.key),
                    )
                  }
                />
              ))}
            </div>
          )}

          {shelf.folders.map((folder) =>
            openFolder === folderId(shelf.kind, folder.key) ? (
              <div className="border-t border-slate-200" key={`open-${folder.key}`}>
                {/* The open folder names itself on a recessed strip, so the rows under it read as the
                    contents of that one chip and not as another list on the shelf. */}
                <p className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-[11px] font-black uppercase tracking-[0.1em] text-slate-700">
                  <FolderOpen aria-hidden className="h-3.5 w-3.5 shrink-0 text-orange-600" />
                  <span className="min-w-0 break-words">{folder.label}</span>
                </p>
                <ul className="divide-y divide-slate-100">
                  {folder.candidates.map((candidate) => (
                    <li
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 transition-colors hover:bg-orange-50/40"
                      key={candidate.id}
                    >
                      {/* The row IS the CV — and since 2026-09-02 it opens the CV itself, in place.
                          A folder you can only look at is an archive; a folder you can read out of
                          is the filing cabinet the owner actually asked for. */}
                      <FiledCvName candidate={candidate} />
                      {/* Everything the profile panel can do that a CV cannot — the full file list
                          for the 105 candidates carrying more than one CV, the status control, the
                          history — still lives one press away, and this is the only route to it from
                          the shelf. Pressing the name used to land here; that is what changed. */}
                      <span className="ml-auto flex flex-wrap items-center gap-2">
                        <button
                          className={rowActionClassName}
                          onClick={() => onOpenCandidate(candidate.id)}
                          title={`Open ${candidateDisplayName(candidate.fullName)}'s full profile`}
                          type="button"
                        >
                          <IdCard aria-hidden className="h-3.5 w-3.5" />
                          Profile
                        </button>
                        <button
                          className={rowActionClassName}
                          disabled={busyId === candidate.id}
                          onClick={() => returnToPool(candidate)}
                          type="button"
                        >
                          <Undo2 aria-hidden className="h-3.5 w-3.5" />
                          Return to pool
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </RecruitmentPanel>
      ))}
    </div>
  );
}

/** "kind/key" — unique across shelves, because two shelves can legitimately hold the same key. */
function folderId(kind: CandidateFolderKind, key: string): string {
  return `${kind}/${key}`;
}

/** The shape `GET /api/recruitment/candidates/:id/files` returns, narrowed to what a preview needs. */
type CandidateFileSummary = { id: string; fileName: string; kind: string; mimeType: string | null };

/**
 * The filed candidate's name, as the control that opens their CV — in a popup, over this screen.
 *
 * WHAT THIS REPLACED, AND WHY. The same button used to promise "Open X's CV" and instead leave the
 * folders screen entirely: it set `?candidate=<id>`, switched to the pool tab, and rendered the
 * profile panel underneath a table of every candidate in the system. Reading one filed CV therefore
 * cost three interactions (name → wait for the profile fetch → press the file name), and it spent
 * the reader's place in the filing cabinet to do it — the shelf they had opened was gone, and
 * getting back to it meant finding the folder again. The owner asked for the CV itself, as a popup,
 * with a download button, and no redirect. This is that.
 *
 * WHY THERE IS ALMOST NOTHING HERE. The hard parts are already solved and deliberately not copied:
 * CvPreviewModal owns the document (PDF rasterised by pdfjs, .docx by docx-preview, images), the
 * zoom, the base64 transport that a download-manager extension cannot hijack, and the Download
 * control in its header. This component's whole job is to answer WHICH file, so the two paths into a
 * CV cannot drift apart.
 *
 * NEWEST CV WINS. `listCandidateFiles` orders by `created_at` descending, so `find` takes the most
 * recent — the right default, and the only one that is stable when a re-send adds a second copy.
 * It matters more than it looks: 105 of 632 candidates carry more than one CV and one carries 11.
 * The full set is not lost, it is behind Profile, which is why that button now exists on the row.
 *
 * THE THREE ANSWERS BESIDE THE NAME are all real states, not decoration. "No CV file on record" is
 * the honest reading of a candidate whose CV never reached storage — the module's standing rule is
 * that a missing source says so rather than showing a blank. `external_url` is empty for every row
 * in production, so a filed CV that reports no file is a genuine gap worth seeing, not a glitch.
 */
function FiledCvName({ candidate }: { candidate: Candidate }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<CandidateFileSummary | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none" | "error">("idle");

  const label = candidateDisplayName(candidate.fullName);

  // Fetched once and kept: re-opening the same CV must not re-ask, and the file list of a filed
  // candidate does not change while a folder sits open.
  const openCv = async () => {
    if (state === "loading") return;
    if (file) {
      setOpen(true);
      return;
    }
    setState("loading");
    try {
      const data = await getJson(`/api/recruitment/candidates/${candidate.id}/files`);
      const files = Array.isArray(data.files) ? (data.files as CandidateFileSummary[]) : [];
      const cv = files.find((entry) => entry.kind === "cv") ?? null;
      if (!cv) {
        setState("none");
        return;
      }
      setFile(cv);
      setState("idle");
      setOpen(true);
    } catch {
      setState("error");
    }
  };

  return (
    <>
      {/* One button spanning name, status and stamp rather than a link on the name alone: the target
          is then the whole left of the row, which is what a finger on a tablet and a tired reader at
          4am both need. `min-w-0` so a long name wraps inside the row instead of pushing it wider
          than the screen — the fits-the-screen rule, which forbids the sideways scrollbar that a
          `whitespace-nowrap` name on a 375px phone would otherwise produce. */}
      <button
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left disabled:opacity-60"
        disabled={state === "loading"}
        onClick={() => void openCv()}
        title={`Open ${label}'s CV`}
        type="button"
      >
        <span className="inline-flex min-w-0 items-start gap-1.5 text-sm font-bold text-slate-950 underline-offset-4 hover:text-orange-700 hover:underline">
          <FileText aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600" />
          <span className="min-w-0 break-words">{label}</span>
        </span>
        <span
          className={`whitespace-nowrap border border-slate-200 bg-white px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.06em] text-slate-500 ${adminChipDepthClassName}`}
        >
          {candidateStatusLabel(candidate.status)}
        </span>
        {candidate.folder ? (
          // BY A PERSON, NEVER BY AN ID. This read "by B-10" until 2026-09-11 — the owner's own HR
          // id, on the screen of the only person who reads it, where the standing rule is
          // human-readable names and never raw codes. `filedByName` is resolved server-side by
          // listCandidates; when it comes back empty the clause says so in words rather than
          // falling back to the id, because an id is exactly what the reader cannot act on.
          <span className="whitespace-nowrap text-phx-xs font-medium text-slate-400">
            filed {cairoDateTime(candidate.folder.filedAt)}
            {candidate.folder.filedByHrId
              ? ` by ${personLabel(candidate.folder.filedByName, UNNAMED_FILER_LABEL)}`
              : ""}
          </span>
        ) : null}
        {state === "loading" ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400">
            <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
            Opening…
          </span>
        ) : null}
        {state === "none" ? (
          <span className="border-l-2 border-dashed border-slate-300 pl-1.5 text-xs font-medium text-slate-500">
            No CV file on record
          </span>
        ) : null}
        {state === "error" ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600">
            <AlertCircle aria-hidden className="h-3 w-3" />
            Couldn&rsquo;t open the CV
          </span>
        ) : null}
      </button>
      {open && file ? (
        <CvPreviewModal
          downloadUrl={`/api/recruitment/files/${file.id}/download`}
          fileName={file.fileName}
          headerActions={
            <ScheduleInterviewButton
              candidate={{ id: candidate.id, jobTitle: candidate.appliedForJobTitle, name: label }}
            />
          }
          mimeType={file.mimeType}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * "These people told us where they belong" — the one-press filing of everyone whose own WhatsApp
 * answers name their folder.
 *
 * PROPOSE, NEVER AUTO-FILE. The owner's own standing rule for the comparable case is that the system
 * flags an expense and never rejects one; filing is the same shape of decision, and a CV filed
 * before any human saw it is a CV that arrived and was hidden in the same instant. So this panel
 * shows exactly who would move and where, and waits to be pressed.
 *
 * The skipped half is shown for the same reason the shelves render when empty: a screen that lists
 * only the confident cases reads as "everyone was handled", and the people who answered but could
 * not be placed are precisely the ones who would otherwise be forgotten.
 */
function DeclaredFilingsPanel({
  areaOptions,
  candidates,
  onOpenCandidate,
}: {
  areaOptions: CandidateFolderAreaOption[];
  candidates: Candidate[];
  /** Opens the candidate's profile, where File to folder lives — the unplaced rows are unplaced
   * because a person has to do exactly that, so the way there is on the row. */
  onOpenCandidate: (candidateId: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same rule as the file-time write: a medical rep's typed area must match one of these exactly, or
  // it is refused here too, so the preview and the actual "File the declared CVs" click never
  // disagree about what would happen. See resolveCanonicalMedicalRepArea in candidate-folder.ts.
  const canonicalAreas = areaOptions.map((option) => option.name);
  const { filings, skipped, rejectedCount } = collectSuggestedFilings(candidates, canonicalAreas);

  if (filings.length === 0 && skipped.length === 0 && rejectedCount === 0) return null;

  // Grouped by destination, because "8 CVs into Gharbia 1 (Tanta)" is a sentence the owner can check
  // at a glance, while eight separate rows naming the same folder is one he has to add up himself.
  const byFolder = new Map<string, { label: string; names: string[] }>();
  for (const filing of filings) {
    const id = folderId(filing.suggestion.kind, filing.suggestion.key.toLowerCase());
    const existing = byFolder.get(id);
    const name = candidateDisplayName(filing.fullName);
    if (existing) existing.names.push(name);
    else byFolder.set(id, { label: filing.suggestion.label, names: [name] });
  }
  const groups = Array.from(byFolder.values()).sort((a, b) => b.names.length - a.names.length);
  // The people who could not be placed, gathered under the one instruction each group needs. Forty-odd
  // rows repeating the same sentence read as noise; a handful of instructions read as a to-do list.
  const unplacedGroups = groupUnplacedFilings(skipped);

  // The owner's own split, made after reading the first fifteen: nine had arrived that morning and
  // five were already shortlisted. Filing everything in one press takes live prospects off the
  // screen recruiters work from, so the safer half gets its own button — and is the DEFAULT one.
  const untouched = filings.filter((filing) => filing.untouched);
  const inPlay = filings.filter((filing) => !filing.untouched);

  const file = async (chosen: SuggestedFiling[]) => {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/recruitment/candidates/file-declared", {
        candidateIds: chosen.map((filing) => filing.candidateId),
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to file these CVs.");
    } finally {
      setBusy(false);
    }
  };

  return (
    // THE LOOK (2026-10-19 premium sweep): the module's panel, its band carrying the two filing
    // buttons — the orange one is the safe default, the glass one files everybody. The band's TITLE
    // wraps: in spaced capitals on the band, the old `whitespace-nowrap` would have held this
    // heading at about the full width of a phone with nothing left beside it. The sentence under it
    // wraps for the 375px measurement the shelves record.
    <RecruitmentPanel
      actions={
        filings.length > 0 ? (
          <>
            {/* Nobody-has-looked-at-them first, and as the primary button. When every suggestion is
                untouched the two buttons would file the same people, so only one is offered. */}
            {untouched.length > 0 ? (
              <button
                className={`${phxButtonAccentClassName} ${adminControlDepthClassName} disabled:shadow-none`}
                disabled={busy}
                onClick={() => file(untouched)}
                type="button"
              >
                <FolderInput aria-hidden className="h-3.5 w-3.5" />
                {busy ? "Filing…" : `File the ${untouched.length} nobody has opened`}
              </button>
            ) : null}
            {inPlay.length > 0 ? (
              <button
                className={`${adminHeroActionSecondaryClassName} disabled:pointer-events-none disabled:opacity-50`}
                disabled={busy}
                onClick={() => file(filings)}
                type="button"
              >
                {busy ? "Filing…" : `File all ${filings.length}`}
              </button>
            ) : null}
          </>
        ) : null
      }
      description="Answered the WhatsApp questions themselves — nothing here was read off a CV."
      icon={<MessageSquareText aria-hidden className="h-4 w-4" />}
      title="They told us where they belong"
    >
      {inPlay.length > 0 ? (
        // Named, not counted. "5 are in play" is a number he has to go and check; the names are the
        // thing that lets him decide without leaving this screen.
        <p className="border-b border-amber-200 border-l-[3px] border-l-amber-500 bg-amber-50/70 px-4 py-2 text-phx-xs font-medium leading-5 text-amber-950">
          <span className="font-bold">Filing the new ones leaves these {inPlay.length} in the pool: </span>
          {inPlay
            .map((filing) => `${candidateDisplayName(filing.fullName)} (${candidateStatusLabel(filing.status)})`)
            .join(" · ")}
        </p>
      ) : null}

      {error ? <PanelError>{error}</PanelError> : null}

      {groups.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {groups.map((group) => (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" key={group.label}>
              <FolderInput aria-hidden className="h-3.5 w-3.5 shrink-0 text-orange-600" />
              <span className="whitespace-nowrap text-sm font-bold text-slate-950">{group.label}</span>
              <span
                className={`whitespace-nowrap border border-orange-200 bg-orange-50 px-1.5 text-phx-2xs font-black tabular-nums text-orange-800 ${adminChipDepthClassName}`}
              >
                {group.names.length} {group.names.length === 1 ? "CV" : "CVs"}
              </span>
              {/* Wraps: this is a joined list of names with no length bound at all, so it is the
                  one span here guaranteed to outgrow a phone. Same rule as the shelf header. */}
              <span className="min-w-0 basis-full text-xs font-medium leading-5 text-slate-500 sm:basis-auto">
                {group.names.join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {skipped.length > 0 || rejectedCount > 0 ? (
        <div className="border-t border-slate-200 bg-slate-50/60 px-4 py-3">
          {/* A rejection is a settled decision, not an open question — see collectSuggestedFilings.
              Counted here rather than listed one row per person, which is what buried the 25 rows a
              recruiter could actually act on under 40 rows nobody can. */}
          {/* WRAPS. Measured on production at 375px on 2026-09-12: held at `whitespace-nowrap` this
              one sentence laid out 415px wide inside a 351px box and dragged the whole tab into a
              65px sideways scroll (main scrollWidth 440 vs clientWidth 375) — the fits-the-screen
              golden rule broken by a single class. Wrapping is the permitted answer and the only
              one: the ellipsis ban means `truncate` was never available here. Same reasoning as the
              shelf header above, which was measured the same way on 2026-09-02. */}
          {rejectedCount > 0 ? (
            <p className="text-xs font-medium text-slate-500">
              {rejectedCount} more already rejected — a rejection is a settled decision, not shown here.
            </p>
          ) : null}
          {skipped.length > 0 ? (
            <>
              {/* Wraps too. It fits at 375px today, but it is a SENTENCE with a count in front of
                  it, and the sibling above is the proof that a no-wrap sentence on this screen is
                  one wording change away from the sideways scroll. Labels and counts below keep
                  their `whitespace-nowrap`; prose does not get it. */}
              <p className="mt-1 text-xs font-bold text-slate-600 first:mt-0">
                {skipped.length} answered but cannot be filed automatically — a person has to place each one
              </p>
              {/* One block per instruction, not one sentence per person. Heading and instruction are
                  prose and WRAP; only a name keeps its `whitespace-nowrap`. The typed answer and the
                  "could be" hint wrap too — they are free text of unbounded length. */}
              <div className="mt-2 space-y-3">
                {unplacedGroups.map((group) => (
                  <div key={group.cause}>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs font-black text-slate-900">
                      <span aria-hidden="true" className="h-3 w-0.5 bg-orange-500" />
                      {group.heading}
                      <span className="font-black tabular-nums text-orange-700">
                        {group.rows.length}
                      </span>
                    </p>
                    <p className="mt-0.5 text-phx-xs font-medium leading-5 text-slate-500">{group.instruction}</p>
                    <ul className="mt-1.5 divide-y divide-slate-200/70">
                      {group.rows.map((row) => (
                        <li
                          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 text-phx-xs"
                          key={row.candidateId}
                        >
                          <span className="whitespace-nowrap font-semibold text-phx-ink">
                            {candidateDisplayName(row.fullName)}
                          </span>
                          {row.typed ? (
                            <span className="font-medium text-slate-500">typed “{row.typed}”</span>
                          ) : group.cause === "degree" ? null : (
                            <span className="font-medium text-slate-500">{row.reason}</span>
                          )}
                          {row.couldBe.length > 0 ? (
                            <span className="font-medium text-slate-500">
                              — could be {row.couldBe.join(" or ")}
                            </span>
                          ) : null}
                          {group.cause === "degree" ? null : (
                            <button
                              className={`ml-auto ${rowActionClassName}`}
                              onClick={() => onOpenCandidate(row.candidateId)}
                              type="button"
                            >
                              <IdCard aria-hidden className="h-3.5 w-3.5" />
                              Open profile
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </RecruitmentPanel>
  );
}

function FolderChip({
  folder,
  isOpen,
  onToggle,
}: {
  folder: CandidateFolder;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      aria-expanded={isOpen}
      className={cn(
        // Never a truncate — the owner's standing rule is that text is never cut — but the label WRAPS,
        // because the no-horizontal-scroll rule outranks the no-wrap habit and this chip has outgrown
        // the 26-character area name the old comment was written for. "Other positions" mints one
        // folder per declared JOB TITLE, and production already holds "Technical Support and
        // infrastructure Engineer": measured at 375px on 2026-09-12 that chip is 311px inside a 349px
        // row — five characters from painting off the side of the phone. max-w-full so it can never
        // exceed its row; the count below keeps its own nowrap so the number never splits off.
        // Square, lifted like every chip in the module; the open one turns orange and keeps an
        // underline in the accent so the reader can see which folder the rows below belong to.
        `relative inline-flex max-w-full items-center gap-2 border px-3 py-1.5 text-left text-xs font-bold transition ${adminChipDepthClassName}`,
        isOpen
          ? "border-orange-400 bg-orange-50 text-orange-800"
          : "border-slate-200 bg-white text-slate-700 hover:border-orange-300 hover:bg-orange-50/50",
      )}
      onClick={onToggle}
      title={folder.lastFiledAt ? `Last filed ${cairoDateTime(folder.lastFiledAt)}` : undefined}
      type="button"
    >
      <FolderOpen aria-hidden className={cn("h-3.5 w-3.5 shrink-0", isOpen ? "text-orange-600" : "text-slate-400")} />
      <span className="min-w-0 break-words">{folder.label}</span>
      <span
        className={cn(
          "whitespace-nowrap border px-1.5 text-phx-2xs font-black tabular-nums",
          isOpen ? "border-orange-200 bg-white text-orange-700" : "border-slate-200 bg-slate-50 text-slate-500",
        )}
      >
        {folder.candidates.length}
      </span>
      {isOpen ? <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 bg-orange-500" /> : null}
    </button>
  );
}
