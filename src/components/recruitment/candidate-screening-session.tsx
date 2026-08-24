"use client";

// Recruitment / ATS — screening mode: the review queue.
//
// WHY THIS EXISTS. Measured through the real UI against production on 2026-08-24, screening one
// candidate in the pool cost four clicks and 8-31 seconds of waiting before a human read a word:
// open the profile (~2.6-5.7s), click the CV filename, wait for the document to render
// (2.8-25s+), close the modal, click "Back to the pool", then find your place again in a
// 426-row table. Twenty candidates took 5 minutes 40 seconds of pure machine time and 80 clicks,
// and two of the twenty never rendered at all. That is why reading the CVs in WhatsApp was
// genuinely faster, and it is the actual defect — not the columns.
//
// So this is not another view of the table. It is the loop every real ATS is built around:
// ONE candidate on screen, the CV already rendered beside the facts, a decision, and the next one
// loads itself. The next candidate's profile and CV bytes are prefetched while you read the
// current one, so the wait moves off the critical path instead of being paid 426 times.
//
// The queue is whatever the pool is currently filtered to, in the order it is displayed, so
// "screen every District Manager in Alex-BHR" is a session with a beginning and an end.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FileWarning, Loader2, SkipForward, X } from "lucide-react";

import { CandidateFactsSummary } from "@/components/recruitment/candidate-facts-summary";
import { CvDocumentView } from "@/components/recruitment/cv-preview-modal";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateScreeningFacts, candidateScreeningRoleFamily } from "@/lib/recruitment/candidate-screening-facts";
import {
  countByBand,
  orderForScreening,
  screeningBandDescriptions,
  screeningBandForFamily,
  screeningBandLabels,
  type ScreeningOrderInput,
} from "@/lib/recruitment/screening-order";
import {
  candidateStatusLabels,
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";
import { primaryCvFile } from "@/lib/recruitment/cv-file-choice";
import type { StoredCvExtraction } from "@/lib/recruitment/cv-extraction-fields";
import type { CandidateProfile } from "@/lib/recruitment/candidates";
import type { Candidate } from "@/lib/recruitment/types";

type LoadedCandidate = { profile: CandidateProfile; extraction: StoredCvExtraction | null };

// Chip colours. Deliberately muted against the dark header: this says where you are in the queue,
// it is not a verdict on the person, and a red badge beside somebody's name reads as one.
const bandChipClass: Record<ReturnType<typeof screeningBandForFamily>, string> = {
  field_force: "bg-emerald-500/15 text-emerald-300",
  pharma_adjacent: "bg-sky-500/15 text-sky-300",
  unknown: "bg-amber-500/15 text-amber-300",
  unrelated: "bg-slate-500/20 text-slate-300",
};

/**
 * What the ordering needs to know about one candidate, resolved through the SAME functions the row
 * and the Role filter use — so the queue cannot disagree with the table about who someone is.
 */
function describeForOrder(candidate: Candidate): ScreeningOrderInput {
  const facts = candidateScreeningFacts(candidate);
  return {
    createdAt: candidate.createdAt,
    family: candidateScreeningRoleFamily(facts, candidateRowAppliedFor(candidate).text),
    hasPharmaExperience: facts.pharmaRep?.value ?? null,
  };
}

export function CandidateScreeningSession({
  candidates,
  onClose,
}: {
  candidates: Candidate[];
  onClose: (decidedCount: number) => void;
}) {
  // Best worth meeting first. The TABLE stays newest-first — that is a record of what arrived —
  // but only ~53 of 381 undecided CVs are field-force shaped, so meeting them in arrival order
  // means seven strangers between every real candidate. Nothing is hidden and nothing is
  // auto-rejected: every candidate is still in this queue and still gets a human decision.
  const queue = useMemo(() => orderForScreening(candidates, describeForOrder), [candidates]);
  const bands = useMemo(() => countByBand(candidates, describeForOrder), [candidates]);

  // Start where the work is. Re-entering the queue after a break should not make you click past
  // everyone you already judged.
  const firstUndecided = Math.max(
    0,
    queue.findIndex((candidate) => (candidate.status ?? "new") === "new"),
  );
  const [index, setIndex] = useState(firstUndecided);
  const [loaded, setLoaded] = useState<Record<string, LoadedCandidate>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, CandidateStatus>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteRef = useRef<HTMLInputElement | null>(null);

  const current = queue[index] ?? null;
  const total = queue.length;

  // One fetch per candidate, ever — the cache is keyed by id and never evicted, so stepping back
  // through people you have already seen is instant.
  const inFlight = useRef<Set<string>>(new Set());
  const load = useCallback(
    async (candidateId: string | undefined) => {
      if (!candidateId || inFlight.current.has(candidateId)) return;
      inFlight.current.add(candidateId);
      try {
        const res = await fetch(`/api/recruitment/candidates/${candidateId}`);
        const data = (await res.json().catch(() => ({}))) as {
          profile?: CandidateProfile;
          latestCvExtraction?: StoredCvExtraction | null;
          message?: string;
        };
        const profile = data.profile;
        if (!res.ok || !profile) throw new Error(data.message ?? "Could not load this candidate.");
        setLoaded((prev) => ({ ...prev, [candidateId]: { extraction: data.latestCvExtraction ?? null, profile } }));
      } catch (caught) {
        setFailed((prev) => ({
          ...prev,
          [candidateId]: caught instanceof Error ? caught.message : "Could not load this candidate.",
        }));
        inFlight.current.delete(candidateId);
      }
    },
    [],
  );

  // The current one, then the next — the prefetch is the whole point. By the time a decision is
  // made on this candidate, the following profile is usually already in hand.
  useEffect(() => {
    void load(queue[index]?.id);
    void load(queue[index + 1]?.id);
  }, [queue, index, load]);

  const entry = current ? loaded[current.id] : undefined;
  const cvFile = useMemo(() => (entry ? primaryCvFile(entry.profile.files) : null), [entry]);

  const goTo = useCallback(
    (next: number) => {
      setError(null);
      setNote("");
      setIndex(Math.min(Math.max(next, 0), total - 1));
    },
    [total],
  );

  const decide = useCallback(
    async (status: CandidateStatus) => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/recruitment/candidates/${current.id}/status`, {
          body: JSON.stringify({ note: note.trim() || undefined, status }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(data.message ?? "Could not save that decision.");
        }
        setDecided((prev) => ({ ...prev, [current.id]: status }));
        setNote("");
        // Auto-advance. Not advancing past the last one — the summary bar is the ending.
        if (index < total - 1) setIndex(index + 1);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not save that decision.");
      } finally {
        setBusy(false);
      }
    },
    [busy, current, index, note, total],
  );

  const decidedCount = Object.keys(decided).length;

  // Keyboard is what makes a queue a queue. Ignored while typing a note, so "s" in "salary" does
  // not shortlist somebody.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable === true;
      if (event.key === "Escape") {
        event.preventDefault();
        if (typing) noteRef.current?.blur();
        else onClose(decidedCount);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") { event.preventDefault(); void decide("shortlisted"); }
      else if (key === "r") { event.preventDefault(); void decide("rejected"); }
      else if (key === "arrowright" || key === " ") { event.preventDefault(); goTo(index + 1); }
      else if (key === "arrowleft") { event.preventDefault(); goTo(index - 1); }
      else if (key === "n") { event.preventDefault(); noteRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, decidedCount, goTo, index, onClose]);

  if (!current) {
    return (
      <div className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-900/80 p-6">
        <div className="rounded-lg bg-white p-6 text-center">
          <p className="text-sm text-slate-700">There is nobody in this queue — clear a filter and try again.</p>
          <button
            className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
            onClick={() => onClose(0)}
            type="button"
          >
            Back to the pool
          </button>
        </div>
      </div>
    );
  }

  const shortlisted = Object.values(decided).filter((value) => value === "shortlisted").length;
  const rejected = Object.values(decided).filter((value) => value === "rejected").length;
  const thisDecision = decided[current.id] ?? null;
  // The status the row already carried before this session — so a candidate somebody judged last
  // week is not silently presented as untouched.
  const existingStatus = (current.status ?? "new") as CandidateStatus;
  const currentBand = screeningBandForFamily(describeForOrder(current).family);
  const loadError = failed[current.id];

  return (
    <div className="fixed inset-0 z-[190] flex flex-col bg-slate-900">
      {/* Where you are, what you have done, and the way out. Progress is not decoration here: the
          reason the pool felt endless is that it never said how much was left. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-700 px-4 py-2.5 text-white">
        <div className="flex items-center gap-2">
          <span className="text-sm font-black tabular-nums">
            {index + 1} <span className="text-slate-400">/ {total}</span>
          </span>
          <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-orange-500 transition-[width]"
              style={{ width: `${Math.round(((index + 1) / total) * 100)}%` }}
            />
          </div>
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{candidateDisplayName(current.fullName)}</p>
        {/* Which group this person is in, and how many are in it. Without this the queue's order is
            invisible and reads as random — and the one thing a screener must never have to wonder
            is why they are being shown this person now. */}
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${bandChipClass[currentBand]}`}
          title={screeningBandDescriptions[currentBand]}
        >
          {screeningBandLabels[currentBand]} · {bands[currentBand]}
        </span>
        <div className="flex items-center gap-3 text-xs tabular-nums">
          <span className="text-emerald-400">{shortlisted} shortlisted</span>
          <span className="text-rose-400">{rejected} rejected</span>
        </div>
        <button
          aria-label="Leave screening mode"
          className="rounded-md p-1.5 text-slate-300 transition hover:bg-slate-700 hover:text-white"
          onClick={() => onClose(decidedCount)}
          type="button"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* The CV, already open. This is the single biggest change: the document is the thing a
            screener actually reads, and it used to be three layers down. */}
        <div className="min-h-0 flex-1 overflow-auto bg-slate-100">
          {loadError ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <p className="text-sm text-rose-600">{loadError}</p>
            </div>
          ) : !entry ? (
            <div className="flex h-full items-center justify-center gap-2 p-6 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading the CV…</span>
            </div>
          ) : cvFile ? (
            // Keyed by file id so switching candidates tears the old document down rather than
            // painting the new one underneath it.
            <CvDocumentView
              downloadUrl={`/api/recruitment/files/${cvFile.id}/download`}
              fileName={cvFile.fileName}
              key={cvFile.id}
              mimeType={cvFile.mimeType}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FileWarning className="h-6 w-6 text-amber-500" />
              <p className="text-sm font-semibold text-slate-700">No readable CV attached</p>
              <p className="max-w-sm text-xs text-slate-500">
                {entry.profile.files.length === 0
                  ? "Nothing was attached to this candidate."
                  : `${entry.profile.files.length} file(s) attached, none of them a CV this viewer can draw.`}
              </p>
            </div>
          )}
        </div>

        {/* The facts and the decision, side by side with the document so nothing needs closing. */}
        <aside className="flex w-full shrink-0 flex-col overflow-auto border-t border-slate-200 bg-white lg:w-[380px] lg:border-l lg:border-t-0">
          <div className="flex-1 space-y-3 p-4">
            <div>
              <p className="text-base font-black leading-tight text-slate-900">
                {candidateDisplayName(current.fullName)}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {[current.email, current.phone].filter(Boolean).join(" · ") || "No contact details"}
              </p>
              {existingStatus !== "new" && !thisDecision ? (
                <p className="mt-1.5 inline-flex rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  Already {candidateStatusLabels[existingStatus].toLowerCase()}
                </p>
              ) : null}
            </div>

            {entry ? (
              <CandidateFactsSummary candidate={entry.profile.candidate} columns={1} extraction={entry.extraction} />
            ) : null}
          </div>

          <div className="sticky bottom-0 space-y-2 border-t border-slate-200 bg-white p-3">
            {error ? <p className="text-xs text-rose-600">{error}</p> : null}
            {thisDecision ? (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                <Check className="h-3.5 w-3.5" />
                Saved as {candidateStatusLabels[thisDecision].toLowerCase()}
              </p>
            ) : null}
            {/* Optional, and deliberately one line: a reason is worth having, but a required field
                would turn a two-second decision back into a form. */}
            <input
              className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-slate-400"
              maxLength={CANDIDATE_STATUS_NOTE_MAX_LENGTH}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Reason (optional) — press N"
              ref={noteRef}
              value={note}
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                className="flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => void decide("shortlisted")}
                type="button"
              >
                <Check className="h-4 w-4" /> Shortlist <kbd className="text-[10px] font-normal opacity-70">S</kbd>
              </button>
              <button
                className="flex items-center justify-center gap-1.5 rounded-md bg-rose-600 px-3 py-2 text-sm font-bold text-white transition hover:bg-rose-700 disabled:opacity-50"
                disabled={busy}
                onClick={() => void decide("rejected")}
                type="button"
              >
                <X className="h-4 w-4" /> Reject <kbd className="text-[10px] font-normal opacity-70">R</kbd>
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 disabled:opacity-40"
                disabled={index === 0}
                onClick={() => goTo(index - 1)}
                type="button"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Back
              </button>
              <button
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-40"
                disabled={index >= total - 1}
                onClick={() => goTo(index + 1)}
                type="button"
              >
                <SkipForward className="h-3.5 w-3.5" /> Skip <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
