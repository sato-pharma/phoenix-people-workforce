"use client";

// Recruitment / ATS — the screening route's client half.
//
// THE FILTER BAR IS THE EXISTING ONE, IMPORTED RATHER THAN REBUILT. Eight URL-driven narrowings
// (status, seen, sent-to-manager, arrival window, role family, region, area, source), the "42 of
// 434" count, the orange treatment on whichever switch is actually holding something, and the Clear
// button — all of it still works, still lives in one file, and still produces a link a recruiter
// can bookmark. A second copy here would be a second thing to keep true, and the first divergence
// would be silent.
//
// SO THE TWO KINDS OF NARROWING ARE SPLIT ON PURPOSE, and the split is not arbitrary:
//
//   • THE URL narrows what is LOADED — the eight filters above. They are shareable, they survive a
//     reload, and changing one is a fresh server read because it changes the pool itself.
//   • THE WORKSTATION narrows what is SHOWN — work queue, vacancy, search. They are instant, they
//     never navigate, and they never lose the CV that is open. That is the whole point: an hour of
//     screening is spent moving between piles, and a page load per move is the cost this replaces.
//
// FULL WIDTH IS A BUTTON, and it is not decoration. Measured on a 1366px laptop, the admin shell's
// sidebar leaves the CV pane roughly 300px narrower than the same pane full-bleed — enough that a
// Word page that reads perfectly one way is squeezed the other. `F` toggles it, Escape leaves it.

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Maximize2, Minimize2 } from "lucide-react";

import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import { ScreeningFilterBar, ScreeningPageFrame } from "@/components/recruitment/screening-page-client";
import { ScreeningWorkstation } from "@/components/recruitment/workstation/screening-workstation";
import {
  screeningHref,
  screeningShellPoolHref,
  type ScreeningHrefOptions,
  type ScreeningNotifiedFilter,
  type ScreeningReceivedFilter,
  type ScreeningRegionFilter,
  type ScreeningRoleFilter,
  type ScreeningSeenFilter,
} from "@/lib/recruitment/screening-link";
import type { WorkQueueCounts } from "@/lib/recruitment/screening-queues";
import type {
  WorkspaceCandidateRow,
  WorkspaceManager,
  WorkspaceVacancy,
} from "@/lib/recruitment/screening-workspace-types";
import type { VacancyApplicantStats } from "@/lib/recruitment/vacancy-applicants";

export function WorkstationPageClient({
  area,
  areaOptions,
  canSendToManagers,
  canWriteNotes,
  counts,
  filteredOut,
  hiringManagers,
  notified,
  overdueManagerFeedback,
  poolHref,
  poolSize,
  positionSuggestions,
  received,
  region,
  role,
  rows,
  seen,
  source,
  sourceOptions,
  status,
  vacancies,
  vacancyStats,
}: {
  area: string | null;
  areaOptions: string[];
  canSendToManagers: boolean;
  canWriteNotes: boolean;
  counts: WorkQueueCounts;
  filteredOut: number;
  hiringManagers: WorkspaceManager[];
  notified: ScreeningNotifiedFilter;
  overdueManagerFeedback: number;
  /**
   * Where "back to the pool" goes. Passed in rather than hard-coded because this page exists in both
   * shells, and sending a portal user to the admin route bounces them straight back out through the
   * (admin) group's own redirect.
   */
  poolHref: string;
  poolSize: number;
  /** Job titles and areas already used, offered as a datalist behind the free-typed position. */
  positionSuggestions: { jobTitles: string[]; areas: string[] };
  received: ScreeningReceivedFilter | null;
  region: ScreeningRegionFilter | null;
  role: ScreeningRoleFilter | null;
  rows: WorkspaceCandidateRow[];
  seen: ScreeningSeenFilter;
  source: string | null;
  sourceOptions: string[];
  status: CandidateStatus | null;
  vacancies: WorkspaceVacancy[];
  vacancyStats: VacancyApplicantStats[];
}) {
  const router = useRouter();
  const [fullBleed, setFullBleed] = useState(false);
  // WHICH SHELL AM I ACTUALLY IN? Not always the one that rendered me — see screeningShellPoolHref.
  const shellPoolHref = screeningShellPoolHref(usePathname(), poolHref);

  const goTo = useCallback(
    (next: ScreeningHrefOptions) => {
      router.push(
        screeningHref(shellPoolHref, {
          area: next.area !== undefined ? next.area : area,
          notified: next.notified !== undefined ? next.notified : notified,
          received: next.received !== undefined ? next.received : received,
          region: next.region !== undefined ? next.region : region,
          role: next.role !== undefined ? next.role : role,
          seen: next.seen !== undefined ? next.seen : seen,
          source: next.source !== undefined ? next.source : source,
          status: next.status !== undefined ? next.status : status,
        }),
      );
    },
    [area, notified, received, region, role, router, seen, shellPoolHref, source, status],
  );

  // `F` for full width, Escape to leave it. Ignored while typing, so an "f" in a search term does
  // not throw the page into full bleed mid-word.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable === true;
      if (event.key === "Escape" && fullBleed && !typing) {
        event.preventDefault();
        setFullBleed(false);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFullBleed((on) => !on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullBleed]);

  const workstation = (
    <ScreeningWorkstation
      canSendToManagers={canSendToManagers}
      canWriteNotes={canWriteNotes}
      counts={counts}
      filteredOut={filteredOut}
      hiringManagers={hiringManagers}
      overdueManagerFeedback={overdueManagerFeedback}
      poolSize={poolSize}
      positionSuggestions={positionSuggestions}
      rows={rows}
      vacancies={vacancies}
      vacancyStats={vacancyStats}
    />
  );

  if (fullBleed) {
    return (
      <div className="fixed inset-0 z-[190] flex flex-col bg-white">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-phx-line bg-phx-surface-2 px-3 py-1.5">
          <span className="text-[12px] font-bold uppercase tracking-[0.08em] text-phx-ink-2">CV screening</span>
          <button
            className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
            onClick={() => setFullBleed(false)}
            type="button"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            Back to the page
          </button>
        </div>
        <div className="min-h-0 flex-1">{workstation}</div>
      </div>
    );
  }

  return (
    <ScreeningPageFrame>
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2 sm:px-4">
        <a
          className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
          href={shellPoolHref}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to the pool
        </a>
        <button
          className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
          onClick={() => setFullBleed(true)}
          title="Read at full width — press F"
          type="button"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Full width
        </button>
      </div>

      <ScreeningFilterBar
        area={area}
        areaOptions={areaOptions}
        notified={notified}
        onChange={goTo}
        onClear={() =>
          goTo({
            area: null,
            notified: "any",
            received: null,
            region: null,
            role: null,
            seen: "any",
            source: null,
            status: null,
          })
        }
        queueCount={rows.length}
        received={received}
        region={region}
        role={role}
        seen={seen}
        source={source}
        sourceOptions={sourceOptions}
        status={status}
        totalCount={poolSize}
      />

      {/* The geometry the screening page has used since August, unchanged: as tall as the viewport
          minus the shell header, with a floor so it does not collapse on a short window. The filter
          bar above draws its own bottom-borderless top corners to join onto this. */}
      <div className="h-[calc(100vh-4rem)] min-h-[32rem] border border-phx-line bg-white">{workstation}</div>
    </ScreeningPageFrame>
  );
}
