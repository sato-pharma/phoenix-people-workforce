"use client";

/**
 * Phoenix CRM — one list request, as the rep who asked and the people who decide see it.
 *
 * Owner, 2026-09-16: a grade change is proposed by the rep and decided by the district manager. The
 * system never decides one, and refusing needs a note, because the rep reads why.
 *
 * Owner, 2026-09-29 (the rep's flow rebuilt): dropping a customer, adding one met outside the list and
 * bringing one back from the Archive take TWO steps — the district manager, then SFE — and the card
 * says which step a waiting request is on. At the district manager's step of an ADD he confirms or
 * changes the A/B/C grade (the one frequency uses) and sets the customer's potential (AA to BC), which
 * is stored and shown and changes nothing else. A refusal at either step is final.
 *
 * Who may decide is the SERVER's answer (`request.canDecide`, from `canDecideListRequest`): the card
 * offers Approve and Refuse only where the surface allows deciding AND the viewer decides the step the
 * request is on — the district manager at the first step, the SFE Manager at the second.
 */

import { useId, useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { cairoStamp } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import { AdministratorDecline, AdministratorStepNote } from "@/components/phoenix-crm/administrator-decline";
import { CrmButton, CrmCard, CrmCheck, CrmChoice, CrmField, CrmNote, CrmPill, crmTextareaClassName, type PillTone } from "@/components/phoenix-crm/ui";
import { DROP_REASON_MAX, POTENTIAL_GRADES, type PotentialGrade } from "@/lib/phoenix-crm/entry-rules";
import {
  isTwoStepKind,
  RETURN_NOTE_MAX,
  RETURN_NOTE_REQUIRED,
  RETURN_REPLY_REQUIRED,
  requestStageLabel,
  sameNameOnSeatText,
  setsAdmissionGrades,
} from "@/lib/phoenix-crm/list-request-rules";
import type { PhoenixCrmGrade, PhoenixCrmRequestStatus } from "@/lib/phoenix-crm/types";
import type { ListRequest } from "@/lib/phoenix-crm/view-types";

const GRADES: readonly PhoenixCrmGrade[] = ["A", "B", "C"];

const STATUS: Record<PhoenixCrmRequestStatus, { label: string; tone: PillTone; accent: string }> = {
  pending: { label: "Waiting for a decision", tone: "warn", accent: "border-l-amber-500" },
  approved: { label: "Approved", tone: "good", accent: "border-l-emerald-500" },
  refused: { label: "Refused", tone: "bad", accent: "border-l-rose-500" },
  withdrawn: { label: "Withdrawn", tone: "neutral", accent: "border-l-slate-300" },
};

/** Answers that mean the request moved on under the card — someone else decided it, or its step. */
const MOVED_ON = new Set(["phoenix_crm_request_decided", "phoenix_crm_request_wrong_stage"]);

type DecideResult = {
  requestId: string;
  status: "approved" | "refused" | "pending";
  stage: "manager" | "sfe" | null;
  final: boolean;
};

/** What the request asks for, in one line. */
export function requestSubject(request: Pick<ListRequest, "kind" | "currentGrade" | "proposedGrade" | "dropReasonLabel">): string {
  if (request.kind === "drop") return `Leave the list · ${request.dropReasonLabel ?? "Reason not given"}`;
  if (request.kind === "add") return `Add to the list · Grade ${request.proposedGrade ?? "—"} proposed`;
  if (request.kind === "restore") return "Bring back to the list from the Archive";
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

/**
 * The pill a request wears: while it waits, the step it is on ("Waiting for the district manager",
 * "Waiting for SFE") — a grade change is the district manager's one step; once decided, the outcome.
 */
function statusPill(request: ListRequest): { label: string; tone: PillTone } {
  if (request.status !== "pending") return STATUS[request.status];
  return { label: request.stageLabel ?? requestStageLabel("manager") ?? STATUS.pending.label, tone: STATUS.pending.tone };
}

/**
 * Whether the request's last decision was taken at the district manager's step. A two-step request
 * refused there carries the same person and moment in both its manager and its final columns, and is
 * said once, not twice.
 */
function decidedAtManagerStep(request: ListRequest): boolean {
  return request.managerDecision !== null && request.decidedAt !== null && request.managerDecision.at === request.decidedAt;
}

function decisionLine(request: ListRequest): string | null {
  if (request.status === "pending" || !request.decidedAt) return null;
  if (request.status === "withdrawn") return `Withdrawn · ${cairoStamp(request.decidedAt)}`;
  const who = request.decidedByName ? ` by ${request.decidedByName}` : "";
  const step = isTwoStepKind(request.kind) ? (decidedAtManagerStep(request) ? "District manager's step" : "SFE's step") : null;
  return `${step ? `${step}: ` : ""}${STATUS[request.status].label}${who} · ${cairoStamp(request.decidedAt)}`;
}

/** The district manager's step of a two-step request, once it moved on to SFE. */
function managerStepLine(request: ListRequest): string | null {
  if (!request.managerDecision || decidedAtManagerStep(request)) return null;
  return `District manager's step: approved by ${request.managerDecision.byName} · ${cairoStamp(request.managerDecision.at)}`;
}

/** An add the district manager approved: the grade he confirmed and the potential he set. */
function admissionLine(request: ListRequest): string | null {
  if (request.kind !== "add" || (request.approvedGrade === null && request.potentialGrade === null)) return null;
  return [
    request.approvedGrade ? `Grade ${request.approvedGrade} confirmed` : null,
    request.potentialGrade ? `potential ${request.potentialGrade}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function RequestCard({
  canDecide,
  canOverride = false,
  canWithdraw,
  onChanged,
  request,
  seatId,
  selection,
  territoryName,
  test,
}: {
  /** The surface allows deciding here; the card still decides only where `request.canDecide` is true. */
  canDecide: boolean;
  /** The Administrator may decline it (never counted as waiting for him). Only the Team tab passes it. */
  canOverride?: boolean;
  /** The viewer is the territory's rep: withdraw a waiting request. */
  canWithdraw: boolean;
  /** A decision or a withdrawal saved; the owner of the list reloads it. */
  onChanged: (message: string) => void;
  request: ListRequest;
  seatId: string;
  /** The Team tab's bulk drop: a tick box on a drop waiting at the viewer's step. Absent everywhere else. */
  selection?: { checked: boolean; disabled: boolean; onChange: (next: boolean) => void };
  /** Shown on the Team tab, where requests from several territories sit together. */
  territoryName?: string | null;
  test: boolean;
}) {
  const fieldId = useId();
  const [note, setNote] = useState("");
  const [grade, setGrade] = useState<PhoenixCrmGrade | null>(request.proposedGrade);
  const [potential, setPotential] = useState<PotentialGrade | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState<"approve" | "refuse" | "withdraw" | "return" | "reply" | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pill = statusPill(request);
  const pending = request.status === "pending";
  const decides = pending && canDecide && request.canDecide;
  // The Administrator takes the step the request is AT, in place of whoever holds it (owner, 2026-10-14),
  // with the same buttons. A request with the rep waits for the rep's comment, so there is nothing to approve.
  const administratorDecides = pending && canOverride && !decides && !request.withRep && request.stage !== null;
  const deciding = decides || administratorDecides;
  // SFE's step of an add or a bring-back waits while the customer's place is on Place checks. The server
  // says so and refuses the approval, so the card shows why and offers only Refuse (System Audit,
  // 2026-10-31: seventeen presses refused from 25 to 29 Oct). Only an approver ever receives it.
  const heldOnPlaceChecks = request.placeCheckHold;
  // Who grades an add: the district manager at his step, and SFE where the territory has no manager at
  // all (one pure rule, `setsAdmissionGrades`, so the card can never differ from what the server takes).
  const admitting =
    deciding &&
    !heldOnPlaceChecks &&
    setsAdmissionGrades({ kind: request.kind, stage: request.stage, managerDecidedAt: request.managerDecision?.at ?? null });
  // Said plainly on the card, because SFE is doing somebody else's job here and should know why.
  const admittingForVacantSeat = decides && admitting && request.stage === "sfe";
  const decided = decisionLine(request);
  const managerStep = managerStepLine(request);
  const admission = admissionLine(request);
  const noteId = `${fieldId}-note`;
  const replyId = `${fieldId}-reply`;
  // SFE may send the step it holds back to the rep; the rep, whose request it is, answers it (2026-10-12).
  const canReturn = decides && request.canReturn;
  const answering = pending && request.withRep && canWithdraw;

  async function decide(decision: "approve" | "refuse") {
    const trimmed = note.trim();
    if (decision === "refuse" && !trimmed) {
      setProblem("Write a note for the rep explaining why.");
      return;
    }
    if (decision === "approve" && admitting && !grade) {
      setProblem("Choose the customer's grade (A, B or C) before approving.");
      return;
    }
    if (decision === "approve" && admitting && !potential) {
      setProblem("Choose the customer's potential (AA to BC) before approving.");
      return;
    }
    setBusy(decision);
    setProblem(null);
    try {
      const result = await crmPost<DecideResult>(
        "/api/phoenix-crm/list/requests/decide",
        {
          requestId: request.requestId,
          decision,
          note: trimmed || null,
          // The step this card was showing: if someone else moved the request on meanwhile, the
          // database refuses rather than deciding a step nobody on this screen saw.
          stage: request.stage,
          approvedGrade: admitting && decision === "approve" ? grade : null,
          potentialGrade: admitting && decision === "approve" ? potential : null,
        },
        "request",
      );
      if (result.status === "pending") {
        onChanged(`Approved — now waiting for SFE: ${request.customerName}.`);
      } else {
        onChanged(`${result.status === "approved" ? "Approved" : "Refused"}: ${request.customerName}.`);
      }
    } catch (error) {
      setProblem(messageOf(error));
      const code = errorCodeOf(error);
      if (code && MOVED_ON.has(code)) {
        onChanged(
          code === "phoenix_crm_request_wrong_stage"
            ? `${request.customerName}: this request has moved on to the next step.`
            : `${request.customerName}: this request was already decided.`,
        );
      }
    } finally {
      setBusy(null);
    }
  }

  async function returnForComment() {
    const trimmed = note.trim();
    if (!trimmed) {
      setProblem(RETURN_NOTE_REQUIRED);
      return;
    }
    setBusy("return");
    setProblem(null);
    try {
      await crmPost("/api/phoenix-crm/list/requests/return", { requestId: request.requestId, note: trimmed }, "request");
      onChanged(`Returned to ${request.requestedByName} for a comment: ${request.customerName}.`);
    } catch (error) {
      setProblem(messageOf(error));
      const code = errorCodeOf(error);
      if (code && MOVED_ON.has(code)) onChanged(`${request.customerName}: this request has moved on.`);
    } finally {
      setBusy(null);
    }
  }

  async function answer() {
    const trimmed = reply.trim();
    if (!trimmed) {
      setProblem(RETURN_REPLY_REQUIRED);
      return;
    }
    setBusy("reply");
    setProblem(null);
    try {
      await crmPost("/api/phoenix-crm/list/requests/answer", { requestId: request.requestId, reply: trimmed, seatId, test }, "request");
      onChanged(`Comment sent to SFE: ${request.customerName}.`);
    } catch (error) {
      setProblem(messageOf(error));
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

  // The last decision's note is the SFE's on a two-step request that reached SFE, the district
  // manager's otherwise.
  const decisionNoteLabel =
    request.status === "withdrawn" ? "Note: " : isTwoStepKind(request.kind) && !decidedAtManagerStep(request) ? "SFE's note: " : "Manager's note: ";

  return (
    <CrmCard
      accent={STATUS[request.status].accent}
      meta={[listText(request.listType), territoryName].filter(Boolean).join(" · ")}
      status={<CrmPill tone={pill.tone}>{pill.label}</CrmPill>}
      title={request.customerName}
    >
      <div className="grid min-w-0 gap-1.5 text-sm leading-6">
        {selection ? (
          <CrmCheck checked={selection.checked} disabled={selection.disabled} onChange={selection.onChange}>
            Select to drop with the others
          </CrmCheck>
        ) : null}
        <p className="break-words text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{request.kindLabel}</p>
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
        {request.returnNote ? (
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">
              {request.returnedByName ? `${request.returnedByName} asked: ` : "SFE asked: "}
            </span>
            {request.returnNote}
          </p>
        ) : null}
        {request.repReply ? (
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">Rep&apos;s comment: </span>
            {request.repReply}
          </p>
        ) : null}
        {managerStep ? <p className="break-words text-xs font-semibold text-slate-500">{managerStep}</p> : null}
        {managerStep && request.managerDecision?.note ? (
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">District manager&apos;s note: </span>
            {request.managerDecision.note}
          </p>
        ) : null}
        {admission ? <p className="break-words text-xs font-bold text-slate-700">{admission}</p> : null}
        {decided ? <p className="break-words text-xs font-semibold text-slate-500">{decided}</p> : null}
        {request.decisionNote ? (
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">{decisionNoteLabel}</span>
            {request.decisionNote}
          </p>
        ) : null}
      </div>

      {deciding ? (
        <div className="mt-3 grid min-w-0 gap-3 border-t border-slate-100 pt-3">
          {administratorDecides ? <AdministratorStepNote holder={request.stage === "sfe" ? "SFE" : "the district manager"} /> : null}
          {admitting ? (
            <>
              {admittingForVacantSeat ? (
                <CrmNote tone="info">
                  This territory has no district manager, so the grading is yours: confirm or change the grade, and set the potential.
                </CrmNote>
              ) : null}
              <CrmField hint="The grade the customer's visits are planned and counted by. The rep proposed it; confirm it or change it." label="Grade">
                <CrmChoice
                  columns={3}
                  label="Grade"
                  onChange={(next) => {
                    setGrade(next);
                    setProblem(null);
                  }}
                  options={GRADES.map((option) => ({
                    value: option,
                    label: `Grade ${option}`,
                    note: option === request.proposedGrade ? "Proposed" : undefined,
                    disabled: busy !== null,
                  }))}
                  value={grade}
                />
              </CrmField>
              <CrmField
                hint="Needed to approve. It is shown on the customer and changes nothing else — visits, targets and every figure follow the A/B/C grade."
                label="Potential"
              >
                <CrmChoice
                  columns={3}
                  label="Potential"
                  onChange={(next) => {
                    setPotential(next);
                    setProblem(null);
                  }}
                  options={POTENTIAL_GRADES.map((option) => ({ value: option, label: option, disabled: busy !== null }))}
                  value={potential}
                />
              </CrmField>
            </>
          ) : null}
          <CrmField hint={canReturn ? "Needed to refuse, or to return it to the rep for a comment. The rep reads it." : "Needed to refuse. The rep reads it."} htmlFor={noteId} label="Note for the rep">
            <textarea
              className={crmTextareaClassName}
              disabled={busy !== null}
              id={noteId}
              maxLength={canReturn ? RETURN_NOTE_MAX : DROP_REASON_MAX}
              onChange={(event) => {
                setNote(event.target.value);
                setProblem(null);
              }}
              rows={2}
              value={note}
            />
          </CrmField>
          {heldOnPlaceChecks ? <CrmNote tone="warn">{heldOnPlaceChecks}</CrmNote> : null}
          {request.sameNameOnSeat && request.sameNameOnSeat.length > 0 ? (
            <CrmNote title="The same name is on this territory already" tone="warn">
              {sameNameOnSeatText(request.sameNameOnSeat)}
            </CrmNote>
          ) : null}
          {request.stage === "manager" ? (
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">Approving hands it to SFE, who decides the last step. Refusing ends it.</p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {heldOnPlaceChecks ? null : (
              <CrmButton busy={busy === "approve"} disabled={busy !== null} onClick={() => void decide("approve")} variant="success">
                Approve
              </CrmButton>
            )}
            <CrmButton busy={busy === "refuse"} disabled={busy !== null} onClick={() => void decide("refuse")} variant="danger">
              Refuse
            </CrmButton>
            {canReturn ? (
              <CrmButton busy={busy === "return"} disabled={busy !== null} onClick={() => void returnForComment()}>
                Return for comment
              </CrmButton>
            ) : null}
          </div>
        </div>
      ) : null}

      {answering ? (
        <div className="mt-3 grid min-w-0 gap-3 border-t border-slate-100 pt-3">
          <CrmField hint="SFE asked you to explain. Your comment goes straight back to SFE." htmlFor={replyId} label="Your comment">
            <textarea
              className={crmTextareaClassName}
              disabled={busy !== null}
              id={replyId}
              maxLength={RETURN_NOTE_MAX}
              onChange={(event) => {
                setReply(event.target.value);
                setProblem(null);
              }}
              rows={3}
              value={reply}
            />
          </CrmField>
          <div className="flex flex-wrap gap-2">
            <CrmButton busy={busy === "reply"} disabled={busy !== null} onClick={() => void answer()} variant="success">
              Send the comment
            </CrmButton>
          </div>
        </div>
      ) : null}

      {pending && canOverride && !deciding ? (
        <AdministratorDecline
          hint="The rep reads it."
          onSubmit={async (comment) => {
            await crmPost<DecideResult>(
              "/api/phoenix-crm/list/requests/decide",
              { requestId: request.requestId, decision: "refuse", note: comment, stage: request.stage },
              "request",
            );
            onChanged(`Declined by the Administrator: ${request.customerName}.`);
          }}
          verb="Decline"
        />
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
