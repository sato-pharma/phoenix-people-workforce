"use client";

/**
 * Phoenix CRM — one grade or drop request, as the rep who asked and the manager who decides see it.
 *
 * Owner, 2026-09-16: a new customer's grade and a grade change are proposed by the rep and approved by
 * the district manager; leaving the list needs a reason and the district manager's approval. The system
 * never decides one. Refusing needs a note, because the rep reads why.
 */

import { useId, useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { cairoStamp } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import { CrmButton, CrmCard, CrmField, CrmNote, CrmPill, crmTextareaClassName, type PillTone } from "@/components/phoenix-crm/ui";
import { DROP_REASON_MAX } from "@/lib/phoenix-crm/entry-rules";
import type { PhoenixCrmRequestStatus } from "@/lib/phoenix-crm/types";
import type { ListRequest } from "@/lib/phoenix-crm/view-types";

const STATUS: Record<PhoenixCrmRequestStatus, { label: string; tone: PillTone; accent: string }> = {
  pending: { label: "Waiting for a decision", tone: "warn", accent: "border-l-amber-500" },
  approved: { label: "Approved", tone: "good", accent: "border-l-emerald-500" },
  refused: { label: "Refused", tone: "bad", accent: "border-l-rose-500" },
  withdrawn: { label: "Withdrawn", tone: "neutral", accent: "border-l-slate-300" },
};

/** What the request asks for, in one line. */
export function requestSubject(request: Pick<ListRequest, "kind" | "currentGrade" | "proposedGrade" | "dropReasonLabel">): string {
  if (request.kind === "drop") return `Leave the list · ${request.dropReasonLabel ?? "Reason not given"}`;
  if (request.currentGrade === null) return `Grade ${request.proposedGrade ?? "—"} proposed · no grade yet`;
  return `Grade change · ${request.currentGrade} to ${request.proposedGrade ?? "—"}`;
}

/** Pending first (oldest waiting longest on top), then the decided ones, newest first. */
export function sortRequests<T extends Pick<ListRequest, "status" | "requestedAt" | "decidedAt">>(requests: ReadonlyArray<T>): T[] {
  return [...requests].sort((left, right) => {
    const leftPending = left.status === "pending";
    const rightPending = right.status === "pending";
    if (leftPending !== rightPending) return leftPending ? -1 : 1;
    if (leftPending) return left.requestedAt.localeCompare(right.requestedAt);
    return (right.decidedAt ?? right.requestedAt).localeCompare(left.decidedAt ?? left.requestedAt);
  });
}

function decisionLine(request: ListRequest): string | null {
  if (request.status === "pending" || !request.decidedAt) return null;
  if (request.status === "withdrawn") return `Withdrawn · ${cairoStamp(request.decidedAt)}`;
  const who = request.decidedByName ? ` by ${request.decidedByName}` : "";
  return `${STATUS[request.status].label}${who} · ${cairoStamp(request.decidedAt)}`;
}

export function RequestCard({
  canDecide,
  canWithdraw,
  onChanged,
  request,
  seatId,
  territoryName,
  test,
}: {
  /** The viewer reviews this territory: approve or refuse. */
  canDecide: boolean;
  /** The viewer is the territory's rep: withdraw a waiting request. */
  canWithdraw: boolean;
  /** A decision or a withdrawal saved; the owner of the list reloads it. */
  onChanged: (message: string) => void;
  request: ListRequest;
  seatId: string;
  /** Shown on the Team tab, where requests from several territories sit together. */
  territoryName?: string | null;
  test: boolean;
}) {
  const fieldId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "refuse" | "withdraw" | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const status = STATUS[request.status];
  const pending = request.status === "pending";
  const decided = decisionLine(request);
  const noteId = `${fieldId}-note`;

  async function decide(decision: "approve" | "refuse") {
    const trimmed = note.trim();
    if (decision === "refuse" && !trimmed) {
      setProblem("Write a note for the rep explaining why.");
      return;
    }
    setBusy(decision);
    setProblem(null);
    try {
      await crmPost("/api/phoenix-crm/list/requests/decide", { requestId: request.requestId, decision, note: trimmed || null }, "request");
      onChanged(`${decision === "approve" ? "Approved" : "Refused"}: ${request.customerName}.`);
    } catch (error) {
      setProblem(messageOf(error));
      if (errorCodeOf(error) === "phoenix_crm_request_decided") onChanged(`${request.customerName}: this request was already decided.`);
    } finally {
      setBusy(null);
    }
  }

  async function withdraw() {
    setBusy("withdraw");
    setProblem(null);
    try {
      await crmPost("/api/phoenix-crm/list/requests/withdraw", { requestId: request.requestId, seatId, test }, "request");
      onChanged(`Request withdrawn: ${request.customerName}.`);
    } catch (error) {
      setProblem(messageOf(error));
      if (errorCodeOf(error) === "phoenix_crm_request_decided") onChanged(`${request.customerName}: this request was already decided.`);
    } finally {
      setBusy(null);
      setConfirmWithdraw(false);
    }
  }

  return (
    <CrmCard
      accent={status.accent}
      meta={[listText(request.listType), territoryName].filter(Boolean).join(" · ")}
      status={<CrmPill tone={status.tone}>{status.label}</CrmPill>}
      title={request.customerName}
    >
      <div className="grid min-w-0 gap-1.5 text-sm leading-6">
        <p className="break-words font-black text-slate-900">{requestSubject(request)}</p>
        {request.note ? (
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">Rep&apos;s note: </span>
            {request.note}
          </p>
        ) : null}
        <p className="break-words text-xs font-semibold text-slate-500">
          Asked by {request.requestedByName} · {cairoStamp(request.requestedAt)}
        </p>
        {decided ? <p className="break-words text-xs font-semibold text-slate-500">{decided}</p> : null}
        {request.decisionNote ? (
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">{request.status === "withdrawn" ? "Note: " : "Manager's note: "}</span>
            {request.decisionNote}
          </p>
        ) : null}
      </div>

      {pending && canDecide ? (
        <div className="mt-3 grid min-w-0 gap-2 border-t border-slate-100 pt-3">
          <CrmField hint="Needed to refuse. The rep reads it." htmlFor={noteId} label="Note for the rep">
            <textarea
              className={crmTextareaClassName}
              disabled={busy !== null}
              id={noteId}
              maxLength={DROP_REASON_MAX}
              onChange={(event) => {
                setNote(event.target.value);
                setProblem(null);
              }}
              rows={2}
              value={note}
            />
          </CrmField>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <CrmButton busy={busy === "approve"} disabled={busy !== null} onClick={() => void decide("approve")} variant="success">
              Approve
            </CrmButton>
            <CrmButton busy={busy === "refuse"} disabled={busy !== null} onClick={() => void decide("refuse")} variant="danger">
              Refuse
            </CrmButton>
          </div>
        </div>
      ) : null}

      {pending && canWithdraw ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          {confirmWithdraw ? (
            <>
              <span className="text-sm font-bold text-slate-700">Withdraw this request?</span>
              <CrmButton busy={busy === "withdraw"} disabled={busy !== null} onClick={() => void withdraw()} size="sm" variant="danger">
                Withdraw
              </CrmButton>
              <CrmButton disabled={busy !== null} onClick={() => setConfirmWithdraw(false)} size="sm">
                Keep it
              </CrmButton>
            </>
          ) : (
            <CrmButton disabled={busy !== null} onClick={() => setConfirmWithdraw(true)} size="sm">
              Withdraw the request
            </CrmButton>
          )}
        </div>
      ) : null}

      {problem ? (
        <CrmNote className="mt-3" tone="bad">
          {problem}
        </CrmNote>
      ) : null}
    </CrmCard>
  );
}
