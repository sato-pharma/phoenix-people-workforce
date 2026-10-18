"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, FileSearch, UserRound } from "lucide-react";

import { patchJson } from "@/components/recruitment/recruitment-fetch";
import {
  backgroundReviewQueue,
  describeBackgroundConfirmation,
  type BackgroundConfirmationOutcome,
  type BackgroundReviewRow,
} from "@/lib/recruitment/background-review";
import { candidateFolderKindLabels, candidateFolderLabel } from "@/lib/recruitment/candidate-folder";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import type { Candidate } from "@/lib/recruitment/types";
import { adminChipDepthClassName, adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentPanel } from "@/components/recruitment/recruitment-premium";
import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
} from "@/components/ui/form-tokens";

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

  // THE LOOK (2026-10-19 premium sweep): the module's panel — the dark band naming the queue, the
  // count as its chip — so this reads as one of the tab's sections and not a card dropped on it.
  //
  // The band's heading WRAPS. It is set in spaced capitals on the band now, and at that size the
  // old `whitespace-nowrap` would have held it on one line at roughly the full width of a phone —
  // a heading with no room left beside it. The SENTENCE under it wraps for the reason it always
  // has: measured at 375px on 2026-09-12, held at `whitespace-nowrap` it laid out 314px inside a
  // 349px row, and #3743 fixed the identical shape two sections down, where the same class had put
  // the whole tab into a 65px sideways scroll. The count is a short label and keeps its class.
  return (
    <RecruitmentPanel
      count={
        <span className="whitespace-nowrap">
          {total} {total === 1 ? "CV" : "CVs"}
        </span>
      }
      description="Nobody here reaches a district manager until you answer."
      icon={<FileSearch aria-hidden className="h-4 w-4" />}
      title="Degrees waiting for you to check"
    >
      {error ? (
        <p
          className="flex items-start gap-2 border-b border-rose-200 border-l-[3px] border-l-rose-500 bg-rose-50 px-4 py-2.5 text-xs font-semibold text-rose-800"
          role="alert"
        >
          <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
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
    </RecruitmentPanel>
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
    <div className="border-b border-slate-200 last:border-b-0">
      {/* The group's own sub-header: a recessed strip with the orange tick, so the two questions
          read as two halves of the queue rather than as one list with a line through it. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-slate-200 bg-slate-50 px-4 py-2">
        <span aria-hidden="true" className="h-3 w-0.5 self-center bg-orange-500" />
        <span className="whitespace-nowrap text-xs font-black text-slate-800">{heading}</span>
        <span className={`ml-auto whitespace-nowrap border border-slate-200 bg-white px-1.5 text-phx-2xs font-black tabular-nums text-slate-600 ${adminChipDepthClassName}`}>
          {rows.length}
        </span>
        <span className="basis-full text-phx-xs font-medium leading-5 text-slate-500">{note}</span>
      </div>

      <ul className="divide-y divide-slate-100">
        {rows.slice(0, shown).map(({ candidate, standing }) => (
          <li
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-orange-50/40"
            key={candidate.id}
          >
            {/* The NAME wraps. Measured at 375px on 2026-09-02: pinned at `whitespace-nowrap` a real
                candidate's five-part name laid out 335px wide inside a 325px box and painted over
                what sits beside it. A name has no length bound, so this is the one label here bound
                to find a phone too narrow for it — the fits-the-screen rule says wrap, and the
                ellipsis ban is untouched because nothing is cut.

                The title says PROFILE, not CV: this button routes to the profile panel, and the row
                in the folder list beside it is the one that now opens the CV itself. */}
            <button
              className="inline-flex min-w-0 items-start gap-1.5 text-left text-sm font-bold text-slate-950 underline-offset-2 hover:text-orange-700 hover:underline"
              onClick={() => onOpenCandidate(candidate.id)}
              title={`Open ${candidateDisplayName(candidate.fullName)}'s profile`}
              type="button"
            >
              <UserRound aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="min-w-0 break-words">{candidateDisplayName(candidate.fullName)}</span>
            </button>

            <span className={`whitespace-nowrap border border-slate-200 bg-white px-1.5 py-0.5 text-phx-2xs font-bold uppercase tracking-[0.06em] text-slate-500 ${adminChipDepthClassName}`}>
              {candidateStatusLabel(candidate.status)}
            </span>

            {/* Already sitting on one of the two field-force shelves — the reason this row is in the
                queue at all despite being "filed". Named so an admin does not have to go find out
                where the CV already is before deciding whether it belongs there.

                The badge WRAPS. It reads like a label, but it is a clause carrying a FOLDER name,
                and a folder name has no length bound — "Dokki - Mohandseen - Bolak" is a real area
                and "Technical Support and infrastructure Engineer" is a real declared job title.
                Measured on the live tab at 375px on 2026-09-12: held at `whitespace-nowrap` that
                second label takes the whole page to scrollWidth 413 against clientWidth 375 — a
                38px sideways scroll, the same break #3743 fixed two sections down. The widest one
                rendering today is only 265px inside 349px, which is why it had not bitten yet. */}
            {candidate.folder &&
            (candidate.folder.kind === "medical_rep" || candidate.folder.kind === "district_manager") ? (
              <span className="border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-phx-xs font-semibold text-amber-800">
                Filed: {candidateFolderKindLabels[candidate.folder.kind]} ·{" "}
                {candidateFolderLabel(candidate.folder.kind, candidate.folder.key)}
              </span>
            ) : null}

            {/* The exact text the rule judged, and where it came from. "declared" is the applicant's
                own answer and "cv" is what the extractor read off the document — an admin weighs
                those two very differently, so the row says which it is rather than just quoting it. */}
            {standing.verdict.evidence ? (
              <span className="basis-full border-l-2 border-slate-300 pl-2 text-phx-xs leading-5 text-slate-700" dir="auto">
                <span className="font-semibold text-slate-400">
                  {standing.verdict.source === "declared" ? "They answered: " : "Their CV says: "}
                </span>
                {standing.verdict.evidence}
              </span>
            ) : (
              <span className="basis-full border-l-2 border-dashed border-slate-300 pl-2 text-phx-xs italic text-slate-400">
                No faculty on the CV
              </span>
            )}

            {/* The decision pair, in the house's decision colours: green for the answer that sends the
                CV on to the district managers, rose for the one that takes it off their screen. It
                WRAPS under the row on a phone instead of holding its width against the name. */}
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <button
                className={`${phxButtonApproveClassName} ${adminControlDepthClassName} disabled:shadow-none`}
                disabled={busyId === candidate.id}
                onClick={() => answer(candidate.id, "eligible")}
                title={describeBackgroundConfirmation("eligible")}
                type="button"
              >
                {busyId === candidate.id ? "Saving…" : "One of the five"}
              </button>
              <button
                className={`${phxButtonDangerClassName} ${adminControlDepthClassName} disabled:shadow-none`}
                disabled={busyId === candidate.id}
                onClick={() => answer(candidate.id, "paramedical")}
                title={describeBackgroundConfirmation("paramedical")}
                type="button"
              >
                Paramedical
              </button>
            </span>
          </li>
        ))}
      </ul>

      {/* Counted, never hidden. A list that silently stops at 25 reads as a queue of 25. */}
      {shown < rows.length ? (
        <div className="border-t border-slate-100 px-4 py-3">
          <button
            className={`${phxButtonGhostClassName} ${adminControlDepthClassName}`}
            onClick={() => setShown(shown + PAGE)}
            type="button"
          >
            Show {Math.min(PAGE, rows.length - shown)} more of {rows.length}
          </button>
        </div>
      ) : null}
    </div>
  );
}
