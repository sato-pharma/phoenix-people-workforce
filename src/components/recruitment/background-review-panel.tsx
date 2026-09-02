"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { patchJson } from "@/components/recruitment/recruitment-fetch";
import {
  backgroundReviewQueue,
  describeBackgroundConfirmation,
  type BackgroundConfirmationOutcome,
  type BackgroundReviewRow,
} from "@/lib/recruitment/background-review";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * The admin's queue for CVs the eligibility rule will not decide by itself.
 *
 * The owner, 2026-08-31: *"the two hundred eligible, you will backfill them. But anyone non eligible,
 * you will make the admin be able to check first their CV and confirm."* The first half needs no
 * screen — those CVs are already reaching the district managers covering their area. This is the
 * second half, and it is a screen because the decision is a person's.
 *
 * ── WHY THE TWO GROUPS ARE NOT ONE LIST ─────────────────────────────────────────────────────────
 *
 * They are different questions. In the first the rule read something it recognises as outside the
 * five disciplines and the admin is checking a conclusion; in the second it read nothing usable and
 * the admin is supplying an answer that does not exist yet. The second group is by far the larger,
 * and merging them would present a few hundred rows as if they were all near-misses on the same
 * judgement — which is how a queue gets select-alled instead of read.
 *
 * ── THE EVIDENCE IS ON SCREEN, NOT BEHIND THE CV ────────────────────────────────────────────────
 *
 * Every row shows the exact text the rule judged. Most of the paramedical group can be settled from
 * that one line without opening anything, and the ones that cannot are precisely the ones where the
 * line looks wrong — which is the signal to open the CV. A queue that shows only names would make an
 * admin open all of them to find the few that matter.
 *
 * NO BULK BUTTON, AND THAT IS DELIBERATE. Filing somebody as paramedical takes them off the screen
 * the recruiters work from and nothing brings them back; the sibling panel above this one can offer
 * one press for a hundred CVs because those people said where they belong themselves. Nobody here
 * said anything. Each row is one person and one click.
 */
export function BackgroundReviewPanel({
  candidates,
  onOpenCandidate,
}: {
  candidates: Candidate[];
  onOpenCandidate: (candidateId: string) => void;
}) {
  const { paramedical, unreadable, total, withoutEvidence } = backgroundReviewQueue(candidates);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (total === 0) return null;

  return (
    <section className="rounded-lg border border-phx-line bg-white">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-phx-line px-3 py-2">
        <span className="flex items-center whitespace-nowrap text-sm font-black text-phx-ink">
          <FileSearch aria-hidden className="mr-1.5 h-4 w-4 text-phx-accent-press" />
          Degrees waiting for you to check
        </span>
        <span className="whitespace-nowrap text-xs font-medium text-slate-500">
          Nobody here reaches a district manager until you answer.
        </span>
        <span className="ml-auto whitespace-nowrap text-xs font-bold tabular-nums text-phx-accent-press">
          {total} {total === 1 ? "CV" : "CVs"}
        </span>
      </div>

      {error ? (
        <p className="border-b border-phx-line bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
          {error}
        </p>
      ) : null}

      <ReviewGroup
        busyId={busyId}
        heading="Reads as something other than the five"
        note="Pharmacy, science, veterinary, medicine and dentistry are the five. Check the line the rule read — most of these can be settled without opening the CV."
        onOpenCandidate={onOpenCandidate}
        rows={paramedical}
        setBusyId={setBusyId}
        setError={setError}
      />

      <ReviewGroup
        busyId={busyId}
        heading="Could not read the degree at all"
        note={
          withoutEvidence > 0
            ? `Nothing to go on but the document itself for ${withoutEvidence} of these — their CV names no faculty.`
            : "The faculty is written in a way the rule could not parse. The CV will say."
        }
        onOpenCandidate={onOpenCandidate}
        rows={unreadable}
        setBusyId={setBusyId}
        setError={setError}
      />
    </section>
  );
}

/** How many rows are drawn before "Show more" — enough to work through, short enough to scroll past. */
const PAGE = 25;

function ReviewGroup({
  busyId,
  heading,
  note,
  onOpenCandidate,
  rows,
  setBusyId,
  setError,
}: {
  busyId: string | null;
  heading: string;
  note: string;
  onOpenCandidate: (candidateId: string) => void;
  rows: BackgroundReviewRow<Candidate>[];
  setBusyId: (id: string | null) => void;
  setError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(PAGE);

  if (rows.length === 0) return null;

  const answer = async (candidateId: string, outcome: BackgroundConfirmationOutcome) => {
    setBusyId(candidateId);
    setError(null);
    try {
      await patchJson(`/api/recruitment/candidates/${candidateId}/background`, { outcome });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to record that answer.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="border-b border-phx-line last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 bg-slate-50 px-3 py-1.5">
        <span className="whitespace-nowrap text-xs font-black text-phx-ink">{heading}</span>
        <span className="text-phx-xs font-medium text-slate-500">{note}</span>
        <span className="ml-auto whitespace-nowrap text-phx-xs font-bold tabular-nums text-slate-500">
          {rows.length}
        </span>
      </div>

      <ul className="divide-y divide-phx-line">
        {rows.slice(0, shown).map(({ candidate, standing }) => (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" key={candidate.id}>
            {/* The NAME wraps. Measured at 375px on 2026-09-02: pinned at `whitespace-nowrap` a real
                candidate's five-part name laid out 335px wide inside a 325px box and painted over
                what sits beside it. A name has no length bound, so this is the one label here bound
                to find a phone too narrow for it — the fits-the-screen rule says wrap, and the
                ellipsis ban is untouched because nothing is cut.

                The title says PROFILE, not CV: this button routes to the profile panel, and the row
                in the folder list beside it is the one that now opens the CV itself. */}
            <button
              className="text-left text-sm font-bold text-phx-ink underline-offset-2 hover:underline"
              onClick={() => onOpenCandidate(candidate.id)}
              title={`Open ${candidateDisplayName(candidate.fullName)}'s profile`}
              type="button"
            >
              {candidateDisplayName(candidate.fullName)}
            </button>

            <span className="whitespace-nowrap text-phx-xs font-semibold text-slate-400">
              {candidateStatusLabel(candidate.status)}
            </span>

            {/* The exact text the rule judged, and where it came from. "declared" is the applicant's
                own answer and "cv" is what the extractor read off the document — an admin weighs
                those two very differently, so the row says which it is rather than just quoting it. */}
            {standing.verdict.evidence ? (
              <span className="text-phx-xs text-slate-600" dir="auto">
                <span className="font-semibold text-slate-400">
                  {standing.verdict.source === "declared" ? "They answered: " : "Their CV says: "}
                </span>
                {standing.verdict.evidence}
              </span>
            ) : (
              <span className="text-phx-xs italic text-slate-400">No faculty on the CV</span>
            )}

            <span className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                disabled={busyId === candidate.id}
                onClick={() => answer(candidate.id, "eligible")}
                title={describeBackgroundConfirmation("eligible")}
              >
                {busyId === candidate.id ? "Saving…" : "One of the five"}
              </Button>
              <Button
                disabled={busyId === candidate.id}
                onClick={() => answer(candidate.id, "paramedical")}
                title={describeBackgroundConfirmation("paramedical")}
                variant="secondary"
              >
                Paramedical
              </Button>
            </span>
          </li>
        ))}
      </ul>

      {/* Counted, never hidden. A list that silently stops at 25 reads as a queue of 25. */}
      {shown < rows.length ? (
        <div className="px-3 py-2">
          <Button onClick={() => setShown(shown + PAGE)} variant="secondary">
            Show {Math.min(PAGE, rows.length - shown)} more of {rows.length}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
