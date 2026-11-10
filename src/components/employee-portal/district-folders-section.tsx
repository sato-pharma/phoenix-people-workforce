"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, FolderOpen } from "lucide-react";

import { CandidateReadCard } from "@/components/employee-portal/candidate-read-card";
import { CandidateReturnControl } from "@/components/employee-portal/candidate-return-control";
import { ManagerCvList } from "@/components/employee-portal/manager-cv-list";
import { alarmGlowRef } from "@/components/layout/alarm-glow";
import { adminControlDepthClassName, adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
import type { CandidateCallClaims } from "@/lib/recruitment/candidate-call-claims";
import type { DistrictManagerBoard } from "@/lib/recruitment/district-manager-folders";
import type { Candidate, TeamCandidateFile } from "@/lib/recruitment/types";

type FolderPick = { areaName: string; seatId: string };

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
 *
 * His own folders wear the recruitment kit's panel (owner, 2026-11-10: "premium polish"), like every
 * other list on My Candidates; the gradient banner and the rounded chips it replaced were the one
 * part of the page off the module's look. While the page's find tray narrows the lists, a folder
 * says "no match" rather than "nothing sent", and the first folder holding a match opens by itself.
 */
export function DistrictFoldersSection({
  boards,
  callClaims,
  files,
  heading = "Your areas",
  narrowKey = "",
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
  /**
   * What the page's find tray is narrowing by, or "" when it shows everything. The boards arrive
   * already narrowed; this only changes what an empty folder says and which folder opens by itself.
   */
  narrowKey?: string;
  subheading?: string;
  viewerHrId: string | null;
  /**
   * TRUE only when the viewer is looking at HIS OWN folders. It turns on the panel and the per-CV
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
  const narrowed = narrowKey !== "";

  const firstFolderWhere = (test: (candidates: Candidate[]) => boolean): FolderPick | null => {
    for (const board of boards) {
      for (const folder of board.folders) {
        if (test(folder.candidates)) return { areaName: folder.areaName, seatId: board.seatId };
      }
    }
    return null;
  };

  // The folder he opened, remembered WITH the narrowing it was opened under. A new search answers
  // with its own first match instead of keeping a folder that may now hold nothing; clearing the
  // search brings back the folder that was open before it. Derived, never set from an effect.
  const [picked, setPicked] = useState<{ key: string; value: FolderPick | null }>(() => ({
    key: narrowKey,
    value: firstFolderWhere((candidates) => unseenIn(candidates) > 0),
  }));
  const open: FolderPick | null =
    picked.key === narrowKey ? picked.value : narrowed ? firstFolderWhere((candidates) => candidates.length > 0) : null;
  // Which CVs the viewer has returned in THIS session, so the card can collapse in place the moment
  // he presses Return — the folders are read on the server and only refresh on reload.
  const [returnedIds, setReturnedIds] = useState<Set<string>>(() => new Set());

  // Renders NOTHING for anybody who holds no seat, which is most people who reach this page.
  if (boards.length === 0) return null;

  const toggle = (seatId: string, areaName: string) => {
    const isOpen = open && open.seatId === seatId && open.areaName === areaName;
    setPicked({ key: narrowKey, value: isOpen ? null : { areaName, seatId } });
  };

  const handleReturned = (candidateId: string) => {
    setReturnedIds((current) => {
      const next = new Set(current);
      next.add(candidateId);
      return next;
    });
  };

  const totalCvs = boards.reduce((sum, board) => sum + board.candidateCount, 0);

  const body = boards.map((board) => {
    const openFolder =
      open && open.seatId === board.seatId ? (board.folders.find((folder) => folder.areaName === open.areaName) ?? null) : null;
    const areaCount = board.folders.filter((folder) => folder.kind === "area").length;
    const shownCandidates = openFolder ? openFolder.candidates.filter((candidate) => !returnedIds.has(candidate.id)) : [];

    return (
      <div className="space-y-3" key={board.seatId}>
        {/* The board's own line, so a manager holding two of them can tell them apart. Both halves
            are named — a region without its line is ambiguous across three lines. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-200 pb-1.5">
          <h3 className="min-w-0 break-words text-sm font-black text-slate-900">
            {[board.lineName, board.regionName].filter(Boolean).join(" · ") || board.seatLabel}
          </h3>
          <span className="text-xs font-semibold tabular-nums text-slate-500">
            {areaCount === 1 ? "1 area" : `${areaCount} areas`} ·{" "}
            {narrowed
              ? `${board.candidateCount} ${board.candidateCount === 1 ? "match" : "matches"}`
              : board.candidateCount === 1
                ? "1 CV"
                : `${board.candidateCount} CVs`}
          </span>
        </div>

        {/* Why a district that is not his own is in front of him. */}
        {board.coveringVacantSeat ? (
          <p className="break-words text-phx-xs font-semibold text-amber-700">
            You are covering this district while {board.coveringVacantSeat} is vacant.
          </p>
        ) : null}

        {/* IT WRAPS; it does not scroll. The chips flow onto a second line and every area name stays
            whole. Square, like every control on the page. */}
        <div className="flex flex-wrap gap-2 pb-1">
          {board.folders.map((folder) => {
            const isOpen = openFolder?.areaName === folder.areaName;
            const isCatchAll = folder.kind === "region";
            const unseen = unseenIn(folder.candidates);
            const count = folder.candidates.length;
            const dimmed = narrowed && count === 0 && !isOpen;
            return (
              <button
                aria-expanded={isOpen}
                className={`relative max-w-full border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1 ${adminControlDepthClassName} ${
                  isCatchAll ? "border-dashed" : ""
                } ${
                  isOpen
                    ? "border-slate-900 bg-slate-900 text-white"
                    : dimmed
                      ? "border-slate-200 bg-slate-50 text-slate-400 hover:border-slate-300"
                      : "border-slate-200 bg-white text-slate-700 hover:border-orange-300"
                }`}
                key={folder.areaName}
                onClick={() => toggle(board.seatId, folder.areaName)}
                type="button"
              >
                <span className="block break-words text-sm font-bold" dir="auto">
                  {folder.areaName}
                </span>
                <span className={`block text-phx-xs tabular-nums ${isOpen ? "text-slate-300" : "text-slate-500"}`}>
                  {count === 0
                    ? narrowed
                      ? "No match"
                      : "No CVs"
                    : narrowed
                      ? `${count} ${count === 1 ? "match" : "matches"}`
                      : `${count} ${count === 1 ? "CV" : "CVs"}`}
                </span>
                {unseen > 0 ? (
                  <span
                    className="nav-badge-alarm absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center bg-[#F05A1A] px-1 text-phx-xs font-bold text-white"
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
              <div className={`border border-slate-200 bg-slate-50/70 px-4 py-6 text-center ${adminRecessedDepthClassName}`}>
                <p className="break-words text-sm font-bold text-slate-700">
                  {narrowed
                    ? `No CV in ${openFolder.areaName} matches`
                    : openFolder.kind === "region"
                      ? "Nothing has been sent to you without a matching area"
                      : `Nothing has been sent to you for ${openFolder.areaName}`}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {narrowed
                    ? "Clear the search or pick All to see everything in this folder."
                    : "This is the real answer, not a filter — the folder is here so you can see it is empty."}
                </p>
              </div>
            ) : (
              <ManagerCvList ids={shownCandidates.map((candidate) => candidate.id)}>
                {openFolder.candidates.map((candidate) =>
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
                )}
              </ManagerCvList>
            )}
          </div>
        ) : null}
      </div>
    );
  });

  if (ownFolders) {
    return (
      <RecruitmentPanel
        bodyClassName="space-y-5 p-3 sm:p-4"
        count={narrowed ? `${totalCvs} ${totalCvs === 1 ? "match" : "matches"}` : totalCvs}
        description={
          <>
            A folder for every area you hold, filled by the recruitment team — nothing arrives by itself. A CV in a
            folder is yours to use: read it, download it, see the phone number, answer, comment. A folder with a CV
            you have not opened keeps alerting you until you open it. If a CV is not for you, open it and use{" "}
            <span className="font-bold text-amber-200">Return to administrator</span> with a reason; the recruitment
            team can also take any CV back. Nothing leaves your folders on its own.
          </>
        }
        icon={<FolderOpen aria-hidden="true" className="h-4 w-4" />}
        title={heading}
      >
        {body}
      </RecruitmentPanel>
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-black text-slate-900">{heading}</h2>
        <p className="break-words text-xs text-slate-500">{subheading}</p>
      </div>
      {body}
    </section>
  );
}

/**
 * What a card becomes the instant its CV is returned — a slim, unmistakable confirmation in the
 * card's own place. It replaces the full card rather than removing the row outright: a CV that
 * simply vanished would read as a delete, when what happened is it went back to the administrator.
 */
function ReturnedStrip({ name }: { name: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-emerald-200 border-l-4 border-l-emerald-500 bg-emerald-50/70 px-4 py-3">
      <CheckCircle2 aria-hidden="true" className="h-4 w-4 flex-none text-emerald-600" />
      <span className="break-words text-sm font-bold text-emerald-900" dir="auto">
        {name?.trim() ? name : "This CV"}
      </span>
      <span className="text-phx-xs font-semibold text-emerald-700">returned to the administrator.</span>
    </div>
  );
}
