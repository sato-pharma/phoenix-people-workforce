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
import { FolderOpen, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { deleteRequest } from "@/components/recruitment/recruitment-fetch";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import {
  partitionCandidatesByFolder,
  type CandidateFolder,
  type CandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
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
   * Open one filed CV. Handed in rather than implemented here on purpose: the profile panel, its
   * fetch, its scroll-restore and its CV viewer all live in the pool tab, and a second copy of that
   * on this screen would be a second thing to keep in step. This routes into the SAME opener the
   * inbound-CV notification uses.
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

      {shelves.map((shelf) => (
        <section className="rounded-lg border border-phx-line bg-white" key={shelf.kind}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-phx-line px-3 py-2">
            <span className="whitespace-nowrap text-sm font-black text-phx-ink">{shelf.label}</span>
            <span className="whitespace-nowrap text-xs font-medium text-slate-400">{shelf.description}</span>
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
                      {/* The row IS the CV — pressing it opens the profile, exactly as pressing a row
                          in the pool does. A folder you can only look at is an archive; a folder you
                          can read out of is the filing cabinet the owner actually asked for.

                          One button spanning name, status and stamp rather than a link on the name
                          alone: the target is then the whole left of the row, which is what a finger
                          on a tablet and a tired reader at 4am both need. */}
                      <button
                        className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left"
                        onClick={() => onOpenCandidate(candidate.id)}
                        title={`Open ${candidateDisplayName(candidate.fullName)}'s CV`}
                        type="button"
                      >
                        <span className="whitespace-nowrap text-sm font-bold text-phx-ink underline-offset-4 hover:underline">
                          {candidateDisplayName(candidate.fullName)}
                        </span>
                        <span className="whitespace-nowrap text-xs font-medium text-slate-500">
                          {candidateStatusLabel(candidate.status)}
                        </span>
                        {candidate.folder ? (
                          <span className="whitespace-nowrap text-phx-xs font-medium text-slate-400">
                            filed {cairoDateTime(candidate.folder.filedAt)}
                            {candidate.folder.filedByHrId ? ` by ${candidate.folder.filedByHrId}` : ""}
                          </span>
                        ) : null}
                      </button>
                      <Button
                        className="ml-auto"
                        disabled={busyId === candidate.id}
                        onClick={() => returnToPool(candidate)}
                        variant="secondary"
                      >
                        <Undo2 aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                        Return to pool
                      </Button>
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
