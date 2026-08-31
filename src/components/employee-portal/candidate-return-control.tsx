"use client";

import { useState } from "react";

/**
 * "Return this CV to the administrator." One control, on a district manager's OWN folder cards.
 *
 * The owner, 2026-09-01: *"make an option to tell them return this CV to the administrator because
 * area not match — or any other situation ... and this returned CV is not any more in the district
 * manager folder."*
 *
 * It is deliberately NOT baked into CandidateReadCard: that card also renders on the National Sales
 * Manager's "your team's candidates" screen, where returning is not his to do. This is passed into
 * the card as a footer only from the district folders (DistrictFoldersSection).
 *
 * On success it tells the parent, which drops the card — the CV has left his folder and is with the
 * administrator. No page moves; the row collapses in place.
 */

export type CandidateReturnContext = {
  seatId: string | null;
  seatLabel: string | null;
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
};

type ReasonCode = "area_not_match" | "other";
type Mode = "idle" | "form" | "submitting" | "done";

export function CandidateReturnControl({
  candidateId,
  context,
  onReturned,
}: {
  candidateId: string;
  context: CandidateReturnContext;
  onReturned: (candidateId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [reasonCode, setReasonCode] = useState<ReasonCode>("area_not_match");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmedNote = note.trim();
    if (reasonCode === "other" && !trimmedNote) {
      setError("Tell the administrator why you are returning this CV.");
      return;
    }
    setMode("submitting");
    setError(null);
    try {
      const res = await fetch(`/api/recruitment/candidates/${candidateId}/district-return`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reasonCode,
          reasonNote: trimmedNote || null,
          seatId: context.seatId,
          seatLabel: context.seatLabel,
          lineName: context.lineName,
          regionName: context.regionName,
          areaName: context.areaName,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(payload?.message ?? "This CV could not be returned. Please try again.");
        setMode("form");
        return;
      }
      setMode("done");
      onReturned(candidateId);
    } catch {
      setError("This CV could not be returned. Please try again.");
      setMode("form");
    }
  };

  if (mode === "done") {
    return (
      <p className="whitespace-nowrap text-phx-xs font-semibold text-emerald-700">
        Returned to the administrator.
      </p>
    );
  }

  if (mode === "idle") {
    return (
      <button
        className="whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 py-1.5 text-phx-xs font-semibold text-slate-600 transition hover:border-amber-300 hover:text-amber-700"
        onClick={() => {
          setError(null);
          setMode("form");
        }}
        type="button"
      >
        Return to administrator
      </button>
    );
  }

  const submitting = mode === "submitting";

  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
      <p className="text-phx-xs font-semibold uppercase tracking-wide text-amber-700">
        Return this CV to the administrator
      </p>

      <div className="space-y-2">
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            checked={reasonCode === "area_not_match"}
            className="mt-0.5"
            name={`return-reason-${candidateId}`}
            onChange={() => setReasonCode("area_not_match")}
            type="radio"
          />
          <span>The area doesn’t match — this applicant isn’t for one of my areas.</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            checked={reasonCode === "other"}
            className="mt-0.5"
            name={`return-reason-${candidateId}`}
            onChange={() => setReasonCode("other")}
            type="radio"
          />
          <span>Another reason.</span>
        </label>
      </div>

      <textarea
        className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-amber-300 focus:outline-none"
        dir="auto"
        onChange={(event) => setNote(event.target.value)}
        placeholder={
          reasonCode === "other"
            ? "Tell the administrator why (required)"
            : "Add anything the administrator should know (optional)"
        }
        rows={2}
        value={note}
      />

      {error ? <p className="text-phx-xs font-semibold text-rose-600">{error}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="whitespace-nowrap rounded-md bg-amber-600 px-3 py-1.5 text-phx-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-60"
          disabled={submitting}
          onClick={submit}
          type="button"
        >
          {submitting ? "Returning…" : "Return to administrator"}
        </button>
        <button
          className="whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 py-1.5 text-phx-xs font-semibold text-slate-600 transition hover:border-slate-400 disabled:opacity-60"
          disabled={submitting}
          onClick={() => {
            setError(null);
            setMode("idle");
          }}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
