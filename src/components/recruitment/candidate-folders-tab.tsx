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
import { FolderInput, FolderOpen, IdCard, Undo2 } from "lucide-react";

import { BackgroundReviewPanel } from "@/components/recruitment/background-review-panel";
import { Button } from "@/components/ui/button";
import { CvPreviewModal } from "@/components/recruitment/cv-preview-modal";
import { deleteRequest, getJson, postJson } from "@/components/recruitment/recruitment-fetch";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import {
  partitionCandidatesByFolder,
  type CandidateFolder,
  type CandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import {
  collectSuggestedFilings,
  type SuggestedFiling,
} from "@/lib/recruitment/candidate-folder-suggestion";
import type { Candidate } from "@/lib/recruitment/types";
import { cn } from "@/lib/utils";

/**
 * Cairo, always — the owner's standing rule, and the same helper shape the workspace uses. A filing
 * stamp read in UTC is an hour or two wrong for every person who will ever look at it.
 */
function cairoDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  });
}

export function CandidateFoldersTab({
  candidates,
  onOpenCandidate,
}: {
  candidates: Candidate[];
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
  const { shelves, filedCount, pool } = partitionCandidatesByFolder(candidates);
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
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-base font-black text-phx-ink">Folders</h2>
        <p className="text-xs font-medium text-slate-500">
          Good CVs kept for later. Filed CVs are off the main pool and nowhere else — they still show
          in search and still count against duplicates.
        </p>
        <span className="ml-auto whitespace-nowrap text-xs font-bold tabular-nums text-phx-accent-press">
          {filedCount} filed · {pool.length} in the pool
        </span>
      </div>

      {error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
          {error}
        </p>
      ) : null}

      <DeclaredFilingsPanel candidates={candidates} />

      {/* Above the shelves and below the one-press panel, in the order the two decisions happen: the
          people who told us where they belong are filed first, and what is left is the queue of
          degrees somebody has to read. Both sit on the Folders tab because both END in a folder. */}
      <BackgroundReviewPanel candidates={candidates} onOpenCandidate={onOpenCandidate} />

      {shelves.map((shelf) => (
        <section className="rounded-lg border border-phx-line bg-white" key={shelf.kind}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-phx-line px-3 py-2">
            <span className="whitespace-nowrap text-sm font-black text-phx-ink">{shelf.label}</span>
            {/* The DESCRIPTION wraps, unlike the label and the count beside it. Measured at 375px on
                2026-09-02: held at `whitespace-nowrap` this sentence laid out 441px wide inside a
                325px box and the tail was simply painted off the side of the phone, unreadable and
                unreachable — the page does not scroll sideways, so nothing gets you to it. The
                fits-the-screen golden rule supersedes the no-wrap habit exactly here: wrapping is
                the permitted answer, and the ellipsis ban is untouched because nothing is cut. */}
            <span className="text-xs font-medium text-slate-400">{shelf.description}</span>
            <span className="ml-auto whitespace-nowrap text-xs font-bold tabular-nums text-phx-accent-press">
              {shelf.candidateCount} {shelf.candidateCount === 1 ? "CV" : "CVs"}
            </span>
          </div>

          {shelf.folders.length === 0 ? (
            // An empty shelf says so in words rather than vanishing. A section that disappears when
            // it empties is one that reads as a bug the first day somebody uses it.
            <p className="px-3 py-3 text-xs font-medium text-slate-500">
              Nothing filed here yet. Use “File to folder” on a CV in the pool.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2 p-3">
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
              <div className="border-t border-phx-line" key={`open-${folder.key}`}>
                <ul className="divide-y divide-phx-line">
                  {folder.candidates.map((candidate) => (
                    <li
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 transition hover:bg-slate-50"
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
                        <Button
                          onClick={() => onOpenCandidate(candidate.id)}
                          title={`Open ${candidateDisplayName(candidate.fullName)}'s full profile`}
                          variant="secondary"
                        >
                          <IdCard aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                          Profile
                        </Button>
                        <Button
                          disabled={busyId === candidate.id}
                          onClick={() => returnToPool(candidate)}
                          variant="secondary"
                        >
                          <Undo2 aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                          Return to pool
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </section>
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
        <span className="text-sm font-bold text-phx-ink underline-offset-4 hover:underline">{label}</span>
        <span className="whitespace-nowrap text-xs font-medium text-slate-500">
          {candidateStatusLabel(candidate.status)}
        </span>
        {candidate.folder ? (
          <span className="whitespace-nowrap text-phx-xs font-medium text-slate-400">
            filed {cairoDateTime(candidate.folder.filedAt)}
            {candidate.folder.filedByHrId ? ` by ${candidate.folder.filedByHrId}` : ""}
          </span>
        ) : null}
        {state === "loading" ? <span className="text-xs font-medium text-slate-400">Opening…</span> : null}
        {state === "none" ? <span className="text-xs font-medium text-slate-400">No CV file on record</span> : null}
        {state === "error" ? (
          <span className="text-xs font-medium text-rose-500">Couldn&rsquo;t open the CV</span>
        ) : null}
      </button>
      {open && file ? (
        <CvPreviewModal
          downloadUrl={`/api/recruitment/files/${file.id}/download`}
          fileName={file.fileName}
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
function DeclaredFilingsPanel({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { filings, skipped } = collectSuggestedFilings(candidates);

  if (filings.length === 0 && skipped.length === 0) return null;

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
    <section className="rounded-lg border border-phx-accent bg-orange-50/60">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-phx-accent/40 px-3 py-2">
        <span className="whitespace-nowrap text-sm font-black text-phx-ink">They told us where they belong</span>
        {/* Wraps — see the shelf header above for the 375px measurement this comes from. */}
        <span className="text-xs font-medium text-slate-500">
          Answered the WhatsApp questions themselves — nothing here was read off a CV.
        </span>
        {filings.length > 0 ? (
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {/* Nobody-has-looked-at-them first, and as the primary button. When every suggestion is
                untouched the two buttons would file the same people, so only one is offered. */}
            {untouched.length > 0 ? (
              <Button disabled={busy} onClick={() => file(untouched)}>
                <FolderInput aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                {busy ? "Filing…" : `File the ${untouched.length} nobody has opened`}
              </Button>
            ) : null}
            {inPlay.length > 0 ? (
              <Button disabled={busy} onClick={() => file(filings)} variant="secondary">
                {busy ? "Filing…" : `File all ${filings.length}`}
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>

      {inPlay.length > 0 ? (
        // Named, not counted. "5 are in play" is a number he has to go and check; the names are the
        // thing that lets him decide without leaving this screen.
        <p className="border-b border-phx-accent/40 px-3 py-1.5 text-phx-xs font-medium text-slate-600">
          <span className="font-bold text-phx-ink">Filing the new ones leaves these {inPlay.length} in the pool: </span>
          {inPlay
            .map((filing) => `${candidateDisplayName(filing.fullName)} (${candidateStatusLabel(filing.status)})`)
            .join(" · ")}
        </p>
      ) : null}

      {error ? (
        <p className="px-3 pt-2 text-xs font-semibold text-rose-700">{error}</p>
      ) : null}

      {groups.length > 0 ? (
        <ul className="divide-y divide-phx-accent/20">
          {groups.map((group) => (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" key={group.label}>
              <span className="whitespace-nowrap text-sm font-bold text-phx-ink">{group.label}</span>
              <span className="whitespace-nowrap text-xs font-bold tabular-nums text-phx-accent-press">
                {group.names.length} {group.names.length === 1 ? "CV" : "CVs"}
              </span>
              {/* Wraps: this is a joined list of names with no length bound at all, so it is the
                  one span here guaranteed to outgrow a phone. Same rule as the shelf header. */}
              <span className="min-w-0 text-xs font-medium text-slate-500">{group.names.join(" · ")}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {skipped.length > 0 ? (
        <div className="border-t border-phx-accent/40 px-3 py-2">
          <p className="whitespace-nowrap text-xs font-bold text-slate-600">
            {skipped.length} answered but cannot be placed
          </p>
          <ul className="mt-1 space-y-0.5">
            {skipped.map((row) => (
              <li className="flex flex-wrap items-baseline gap-x-2 text-phx-xs" key={row.candidateId}>
                <span className="whitespace-nowrap font-semibold text-phx-ink">
                  {candidateDisplayName(row.fullName)}
                </span>
                <span className="font-medium text-slate-500">{row.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
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
        // whitespace-nowrap, never a truncate: the owner's standing rule is that text is never cut
        // and never wrapped, and "Dokki - Mohandseen - Bolak" is a real 26-character area name.
        "inline-flex items-center gap-2 whitespace-nowrap rounded-md border px-3 py-1.5 text-xs font-semibold transition",
        isOpen
          ? "border-phx-accent bg-orange-50 text-phx-accent-press"
          : "border-phx-line bg-white text-slate-700 hover:bg-slate-50",
      )}
      onClick={onToggle}
      title={folder.lastFiledAt ? `Last filed ${cairoDateTime(folder.lastFiledAt)}` : undefined}
      type="button"
    >
      <FolderOpen aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {folder.label}
      <span className="tabular-nums opacity-70">{folder.candidates.length}</span>
    </button>
  );
}
