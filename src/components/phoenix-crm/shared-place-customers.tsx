"use client";

/**
 * Phoenix CRM — the customers seated in one polyclinic, drawn under the building itself (owner,
 * 2026-10-17: "make sure every polyclinic is grouped with the customers in it, showing … the customers'
 * timetable, and make the option for the admin to reject a customer who is not in the timetable").
 *
 * A seated customer has no sign and no reading of his own — the building holds both — so what stands
 * behind his name is the TIMETABLE inside it, photographed once for everybody. Each row therefore says
 * what the system read beside his name on that timetable (it names him, names somebody else, or there
 * is no timetable in the photo), shows his own copy of the photo only when it is not the building's, and
 * gives the Super Admin the one control the request names: reject him because he is not on it.
 *
 * 🔴 THE REJECT CONTROL IS THE EXISTING REFUSAL, NOT A NEW DECISION PATH. A customer with a review row
 * goes through the review decision route (it keeps the evidence the system held him on); one the system
 * never questioned goes through the refuse route, exactly as the single clinics' list does. Both use the
 * timetable pick-list (`kind="schedule"`), so a timetable refusal is never offered "a photo of paper".
 * The rep is told one closed-list sentence about his photo and never that a person looked at him.
 *
 * 🔴 A MANAGER'S BOARD (`mode="team"`) GETS NO DECISION CONTROL AND NO SENTENCE ABOUT ONE. He reads the
 * evidence and comments; who decides is not on his screen (owner, 2026-10-13).
 *
 * Desktop draws the module's `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { CrmButton, CrmCardsOnPhone, CrmNote, CrmPill, CrmTable, crmTdClassName, crmTextareaClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import type { SeatedCustomer, SeatedTimetable } from "@/lib/phoenix-crm/shared-place-groups";
import { VALIDATION_NOTE_LABEL, VALIDATION_REASON_REQUIRED, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";

/** What the system read beside this customer's name on the building's timetable. A verdict, never a decision. */
const TIMETABLE_TEXT: Record<SeatedTimetable["verdict"], string> = {
  match: "The timetable names this customer",
  other_name: "The timetable does not name this customer",
  no_schedule: "No timetable in the photo",
  unjudged: "The timetable could not be read",
};

/** The reason the reject control starts on: the one the request names — he is not on the timetable. */
function defaultReason(customer: SeatedCustomer): ValidationRefusalReason {
  return customer.timetable?.verdict === "no_schedule" ? "schedule_missing" : "schedule_other_name";
}

/**
 * The reason a waiting row starts on: only what the system itself read. A row the timetable named
 * (or one with no timetable in the photo) opens on that reason; a customer the system could not read,
 * or read as named, opens on NOTHING, so a reject is never one click away from telling a rep that
 * the timetable does not name him when it may have.
 */
function evidenceReason(customer: SeatedCustomer): ValidationRefusalReason | "" {
  if (customer.timetable?.verdict === "other_name") return "schedule_other_name";
  if (customer.timetable?.verdict === "no_schedule") return "schedule_missing";
  return "";
}

/** Whether a decision can be made on this customer's review row — the route that keeps the evidence. */
function decidesOnReview(customer: SeatedCustomer): boolean {
  return customer.reviewId !== null && (customer.state === "waiting" || customer.refusable);
}

function Who({ customer, mode }: { customer: SeatedCustomer; mode: PlaceCheckNotesMode }) {
  const dated = customer.state === "sent_back" ? "Sent back" : customer.state === "in_use" ? "Seated" : "Held";
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {customer.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{[customer.listType, customer.speciality].filter(Boolean).join(" · ")}</p>
      <p className="break-words text-sm text-slate-700">{customer.repName}</p>
      <p className="break-words text-xs text-slate-500">{customer.territory}</p>
      <p className="break-words text-xs text-slate-500">
        {dated} {customer.atText}
      </p>
      <div className="flex min-w-0 flex-wrap gap-1">
        {customer.state === "waiting" ? <CrmPill tone="warn">Still being checked</CrmPill> : null}
        {customer.state === "rejected" ? <CrmPill tone="bad">{mode === "team" ? "Settled" : "Rejected"}</CrmPill> : null}
        {customer.state === "sent_back" ? <CrmPill tone="neutral">Waiting to be captured again</CrmPill> : null}
        {customer.state === "in_use" && !customer.reviewed ? <CrmPill tone="info">Never looked at</CrmPill> : null}
        {customer.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
    </div>
  );
}

function Timetable({ customer, venueTimetablePath }: { customer: SeatedCustomer; venueTimetablePath: string | null }) {
  // The photograph THIS customer's rep took is always on their row — what the checker called unreadable or
  // empty must be seen with his own eyes, and it can be the very photograph the building shows above.
  const own = customer.photoPath;
  const sameAsBuilding = own !== null && own === venueTimetablePath;
  if (customer.state === "sent_back") {
    return (
      <div className="min-w-0 space-y-0.5 text-sm text-slate-700">
        <p className="break-words text-xs text-slate-700">
          {customer.reasonLabel ? `The rep was told: ${customer.reasonLabel}.` : "The rep was told what is wrong with the building's photo."}
        </p>
        {customer.waitingHours !== null ? (
          <p className="break-words text-xs text-slate-500">
            Waiting {customer.waitingHours} {customer.waitingHours === 1 ? "hour" : "hours"} so far.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1 text-sm text-slate-700">
      {customer.timetable ? (
        <CrmPill tone={customer.timetable.verdict === "match" ? "good" : customer.timetable.verdict === "unjudged" ? "neutral" : "warn"}>
          {TIMETABLE_TEXT[customer.timetable.verdict]}
        </CrmPill>
      ) : (
        <p className="text-xs text-slate-500">The timetable has not been read for this customer yet.</p>
      )}
      {customer.timetable?.hoursRead ? (
        <p className="break-words text-xs text-slate-700" dir="auto">
          Hours read: {customer.timetable.hoursRead}
        </p>
      ) : null}
      {customer.timetable?.scheduleText ? (
        <p className="break-words text-xs text-slate-700" dir="auto">
          {customer.timetable.scheduleText}
        </p>
      ) : null}
      {customer.state === "rejected" && customer.reasonLabel ? <p className="break-words text-xs text-slate-600">The rep was told: {customer.reasonLabel}.</p> : null}
      {own ? <CrmPhotoThumb alt={`Timetable photo for ${customer.customerName}`} className="h-28 w-28" path={own} /> : null}
      {sameAsBuilding ? <p className="break-words text-xs text-slate-500">The same photograph as the building's timetable.</p> : null}
    </div>
  );
}

/** What rejecting one seated customer costs, in plain words — read before the button, not after. */
function Cost({ customer }: { customer: SeatedCustomer }) {
  const lines = [
    customer.otherPlaces === null
      ? "This retires their seat in the building; when it is their only place they go back to To validate."
      : customer.otherPlaces === 0
        ? "They go back to To validate — this is the customer's only place."
        : `The customer keeps ${customer.otherPlaces === 1 ? "their other place" : `their other ${customer.otherPlaces} places`}, so they stay validated.`,
    "The building and everybody else seated in it are not touched.",
  ];
  if (customer.visits !== null && customer.visits > 0) {
    lines.push(`${customer.visits} ${customer.visits === 1 ? "visit is" : "visits are"} measured against the seat, and ${customer.visits === 1 ? "it loses its distance" : "they lose their distances"}.`);
  }
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

/**
 * The reject control (owner, 2026-10-17: "the option for the admin to reject a customer who is not in
 * the timetable"). It opens already pointed at the reason the request names — the timetable does not
 * name this customer — and a different timetable reason can still be picked. The note stays optional.
 */
function RejectNotOnTimetable({ customer, scope }: { customer: SeatedCustomer; scope: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ValidationRefusalReason | "">(defaultReason(customer));
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function reject() {
    if (saving || reason === "") return;
    setSaving(true);
    setProblem(null);
    try {
      if (decidesOnReview(customer)) {
        await crmPost<unknown>("/api/phoenix-crm/validation-reviews", { reviewId: customer.reviewId, decision: "reject", note, refusalReason: reason }, "decided");
      } else {
        await crmPost<unknown>("/api/phoenix-crm/validation-reviews/refuse", { placeId: customer.placeId, note, refusalReason: reason }, "refused");
      }
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
      setArmed(false);
    }
  }

  if (!open) {
    return (
      <CrmButton onClick={() => setOpen(true)} variant="danger">
        Reject — not on the timetable
      </CrmButton>
    );
  }

  return (
    <div className="space-y-2">
      <Cost customer={customer} />
      <RefusalReasonField
        disabled={saving}
        id={`seated-reason-${scope}-${customer.key}`}
        kind="schedule"
        onChange={(next) => {
          setReason(next);
          setArmed(false);
        }}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`seated-note-${scope}-${customer.key}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`seated-note-${scope}-${customer.key}`}
        maxLength={500}
        onChange={(event) => {
          setNote(event.target.value);
          setArmed(false);
        }}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      {armed ? (
        <div className="space-y-2">
          <CrmNote tone="warn">This retires their seat — the rep captures the customer again from their own list. You can approve it after all from this row.</CrmNote>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <CrmButton busy={saving} disabled={saving} onClick={() => void reject()} variant="danger">
              {saving ? "Rejecting…" : "Yes, reject them"}
            </CrmButton>
            <CrmButton
              disabled={saving}
              onClick={() => {
                setArmed(false);
                setOpen(false);
              }}
            >
              Keep them
            </CrmButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
          <CrmButton disabled={reason === "" || saving} onClick={() => setArmed(true)} variant="danger">
            Reject this customer
          </CrmButton>
          <CrmButton disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </CrmButton>
        </div>
      )}
      {reason === "" && !armed ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED}</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/** A customer the system is still checking: approve him, or reject him with a timetable reason. */
function WaitingDecision({ customer, scope }: { customer: SeatedCustomer; scope: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ValidationRefusalReason | "">(evidenceReason(customer));
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (saving || !customer.reviewId) return;
    setSaving(decision);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews",
        { reviewId: customer.reviewId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
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
      <RefusalReasonField disabled={saving !== null} id={`seated-reason-${scope}-${customer.key}`} kind="schedule" onChange={setReason} value={reason} />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`seated-note-${scope}-${customer.key}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={`seated-note-${scope}-${customer.key}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton disabled={saving !== null} onClick={() => void decide("approve")} variant="primary">
          {saving === "approve" ? "Approving…" : "Approve"}
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

/** Taking a rejection back — the mirror of the reject, through the review restore route. */
function RestoreSeated({ customer, scope }: { customer: SeatedCustomer; scope: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function restore() {
    if (saving || !customer.reviewId) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/restore", { reviewId: customer.reviewId, note }, "restored");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <p className="break-words text-xs text-slate-500">{[customer.decidedByName, customer.decidedAtText].filter(Boolean).join(" · ")}</p>
      {customer.decisionNote ? <p className="break-words text-xs text-slate-600">{customer.decisionNote}</p> : null}
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`seated-restore-note-${scope}-${customer.key}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`seated-restore-note-${scope}-${customer.key}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <CrmButton busy={saving} disabled={saving} onClick={() => void restore()} variant="primary">
        {saving ? "Bringing them back" : "Approve it after all"}
      </CrmButton>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/** The decision control that fits where this customer stands. */
function Decision({ customer, scope }: { customer: SeatedCustomer; scope: string }) {
  if (customer.state === "waiting" && customer.reviewId) return <WaitingDecision customer={customer} scope={scope} />;
  if (customer.state === "rejected") return customer.restorable ? <RestoreSeated customer={customer} scope={scope} /> : null;
  if (customer.state === "in_use" && customer.placeId) return <RejectNotOnTimetable customer={customer} scope={scope} />;
  return null;
}

/**
 * The last column, both modes together.
 *
 * 🔴 A MANAGER GETS NO `Decision` AND NOT EVEN THE `Cost` WARNING INSIDE IT. Rejecting a seated customer
 * retires his seat and can send him back to To validate — the Super Admin's alone. A manager reads the
 * timetable evidence, comments on it and recommends.
 */
function LastColumn({ customer, mode, noteIndex, scope }: { customer: SeatedCustomer; mode: PlaceCheckNotesMode; noteIndex: PlaceNoteIndex; scope: string }) {
  const key = customer.placeId ? placeNoteSubjectKey("place", customer.placeId) : null;
  return (
    <div className="min-w-0 space-y-2">
      {mode === "team" ? null : <Decision customer={customer} scope={scope} />}
      {customer.placeId && key ? (
        <PlaceCheckNotes
          integrity={noteIndex.integrity[key] ?? []}
          mode={mode}
          notes={noteIndex.notes[key] ?? []}
          recommendations={noteIndex.recommendations[key] ?? []}
          subjectId={customer.placeId}
          subjectKind="place"
        />
      ) : null}
    </div>
  );
}

export function SeatedCustomers({
  customers,
  layout = "both",
  mode,
  noteIndex,
  total,
  venueTimetablePath,
}: {
  customers: SeatedCustomer[];
  /**
   * Which of the two layouts to draw. The polyclinic list already draws a phone block and a desktop
   * block, and hands each one the matching layout, so a customer is on the page once per screen size
   * and a control's label always points at the control the reader can see.
   */
  layout?: "both" | "cards" | "table";
  mode: PlaceCheckNotesMode;
  noteIndex: PlaceNoteIndex;
  /** How many are seated in the building before the filters, so a narrowed list says so. */
  total: number;
  /** The building's one timetable, so a customer's own copy is drawn only when it is a different photograph. */
  venueTimetablePath: string | null;
}) {
  if (customers.length === 0) {
    return (
      <p className="break-words px-4 py-3 text-xs text-slate-500">
        {total === 0 ? "Nobody is seated in this building yet." : `${total} ${total === 1 ? "customer is" : "customers are"} seated here; none match these filters.`}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <p className="break-words px-4 pt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
        {customers.length === total ? `Customers seated here (${total})` : `Customers seated here (${customers.length} of ${total})`}
      </p>
      {layout !== "table" ? (
        <CrmCardsOnPhone>
          {customers.map((customer) => (
            <div key={customer.key} className="space-y-3 px-4 py-4">
              <Who customer={customer} mode={mode} />
              <Timetable customer={customer} venueTimetablePath={venueTimetablePath} />
              <LastColumn customer={customer} mode={mode} noteIndex={noteIndex} scope="cards" />
            </div>
          ))}
        </CrmCardsOnPhone>
      ) : null}
      {layout !== "cards" ? (
        <CrmTable columns={["42%", "30%", "28%"]}>
          <thead>
            <tr>
              <th className={crmThClassName}>Customer and rep</th>
              <th className={crmThClassName}>What the timetable says</th>
              <th className={crmThClassName}>{mode === "team" ? "Your comment" : "Decision"}</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <tr key={customer.key} className="even:bg-slate-50/60">
                <td className={crmTdClassName}>
                  <Who customer={customer} mode={mode} />
                </td>
                <td className={crmTdClassName}>
                  <Timetable customer={customer} venueTimetablePath={venueTimetablePath} />
                </td>
                <td className={crmTdClassName}>
                  <LastColumn customer={customer} mode={mode} noteIndex={noteIndex} scope="table" />
                </td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
      ) : null}
    </div>
  );
}
