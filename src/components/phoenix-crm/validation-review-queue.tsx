"use client";

/**
 * Phoenix CRM — the Super Admin's queue of places the Google Maps check could not confirm.
 *
 * Owner, 2026-10-03: "held for review and only system admin can approve or reject". Each row is one
 * place the rep captured at the door: his photo, where his phone put him, and every listing Google
 * returned for the customer's name — the same evidence the system judged on. Approve validates the
 * customer in the rep's own name; Reject retires the place and sends him back to To validate. Either
 * way the rep reads it as the system's answer: nothing he receives names who decided.
 *
 * Desktop draws the module's own `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmButton, CrmCardsOnPhone, CrmNote, CrmPill, CrmTable, crmTdClassName, crmTextareaClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import type { ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

const REASON_TEXT: Record<NonNullable<ValidationReviewRow["reason"]>, string> = {
  no_confident_listing: "Google has no listing the system is sure is this customer.",
  lookup_failed: "Google Maps could not be asked at the time (no answer).",
  listing_far: "Google's pin for this customer is over 1 km from him: the hospital may have moved, or the pin is old.",
  refused_by_admin: "The system did not question this one — it was refused here, by hand. The reason is the note.",
};

function readingText(label: string, reading: ValidationReviewRow["pin"]): string | null {
  if (!reading) return null;
  const accuracy = reading.accuracyMeters === null ? "accuracy unknown" : `within ${Math.round(reading.accuracyMeters)} m`;
  return `${label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} (${accuracy})`;
}

function Who({ row }: { row: ValidationReviewRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">
        {[row.listType, row.speciality, row.kind === "added_place" ? "Another clinic" : null].filter(Boolean).join(" · ")}
      </p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      <p className="break-words text-xs text-slate-500">Captured {row.createdAtText}</p>
      {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
    </div>
  );
}

function Evidence({ row }: { row: ValidationReviewRow }) {
  const readings = [readingText("Photo", row.photo), readingText("Capture location", row.pin)].filter((line): line is string => line !== null);
  return (
    <div className="min-w-0 space-y-2 text-sm text-slate-700">
      <div className="space-y-0.5">
        {row.placeLabel ? (
          <p className="break-words font-semibold" dir="auto">
            {row.placeLabel}
          </p>
        ) : null}
        {row.address ? <p className="break-words text-xs text-slate-500">{row.address}</p> : null}
        {row.brickName || row.areaName ? (
          <p className="break-words text-xs text-slate-500">{[row.brickName, row.areaName].filter(Boolean).join(" · ")}</p>
        ) : null}
        {readings.map((line) => (
          <p key={line} className="break-words text-xs text-slate-500">
            {line}
          </p>
        ))}
        <a className="text-xs font-black text-orange-700 underline underline-offset-2" href={row.mapsLink} rel="noreferrer" target="_blank">
          Open where he stood in Google Maps
        </a>
      </div>
      <div className="border-t border-slate-100 pt-2">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">What Google Maps returned</p>
        {row.reason ? <p className="mt-1 break-words text-xs text-slate-600">{REASON_TEXT[row.reason]}</p> : null}
        {row.query ? (
          <p className="mt-0.5 break-words text-xs text-slate-500">
            Searched for <span dir="auto">{row.query}</span>
          </p>
        ) : null}
        {row.listings.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">No listing came back.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {row.listings.map((listing) => (
              <li key={listing.placeId || listing.name} className="break-words text-xs text-slate-700">
                <span dir="auto">{listing.name}</span>
                <span className="text-slate-500"> · {listing.distanceMeters.toLocaleString("en-GB")} m from him</span>
                {listing.mapsUri ? (
                  <>
                    {" · "}
                    <a className="font-black text-orange-700 underline underline-offset-2" href={listing.mapsUri} rel="noreferrer" target="_blank">
                      open
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Taking a rejection back (owner, 2026-10-03: "add the option to approve after reject"). Offered only
 * while the place is still retired and nothing newer has been said about it — the same test the
 * database makes. The reason is required, as it is for the decision this reverses.
 */
function Restore({ row }: { row: ValidationReviewRow }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function restore() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/restore", { reviewId: row.reviewId, note }, "restored");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-2">
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`restore-note-${row.reviewId}`}>
        Why it is accepted after all (kept on the record, never shown to the rep)
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`restore-note-${row.reviewId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <CrmButton disabled={saving || note.trim().length === 0} onClick={() => void restore()} variant="primary">
        {saving ? "Bringing it back…" : "Approve it after all"}
      </CrmButton>
      <p className="break-words text-xs text-slate-500">
        The place comes back and the customer is validated again in {row.repName}&rsquo;s own name. His visits are measured against it again.
      </p>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

function Decision({ row }: { row: ValidationReviewRow }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (row.status !== "pending") {
    return (
      <div className="space-y-1">
        <CrmPill tone={row.status === "approved" ? "good" : "warn"}>{row.status === "approved" ? "Approved" : "Rejected"}</CrmPill>
        <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
        {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
        {row.restorable ? <Restore row={row} /> : null}
      </div>
    );
  }

  async function decide(decision: "approve" | "reject") {
    if (saving) return;
    setSaving(decision);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews", { reviewId: row.reviewId, decision, note }, "decided");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`review-note-${row.reviewId}`}>
        Note (kept on the record, never shown to the rep)
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={`review-note-${row.reviewId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton disabled={saving !== null} onClick={() => void decide("approve")} variant="primary">
          {saving === "approve" ? "Approving…" : "Approve"}
        </CrmButton>
        <CrmButton disabled={saving !== null} onClick={() => void decide("reject")} variant="danger">
          {saving === "reject" ? "Rejecting…" : "Reject"}
        </CrmButton>
      </div>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

export function ValidationReviewQueue({ rows }: { rows: ValidationReviewRow[] }) {
  return (
    <>
      <CrmCardsOnPhone>
        {rows.map((row) => (
          <div key={row.reviewId} className="space-y-3 px-4 py-4">
            <div className="flex min-w-0 gap-3">
              <CrmPhotoThumb alt={`Signboard photo for ${row.customerName}`} path={row.photoPath} />
              <Who row={row} />
            </div>
            <Evidence row={row} />
            <Decision row={row} />
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["14%", "22%", "40%", "24%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Photo</th>
            <th className={crmThClassName}>Customer and rep</th>
            <th className={crmThClassName}>Where he stood, and Google</th>
            <th className={crmThClassName}>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reviewId} className="even:bg-slate-50/60">
              <td className={crmTdClassName}>
                <CrmPhotoThumb alt={`Signboard photo for ${row.customerName}`} path={row.photoPath} />
              </td>
              <td className={crmTdClassName}>
                <Who row={row} />
              </td>
              <td className={crmTdClassName}>
                <Evidence row={row} />
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
