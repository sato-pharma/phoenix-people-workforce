"use client";

import { useState, type ReactNode } from "react";

import { CandidateReadCard } from "@/components/employee-portal/candidate-read-card";
import { CandidateReturnControl } from "@/components/employee-portal/candidate-return-control";
import { Card } from "@/components/ui/card";
import { alarmGlowRef } from "@/components/layout/alarm-glow";
import type { CandidateCallClaims } from "@/lib/recruitment/candidate-call-claims";
import type { DistrictManagerBoard } from "@/lib/recruitment/district-manager-folders";
import type { Candidate, TeamCandidateFile } from "@/lib/recruitment/types";

/**
 * A manager's folders — one per area on his part of the organogram, and one "Other CVs".
 *
 * The owner, 2026-10-16: *"no more managers receive CVs automatic. Every manager has an empty folder
 * for every area in his region, based on the organogram. The TA or admin pushes a CV whenever needed
 * and can any time get it back. When the CV reaches the manager there is no restriction."*
 *
 * EVERY AREA IS LISTED, INCLUDING THE EMPTY ONES. An empty folder is information: it says nothing
 * has been sent for that area. A screen that lists only the folders holding CVs reads as "these are
 * my areas", which is false.
 *
 * THE FOLDERS HOLD ONLY WHAT WAS SENT. Nothing arrives by itself; a CV is here because Talent
 * Acquisition sent it to this manager, and it leaves only when they take it back or when he returns it.
 * See manager-cv-folders.ts.
 *
 * A folder with a CV he has not yet opened pulses, and the first such folder is open when he arrives,
 * so what was just sent is the first thing on the screen.
 */
export function DistrictFoldersSection({
  boards,
  callClaims,
  files,
  heading = "Your areas",
  subheading = `Every area on your part of the organogram. A folder holds the CVs the recruitment team has sent you for that area, and nothing else. Open a folder to read them. A CV stays in your folder until you return it or the recruitment team takes it back.`,
  viewerHrId,
  ownFolders = false,
  renderOwnCard,
  unseenIds,
}: {
  boards: DistrictManagerBoard<Candidate>[];
  /** Who has said "I will call" each CV, keyed by candidate id. Read-only screens still show it. */
  callClaims: CandidateCallClaims;
  files: Record<string, TeamCandidateFile[]>;
  heading?: string;
  subheading?: string;
  viewerHrId: string | null;
  /**
   * TRUE only when the viewer is looking at HIS OWN folders. It turns on the banner and the per-CV
   * "Return to administrator" control, and removes every restriction on the card: the number and the
   * file are his. A National Sales Manager reading a district manager's folders leaves it false.
   */
  ownFolders?: boolean;
  /**
   * How an own-folder card is drawn. The portal passes the same card "Sent to you" uses, so a CV in a
   * folder carries the same answer buttons and filing control as one in that list.
   */
  renderOwnCard?: (candidate: Candidate) => ReactNode;
  /** The CVs in these folders the viewer has not yet opened — what makes a folder pulse. */
  unseenIds?: ReadonlySet<string>;
}) {
  const unseenIn = (candidates: Candidate[]): number =>
    unseenIds ? candidates.filter((candidate) => unseenIds.has(candidate.id)).length : 0;

  const [open, setOpen] = useState<{ areaName: string; seatId: string } | null>(() => {
    for (const board of boards) {
      for (const folder of board.folders) {
        if (unseenIn(folder.candidates) > 0) return { areaName: folder.areaName, seatId: board.seatId };
      }
    }
    return null;
  });
  // Which CVs the viewer has returned in THIS session, so the card can collapse in place the moment
  // he presses Return — the folders are read on the server and only refresh on reload.
  const [returnedIds, setReturnedIds] = useState<Set<string>>(() => new Set());

  // Renders NOTHING for anybody who holds no seat, which is most people who reach this page.
  if (boards.length === 0) return null;

  const toggle = (seatId: string, areaName: string) => {
    setOpen((current) =>
      current && current.seatId === seatId && current.areaName === areaName ? null : { areaName, seatId },
    );
  };

  const handleReturned = (candidateId: string) => {
    setReturnedIds((current) => {
      const next = new Set(current);
      next.add(candidateId);
      return next;
    });
  };

  return (
    <section className="space-y-4">
      {ownFolders ? (
        <FoldersBanner />
      ) : (
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{heading}</h2>
          <p className="text-xs text-slate-500">{subheading}</p>
        </div>
      )}

      {boards.map((board) => {
        const openFolder =
          open && open.seatId === board.seatId
            ? (board.folders.find((folder) => folder.areaName === open.areaName) ?? null)
            : null;

        return (
          <div className="space-y-3" key={board.seatId}>
            {/* The board's own line, so a manager holding two of them can tell them apart. Both
                halves are named — a region without its line is ambiguous across three lines. */}
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-1">
              <h3 className="whitespace-nowrap text-sm font-bold text-slate-800">
                {[board.lineName, board.regionName].filter(Boolean).join(" · ") || board.seatLabel}
              </h3>
              <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-slate-500">
                {board.folders.filter((folder) => folder.kind === "area").length === 1
                  ? "1 area"
                  : `${board.folders.filter((folder) => folder.kind === "area").length} areas`}{" "}
                · {board.candidateCount === 1 ? "1 CV" : `${board.candidateCount} CVs`}
              </span>
            </div>

            {/* Why a district that is not his own is in front of him. */}
            {board.coveringVacantSeat ? (
              <p className="whitespace-nowrap text-phx-xs text-amber-700">
                You are covering this district while {board.coveringVacantSeat} is vacant.
              </p>
            ) : null}

            {/* IT WRAPS; it does not scroll. The chips flow onto a second line and every area name
                still stays whole. `shrink-0` stays on each chip: a `shrink-0` CHILD of a wrapping
                row wraps rather than being squeezed. */}
            <div className="flex flex-wrap gap-2 pb-1">
              {board.folders.map((folder) => {
                const isOpen = openFolder?.areaName === folder.areaName;
                const isCatchAll = folder.kind === "region";
                const unseen = unseenIn(folder.candidates);
                return (
                  <button
                    className={`relative max-w-full rounded-lg border px-3 py-2 text-left transition ${
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
                    <span className="block text-sm font-semibold" dir="auto">
                      {folder.areaName}
                    </span>
                    <span
                      className={`block text-phx-xs ${isOpen ? "text-slate-300" : "text-slate-500"}`}
                    >
                      {folder.candidates.length === 0
                        ? "No CVs"
                        : `${folder.candidates.length} ${folder.candidates.length === 1 ? "CV" : "CVs"}`}
                    </span>
                    {unseen > 0 ? (
                      <span
                        className="nav-badge-alarm absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded bg-[#F05A1A] px-1 text-phx-xs font-bold text-white"
                        ref={alarmGlowRef}
                        title={`${unseen} not opened yet`}
                      >
                        {unseen}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {openFolder ? (
              <div className="space-y-3">
                {openFolder.candidates.length === 0 ? (
                  <Card className="rounded-lg border border-gray-200 bg-white p-6 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
                    <p className="text-sm font-semibold text-slate-700">
                      {openFolder.kind === "region"
                        ? "Nothing has been sent to you without a matching area"
                        : `Nothing has been sent to you for ${openFolder.areaName}`}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      This is the real answer, not a filter — the folder is here so you can see it is empty.
                    </p>
                  </Card>
                ) : (
                  openFolder.candidates.map((candidate) =>
                    returnedIds.has(candidate.id) ? (
                      <ReturnedStrip key={candidate.id} name={candidate.fullName} />
                    ) : ownFolders && renderOwnCard ? (
                      <div className="space-y-2" key={candidate.id}>
                        {renderOwnCard(candidate)}
                        <CandidateReturnControl
                          candidateId={candidate.id}
                          context={{
                            areaName: openFolder.areaName,
                            lineName: board.lineName,
                            regionName: board.regionName,
                            seatId: board.seatId,
                            seatLabel: board.seatLabel,
                          }}
                          onReturned={handleReturned}
                        />
                      </div>
                    ) : (
                      <CandidateReadCard
                        candidate={candidate}
                        claim={callClaims[candidate.id] ?? null}
                        files={files[candidate.id] ?? []}
                        footer={
                          ownFolders ? (
                            <CandidateReturnControl
                              candidateId={candidate.id}
                              context={{
                                areaName: openFolder.areaName,
                                lineName: board.lineName,
                                regionName: board.regionName,
                                seatId: board.seatId,
                                seatLabel: board.seatLabel,
                              }}
                              onReturned={handleReturned}
                            />
                          ) : undefined
                        }
                        key={candidate.id}
                        unrestricted={ownFolders}
                        viewerHrId={viewerHrId}
                      />
                    ),
                  )
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The banner over a manager's OWN folders, in the portal's section-header identity — the orange accent
 * bar, the orange kicker, and the title on the white-to-slate gradient card. It says what the folders
 * are now: empty shelves that Talent Acquisition fills by sending, with nothing restricted once a CV
 * is in one.
 */
function FoldersBanner() {
  return (
    <Card className="rounded border border-slate-200/90 bg-gradient-to-br from-white to-slate-50/50 p-5 shadow-[0_12px_34px_rgba(15,23,42,0.05)] sm:p-6">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-8 w-[3px] shrink-0 rounded-full bg-gradient-to-b from-orange-400 to-orange-600" />
        <div className="space-y-2">
          <div>
            <p className="text-phx-2xs font-bold uppercase tracking-[0.18em] text-orange-500">
              Your candidate folders
            </p>
            <h2 className="mt-0.5 text-[22px] font-semibold leading-tight tracking-tight text-slate-900">
              A folder for every area you hold — filled by the recruitment team
            </h2>
          </div>
          <p className="max-w-3xl text-sm leading-relaxed text-slate-600">
            Nothing reaches a folder by itself. When the recruitment team sends you a CV, it lands in the folder
            for its area, and from then on it is yours to use: read it, download it, see the phone number, answer,
            comment. A folder with a CV you have not opened keeps alerting you until you open it.
          </p>
          <p className="max-w-3xl text-sm leading-relaxed text-slate-600">
            If a CV is not for you, open the card and use{" "}
            <span className="font-semibold text-amber-700">Return to administrator</span> with a reason. The
            recruitment team can also take any CV back at any time. Nothing leaves your folders on its own.
          </p>
        </div>
      </div>
    </Card>
  );
}

/**
 * What a card becomes the instant its CV is returned — a slim, unmistakable confirmation in the
 * card's own place. It replaces the full card rather than removing the row outright: a CV that
 * simply vanished would read as a delete, when what happened is it went back to the administrator.
 */
function ReturnedStrip({ name }: { name: string | null }) {
  return (
    <Card className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
      <span className="text-sm font-semibold text-emerald-900" dir="auto">
        {name?.trim() ? name : "This CV"}
      </span>
      <span className="text-phx-xs font-medium text-emerald-700">returned to the administrator.</span>
    </Card>
  );
}
