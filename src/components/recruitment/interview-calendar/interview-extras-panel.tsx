"use client";

// Tier 3 (owner, 2026-09-26): the three finishing touches on an interview's detail —
//   1. Confirm / decline — the chosen interviewer answers the assignment.
//   2. CV — replace or attach the CV of someone from outside Phoenix, after booking.
//   3. Change history — every recorded change on this interview, newest first.
// Each section draws only when it has something to show for the person reading.

import { CheckCircle2, Clock, FileText, Loader2, Upload, XCircle } from "lucide-react";
import { useRef, useState } from "react";

import { Action } from "@/components/recruitment/workstation/workstation-look";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import type { InterviewBooking } from "@/lib/recruitment/interview-calendar-types";

import { type CalendarApi, reasonText } from "./calendar-api";
import { ErrorLine } from "./calendar-dialog";

function whenText(iso: string): string {
  try {
    return stableEnGbFormatter({
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      timeZone: "Africa/Cairo",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

export function InterviewExtrasPanel({
  api,
  booking,
  canBook,
  onChanged,
}: {
  api: CalendarApi;
  booking: InterviewBooking;
  canBook: boolean;
  onChanged: (booking: InterviewBooking) => void;
}) {
  const [busy, setBusy] = useState<"confirm" | "decline" | "cv" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decliningOpen, setDecliningOpen] = useState(false);
  const [reason, setReason] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const path = `/bookings/${encodeURIComponent(booking.id)}`;

  async function answer(decision: "confirmed" | "declined") {
    setBusy(decision === "confirmed" ? "confirm" : "decline");
    setError(null);
    try {
      const data = await api.post(`${path}/confirmation`, { decision, reason: decision === "declined" ? reason.trim() : undefined });
      onChanged(data.booking as InterviewBooking);
      setDecliningOpen(false);
      setReason("");
    } catch (reasonErr) {
      setError(reasonText(reasonErr, "Your answer could not be saved."));
    } finally {
      setBusy(null);
    }
  }

  async function replaceCv() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CV file first.");
      return;
    }
    setBusy("cv");
    setError(null);
    try {
      const form = new FormData();
      form.append("cv", file);
      const data = await api.postForm(`${path}/cv`, form);
      onChanged(data.booking as InterviewBooking);
      if (fileRef.current) fileRef.current.value = "";
    } catch (reasonErr) {
      setError(reasonText(reasonErr, "The CV could not be updated."));
    } finally {
      setBusy(null);
    }
  }

  const confirmation = booking.interviewerConfirmation;
  const showConfirmSection = booking.canConfirmInterview || confirmation !== null;
  const showCvSection = canBook && booking.external;
  const history = booking.changeHistory;

  if (!showConfirmSection && !showCvSection && history.length === 0) return null;

  return (
    <>
      {showConfirmSection ? (
        <section aria-label="Confirmation" className="border-t border-slate-200 pt-3">
          <p className="mb-2 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">Your answer</p>
          {confirmation === "confirmed" ? (
            <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              {booking.confirmedByName ?? "The interviewer"} confirmed{booking.confirmationAt ? ` · ${whenText(booking.confirmationAt)}` : ""}
            </p>
          ) : confirmation === "declined" ? (
            <div className="border-l-[3px] border-l-red-300 bg-red-50 px-3 py-2">
              <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-red-800">
                <XCircle className="h-4 w-4" />
                {booking.confirmedByName ?? "The interviewer"} declined{booking.confirmationAt ? ` · ${whenText(booking.confirmationAt)}` : ""}
              </p>
              {booking.declineReason ? <p className="mt-0.5 text-[12px] text-red-900">{booking.declineReason}</p> : null}
              {canBook ? <p className="mt-1 text-[11px] text-slate-600">Choose another interviewer from Edit details to reassign it.</p> : null}
            </div>
          ) : null}

          {booking.canConfirmInterview ? (
            <div className={confirmation !== null ? "mt-2" : ""}>
              {!decliningOpen ? (
                <div className="flex flex-wrap gap-2">
                  <Action disabled={busy !== null} onClick={() => void answer("confirmed")} tone="primary">
                    {busy === "confirm" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    {confirmation === "confirmed" ? "Still confirming" : "I'll conduct it"}
                  </Action>
                  <Action disabled={busy !== null} onClick={() => setDecliningOpen(true)} tone="ghost">
                    <XCircle className="h-3.5 w-3.5" />
                    {"I can't"}
                  </Action>
                </div>
              ) : (
                <div className="border border-slate-200 bg-white p-3">
                  <p className="text-[12px] font-bold text-slate-700">{"Why can't you conduct it? (optional)"}</p>
                  <textarea
                    className="mt-1.5 block w-full border border-slate-200 px-2 py-1.5 text-[13px] text-slate-800 focus:border-orange-500 focus:outline-none"
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="A short reason for whoever reassigns it (optional)"
                    rows={2}
                    value={reason}
                  />
                  <div className="mt-2 flex flex-wrap justify-end gap-2">
                    <Action disabled={busy !== null} onClick={() => setDecliningOpen(false)} tone="quiet">
                      Back
                    </Action>
                    <Action disabled={busy !== null} onClick={() => void answer("declined")} tone="ghost">
                      {busy === "decline" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                      Decline the interview
                    </Action>
                  </div>
                </div>
              )}
              <p className="mt-1.5 text-[11px] text-slate-500">Declining keeps the interview for reassignment and stops your reminders for it.</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {showCvSection ? (
        <section aria-label="CV" className="border-t border-slate-200 pt-3">
          <p className="mb-2 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">CV</p>
          {booking.externalHasCv ? (
            <a
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-slate-800 underline decoration-slate-300 underline-offset-2"
              href={api.href(`${path}/cv`)}
              rel="noreferrer"
              target="_blank"
            >
              <FileText className="h-4 w-4" />
              {booking.externalCvFileName ?? "Open CV"}
            </a>
          ) : (
            <p className="text-[12px] text-slate-500">No CV kept on this interview yet.</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              accept=".pdf,.doc,.docx,image/*"
              className="max-w-full text-[12px] text-slate-700 file:mr-2 file:border file:border-slate-300 file:bg-white file:px-2 file:py-1 file:text-[12px] file:font-semibold"
              ref={fileRef}
              type="file"
            />
            <Action disabled={busy !== null} onClick={() => void replaceCv()} tone="quiet">
              {busy === "cv" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {booking.externalHasCv ? "Replace CV" : "Attach CV"}
            </Action>
          </div>
        </section>
      ) : null}

      {error ? <ErrorLine>{error}</ErrorLine> : null}

      {history.length > 0 ? (
        <section aria-label="History" className="border-t border-slate-200 pt-3">
          <p className="mb-2 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-700">History</p>
          <ul className="flex flex-col gap-1.5">
            {history.map((change) => (
              <li className="flex items-start gap-2 text-[12px] text-slate-700" key={change.id}>
                <Clock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span>
                  {change.summary}
                  <span className="text-slate-400"> · {whenText(change.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
