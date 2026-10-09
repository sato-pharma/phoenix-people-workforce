"use client";

/**
 * Phoenix CRM — the polyclinics and centres, and the administrator's decision on each.
 *
 * Owner, 2026-10-09 in chat (Arabic): "من حق الادمنستريتور ان هو يراجع الجدول ويبص" — the
 * administrator has the right to review the schedule and look. This is that review for the VENUE: the
 * live photo of the sign on the building, the two readings taken at its door, where it resolved to,
 * who captured it and when, and how many customers are seated behind it.
 *
 * 🔴 NO GOOGLE COLUMN, DELIBERATELY. The listing check compares a listing against the name on a
 * customer's LIST row, and a venue has no list name at all — so there is nothing to compare and
 * nothing is shown. The owner was asked this directly the same day and answered that the live photo
 * and the location are the gate: "even if no Google check, he must validate by a live photo and
 * location." This section is the human gate behind them.
 *
 * Rejecting one is the heavy decision on this page, so what it costs is written above the button
 * rather than after it: the venue is retired, every customer seated in it is retired with it, and each
 * of them goes back to To validate. The rep is told what is wrong with the photo from the same closed
 * list every other refusal uses, and never that a person looked at him.
 *
 * Desktop draws the module's `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import {
  CrmButton,
  CrmCardsOnPhone,
  CrmNote,
  CrmPill,
  CrmTable,
  crmTdClassName,
  crmTextareaClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import {
  VALIDATION_NOTE_LABEL,
  VALIDATION_REASON_REQUIRED,
  type ValidationRefusalReason,
} from "@/lib/phoenix-crm/validation-feedback";
import type { SharedPlaceBoardRow } from "@/lib/phoenix-crm/view-types";

/** What the system read on the sign of the BUILDING. A verdict on the venue's own name, never on a person's. */
const SIGNBOARD_TEXT: Record<string, string> = {
  match: "The sign names this polyclinic",
  other_name: "The sign names something else",
  no_name: "No name to judge on the sign",
  unjudged: "The sign could not be read",
};

function readingText(label: string, reading: SharedPlaceBoardRow["pin"]): string | null {
  if (!reading) return null;
  const accuracy = reading.accuracyMeters === null ? "accuracy unknown" : `within ${Math.round(reading.accuracyMeters)} m`;
  return `${label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} (${accuracy})`;
}

function Venue({ row }: { row: SharedPlaceBoardRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.name}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{row.kindLabel}</p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      <p className="break-words text-xs text-slate-500">Captured {row.capturedAtText}</p>
      <div className="flex min-w-0 flex-wrap gap-1">
        <CrmPill tone={row.seated === 0 ? "neutral" : "info"}>
          {row.seated === 0 ? "Nobody seated yet" : `${row.seated} ${row.seated === 1 ? "customer seated" : "customers seated"}`}
        </CrmPill>
        {row.status === "held" ? <CrmPill tone="warn">Waiting for you</CrmPill> : null}
        {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
    </div>
  );
}

function Where({ row }: { row: SharedPlaceBoardRow }) {
  const readings = [readingText("Photo", row.photo), readingText("Capture location", row.pin)].filter((line): line is string => line !== null);
  return (
    <div className="min-w-0 space-y-0.5 text-sm text-slate-700">
      {row.address ? <p className="break-words text-xs text-slate-500">{row.address}</p> : null}
      {row.brickName || row.areaName ? (
        <p className="break-words text-xs text-slate-500">{[row.brickName, row.areaName].filter(Boolean).join(" · ")}</p>
      ) : null}
      {readings.map((line) => (
        <p key={line} className="break-words text-xs text-slate-500">
          {line}
        </p>
      ))}
      <a className="inline-block text-xs font-black text-orange-700 underline underline-offset-2" href={row.mapsLink} rel="noreferrer" target="_blank">
        Open the building in Google Maps
      </a>
      <div className="space-y-0.5 border-t border-slate-100 pt-1">
        {row.signboard ? (
          <CrmPill tone={row.signboard.verdict === "match" ? "good" : row.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
            {SIGNBOARD_TEXT[row.signboard.verdict] ?? "The sign could not be read"}
          </CrmPill>
        ) : (
          <p className="text-xs text-slate-500">The sign has not been read yet.</p>
        )}
        {row.signboard?.signText ? (
          <p className="break-words text-xs text-slate-700" dir="auto">
            {row.signboard.signText}
          </p>
        ) : null}
        <p className="break-words text-xs text-slate-500">
          This building is not looked up in Google: the check reads a customer&apos;s own name, and a polyclinic has none.
        </p>
      </div>
    </div>
  );
}

/** What rejecting this venue costs, in plain words — read before the button, not after. */
function Cost({ row }: { row: SharedPlaceBoardRow }) {
  const lines = [
    row.seated === 0
      ? "Nobody is seated in it yet, so no customer is affected."
      : `${row.seated === 1 ? "The 1 customer seated in it is retired with it and goes" : `All ${row.seated} customers seated in it are retired with it and go`} back to To validate.`,
    "The rep captures it again from their own list, and is told what is wrong with the photo and nothing else.",
  ];
  return (
    <ul className="space-y-0.5">
      {lines.map((line) => (
        <li key={line} className="break-words text-xs text-slate-600">
          {line}
        </li>
      ))}
    </ul>
  );
}

function Decision({ row }: { row: SharedPlaceBoardRow }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ValidationRefusalReason | "">("");
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (saving) return;
    setSaving(decision);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews/shared-place",
        { sharedPlaceId: row.sharedPlaceId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
        "decided",
      );
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  return (
    <div className="space-y-2">
      {row.decidedAtText ? (
        <div className="space-y-0.5">
          <CrmPill tone="good">Approved</CrmPill>
          <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
          {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
        </div>
      ) : null}
      <Cost row={row} />
      <RefusalReasonField
        disabled={saving !== null}
        id={`shared-place-reason-${row.sharedPlaceId}`}
        onChange={setReason}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`shared-place-note-${row.sharedPlaceId}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={`shared-place-note-${row.sharedPlaceId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton disabled={saving !== null} onClick={() => void decide("approve")} variant="primary">
          {saving === "approve" ? "Approving…" : row.status === "held" ? "Approve" : "Keep it"}
        </CrmButton>
        <CrmButton disabled={saving !== null || reason === ""} onClick={() => void decide("reject")} variant="danger">
          {saving === "reject" ? "Rejecting…" : "Reject"}
        </CrmButton>
      </div>
      {reason === "" ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED} Approve needs no reason.</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

export function SharedPlaceList({ rows }: { rows: SharedPlaceBoardRow[] }) {
  return (
    <>
      <CrmCardsOnPhone>
        {rows.map((row) => (
          <div key={row.sharedPlaceId} className="space-y-3 px-4 py-4">
            <div className="flex min-w-0 gap-3">
              <CrmPhotoThumb alt={`Sign photo for ${row.name}`} path={row.photoPath} />
              <Venue row={row} />
            </div>
            <Where row={row} />
            <Decision row={row} />
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["12%", "24%", "36%", "28%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Photo</th>
            <th className={crmThClassName}>The polyclinic</th>
            <th className={crmThClassName}>Where it was captured</th>
            <th className={crmThClassName}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sharedPlaceId} className="even:bg-slate-50/60">
              <td className={crmTdClassName}>
                <CrmPhotoThumb alt={`Sign photo for ${row.name}`} path={row.photoPath} />
              </td>
              <td className={crmTdClassName}>
                <Venue row={row} />
              </td>
              <td className={crmTdClassName}>
                <Where row={row} />
              </td>
              <td className={crmTdClassName}>
                <Decision row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </>
  );
}
