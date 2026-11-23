"use client";

import { AlertTriangle, Check, Download, Search, Wallet } from "lucide-react";
import type { KeyboardEvent } from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { CrmLoadError, CrmLoading, CrmNote, crmInputClassName } from "@/components/phoenix-crm/ui";
import { formatNumberValue } from "@/lib/i18n/format";
import { kindCounts } from "@/lib/outstation/approvals/claim-kind";
import { DESK_DECISION_LIMIT } from "@/lib/outstation/approvals/decision-body";
import {
  DESK_LANES,
  DESK_LANE_LABEL,
  DESK_WORDS,
  type DeskLane,
  claimsInLane,
  filteredLaneCounts,
  laneSummaries,
  narrowsHistory,
  readyBatch,
} from "@/lib/outstation/approvals/desk-view";
import type { TripStanding } from "@/lib/outstation/approvals/standing";
import { cn } from "@/lib/utils";

import { DeskHistory } from "./desk-history";
import { DeskKindFilter } from "./desk-kind-filter";
import { egp } from "./desk-parts";
import { DeskPeriodFilter } from "./desk-period-filter";
import { DeskReviewer } from "./desk-reviewer";
import { DeskList } from "./desk-row";
import { DeskTiles, DeskTopLine } from "./desk-tiles";
import { DeskNotices, DeskUndoBar } from "./desk-undo-bar";
import { useDecidedCount } from "./use-decided-count";
import { TypedAmountsProvider, useTypedAmounts } from "./typed-amounts";
import { useDesk } from "./use-desk";

/**
 * Expense Approvals — the decision desk.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH LESS THAN 9.5/10 PER ITEM IS NOT ACCEPTED"). From
 * the top: one line saying how many decisions wait, five true tiles, three lanes — Ready, Your call,
 * History — and the list, on the first screen. A decision is one press on the row, saved by itself
 * with six seconds of Undo; there is no Save button and nothing is marked for later.
 *
 * This file only lays the page out. What the page reads and how a press travels are in use-desk.ts;
 * every rule about lanes, words and figures is in src/lib/outstation/approvals/.
 */
/** The typed amounts live above the page, so every row, the opened trip and both batches read one store. */
export function DeskWorkspace({ initialSearch }: { initialSearch: string }) {
  return (
    <TypedAmountsProvider>
      <DeskWorkspaceBody initialSearch={initialSearch} />
    </TypedAmountsProvider>
  );
}

function DeskWorkspaceBody({ initialSearch }: { initialSearch: string }) {
  const typedAmounts = useTypedAmounts();
  const desk = useDesk(initialSearch);
  const { canDecide, lane, load, queue, view } = desk;

  const narrowed = Boolean(view.search.trim()) || view.overSevenDays || view.kind !== null || view.from !== null || view.to !== null;
  const lanes = queue ? laneSummaries(queue.claims) : null;
  // Each tab counts what pressing it will show (owner, 23 Nov 2026: "The tab are empty … there's
  // something wrong" — they said 15 and 51 over two empty lists). History's figure is its own count
  // under the same filters, read only while one of them is set.
  const shown = queue && narrowed ? filteredLaneCounts(queue.claims, view) : null;
  const decided = useDecidedCount({ enabled: Boolean(queue) && narrowsHistory(view), from: view.from, kind: view.kind, search: view.search, to: view.to, version: desk.historyVersion });
  const laneClaims = queue && lane !== "history" ? claimsInLane(queue.claims, lane, view) : [];
  // The figure on each kind button: the lane on screen as the search, "over 7 days" and the trip dates
  // leave it, before the kind narrows it — so a button says what pressing it will show.
  const kinds = queue && lane !== "history" ? kindCounts(claimsInLane(queue.claims, lane, { ...view, kind: null })) : null;
  const batch = lane === "ready" ? readyBatch(laneClaims, DESK_DECISION_LIMIT, typedAmounts) : null;
  const open = (requestId: number) => desk.setView({ trip: requestId });

  const openTile = (standing: TripStanding) => {
    if (standing === "waiting") desk.setView({ lane: lanes && lanes.ready.count > 0 ? "ready" : "your_call" });
    else desk.setView({ history: standing === "rejected" ? "rejected" : "approved", lane: "history" });
    // On a phone the tiles sit under the list, so the lane a tile opens is brought back into view.
    document.querySelector("[data-desk-top-line]")?.scrollIntoView({ block: "nearest" });
  };

  const exportHref = view.search.trim() ? `/api/admin/outstation/expenses/export?search=${encodeURIComponent(view.search.trim())}` : "/api/admin/outstation/expenses/export";

  return (
    <div className="min-w-0 space-y-3" data-expense-desk>
      <AdminPageHero
        actions={
          <a
            className="inline-flex min-h-11 items-center gap-2 border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            href={exportHref}
            title="Every trip, every decision state, as a workbook"
          >
            <Download aria-hidden className="h-4 w-4" /> Export XLSX
          </a>
        }
        compact
        description={
          queue && !canDecide
            ? "You can read every claim here. The decisions are the Super Admin's."
            : "Nothing is paid without your decision. A press saves by itself, and Undo stays for six seconds."
        }
        eyebrow="Expenses"
        icon={<Wallet aria-hidden className="h-3.5 w-3.5" />}
        title="Expense approvals"
      />

      {load.sessionExpired ? (
        <p className="flex min-w-0 flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm font-semibold text-amber-900">
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
          Your session has expired.
          <a className="font-black underline hover:text-amber-950" href="/login">
            Sign in again
          </a>
        </p>
      ) : null}

      {!queue ? (
        <section className="min-w-0 border border-slate-200 bg-white">
          {load.loading ? <CrmLoading label="Reading the claims that wait" /> : load.sessionExpired ? null : <CrmLoadError message={load.error ?? "Unable to load the expense approvals."} onRetry={desk.retry} />}
        </section>
      ) : (
        <>
          <DeskTopLine onToggleOld={() => desk.setView({ overSevenDays: !view.overSevenDays })} overOnly={view.overSevenDays} queue={queue} />
          {/* A desktop reads the tiles first. On a phone they stood between the count and the first
              claim, which began 904 px down (measured at 375, 23 Nov 2026), so there they are drawn
              after the list: the one line above already says what waits. */}
          <DeskTiles className="hidden md:block" onOpen={openTile} queue={queue} />

          {queue.unavailable.length > 0 ? (
            <CrmNote title="Some of the checks could not be made just now" tone="warn">
              Not read: {queue.unavailable.join(", ")}. A claim that depends on one of them is in Your call and says so — it is never shown as Ready.
            </CrmNote>
          ) : null}

          <DeskNotices notices={desk.notices} onDismiss={desk.dismissNotice} onOpen={open} />

          <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-slate-200">
            <DeskTabs
              counts={{ history: decided, ready: shown?.ready ?? lanes?.ready.count ?? 0, your_call: shown?.your_call ?? lanes?.your_call.count ?? 0 }}
              lane={lane}
              onChoose={(next) => desk.setView({ lane: next })}
            />
            <label className="relative mb-1.5 block w-full min-w-0 sm:w-72">
              <span className="sr-only">Search by employee or place</span>
              <Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
              <input
                autoComplete="off"
                className={cn(crmInputClassName, "appearance-none pl-9")}
                data-desk-search
                onChange={(event) => desk.setView({ search: event.target.value })}
                placeholder={lane === "history" ? "Search by employee" : "Search by employee or place"}
                type="search"
                value={view.search}
              />
            </label>
          </div>

          <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2" data-desk-filters>
            <DeskKindFilter counts={kinds} kind={view.kind} onChoose={(kind) => desk.setView({ kind })} />
            <DeskPeriodFilter onChoose={(period) => desk.setView(period)} period={{ from: view.from, to: view.to }} />
          </div>

          {lane === "history" ? (
            <DeskHistory
              canDecide={canDecide}
              choice={view.history}
              from={view.from}
              kind={view.kind}
              onChoose={(history) => desk.setView({ history })}
              onOpen={open}
              onPress={desk.press}
              pressed={desk.pressed}
              search={view.search.trim()}
              to={view.to}
              version={desk.historyVersion}
            />
          ) : (
            <DeskList
              action={
                canDecide && batch && batch.count > 0 ? (
                  <button
                    className={approvalActionClassName("approve", "regular")}
                    data-approve-all={batch.count}
                    onClick={() => desk.press(batch.decisions, laneClaims)}
                    title={batch.left > 0 ? `${formatNumberValue(batch.left)} more stay in the lane for the next press` : "Every claim in this lane passed every check"}
                    type="button"
                  >
                    <Check aria-hidden className="h-4 w-4 shrink-0" />
                    {narrowed || batch.left > 0 ? `${DESK_WORDS.approve} these ${formatNumberValue(batch.count)}` : `${DESK_WORDS.approveAll} ${formatNumberValue(batch.count)}`} · {egp(batch.value)}
                  </button>
                ) : null
              }
              canDecide={canDecide}
              claims={laneClaims}
              decided={decided}
              key={lane}
              lane={lane}
              narrowed={narrowed}
              onOpen={open}
              onPress={desk.press}
              onShowHistory={() => desk.setView({ history: "all", lane: "history" })}
              view={view}
            />
          )}

          <DeskTiles className="md:hidden" onOpen={openTile} queue={queue} />

          <DeskUndoBar onUndo={desk.undo} presses={desk.presses} />
        </>
      )}

      {view.trip !== null ? (
        <DeskReviewer
          canDecide={canDecide}
          notice={desk.notices.find((notice) => notice.requestId === view.trip) ?? null}
          onClose={() => desk.setView({ trip: null })}
          onGo={open}
          onPress={desk.press}
          onUndo={desk.undo}
          presses={desk.presses}
          requestId={view.trip}
          walk={laneClaims.map((claim) => claim.requestId)}
        />
      ) : null}
    </div>
  );
}

function DeskTabs({
  counts,
  lane,
  onChoose,
}: {
  /** History's figure is null when nothing History reads is filtered, or while its count is read. */
  counts: Record<Exclude<DeskLane, "history">, number> & { history: number | null };
  lane: DeskLane;
  onChoose: (lane: DeskLane) => void;
}) {
  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = DESK_LANES.length - 1;
    const target =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    onChoose(DESK_LANES[target]);
    document.getElementById(`desk-tab-${DESK_LANES[target]}`)?.focus();
  }
  return (
    <div aria-label="Expense approvals" className="flex min-w-0 flex-wrap" role="tablist">
      {DESK_LANES.map((key, index) => (
        <button
          aria-controls={lane === key ? `desk-panel-${key}` : undefined}
          aria-selected={lane === key}
          className={cn(
            "-mb-px inline-flex min-h-11 min-w-0 items-center gap-2 border-b-2 px-4 py-2.5 text-left text-sm font-black",
            lane === key ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-700",
          )}
          data-lane={key}
          id={`desk-tab-${key}`}
          key={key}
          onClick={() => onChoose(key)}
          onKeyDown={(event) => move(event, index)}
          role="tab"
          tabIndex={lane === key ? 0 : -1}
          type="button"
        >
          <span className="break-words">
            {DESK_LANE_LABEL[key]}
            {key !== "history" ? (
              <span className="tabular-nums"> ({formatNumberValue(counts[key])})</span>
            ) : counts.history !== null ? (
              <span className="tabular-nums" data-history-count={counts.history}> ({formatNumberValue(counts.history)})</span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}
