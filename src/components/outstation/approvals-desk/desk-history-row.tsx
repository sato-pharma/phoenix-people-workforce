"use client";

import { Fragment, useState } from "react";

import { crmTdClassName } from "@/components/phoenix-crm/ui";
import { TableRowDetail } from "@/components/ui/table-row-detail";
import { formatDateValue } from "@/lib/i18n/format";
import type { DeskClaim } from "@/lib/outstation/approvals/types";
import { displayPlace } from "@/lib/outstation/place-label";
import { cn } from "@/lib/utils";

import { type DecisionMode, DecisionButtons, DecisionPanel, type OnPress } from "./desk-decision";
import { MoneyCell, STANDING_RAIL, StandingPill, TripLine, kindNote, tripDates } from "./desk-parts";

/**
 * One decided claim in History: a table row on a desktop, a card on a phone.
 *
 * Owner, 23 Nov 2026 (about 21:05 Cairo): "make me able to reject even if approved in history. Make
 * me easily able to approve or reject." So a decided claim is changed ON its row, without opening
 * it: Reject on an approved claim no payroll has taken (then its reason, joined to the row), or
 * Approve on a rejected one, naming the full amount. The buttons are the desk's own
 * (`DecisionButtons`), so there is still one way to decide; which button a claim gets, if any, is
 * decided in `decided-change.ts`. A claim a payroll took, or whose payroll already ran, draws Open
 * alone, and its opened trip says why.
 *
 * A row inside a press draws no decision button until the press is answered: six seconds of Undo,
 * then the save. History reads itself again when it is.
 */

export type HistoryRowProps = {
  canDecide: boolean;
  claim: DeskClaim;
  onOpen: (requestId: number) => void;
  onPress: OnPress;
  /** This claim is inside a press right now. */
  pressed: boolean;
};

function ReasonText({ claim }: { claim: DeskClaim }) {
  if (!claim.hrComment) return <span className="text-slate-400">—</span>;
  return (
    <bdi className="block min-w-0 break-words text-sm font-medium leading-5 text-slate-700" dir="auto">
      {claim.hrComment}
    </bdi>
  );
}

function RowDecision({
  canDecide,
  claim,
  mode,
  onMode,
  onOpen,
  onPress,
  pressed,
  size,
}: HistoryRowProps & { mode: DecisionMode; onMode: (mode: DecisionMode) => void; size: "dense" | "regular" }) {
  return (
    <>
      <DecisionButtons canDecide={canDecide && !pressed} claim={claim} mode={mode} onMode={onMode} onOpen={() => onOpen(claim.requestId)} onPress={onPress} size={size} />
      {pressed ? (
        <p className="mt-1 min-w-0 break-words text-xs font-bold text-slate-600" data-history-pressed>
          Your decision is being saved.
        </p>
      ) : null}
    </>
  );
}

export function HistoryTableRow(props: HistoryRowProps) {
  const { claim, onPress, pressed } = props;
  const [mode, setMode] = useState<DecisionMode>("idle");
  const panelId = `desk-history-decision-${claim.requestId}`;
  return (
    <Fragment>
      <tr className="transition-colors hover:bg-slate-50" data-request-id={claim.requestId}>
        <td className={cn(crmTdClassName, "border-l-[3px]", STANDING_RAIL[claim.standing])}>
          <span className="block break-words text-sm font-black text-slate-950">
            <bdi dir="auto">{claim.employeeName || "Unassigned"}</bdi>
          </span>
          <TripLine claim={claim} />
        </td>
        <td className={crmTdClassName}>
          <StandingPill standing={claim.standing} />
          {claim.decidedAt ? <span className="mt-1 block text-xs font-semibold text-slate-500">Decided {formatDateValue(claim.decidedAt, null, { year: undefined })}</span> : null}
        </td>
        <td className={crmTdClassName}>
          <ReasonText claim={claim} />
        </td>
        <td className={cn(crmTdClassName, "text-right")}>
          <MoneyCell claim={claim} />
        </td>
        <td className={crmTdClassName}>
          <RowDecision {...props} mode={mode} onMode={setMode} size="dense" />
        </td>
      </tr>
      {mode !== "idle" && !pressed ? (
        <TableRowDetail colSpan={5} id={panelId}>
          <DecisionPanel claim={claim} key={mode} mode={mode} onClose={() => setMode("idle")} onPress={onPress} size="dense" />
        </TableRowDetail>
      ) : null}
    </Fragment>
  );
}

export function HistoryCard(props: HistoryRowProps) {
  const { claim, onPress, pressed } = props;
  const [mode, setMode] = useState<DecisionMode>("idle");
  return (
    <article className={cn("min-w-0 border-l-[3px] bg-white px-3 py-2.5", STANDING_RAIL[claim.standing])} data-request-id={claim.requestId}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0 break-words text-sm font-black text-slate-950">
          <bdi dir="auto">{claim.employeeName || "Unassigned"}</bdi>
        </span>
        <span className="shrink-0 text-right">
          <MoneyCell claim={claim} />
        </span>
      </div>
      <p className="mt-0.5 min-w-0 break-words text-xs font-semibold text-slate-500">
        {tripDates(claim)}
        {kindNote(claim) ? ` · ${kindNote(claim)}` : ""} · <bdi dir="auto">{displayPlace(claim.to)}</bdi>
      </p>
      <div className="mt-1.5 min-w-0">
        <StandingPill standing={claim.standing} />
      </div>
      {claim.hrComment ? (
        <div className="mt-1.5">
          <ReasonText claim={claim} />
        </div>
      ) : null}
      <div className="mt-2 min-w-0">
        <RowDecision {...props} mode={mode} onMode={setMode} size="regular" />
      </div>
      {mode !== "idle" && !pressed ? (
        <div className="mt-2 min-w-0">
          <DecisionPanel claim={claim} key={mode} mode={mode} onClose={() => setMode("idle")} onPress={onPress} />
        </div>
      ) : null}
    </article>
  );
}
