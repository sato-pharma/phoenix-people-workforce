"use client";

import { useState } from "react";

import { Card } from "@/components/ui/card";
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
 *
 * The candidate card itself is passed in rather than built here: the manager's own CVs and his
 * team's are two different cards with two different sets of buttons, and this component's job is the
 * cabinet, not what is in the envelopes.
 */
export function ManagerFoldersSection({
  renderCandidate,
  shelves,
  totalFiled,
}: {
  renderCandidate: (candidate: Candidate) => React.ReactNode;
  shelves: CandidateFolderShelf[];
  totalFiled: number;
}) {
  // Nothing filed at all: say so once, rather than printing three empty shelves at somebody who has
  // never used the feature. The shelves appear as soon as the first CV is filed.
  if (totalFiled === 0) return null;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Your folders</h2>
        <p className="text-xs text-slate-500">
          Good CVs you kept for later. They are out of the list above but not out of the system, and only you see this
          shelf — the recruitment team&apos;s own folders are separate.
        </p>
      </div>
      {shelves.map((shelf) => (
        <div className="space-y-2" key={shelf.kind}>
          <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-1">
            <h3 className="whitespace-nowrap text-sm font-bold text-slate-800">{shelf.label}</h3>
            <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-slate-500">
              {shelf.candidateCount === 0
                ? "Nothing filed"
                : `${shelf.candidateCount} ${shelf.candidateCount === 1 ? "CV" : "CVs"}`}
            </span>
          </div>
          {shelf.folders.length === 0 ? (
            <p className="text-phx-xs text-slate-400">{shelf.description}</p>
          ) : (
            shelf.folders.map((folder) => (
              <FolderRow
                candidates={folder.candidates}
                key={folder.key}
                label={folder.label}
                lastFiledAt={folder.lastFiledAt}
                renderCandidate={renderCandidate}
              />
            ))
          )}
        </div>
      ))}
    </section>
  );
}

function FolderRow({
  candidates,
  label,
  lastFiledAt,
  renderCandidate,
}: {
  candidates: Candidate[];
  label: string;
  lastFiledAt: string | null;
  renderCandidate: (candidate: Candidate) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3">
      <button
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-slate-400"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="min-w-0">
          {/* dir="auto" because a free-typed job-title folder can be Arabic, and this is a single
              language per value — the case where block-level auto is correct and is house style. */}
          <span className="block whitespace-nowrap text-sm font-semibold text-slate-900" dir="auto">
            {open ? "▾" : "▸"} {label}
          </span>
          <span className="block whitespace-nowrap text-phx-xs text-slate-500">
            {candidates.length === 1 ? "1 CV" : `${candidates.length} CVs`}
            {lastFiledAt ? ` · last filed ${cairoDateTime(lastFiledAt)}` : ""}
          </span>
        </span>
      </button>
      {open ? (
        <div className="space-y-3">
          {candidates.length === 0 ? (
            <Card className="rounded-lg border border-gray-200 bg-white p-4 text-center text-xs text-slate-400">
              This folder is empty.
            </Card>
          ) : (
            candidates.map((candidate) => renderCandidate(candidate))
          )}
        </div>
      ) : null}
    </div>
  );
}
