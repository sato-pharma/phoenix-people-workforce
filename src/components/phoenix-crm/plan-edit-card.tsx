"use client";

/**
 * Phoenix CRM — one rep's request to edit a week he already sent, as each step sees it.
 *
 * Owner, 2026-10-01: a sent week is no longer taken back by the rep. He asks — one button, no reason —
 * and the request runs: his district manager APPROVES, then SFE APPROVES, then HR (Omar Gawish)
 * ACKNOWLEDGES, and only that acknowledgement opens the week again. A refusal at the manager's step or
 * SFE's ends it and needs a note, because the rep reads why. HR acknowledges; it never approves or
 * refuses.
 *
 * "Open the week" shows the plan as it was sent, so a step is never taken without looking at it.
 */

import { useId, useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { cairoStamp } from "@/components/phoenix-crm/format";
import { CrmButton, CrmCard, CrmField, CrmNote, CrmPill, crmTextareaClassName, type PillTone } from "@/components/phoenix-crm/ui";
import { PLAN_EDIT_NOTE_MAX, type PlanEditStatus } from "@/lib/phoenix-crm/plan-edit-rules";
import type { TeamPlanEdit } from "@/lib/phoenix-crm/view-types";

const STATUS: Record<PlanEditStatus, { tone: PillTone; accent: string }> = {
  manager_pending: { tone: "warn", accent: "border-l-amber-500" },
  sfe_pending: { tone: "warn", accent: "border-l-amber-500" },
  hr_pending: { tone: "warn", accent: "border-l-amber-500" },
  reopened: { tone: "good", accent: "border-l-emerald-500" },
  refused: { tone: "bad", accent: "border-l-rose-500" },
  expired: { tone: "neutral", accent: "border-l-slate-300" },
};

/** The button that moves the request one step on, in words that say where it goes. */
function approveLabel(status: PlanEditStatus): string {
  if (status === "manager_pending") return "Approve · goes to SFE";
  if (status === "sfe_pending") return "Approve · goes to HR";
  return "Acknowledge · opens the week";
}

export function PlanEditCard({
  edit,
  onChanged,
  onOpenWeek,
}: {
  edit: TeamPlanEdit;
  /** A step saved; the Team tab reads its counts again. */
  onChanged: (message: string) => void;
  /** The week as it was sent, on the plan board. */
  onOpenWeek: () => void;
}) {
  const fieldId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "refuse" | "acknowledge" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const status = STATUS[edit.status];
  const noteId = `${fieldId}-note`;
  const hrStep = edit.status === "hr_pending";

  async function decide(decision: "approve" | "refuse" | "acknowledge") {
    const trimmed = note.trim();
    if (decision === "refuse" && !trimmed) {
      setProblem("Write a note for the rep explaining why.");
      return;
    }
    setBusy(decision);
    setProblem(null);
    try {
      await crmPost(
        "/api/phoenix-crm/plans/edit-requests/decide",
        { requestId: edit.requestId, decision, note: trimmed || null, expectedVersion: edit.version },
        "plan",
      );
      onChanged(
        decision === "refuse"
          ? `Refused: ${edit.repName}'s request to edit a weekly plan.`
          : decision === "acknowledge"
            ? `Acknowledged: ${edit.repName}'s week is open again for him to change.`
            : `Approved: ${edit.repName}'s request to edit a weekly plan.`,
      );
    } catch (error) {
      setProblem(messageOf(error));
      const code = errorCodeOf(error);
      if (code === "phoenix_crm_plan_edit_decided" || code === "phoenix_crm_plan_edit_wrong_stage") {
        onChanged(`${edit.repName}: this request has already moved on.`);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <CrmCard
      accent={status.accent}
      meta={[edit.weekLabel, edit.territoryName].join(" · ")}
      status={<CrmPill tone={status.tone}>{edit.statusLabel}</CrmPill>}
      title={edit.repName}
    >
      <div className="grid min-w-0 gap-1.5 text-sm leading-6">
        <p className="break-words font-medium text-slate-700">
          Asks to edit his plan for this week, which is already sent. Asked {cairoStamp(edit.raisedAt)}.
        </p>
        <p className="break-words text-xs font-semibold text-slate-600">The week now: {edit.planStatusLabel}</p>
        {/* The steps already passed. Each step reads who already said yes before saying it too. */}
        {edit.managerDecidedByName ? (
          <p className="break-words text-xs font-semibold text-slate-600">
            District manager approved: {edit.managerDecidedByName}
            {edit.managerNote ? ` · ${edit.managerNote}` : ""}
          </p>
        ) : null}
        {edit.sfeDecidedByName ? (
          <p className="break-words text-xs font-semibold text-slate-600">
            SFE approved: {edit.sfeDecidedByName}
            {edit.sfeNote ? ` · ${edit.sfeNote}` : ""}
          </p>
        ) : null}
        <p className="break-words text-xs font-semibold text-slate-500">
          The district manager decides first, then SFE, then HR acknowledges. The week opens again only after HR.
        </p>
      </div>

      <div className="mt-3 grid min-w-0 gap-2">
        {edit.canDecide && !hrStep ? (
          <CrmField hint="Needed to refuse. The rep reads it." htmlFor={noteId} label="Note for the rep">
            <textarea
              className={crmTextareaClassName}
              disabled={busy !== null}
              id={noteId}
              maxLength={PLAN_EDIT_NOTE_MAX}
              onChange={(event) => {
                setProblem(null);
                setNote(event.target.value);
              }}
              rows={2}
              value={note}
            />
          </CrmField>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {edit.canDecide ? (
            <CrmButton disabled={busy !== null} onClick={() => void decide(hrStep ? "acknowledge" : "approve")} variant="primary">
              {busy === "approve" || busy === "acknowledge" ? "Saving…" : approveLabel(edit.status)}
            </CrmButton>
          ) : null}
          {edit.canDecide && !hrStep ? (
            <CrmButton disabled={busy !== null} onClick={() => void decide("refuse")}>
              {busy === "refuse" ? "Refusing…" : "Refuse"}
            </CrmButton>
          ) : null}
          <CrmButton disabled={busy !== null} onClick={onOpenWeek}>
            Open the week
          </CrmButton>
        </div>
        {problem ? (
          <CrmNote tone="bad" title="The decision was not saved">
            {problem}
          </CrmNote>
        ) : null}
      </div>
    </CrmCard>
  );
}
