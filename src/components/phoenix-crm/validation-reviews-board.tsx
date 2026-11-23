"use client";

/**
 * Phoenix CRM — Place checks: the board. It decides places, and nothing else is above the first of them.
 *
 * 🔴 REBUILT ON 23 NOV 2026 (owner: "rebuild from scratch"). The audit found the first waiting place about
 * 1,700 px down a desktop page and a phone page 51,062 px long, with three different "waiting" numbers.
 * So, on the Super Admin's board: one line saying how many decisions wait (`desk-header.tsx`); two lanes
 * the system sorts — **Ready**, which one press approves, and **Your call**, each row with the one reason
 * it is his (`place-check-lanes.ts`); and everything that is not a decision on a tab of its own — the
 * scorecard, what the system approved by itself, the places in use, the buildings, the comparisons, and
 * whatever the page hands in (`slots`).
 *
 * This file is the frame only. The state is one hook (`place-checks/use-place-check-board.tsx`) and each
 * tab is its own panel under `place-checks/`, so no file of the board is long enough to hide a rule.
 *
 * 🔴 ONE BOARD, TWO MODES, AND NEVER A SECOND COPY (owner, 2026-10-13: a district manager gets this board
 * for his own team). `mode="company"` is the Super Admin's and the SFE Manager's (2026-10-19);
 * `mode="team"` renders NO decision control and no sentence about one: not "waiting for your decision",
 * not who decided a settled row, not what approving or rejecting would do, and not the system's advice.
 * A district manager's board has no lanes, no header and no meter, and still opens with its scorecard.
 * The SFE Manager reads the company board and decides nothing on it (owner, 2026-11-19), so his has no
 * lanes either: every waiting place is in the one list.
 *
 * 🔴 IT IS A REPORT, NOT A DUMP (owner, 2026-10-17): only the open tab is drawn, every list is paged, test
 * entries are never drawn, and a rejected building is behind its own switch.
 *
 * 🔴 A BULK RUN HOLDS THE BOARD STILL (17 Nov 2026): the two holds below are the tabs, filters and counts,
 * and every row's own buttons. The Ready lane's one press holds them the same way.
 *
 * It is an admin screen, so the dropdowns are combo boxes the Super Admin types into (the module's
 * surface rule): the board declares `surface="admin"` around itself.
 */

import { useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { CustomerMatchBoardView } from "@/components/phoenix-crm/customer-match-board";
import { LineLookalikeBoardView } from "@/components/phoenix-crm/line-lookalike-board";
import { PlaceMatchBoardView } from "@/components/phoenix-crm/place-match-board";
import type { PlaceCheckBoardProps } from "@/components/phoenix-crm/place-checks/board-types";
import { PlaceChecksBuildingsPanel } from "@/components/phoenix-crm/place-checks/buildings-panel";
import { PlaceCheckDeskHeader, PlaceCheckTop } from "@/components/phoenix-crm/place-checks/desk-header";
import { PlaceCheckFilterBar } from "@/components/phoenix-crm/place-checks/filter-bar";
import { PlaceChecksBySystemPanel, PlaceChecksHistoryPanel } from "@/components/phoenix-crm/place-checks/history-panel";
import { PlaceChecksInUsePanel } from "@/components/phoenix-crm/place-checks/in-use-panel";
import { PlaceChecksWaitingPanel } from "@/components/phoenix-crm/place-checks/needs-panel";
import { ReadingEverything } from "@/components/phoenix-crm/place-checks/paged";
import { PlaceChecksScorecardPanel } from "@/components/phoenix-crm/place-checks/scorecard-panel";
import { PlaceCheckTabStrip } from "@/components/phoenix-crm/place-checks/tab-strip";
import { usePlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";

export function ValidationReviewsBoard(props: PlaceCheckBoardProps) {
  const board = usePlaceCheckBoard(props);
  const {
    askForDeck,
    bulkRunning,
    canRestore,
    capped,
    complete,
    deckInput,
    everythingRead,
    filters,
    lanes,
    lineLookalikesOpened,
    onDemand,
    reading,
    reloadEverything,
    reviewDeck,
    sameCustomerOpened,
    samePlaceOpened,
    slots,
    team,
    view,
    wanted,
  } = board;
  // The one-by-one review's button: beside the waiting number on the Super Admin's board.
  const review =
    deckInput && reviewDeck ? reviewDeck(deckInput, { ready: complete, want: askForDeck, error: everythingRead.error, retry: reloadEverything, bare: lanes }) : null;
  // 🔴 A TAB THE PAGE HANDS IN IS DRAWN FROM ITS FIRST OPENING ON, never before (23 Nov 2026). Each stayed
  // mounted from the start, hidden, so "Full names" and "Figures" were in the HTML and in the page of
  // somebody who opened Your call. Once opened it stays, so a name half corrected is still there.
  const [slotsOpened, setSlotsOpened] = useState<ReadonlyArray<string>>([]);
  if (view.startsWith("slot:") && !slotsOpened.includes(view)) setSlotsOpened([...slotsOpened, view]);
  // The tabs that read for themselves, or are the page's own, never wait for the click's read.
  const readsItself = view === "samePlace" || view === "sameCustomer" || view === "lineLookalikes" || view.startsWith("slot:");

  return (
    <CrmSurfaceProvider surface="admin">
      <div className="space-y-5">
        <fieldset className="m-0 min-w-0 space-y-5 border-0 p-0" disabled={bulkRunning}>
          <PlaceCheckTop hero={props.hero}>{lanes ? <PlaceCheckDeskHeader board={board} review={review} /> : review}</PlaceCheckTop>
          <PlaceCheckFilterBar board={board} />

          {capped.reviews || capped.validated || capped.reopened || capped.sharedPlaces ? (
            <AdminCallout tone="warning">
              <span>
                This page is showing the newest rows only: there are more than it can hold in one read. Narrow the period or the
                filters to reach the older ones.
              </span>
            </AdminCallout>
          ) : null}

          {/* A district manager's board still opens with each rep's captures; on the company board it is a tab. */}
          {team ? <PlaceChecksScorecardPanel board={board} /> : null}

          <PlaceCheckTabStrip board={board} />
        </fieldset>

        {bulkRunning ? (
          <p className="break-words border-l-4 border-orange-500 bg-white px-4 py-2 text-sm font-semibold text-slate-700" role="status">
            Answering the rows you picked. The tabs, the filters and every other decision wait until it is done.
          </p>
        ) : null}

        {onDemand && wanted && complete && everythingRead.error ? (
          <ReadingEverything error={everythingRead.error} onRetry={reloadEverything} stale />
        ) : null}

        {/* 🔴 EVERY ROW'S OWN BUTTONS WAIT FOR A BULK RUN TOO (17 Nov 2026, the review of the audit fixes): an
            approved place can be rejected on its own row, so a row approved by hand mid-run was rejected
            again when the run reached it. The running bar's own controls are already held by `busy`. */}
        <fieldset className="m-0 min-w-0 space-y-5 border-0 p-0" disabled={bulkRunning}>
          {!reading && view === "ready" ? (
            <div aria-labelledby="vr-tab-ready" className="space-y-5" id="vr-panel-ready" role="tabpanel">
              <PlaceChecksWaitingPanel board={board} lane="ready" />
            </div>
          ) : null}

          {!reading && view === "needs" ? (
            <div aria-labelledby="vr-tab-needs" className="space-y-5" id="vr-panel-needs" role="tabpanel">
              <PlaceChecksWaitingPanel board={board} lane="needs" />
            </div>
          ) : null}

          {!reading && view === "unconfirmed" ? (
            <div aria-labelledby="vr-tab-unconfirmed" className="space-y-3" id="vr-panel-unconfirmed" role="tabpanel">
              <PlaceChecksInUsePanel board={board} />
            </div>
          ) : null}

          {!reading && view === "polyclinics" ? (
            <div aria-labelledby="vr-tab-polyclinics" className="space-y-3" id="vr-panel-polyclinics" role="tabpanel">
              <PlaceChecksBuildingsPanel board={board} />
            </div>
          ) : null}

          {!reading && view === "scorecard" ? (
            <div aria-labelledby="vr-tab-scorecard" className="space-y-5" id="vr-panel-scorecard" role="tabpanel">
              <PlaceChecksScorecardPanel board={board} />
            </div>
          ) : null}

          {reading && !readsItself ? <ReadingEverything error={everythingRead.error} onRetry={reloadEverything} /> : null}

          {!team && samePlaceOpened ? (
            <div aria-labelledby="vr-tab-samePlace" hidden={view !== "samePlace"} id="vr-panel-samePlace" role="tabpanel">
              <PlaceMatchBoardView filters={filters} />
            </div>
          ) : null}

          {!team && sameCustomerOpened ? (
            <div aria-labelledby="vr-tab-sameCustomer" hidden={view !== "sameCustomer"} id="vr-panel-sameCustomer" role="tabpanel">
              <CustomerMatchBoardView filters={filters} />
            </div>
          ) : null}

          {!team && canRestore && lineLookalikesOpened ? (
            <div aria-labelledby="vr-tab-lineLookalikes" hidden={view !== "lineLookalikes"} id="vr-panel-lineLookalikes" role="tabpanel">
              <LineLookalikeBoardView filters={filters} />
            </div>
          ) : null}

          {/* What the page hands in stays mounted once opened, so a name half corrected is still there when he comes back to its tab. */}
          {slots
            .filter((slot) => view === `slot:${slot.key}` || slotsOpened.includes(`slot:${slot.key}`))
            .map((slot) => (
              <div key={slot.key} aria-labelledby={`vr-tab-slot:${slot.key}`} className="space-y-5" hidden={view !== `slot:${slot.key}`} id={`vr-panel-slot:${slot.key}`} role="tabpanel">
                {slot.content}
              </div>
            ))}

          {!reading && view === "bySystem" ? (
            <div aria-labelledby="vr-tab-bySystem" className="space-y-5" id="vr-panel-bySystem" role="tabpanel">
              <PlaceChecksBySystemPanel board={board} />
            </div>
          ) : null}

          {!reading && view === "history" ? (
            <div aria-labelledby="vr-tab-history" className="space-y-5" id="vr-panel-history" role="tabpanel">
              <PlaceChecksHistoryPanel board={board} />
            </div>
          ) : null}
        </fieldset>
      </div>
    </CrmSurfaceProvider>
  );
}
