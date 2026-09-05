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
//
// AND SO IS EVERY BAR ON THE PAGE. The owner's words: "I need the full screen to see the CV in."
// So the toolbar folds, the filter bar folds, and one control — CV FULL SCREEN — folds every bar
// and every pane at once, leaving a single line above the document. The state lives HERE rather
// than inside the workstation because the two bars this page owns have to fold with it; the panes
// keep their own flags underneath and get them back untouched when the reader comes out.

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, Minimize2, ScanLine } from "lucide-react";

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
  canDecide,
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
  throughput,
  vacancies,
  vacancyStats,
}: {
  area: string | null;
  areaOptions: string[];
  /**
   * May this reader decide candidates — the gate on both the single verdict and the bulk one.
   *
   * Its own prop rather than a second use of `canWriteNotes`, even though the two are the same
   * value today. They answer different questions, and the day notes are gated separately from
   * decisions, a shared prop would move who can reject fifty CVs without anybody editing this file.
   */
  canDecide: boolean;
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
  /** Backlog in against backlog out — see the strip below and ScreeningWorkspace["throughput"]. */
  throughput: { unread: number; arrived7: number; decided7: number };
  vacancies: WorkspaceVacancy[];
  vacancyStats: VacancyApplicantStats[];
}) {
  const router = useRouter();
  const [fullBleed, setFullBleed] = useState(false);
  const [focus, setFocus] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  // What full-bleed was before focus took it, so leaving focus puts the shell back exactly as it
  // was rather than deciding for the reader that he also wanted his sidebar returned.
  const [bleedBeforeFocus, setBleedBeforeFocus] = useState(false);

  // FOCUS TAKES THE SIDEBAR TOO. "I need the full screen to see the CV in" is one screen, not one
  // column of it: with the admin shell still on the left the document gets about 1,100px of a
  // 1,440px laptop, and the 300px the shell holds is the difference between a Word page that reads
  // and one that is squeezed. So entering focus turns full-bleed on as well, and leaving it hands
  // back whichever state the reader had chosen for himself.
  const enterFocus = useCallback(() => {
    setBleedBeforeFocus(fullBleed);
    setFullBleed(true);
    setFocus(true);
  }, [fullBleed]);
  const leaveFocus = useCallback(() => {
    setFocus(false);
    setFullBleed(bleedBeforeFocus);
  }, [bleedBeforeFocus]);
  const toggleFocus = useCallback(() => {
    if (focus) leaveFocus();
    else enterFocus();
  }, [enterFocus, focus, leaveFocus]);

  // How many of the eight URL narrowings are actually holding something. It is what the folded
  // filter bar says about itself: a bar that hides how many filters are on is a bar that makes
  // "why am I only seeing four people" unanswerable without opening it again.
  const activeFilters = [
    area,
    source,
    status,
    role,
    region,
    received,
    notified === "any" ? null : notified,
    seen === "any" ? null : seen,
  ].filter((value) => value !== null && value !== undefined && value !== "").length;
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
      if (event.key === "Escape" && !typing && (focus || fullBleed)) {
        event.preventDefault();
        // Focus first: it is the deeper of the two, and it puts back whatever full-bleed state the
        // reader had before it, so a second Escape can then leave that too.
        if (focus) leaveFocus();
        else setFullBleed(false);
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
  }, [focus, fullBleed, leaveFocus]);

  const workstation = (
    <ScreeningWorkstation
      canDecide={canDecide}
      canSendToManagers={canSendToManagers}
      canWriteNotes={canWriteNotes}
      counts={counts}
      filteredOut={filteredOut}
      focus={focus}
      hiringManagers={hiringManagers}
      onToggleFocus={toggleFocus}
      overdueManagerFeedback={overdueManagerFeedback}
      poolSize={poolSize}
      positionSuggestions={positionSuggestions}
      rows={rows}
      vacancies={vacancies}
      vacancyStats={vacancyStats}
    />
  );

  return (
    <ScreeningPageFrame>
      {/* THE PAGE'S OWN CHROME. Both bars answer focus; both are gone in full bleed, which draws its
          own single bar inside the frame below. */}
      {focus || fullBleed ? null : <ThroughputStrip poolSize={poolSize} throughput={throughput} />}

      {focus || fullBleed ? null : (
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2 sm:px-4">
          <a
            className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
            href={shellPoolHref}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to the pool
          </a>
          <button
            aria-expanded={filtersOpen}
            className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
            onClick={() => setFiltersOpen((open) => !open)}
            title={filtersOpen ? "Hide the filter bar" : "Show the filter bar"}
            type="button"
          >
            {filtersOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            Filters
            {activeFilters > 0 ? (
              <span className="border border-phx-accent-line bg-phx-accent-soft px-1 text-[11px] font-black tabular-nums text-phx-accent-press">
                {activeFilters}
              </span>
            ) : null}
          </button>
          <button
            className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
            onClick={() => setFullBleed(true)}
            title="Read at full width — press F"
            type="button"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Full width
          </button>
          <FocusButton onClick={enterFocus} />
        </div>
      )}

      {focus || fullBleed || !filtersOpen ? null : (
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
      )}

      {/* ONE TREE, TWO GEOMETRIES — and the single tree is the load-bearing part.
          Full bleed used to be an early `return` into a different element tree, which meant React
          UNMOUNTED the workstation on the way in and on the way out: the selection went back to the
          first row, every loaded profile was thrown away, and the CV the reader was in the middle of
          re-fetched. Entering focus turns full bleed on, so that reset would have landed on the one
          press this whole change exists to make good. Same position in the tree, different class.

          The normal geometry is the one the screening page has used since August: as tall as the
          viewport minus the shell header, with a floor so it does not collapse on a short window. */}
      <div
        className={
          fullBleed
            ? "fixed inset-0 z-[190] flex flex-col bg-white"
            : "flex h-[calc(100vh-4rem)] min-h-[32rem] flex-col border border-phx-line bg-white"
        }
      >
        {fullBleed && !focus ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-phx-line bg-phx-surface-2 px-3 py-1.5">
            <span className="text-[12px] font-bold uppercase tracking-[0.08em] text-phx-ink-2">CV screening</span>
            <span className="flex items-center gap-1.5">
              <FocusButton onClick={enterFocus} />
              <button
                className="inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold text-phx-ink-2 transition hover:bg-phx-paper"
                onClick={() => setFullBleed(false)}
                type="button"
              >
                <Minimize2 className="h-3.5 w-3.5" />
                Back to the page
              </button>
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{workstation}</div>
      </div>
    </ScreeningPageFrame>
  );
}

/**
 * IS THE BACKLOG GROWING OR SHRINKING? The one question the rail could not answer.
 *
 * Every number on this page described a PILE. None of them said whether the reader was keeping up,
 * and the answer on 2026-09-05 was no: 597 in the pool, 438 never opened by anybody, 153 arrived in
 * seven days, and an average of 12.8 days to a first decision. The queue was correct and losing, and
 * nothing on screen said so.
 *
 * So: what came in, what went out, and the difference — in that order, because the difference is
 * meaningless without the two figures that produced it. `net` is deliberately signed and worded
 * rather than coloured: "+38 this week" is a fact, and a red pill would be this component having an
 * opinion about a recruiter's week.
 *
 * The unread figure is THIS VIEWER's, the same "seen" the rest of the page means — see
 * candidate-views.ts on why that is per person and not per candidate.
 */
function ThroughputStrip({
  poolSize,
  throughput,
}: {
  poolSize: number;
  throughput: { unread: number; arrived7: number; decided7: number };
}) {
  const net = throughput.arrived7 - throughput.decided7;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 border border-phx-line bg-phx-surface-2 px-3 py-1.5 text-[12px] sm:mx-2">
      <Figure label="in the pool" value={poolSize} />
      <Figure label="you have not opened" value={throughput.unread} />
      <Figure label="arrived this week" value={throughput.arrived7} />
      <Figure label="decided this week" value={throughput.decided7} />
      <span className="flex items-baseline gap-1 font-bold text-phx-ink-2">
        <span className="tabular-nums">
          {net > 0 ? "+" : ""}
          {net}
        </span>
        <span className="font-semibold text-phx-ink-soft">
          {net > 0 ? "the backlog grew this week" : net < 0 ? "the backlog shrank this week" : "the backlog held level"}
        </span>
      </span>
    </div>
  );
}

/** One figure and its words. Tabular so the row does not jitter as the numbers change. */
function Figure({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="font-bold tabular-nums text-phx-ink">{value}</span>
      <span className="font-semibold text-phx-ink-soft">{label}</span>
    </span>
  );
}

/**
 * One press, and every bar and every pane on this screen folds away.
 *
 * It is deliberately NOT "hide the sidebar" or "collapse the filters" spelled four times: the owner
 * asked for the screen, not for four controls that each give back a strip of it. Everything it folds
 * can also be folded on its own, and coming back out restores exactly what was open before.
 */
function FocusButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="inline-flex items-center gap-1 border border-phx-accent-line bg-phx-accent-soft px-2 py-1 text-[12px] font-bold text-phx-accent-press transition hover:bg-phx-accent hover:text-white"
      onClick={onClick}
      title="Give the whole screen to the CV — Escape comes back"
      type="button"
    >
      <ScanLine className="h-3.5 w-3.5" />
      CV full screen
    </button>
  );
}
