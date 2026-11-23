"use client";

/**
 * Phoenix CRM — Place checks: the Ready lane's one press.
 *
 * "Approve all N" answers every decision in the lane: each ready building, the customers waiting behind
 * it, then the ready clinics (`readyLaneRequests`). The count on the button is decisions, the unit of the
 * page's one number.
 *
 * 🔴 IT IS THE ROWS' OWN REQUESTS, ONE AFTER ANOTHER — never a second decision path. It holds the board
 * still exactly as a tick-box run does (`holdBoardForBulkRun`), marks each row as its own control would
 * (`markRowSaved`), counts "already decided" as an answer, and reads the page again when it ends.
 *
 * 🔴 A CUSTOMER IS LEFT ALONE WHEN HIS BUILDING'S OWN APPROVAL FAILS, and the report names him: an approval
 * behind a building that could not be approved would settle his review and leave him uncounted.
 *
 * 🔴 NOTHING IS APPROVED UNTIL HE PRESSES. The lane is what the system would approve; the press is his.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { holdBoardForBulkRun, useBulkRunGoing } from "@/components/phoenix-crm/place-check-bulk";
import { approvalOutcome, bulkOutcomeSummary, isAlreadyDecided, markRowSaved, type PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { readyLaneRequests } from "@/lib/phoenix-crm/place-check-lanes";

/** Said of a customer whose building's own approval failed in the same run. */
export const READY_LEFT_BEHIND_BUILDING = "Left as it is: its building could not be approved in this run.";

export function ReadyLaneBar({ board }: { board: PlaceCheckBoard }) {
  const { readyGroups, readyReviews, stayOnView } = board;
  const router = useRouter();
  const anyRunGoing = useBulkRunGoing();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, of: 0 });
  const [failures, setFailures] = useState<ReadonlyArray<{ name: string; problem: string }>>([]);
  const [summary, setSummary] = useState<string | null>(null);

  // 🔴 A RUN DIES WITH ITS BAR, like a tick-box run: leaving the page stops it before its next row and
  // hands the board back at once.
  const alive = useRef(true);
  const letGo = useRef<(() => void) | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      letGo.current?.();
      letGo.current = null;
    };
  }, []);

  const decisions = readyReviews.length + readyGroups.length;

  async function approveAll() {
    if (running || anyRunGoing || decisions === 0) return;
    const release = holdBoardForBulkRun();
    if (!release) return;
    letGo.current = release;
    const requests = readyLaneRequests({ reviews: readyReviews, groups: readyGroups });
    // The lane empties as the run lands; he stays on it, with the report, instead of being moved off.
    stayOnView();
    setRunning(true);
    setProgress({ done: 0, of: requests.length });
    setFailures([]);
    setSummary(null);
    // The run reads the page itself when it ends, and its rows are owed from the first one (`place-check-bulk.tsx`).
    placeCheckReread.cancel();
    placeCheckReread.owe();
    const failed: Array<{ name: string; problem: string }> = [];
    const landed: PlaceCheckOutcome[] = [];
    const failedBuildings = new Set<string>();
    try {
      for (const request of requests) {
        if (!alive.current) break;
        if (request.kind === "customer" && request.building !== null && failedBuildings.has(request.building)) {
          failed.push({ name: request.name, problem: READY_LEFT_BEHIND_BUILDING });
        } else {
          try {
            const answer = await crmPost<unknown>(request.route, request.body, "decided");
            // A building's own control reads "Approved"; a customer's reads whether he waits for his building.
            const outcome = request.kind === "building" ? "approved" : approvalOutcome(answer, "approved");
            landed.push(outcome);
            markRowSaved(request.subject, outcome);
          } catch (error) {
            if (isAlreadyDecided(error)) {
              landed.push("already");
              markRowSaved(request.subject, "already");
            } else {
              failed.push({ name: request.name, problem: messageOf(error) });
              if (request.kind === "building" && request.building !== null) failedBuildings.add(request.building);
            }
          }
        }
        setProgress((current) => ({ ...current, done: current.done + 1 }));
      }
    } finally {
      letGo.current?.();
      letGo.current = null;
    }
    if (!alive.current) return;
    setFailures(failed);
    setSummary(landed.length > 0 ? bulkOutcomeSummary(landed) : null);
    setRunning(false);
    placeCheckReread.refreshNow(() => router.refresh());
  }

  if (decisions === 0 && !running && summary === null && failures.length === 0) return null;

  return (
    <div className="min-w-0 space-y-2 border border-l-4 border-slate-200 border-l-emerald-600 bg-white px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 basis-60 break-words text-sm text-slate-700">
          {decisions > 0
            ? "Every check passed on these, and you have approved this kind of evidence 19 times in 20. Nothing is approved until you press."
            : "Nothing is left in this lane."}
        </p>
        {decisions > 0 || running ? (
          <CrmButton busy={running} disabled={anyRunGoing} onClick={() => void approveAll()} variant="primary">
            {running ? `Approving ${progress.done} of ${progress.of}` : `Approve all ${decisions}`}
          </CrmButton>
        ) : null}
      </div>
      {summary ? (
        <p className="break-words text-sm font-semibold text-slate-900" role="status">
          {summary}
        </p>
      ) : null}
      {failures.length > 0 ? (
        <CrmNote title={`Not approved: ${failures.length}`} tone="bad">
          <ul className="space-y-0.5">
            {failures.map((failure, index) => (
              <li key={`${failure.name}-${index}`} className="break-words" dir="auto">
                {failure.name}: {failure.problem}
              </li>
            ))}
          </ul>
        </CrmNote>
      ) : null}
    </div>
  );
}
