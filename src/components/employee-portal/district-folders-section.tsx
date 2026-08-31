"use client";

import { useState } from "react";

import { CandidateReadCard } from "@/components/employee-portal/candidate-read-card";
import { Card } from "@/components/ui/card";
import type { DistrictManagerBoard } from "@/lib/recruitment/district-manager-folders";
import type { Candidate, TeamCandidateFile } from "@/lib/recruitment/types";

/**
 * A district manager's own folders — one per area he holds in the organogram.
 *
 * The owner, 2026-08-31: *"you will make a folder per district manager. Each folder has his areas.
 * His areas listed. All his areas in the organogram. And populate the folders based on the CVs we
 * receive. So if you need a CV from any area, he click the folder and open he find all CVs."*
 *
 * EVERY AREA IS LISTED, INCLUDING THE EMPTY ONES. An empty folder is information: a manager looking
 * at eight areas of which three read "No CVs" knows those three have had no applicants. A screen
 * that lists only the areas with CVs reads as "these are my areas", which is false, and the day a
 * CV arrives for a ninth the list silently grows.
 *
 * THE FOLDERS ARE DERIVED, NOT STORED. They come from `au_v_org_tree` at read time, so a
 * restructure moves them the same day. See district-manager-folders.ts for the rule and why nothing
 * here is written.
 *
 * A CV can appear here AND under "Sent to you". That is not a duplicate to be suppressed: the two
 * lists answer different questions — one is what a recruiter asked him about, the other is
 * everything that has arrived for his territory — and hiding the overlap would make a folder that
 * silently omits the best CV in the area.
 *
 * The chips-then-list shape is the one already on this page for "Your team's candidates". Matching
 * it is deliberate; a manager should not have to learn a second way to open a list on one screen.
 */
export function DistrictFoldersSection({
  boards,
  files,
  heading = "Your areas",
  subheading = "Every area you hold in the organogram, and the CVs of applicants who asked to work in it. Open a folder to read them.",
  viewerHrId,
}: {
  boards: DistrictManagerBoard<Candidate>[];
  files: Record<string, TeamCandidateFile[]>;
  heading?: string;
  subheading?: string;
  viewerHrId: string | null;
}) {
  const [open, setOpen] = useState<{ areaName: string; seatId: string } | null>(null);

  // Renders NOTHING for anybody who holds no district seat, which is most people who reach this
  // page. An empty heading over an empty list would read as a fault in the screen.
  if (boards.length === 0) return null;

  const toggle = (seatId: string, areaName: string) => {
    setOpen((current) =>
      current && current.seatId === seatId && current.areaName === areaName ? null : { areaName, seatId },
    );
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{heading}</h2>
        <p className="text-xs text-slate-500">{subheading}</p>
      </div>

      {boards.map((board) => {
        const openFolder =
          open && open.seatId === board.seatId
            ? (board.folders.find((folder) => folder.areaName === open.areaName) ?? null)
            : null;

        return (
          <div className="space-y-3" key={board.seatId}>
            {/* The district's own line, so a manager holding two of them can tell them apart. Both
                halves are named — a region without its line is ambiguous across three lines. */}
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-1">
              <h3 className="whitespace-nowrap text-sm font-bold text-slate-800">
                {[board.lineName, board.regionName].filter(Boolean).join(" · ") || board.seatLabel}
              </h3>
              <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-slate-500">
                {board.folders.length === 1 ? "1 area" : `${board.folders.length} areas`} ·{" "}
                {board.candidateCount === 1 ? "1 CV" : `${board.candidateCount} CVs`}
              </span>
            </div>

            {/* Why a district that is not his own is in front of him. Without this line an NSM
                covering a vacant seat reads someone else's areas as his own. */}
            {board.coveringVacantSeat ? (
              <p className="whitespace-nowrap text-phx-xs text-amber-700">
                You are covering this district while {board.coveringVacantSeat} is vacant.
              </p>
            ) : null}

            {/* Horizontal scroll rather than wrapping — the owner's rule is that text is never cut
                with an ellipsis and never wraps, and an area name plus its count does not fit a chip
                on a phone. The row scrolls; every name stays whole. */}
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {board.folders.map((folder) => {
                const isOpen = openFolder?.areaName === folder.areaName;
                // The catch-all is drawn dashed, and that is not decoration. Its CVs reached this
                // district through the governorate printed on the CV, not through an applicant
                // saying where they want to work, and a manager reading the two side by side has to
                // be able to tell which is which before he picks up the phone.
                const isCatchAll = folder.kind === "region";
                return (
                  <button
                    className={`shrink-0 whitespace-nowrap rounded-lg border px-3 py-2 text-left transition ${
                      isCatchAll ? "border-dashed" : ""
                    } ${
                      isOpen
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-gray-200 bg-white text-slate-700 hover:border-slate-400"
                    }`}
                    key={folder.areaName}
                    onClick={() => toggle(board.seatId, folder.areaName)}
                    type="button"
                  >
                    <span className="block whitespace-nowrap text-sm font-semibold" dir="auto">
                      {folder.areaName}
                    </span>
                    <span
                      className={`block whitespace-nowrap text-phx-xs ${isOpen ? "text-slate-300" : "text-slate-500"}`}
                    >
                      {folder.candidates.length === 0
                        ? "No CVs"
                        : `${folder.candidates.length} ${folder.candidates.length === 1 ? "CV" : "CVs"}`}
                    </span>
                  </button>
                );
              })}
            </div>

            {openFolder ? (
              <div className="space-y-3">
                {/* Said once, above the cards, rather than on each of them. These applicants never
                    named an area — their CV was matched to this region by the governorate written
                    on it — and a manager needs to know that before he reads the first name. */}
                {openFolder.kind === "region" && openFolder.candidates.length > 0 ? (
                  <p className="text-phx-xs text-slate-500">
                    These applicants did not say which area they want. Their CV places them in{" "}
                    {board.regionName ?? "this region"}.
                  </p>
                ) : null}
                {openFolder.candidates.length === 0 ? (
                  <Card className="rounded-lg border border-gray-200 bg-white p-6 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
                    <p className="text-sm font-semibold text-slate-700">
                      {openFolder.kind === "region"
                        ? "No CVs without an area have arrived yet"
                        : `Nobody has applied for ${openFolder.areaName} yet`}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      This is the real answer, not a filter — the folder is here so you can see it is empty.
                    </p>
                  </Card>
                ) : (
                  openFolder.candidates.map((candidate) => (
                    <CandidateReadCard
                      candidate={candidate}
                      files={files[candidate.id] ?? []}
                      key={candidate.id}
                      viewerHrId={viewerHrId}
                    />
                  ))
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
