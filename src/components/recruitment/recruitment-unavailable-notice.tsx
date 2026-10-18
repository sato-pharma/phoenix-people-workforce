"use client";

import { AlertTriangle, RotateCw } from "lucide-react";

import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { describeUnavailable, type RecruitmentReadSource } from "@/lib/recruitment/page-reads";

/**
 * The amber notice both pieces below are drawn on: a hairline box with a 3px amber rule down its
 * leading edge, lifted like any other box inside a panel, and an icon tile so it reads as the page
 * talking rather than as a row of data. Square, like everything in the module.
 */
const noticeClassName = `flex min-w-0 items-start gap-3 border border-amber-200 border-l-[3px] border-l-amber-500 bg-amber-50/80 px-4 py-3 text-sm text-amber-950 ${adminSoftDepthClassName}`;

const noticeIconClassName = `flex h-8 w-8 shrink-0 items-center justify-center border border-amber-300 bg-white text-amber-600 ${adminChipDepthClassName}`;

/**
 * Says, in words, which parts of the Recruitment page did not load -- and offers the one thing that
 * helps, which is asking again.
 *
 * It replaces a single red line and a sentence about applying migrations on staging. The page used to
 * go blank when ANY of its reads failed, and the advice it gave was for a fresh environment; the
 * Talent Acquisition seat read it on production on 18 Oct 2026 while the database was only slow. The
 * button is inside the text column rather than beside it so the notice fits a 375px screen without a
 * sideways scroll.
 */
export function RecruitmentUnavailableNotice({
  onRetry,
  pending,
  sources,
}: {
  onRetry: () => void;
  pending: boolean;
  sources: ReadonlyArray<RecruitmentReadSource>;
}) {
  if (sources.length === 0) return null;
  // With the dashboard and the candidate pool both missing there is no working "rest" to point at.
  const restIsWorking = !(sources.includes("dashboard") && sources.includes("pool"));
  return (
    <div className={noticeClassName}>
      <span aria-hidden="true" className={noticeIconClassName}>
        <AlertTriangle className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-2.5" role="status">
        <div className="space-y-1">
          <p className="break-words font-bold text-amber-950">Some recruitment information is temporarily unavailable.</p>
          <p className="break-words text-[13px] leading-5 text-amber-900">
            Not loaded: {describeUnavailable(sources)}.{restIsWorking ? " The rest of this page is working." : ""}
          </p>
        </div>
        <button
          className={`${phxButtonGhostClassName} ${adminControlDepthClassName} disabled:shadow-none`}
          disabled={pending}
          onClick={onRetry}
          type="button"
        >
          <RotateCw aria-hidden="true" className={pending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          {pending ? "Trying again" : "Try again"}
        </button>
      </div>
    </div>
  );
}

/** Stands in for a tab whose own data did not load -- never an empty table that reads as "none". */
export function RecruitmentTabUnavailable({ what }: { what: string }) {
  return (
    <div className={noticeClassName}>
      <span aria-hidden="true" className={noticeIconClassName}>
        <AlertTriangle className="h-4 w-4" />
      </span>
      <p className="min-w-0 flex-1 break-words self-center text-[13px] leading-5 text-amber-900">
        <span className="font-bold text-amber-950">{what} is temporarily unavailable.</span> Use Try again above.
      </p>
    </div>
  );
}
