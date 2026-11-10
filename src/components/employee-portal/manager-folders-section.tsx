"use client";

import { useState } from "react";
import { Archive, ChevronDown, ChevronRight } from "lucide-react";

import { ManagerCvList } from "@/components/employee-portal/manager-cv-list";
import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
import type { CandidateFolderShelf } from "@/lib/recruitment/candidate-folder";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * "Your folders" — the manager's own CV shelf, on his portal.
 *
 * The owner, 2026-08-30: *"and I want him to have a folders like like me."* Same three shelves, same
 * folder names, same sort order as the recruiter's screen, because he asked for HIS folders and two
 * screens that call the same folder by two names are worse than one screen.
 *
 * FOLDERS ARE CLOSED UNTIL OPENED, and shelves with nothing on them are still listed. The first is
 * because the point of a filing cabinet is that its contents are out of the way — a shelf that
 * renders every card it holds is the flat list this feature exists to replace. The second is because
 * an empty shelf is information ("nothing filed under District Manager yet"), while a shelf that
 * disappears when it empties makes the whole feature look broken the first time somebody opens it.
 * While the page's find tray narrows the lists, a folder holding a match opens by itself.
 *
 * The candidate card itself is passed in rather than built here: the manager's own CVs and his
 * team's are two different cards with two different sets of buttons, and this component's job is the
 * cabinet, not what is in the envelopes.
 */
export function ManagerFoldersSection({
  narrowKey = "",
  renderCandidate,
  shelves,
  totalFiled,
}: {
  /** What the page's find tray is narrowing by, or "" when it shows everything. */
  narrowKey?: string;
  renderCandidate: (candidate: Candidate) => React.ReactNode;
  shelves: CandidateFolderShelf[];
  totalFiled: number;
}) {
  // Nothing filed at all: say so once, rather than printing three empty shelves at somebody who has
  // never used the feature. The shelves appear as soon as the first CV is filed.
  if (totalFiled === 0) return null;
  const narrowed = narrowKey !== "";

  return (
    <RecruitmentPanel
      bodyClassName="space-y-4 p-3 sm:p-4"
      count={totalFiled}
      description="Good CVs you kept for later. They are out of the list above but not out of the system, and only you see this shelf — the recruitment team's own folders are separate."
      icon={<Archive aria-hidden="true" className="h-4 w-4" />}
      title="Your folders"
    >
      {shelves.map((shelf) => (
        <div className="space-y-2" key={shelf.kind}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-200 pb-1.5">
            <h3 className="min-w-0 break-words text-sm font-black text-slate-900">{shelf.label}</h3>
            <span className="text-xs font-semibold tabular-nums text-slate-500">
              {shelf.candidateCount === 0
                ? narrowed
                  ? "No match"
                  : "Nothing filed"
                : `${shelf.candidateCount} ${shelf.candidateCount === 1 ? "CV" : "CVs"}`}
            </span>
          </div>
          {shelf.folders.length === 0 ? (
            <p className="break-words text-phx-xs text-slate-500">
              {narrowed ? "Nothing on this shelf matches." : shelf.description}
            </p>
          ) : (
            shelf.folders.map((folder) => (
              <FolderRow
                candidates={folder.candidates}
                key={folder.key}
                label={folder.label}
                lastFiledAt={folder.lastFiledAt}
                narrowKey={narrowKey}
                renderCandidate={renderCandidate}
              />
            ))
          )}
        </div>
      ))}
    </RecruitmentPanel>
  );
}

function FolderRow({
  candidates,
  label,
  lastFiledAt,
  narrowKey,
  renderCandidate,
}: {
  candidates: Candidate[];
  label: string;
  lastFiledAt: string | null;
  narrowKey: string;
  renderCandidate: (candidate: Candidate) => React.ReactNode;
}) {
  // Opened or closed by hand under one narrowing; a new search opens every folder that holds a match.
  const [picked, setPicked] = useState<{ key: string; open: boolean }>({ key: narrowKey, open: false });
  const open = picked.key === narrowKey ? picked.open : narrowKey !== "" && candidates.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="space-y-3">
      <button
        aria-expanded={open}
        className={`flex w-full items-start gap-3 border border-slate-200 bg-white px-4 py-3 text-left transition-colors hover:border-orange-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1 ${adminControlDepthClassName}`}
        onClick={() => setPicked({ key: narrowKey, open: !open })}
        type="button"
      >
        <Chevron aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none text-orange-500" />
        <span className="min-w-0">
          {/* dir="auto" because a free-typed job-title folder can be Arabic, and this is a single
              language per value — the case where block-level auto is correct and is house style. */}
          <span className="block break-words text-sm font-bold text-slate-900" dir="auto">
            {label}
          </span>
          <span className="block break-words text-phx-xs tabular-nums text-slate-500">
            {candidates.length === 1 ? "1 CV" : `${candidates.length} CVs`}
            {lastFiledAt ? ` · last filed ${cairoDateTime(lastFiledAt)}` : ""}
          </span>
        </span>
      </button>
      {open ? (
        <div className="space-y-3">
          {candidates.length === 0 ? (
            <p className={`border border-slate-200 bg-slate-50/70 px-4 py-4 text-center text-xs text-slate-500 ${adminRecessedDepthClassName}`}>
              This folder is empty.
            </p>
          ) : (
            <ManagerCvList ids={candidates.map((candidate) => candidate.id)}>
              {candidates.map((candidate) => renderCandidate(candidate))}
            </ManagerCvList>
          )}
        </div>
      ) : null}
    </div>
  );
}
