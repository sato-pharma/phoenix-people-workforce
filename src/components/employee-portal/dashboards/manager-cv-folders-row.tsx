"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { LANDING_FOCUS, LandingEmpty, LandingFigure, LandingPanel } from "@/components/employee-portal/landing-kit";
import { alarmGlowRef } from "@/components/layout/alarm-glow";
import type { ManagerFolderSummary } from "@/lib/recruitment/manager-cv-folders";

/**
 * The overview row for a manager's CV folders (owner, 2026-10-16: "a small row in their overview
 * holding folders of the cvs ... the folder pumps notifications and never stop until the cv is
 * seen").
 *
 * A prompt, not a list: only folders that hold something get a row, each carrying a pulsing count
 * for the CVs not opened yet, and the empty ones are only counted. Absent for a manager who holds no
 * shelf (`cvFolders` is null), so a head-office manager never sees an empty heading. Every name
 * wraps rather than clips, and the whole panel opens My Candidates.
 *
 * Drawn in the landing language (owner, 2026-11-20 redesign): a white panel with the tick title, the
 * waiting count as the panel's figure, one ruled row per folder, and the pulsing count at the row's
 * end — beside the folder, never perched on a chip as a badge on a badge.
 */
export function ManagerCvFoldersRow({ summary }: { summary: ManagerFolderSummary | null | undefined }) {
  if (!summary || summary.totalFolders === 0) return null;

  const { chips, emptyFolders, totalCandidates, unseenCandidates } = summary;
  const figure = unseenCandidates > 0 ? unseenCandidates : totalCandidates;
  const unit =
    unseenCandidates > 0
      ? `${unseenCandidates === 1 ? "CV" : "CVs"} waiting to be opened`
      : `${totalCandidates === 1 ? "CV" : "CVs"} in your folders, all opened`;

  return (
    <Link className={`group block min-w-0 ${LANDING_FOCUS}`} href="/employee-portals/recruitment-candidates">
      <LandingPanel
        className="transition-colors motion-reduce:transition-none group-hover:border-[#08111f]"
        right={
          <span className="inline-flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-[#08111f]">
            Open
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </span>
        }
        title="CV Folders"
      >
        {totalCandidates === 0 ? (
          <LandingEmpty>Nothing has been sent to your folders yet.</LandingEmpty>
        ) : (
          <div className="px-3 py-3 sm:px-4">
            <LandingFigure size="md" tone={unseenCandidates > 0 ? undefined : "text-slate-500"} unit={unit}>
              {figure}
            </LandingFigure>
          </div>
        )}

        {chips.length > 0 ? (
          <ul>
            {chips.map((chip) => (
              <li
                className="flex min-w-0 items-center gap-3 border-t border-slate-200 px-3 py-2.5 sm:px-4"
                key={`${chip.lineName ?? ""}::${chip.name}`}
              >
                <span className="min-w-0 flex-1 break-words text-phx-md font-bold leading-snug text-[#08111f]">{chip.name}</span>
                <span className="shrink-0 text-phx-sm font-bold tabular-nums text-slate-500">
                  {chip.count} {chip.count === 1 ? "CV" : "CVs"}
                </span>
                {chip.unseen > 0 ? (
                  <span
                    className="nav-badge-alarm flex h-5 min-w-5 shrink-0 items-center justify-center bg-[#F05A1A] px-1 text-phx-xs font-bold tabular-nums text-white"
                    ref={alarmGlowRef}
                    title={`${chip.unseen} not opened yet`}
                  >
                    {chip.unseen}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {emptyFolders > 0 ? (
          <p className="border-t border-slate-200 px-3 py-2.5 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500 sm:px-4">
            {emptyFolders} empty {emptyFolders === 1 ? "folder" : "folders"}
          </p>
        ) : null}
      </LandingPanel>
    </Link>
  );
}
