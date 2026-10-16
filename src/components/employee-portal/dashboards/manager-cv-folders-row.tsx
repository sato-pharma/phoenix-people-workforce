"use client";

import Link from "next/link";
import { FolderOpen } from "lucide-react";

import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { alarmGlowRef } from "@/components/layout/alarm-glow";
import type { ManagerFolderSummary } from "@/lib/recruitment/manager-cv-folders";

/**
 * The overview row for a manager's CV folders (owner, 2026-10-16: "a small row in their overview
 * holding folders of the cvs ... the folder pumps notifications and never stop until the cv is
 * seen").
 *
 * A prompt, not a list: only folders that hold something get a chip, each carrying a pulsing count
 * for the CVs not opened yet, and the empty ones are only counted. Absent for a manager who holds no
 * shelf (`cvFolders` is null), so a head-office manager never sees an empty heading. Every chip
 * wraps rather than clips, and the whole row opens My Candidates.
 */
export function ManagerCvFoldersRow({ summary }: { summary: ManagerFolderSummary | null | undefined }) {
  if (!summary || summary.totalFolders === 0) return null;

  const { chips, emptyFolders, totalCandidates, unseenCandidates } = summary;
  const headline =
    totalCandidates === 0
      ? "Nothing has been sent to your folders yet."
      : unseenCandidates > 0
        ? `${unseenCandidates} ${unseenCandidates === 1 ? "CV" : "CVs"} waiting to be opened`
        : `${totalCandidates} ${totalCandidates === 1 ? "CV" : "CVs"} in your folders, all opened`;

  return (
    <Link
      className={`block border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-[#f47b20] sm:px-5 ${adminSoftDepthClassName}`}
      href="/employee-portals/recruitment-candidates"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FolderOpen aria-hidden className="h-4 w-4 shrink-0 text-[#f47b20]" />
        <h2 className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
          CV Folders
        </h2>
        <span className={`min-w-0 break-words text-sm ${unseenCandidates > 0 ? "font-bold text-slate-900" : "text-slate-600"}`}>
          {headline}
        </span>
      </div>

      {chips.length > 0 || emptyFolders > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <span
              className={`relative flex items-center gap-2 border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-xs text-slate-800 ${adminChipDepthClassName}`}
              key={`${chip.lineName ?? ""}::${chip.name}`}
            >
              <span className="min-w-0 break-words font-semibold">{chip.name}</span>
              <span className="text-slate-500">{chip.count}</span>
              {chip.unseen > 0 ? (
                <span
                  className="nav-badge-alarm absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center bg-[#F05A1A] px-1 text-phx-xs font-bold text-white"
                  ref={alarmGlowRef}
                  title={`${chip.unseen} not opened yet`}
                >
                  {chip.unseen}
                </span>
              ) : null}
            </span>
          ))}
          {emptyFolders > 0 ? (
            <span className="text-phx-xs text-slate-500">
              {emptyFolders} empty {emptyFolders === 1 ? "folder" : "folders"}
            </span>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}
