"use client";

/**
 * Phoenix CRM — one off-plan visit, as the manager and then the SFE see it.
 *
 * Owner, 2026-09-26: a rep may visit a doctor who is not on today's plan, but he writes why, and the
 * visit counts in NOTHING until his direct manager approves it and then the SFE does. One refusal at
 * either step ends it, and a refusal needs a note, because the rep reads why.
 *
 * The evidence is already on the visit and is shown here rather than described: the live photo, how
 * far he stood from the saved place, what he discussed. A decision made without looking at the photo
 * is not a decision.
 */

import { useId, useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { cairoStamp, dayLabelLong } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmButton, CrmCard, CrmField, CrmNote, CrmPill, crmTextareaClassName, type PillTone } from "@/components/phoenix-crm/ui";
import { UNPLANNED_DECISION_NOTE_MAX, type UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";
import type { TeamUnplannedVisit } from "@/lib/phoenix-crm/view-types";

const STATUS: Record<UnplannedVisitStatus, { label: string; tone: PillTone; accent: string }> = {
  manager_pending: { label: "Waiting for the manager", tone: "warn", accent: "border-l-amber-500" },
  sfe_pending: { label: "Waiting for SFE", tone: "warn", accent: "border-l-amber-500" },
  approved: { label: "Approved — it counts", tone: "good", accent: "border-l-emerald-500" },
  refused: { label: "Refused — it does not count", tone: "bad", accent: "border-l-rose-500" },
};

/** What the decider needs to know about where the rep stood, in the words the visit already uses. */
function locationLine(flag: string | null): string | null {
  if (flag === "far") return "Saved far from the customer's place.";
  if (flag === "weak_gps") return "Weak location signal when it was saved.";
  if (flag === "no_place") return "No place saved yet to compare with.";
  return null;
}

export function UnplannedVisitCard({
  onChanged,
  visit,
}: {
  /** A decision saved; the Team tab reads its counts again. */
  onChanged: (message: string) => void;
  visit: TeamUnplannedVisit;
}) {
  const fieldId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "refuse" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const status = STATUS[visit.status];
  const noteId = `${fieldId}-note`;
  const location = locationLine(visit.locationFlag);

  async function decide(decision: "approve" | "refuse") {
    const trimmed = note.trim();
    if (decision === "refuse" && !trimmed) {
      setProblem("Write a note for the rep explaining why.");
      return;
    }
    setBusy(decision);
    setProblem(null);
    try {
      await crmPost(
        "/api/phoenix-crm/visits/unplanned",
        { visitId: visit.visitId, decision, note: trimmed || null, expectedVersion: visit.version },
        "visit",
      );
      onChanged(`${decision === "approve" ? "Approved" : "Refused"}: off-plan visit to ${visit.customerName}.`);
    } catch (error) {
      setProblem(messageOf(error));
      const code = errorCodeOf(error);
      if (code === "phoenix_crm_unplanned_decided" || code === "phoenix_crm_unplanned_wrong_stage") {
        onChanged(`${visit.customerName}: this visit was already decided.`);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <CrmCard
      accent={status.accent}
      meta={[dayLabelLong(visit.visitDate), listText(visit.customerListType), visit.territoryName].filter(Boolean).join(" · ")}
      status={<CrmPill tone={status.tone}>{status.label}</CrmPill>}
      title={visit.customerName}
    >
      <div className="flex min-w-0 items-start gap-3">
        {visit.photoPath ? (
          <CrmPhotoThumb
            alt={`Visit photo: ${visit.customerName}`}
            caption={`${visit.customerName} · ${cairoStamp(visit.raisedAt)}`}
            path={visit.photoPath}
          />
        ) : null}
        <div className="grid min-w-0 flex-1 gap-1.5 text-sm leading-6">
          <p className="break-words font-black text-slate-900">{visit.repName}</p>
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">Why he went: </span>
            <span dir="auto">{visit.clarification}</span>
          </p>
          {visit.speciality ? <p className="break-words text-xs font-semibold text-slate-500">{visit.speciality}</p> : null}
          {visit.products.length > 0 ? (
            <p className="break-words text-xs font-semibold text-slate-600">
              <span className="font-black text-slate-800">Products: </span>
              {visit.products.join(", ")}
            </p>
          ) : null}
          {visit.comment ? (
            <p className="whitespace-pre-line break-words text-xs font-semibold text-slate-600">
              <span className="font-black text-slate-800">Comment: </span>
              <span dir="auto">{visit.comment}</span>
            </p>
          ) : null}
          {location ? <p className="break-words text-xs font-semibold text-amber-800">{location}</p> : null}
          {/* The first step, once it is past. The SFE reads who already said yes before saying it too. */}
          {visit.managerDecidedByName ? (
            <p className="break-words text-xs font-semibold text-slate-600">
              Approved by {visit.managerDecidedByName}
              {visit.managerNote ? ` · ${visit.managerNote}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {visit.canDecide ? (
        <div className="mt-3 grid min-w-0 gap-2">
          <CrmField hint="Needed to refuse. The rep reads it." htmlFor={noteId} label="Note for the rep">
            <textarea
              className={crmTextareaClassName}
              disabled={busy !== null}
              id={noteId}
              maxLength={UNPLANNED_DECISION_NOTE_MAX}
              onChange={(event) => {
                setProblem(null);
                setNote(event.target.value);
              }}
              rows={2}
              value={note}
            />
          </CrmField>
          <div className="flex flex-wrap gap-2">
            <CrmButton disabled={busy !== null} onClick={() => void decide("approve")} variant="primary">
              {busy === "approve" ? "Approving…" : visit.status === "manager_pending" ? "Approve · goes to SFE" : "Approve · it counts"}
            </CrmButton>
            <CrmButton disabled={busy !== null} onClick={() => void decide("refuse")}>
              {busy === "refuse" ? "Refusing…" : "Refuse"}
            </CrmButton>
          </div>
          {problem ? (
            <CrmNote tone="bad" title="The decision was not saved">
              {problem}
            </CrmNote>
          ) : null}
        </div>
      ) : null}
    </CrmCard>
  );
}
