"use client";

import { Fragment, type ReactNode, useState } from "react";

import { CrmEmpty, CrmShowMore, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { TableRowDetail } from "@/components/ui/table-row-detail";
import { formatNumberValue } from "@/lib/i18n/format";
import { DESK_DECISION_LIMIT } from "@/lib/outstation/approvals/decision-body";
import { DESK_LANE_LABEL, DESK_LANE_MEANING, selectionBatch, waitLabel, type DeskLane } from "@/lib/outstation/approvals/desk-view";
import type { DeskClaim } from "@/lib/outstation/approvals/types";
import { displayPlace } from "@/lib/outstation/place-label";
import { cn } from "@/lib/utils";

import { type DecisionMode, DecisionButtons, DecisionPanel, type OnPress } from "./desk-decision";
import { FoundCell, MoneyCell, STANDING_RAIL, TripLine, WaitFigure, egp, tripDates } from "./desk-parts";
import { SelectionBar, TickAll, TickBox } from "./desk-select";

/** Rows drawn at a time; "Show 20 more" under the list reaches the rest. */
const PAGE_ROWS = 20;

type RowProps = {
  canDecide: boolean;
  claim: DeskClaim;
  onOpen: (requestId: number) => void;
  onPress: OnPress;
  /** Omitted for a reader who cannot decide: no tick is drawn. */
  onTick?: (ticked: boolean) => void;
  ticked: boolean;
};

/**
 * One waiting lane: a fixed five-column table on a desktop (nothing scrolls sideways) and a short
 * card per trip on a phone, twenty at a time, oldest first as the server sent them. Every decision
 * is made on the row; the second press of a rejection or a reduced amount opens joined to its row.
 * Several claims go in one press by ticking them (desk-select.tsx); the ticks are this lane's own
 * and are forgotten when the lane changes.
 */
export function DeskList({
  action,
  canDecide,
  claims,
  lane,
  narrowed,
  onOpen,
  onPress,
}: {
  /** The lane's own one-press action ("Approve all"), drawn in the heading. */
  action?: ReactNode;
  canDecide: boolean;
  claims: DeskClaim[];
  lane: Exclude<DeskLane, "history">;
  narrowed: boolean;
  onOpen: (requestId: number) => void;
  onPress: OnPress;
}) {
  const [shown, setShown] = useState(PAGE_ROWS);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() => new Set());
  const page = claims.slice(0, shown);
  // Read against the claims on screen, so a tick on a claim that was decided or left the lane is gone.
  const selection = selectionBatch(claims, ticked, DESK_DECISION_LIMIT);
  const tick = (requestId: number, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(requestId);
      else next.delete(requestId);
      return next;
    });
  const allTicked = page.length > 0 && page.every((claim) => ticked.has(claim.requestId));
  const row = (claim: DeskClaim) => ({
    canDecide,
    claim,
    onOpen,
    onPress,
    onTick: canDecide ? (on: boolean) => tick(claim.requestId, on) : undefined,
    ticked: ticked.has(claim.requestId),
  });
  return (
    <section aria-labelledby={`desk-tab-${lane}`} className="min-w-0 overflow-hidden border border-slate-200 bg-white" data-desk-list={lane} id={`desk-panel-${lane}`} role="tabpanel">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2">
        <h2 className="min-w-0 break-words text-sm font-black text-slate-950">
          <span aria-hidden className="mr-2 inline-block h-2 w-2 bg-orange-500 align-middle" />
          {DESK_LANE_LABEL[lane]} ({formatNumberValue(claims.length)})
          <span className="ml-2 font-semibold text-slate-500">{DESK_LANE_MEANING[lane]}</span>
        </h2>
        {claims.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            {canDecide ? <TickAll checked={allTicked} count={page.length} onChange={(on) => setTicked(on ? new Set(page.map((claim) => claim.requestId)) : new Set())} /> : null}
            {action}
          </div>
        ) : null}
      </div>
      {canDecide && selection.count > 0 ? <SelectionBar onClear={() => setTicked(new Set())} onKeep={(requestIds) => setTicked(new Set(requestIds))} onPress={onPress} selection={selection} /> : null}
      {claims.length === 0 ? (
        <CrmEmpty
          message={narrowed ? "Nothing in this lane matches the search. Clear it to see every waiting claim." : lane === "ready" ? "No claim has passed every check and is still waiting." : "Nothing unclear is waiting for you."}
          title={narrowed ? "Nothing matches" : `Nothing in ${DESK_LANE_LABEL[lane]}`}
        />
      ) : (
        <>
          <div className="divide-y divide-slate-100 md:hidden">
            {page.map((claim) => (
              <DeskCard key={claim.requestId} {...row(claim)} />
            ))}
          </div>
          <CrmTable columns={["26%", null, "8%", "14%", "25%"]}>
            <thead>
              <tr>
                <th className={crmThClassName} scope="col">Employee and trip</th>
                <th className={crmThClassName} scope="col">What the system found</th>
                <th className={crmThClassName} scope="col">Waited</th>
                <th className={cn(crmThClassName, "text-right")} scope="col">Claim</th>
                <th className={crmThClassName} scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {page.map((claim) => (
                <DeskTableRow key={claim.requestId} {...row(claim)} />
              ))}
            </tbody>
          </CrmTable>
          <CrmShowMore left={claims.length - page.length} onMore={() => setShown((current) => current + PAGE_ROWS)} page={PAGE_ROWS} />
        </>
      )}
    </section>
  );
}

function NameButton({ claim, onOpen }: { claim: DeskClaim; onOpen: (requestId: number) => void }) {
  return (
    <button
      className="min-w-0 break-words text-left text-sm font-black text-slate-950 hover:text-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
      onClick={() => onOpen(claim.requestId)}
      type="button"
    >
      <bdi dir="auto">{claim.employeeName || "Unassigned"}</bdi>
    </button>
  );
}

function DeskTableRow({ canDecide, claim, onOpen, onPress, onTick, ticked }: RowProps) {
  const [mode, setMode] = useState<DecisionMode>("idle");
  const panelId = `desk-decision-${claim.requestId}`;
  return (
    <Fragment>
      <tr className="transition-colors hover:bg-slate-50" data-request-id={claim.requestId}>
        <td className={cn(crmTdClassName, "border-l-[3px]", STANDING_RAIL[claim.standing])}>
          <div className="flex min-w-0 items-start gap-1">
            {onTick ? <TickBox checked={ticked} name={claim.employeeName} onChange={onTick} /> : null}
            <div className="min-w-0 flex-1">
              <NameButton claim={claim} onOpen={onOpen} />
              {claim.employeeRole ? <span className="block text-xs font-semibold text-slate-400">{claim.employeeRole}</span> : null}
              <TripLine claim={claim} />
            </div>
          </div>
        </td>
        <td className={crmTdClassName}>
          <FoundCell claim={claim} />
        </td>
        <td className={crmTdClassName}>
          <WaitFigure days={claim.daysWaiting} />
        </td>
        <td className={cn(crmTdClassName, "text-right")}>
          <MoneyCell claim={claim} />
        </td>
        <td className={crmTdClassName}>
          <DecisionButtons canDecide={canDecide} claim={claim} mode={mode} onMode={setMode} onOpen={() => onOpen(claim.requestId)} onPress={onPress} />
        </td>
      </tr>
      {mode !== "idle" ? (
        <TableRowDetail colSpan={5} id={panelId}>
          <DecisionPanel claim={claim} key={mode} mode={mode} onClose={() => setMode("idle")} onPress={onPress} />
        </TableRowDetail>
      ) : null}
    </Fragment>
  );
}

/**
 * The phone card: who and how much, the trip in one line, the one reason, the buttons. About 140px
 * for a Ready claim — twenty trips in three and a half screens, where the old page showed nine.
 */
function DeskCard({ canDecide, claim, onOpen, onPress, onTick, ticked }: RowProps) {
  const [mode, setMode] = useState<DecisionMode>("idle");
  return (
    <article className={cn("min-w-0 border-l-[3px] bg-white px-3 py-2.5", STANDING_RAIL[claim.standing])} data-request-id={claim.requestId}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-1">
          {onTick ? <TickBox checked={ticked} name={claim.employeeName} onChange={onTick} /> : null}
          <NameButton claim={claim} onOpen={onOpen} />
        </div>
        <span className="shrink-0 text-right text-sm font-black tabular-nums text-slate-950">{egp(claim.total)}</span>
      </div>
      <p className="mt-0.5 min-w-0 break-words text-xs font-semibold text-slate-500">
        {tripDates(claim)} · <bdi dir="auto">{displayPlace(claim.to)}</bdi> · <span className={claim.daysWaiting > 7 ? "font-black text-orange-700" : undefined}>waited {waitLabel(claim.daysWaiting).toLowerCase()}</span>
      </p>
      {claim.verdict.lane === "your_call" || claim.holdReason ? (
        <div className="mt-1 min-w-0">
          <FoundCell claim={claim} />
        </div>
      ) : null}
      <div className="mt-2 min-w-0">
        <DecisionButtons canDecide={canDecide} claim={claim} mode={mode} onMode={setMode} onOpen={() => onOpen(claim.requestId)} onPress={onPress} size="regular" />
      </div>
      {mode !== "idle" ? (
        <div className="mt-2 min-w-0">
          <DecisionPanel claim={claim} key={mode} mode={mode} onClose={() => setMode("idle")} onPress={onPress} />
        </div>
      ) : null}
    </article>
  );
}
