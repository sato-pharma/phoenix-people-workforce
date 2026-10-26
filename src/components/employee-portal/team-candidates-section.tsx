"use client";

import { useMemo, useState } from "react";

// The card itself lives in candidate-read-card.tsx, shared with the district folders. Both screens
// show a manager a CV he can read and comment on but must not answer, and the day they stopped being
// one component is the day one of them would quietly lose the View CV button.
import { CandidateReadCard } from "@/components/employee-portal/candidate-read-card";
import { CandidateOpenersProvider } from "@/components/employee-portal/candidate-opened-notice";
import { DistrictFoldersSection } from "@/components/employee-portal/district-folders-section";
import { Card } from "@/components/ui/card";
import type { CandidateCallClaims } from "@/lib/recruitment/candidate-call-claims";
import type { CandidateOpeners } from "@/lib/recruitment/candidate-openers";
import type { DistrictManagerBoard } from "@/lib/recruitment/district-manager-folders";
import { tidyTeamManagers } from "@/lib/recruitment/my-candidates-tidy";
import { managerLabel } from "@/lib/recruitment/person-labels";
import type { Candidate, TeamCandidateFile } from "@/lib/recruitment/types";

/**
 * A manager reading the CVs that sit with the managers below him.
 *
 * The owner, 2026-08-30: *"I want the National Sales Manager to have the authority to filter for one
 * of the district managers reporting to him and see the CVs and candidates in his portal ... and can
 * also give a comment on him. On the CV itself, I mean."*
 *
 * TWO DELIBERATE ABSENCES.
 *
 *   • There are no Interview / Not interested buttons here. The owner asked to see and to comment,
 *     and those are what this does. The answer belongs to the manager the CV was pushed to; a
 *     National Sales Manager pressing it from this screen would overwrite their decision with no
 *     record of whose it was.
 *   • Every manager who is still with the company is listed, including the ones with no CVs at all —
 *     8 of the 12 managers under the two people holding an NSM seat had none on the morning this was
 *     built. A picker that hides them reads as "my other districts are missing", and the fix for that
 *     is a zero, not a gap. The exception (owner, 2026-10-26) is a manager who has LEFT the company and
 *     holds no CV: nothing is waiting there, so they are hidden. One who left but still holds CVs
 *     stays, and the managers holding CVs are listed first (`tidyTeamManagers`).
 */

export type TeamManagerOption = {
  hrId: string;
  fullName: string | null;
  jobTitle: string | null;
  direct: boolean;
  active: boolean;
  cvCount: number;
  awaitingCount: number;
};

/**
 * What a district manager is called in the picker and on the panel heading.
 *
 * The name, or words saying we could not resolve one — never the HR id, which this returned until
 * 2026-09-11. The owner's rule is human-readable names, and an NSM choosing between his districts
 * cannot pick "B-94" off a list.
 */
function teamManagerLabel(manager: TeamManagerOption): string {
  return managerLabel(manager.fullName);
}

export function TeamCandidatesSection({
  managers: allManagers,
  viewerHrId,
}: {
  managers: TeamManagerOption[];
  viewerHrId: string | null;
}) {
  const managers = useMemo(() => tidyTeamManagers(allManagers), [allManagers]);
  const [selected, setSelected] = useState<TeamManagerOption | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  // That manager's OWN areas from the organogram, each with everyone who asked for it. Separate
  // state from `candidates` because it answers a different question — what was sent to him, against
  // what has arrived for his territory — and merging the two would hide which is which.
  const [districtBoards, setDistrictBoards] = useState<DistrictManagerBoard<Candidate>[]>([]);
  const [files, setFiles] = useState<Record<string, TeamCandidateFile[]>>({});
  // Who has said "I will call" each of the CVs sitting with this manager. Read-only here: a National
  // Sales Manager sees the reservation and cannot take one, which is the 2026-08-30 rule that the
  // answer belongs to the manager the CV was sent to.
  const [callClaims, setCallClaims] = useState<CandidateCallClaims>({});
  // Who ELSE has opened each of those CVs, with their title and the time. It arrives with the list
  // for the reason the claims do, and it is what puts the "already opened by" banner on a team card:
  // this reader is not the person the CV was sent to, so the map is loaded for HIM, not for them.
  const [openers, setOpeners] = useState<CandidateOpeners>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (managers.length === 0) return null;

  const open = async (manager: TeamManagerOption) => {
    // A second press on the same chip closes it. The list of managers stays on screen either way,
    // so there is never a state where the picker has vanished behind what it opened.
    if (selected && selected.hrId === manager.hrId) {
      setSelected(null);
      setCandidates(null);
      setDistrictBoards([]);
      setFiles({});
      setCallClaims({});
      setOpeners({});
      return;
    }
    setSelected(manager);
    setCandidates(null);
    setDistrictBoards([]);
    setFiles({});
    setCallClaims({});
    setOpeners({});
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(
        `/api/recruitment/hiring-manager/team/${encodeURIComponent(manager.hrId)}/candidates`,
      );
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(typeof data.message === "string" ? data.message : "Failed to load those candidates.");
      }
      setCandidates(Array.isArray(data.candidates) ? (data.candidates as Candidate[]) : []);
      setDistrictBoards(
        Array.isArray(data.districtBoards) ? (data.districtBoards as DistrictManagerBoard<Candidate>[]) : [],
      );
      // The CV files arrive WITH the list. Every card can then offer View CV / Download the moment
      // it renders, instead of each one asking separately and the control turning up much later.
      setFiles(
        data.files && typeof data.files === "object"
          ? (data.files as Record<string, TeamCandidateFile[]>)
          : {},
      );
      // The claims arrive WITH the list, exactly like the files and for a sharper reason: the claim
      // is what decides whether a phone number is printed, so a card still waiting to hear back
      // would show "Hidden" on a CV the reader can already see is reserved.
      setCallClaims(
        data.callClaims && typeof data.callClaims === "object"
          ? (data.callClaims as CandidateCallClaims)
          : {},
      );
      setOpeners(
        data.openers && typeof data.openers === "object" ? (data.openers as CandidateOpeners) : {},
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load those candidates.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Your team&apos;s candidates</h2>
        <p className="text-xs text-slate-500">
          CVs the recruitment team sent to the managers reporting to you. Read them and add a comment; the answer stays
          with the manager it was sent to.
        </p>
      </div>

      {/* IT WRAPS; it does not scroll. The note here used to say the owner's rule is that text
          "never wraps and is never cut with an ellipsis" — only the second half of that is his
          rule. AGENTS.md §4 says in as many words that where the no-ellipsis rule collides with
          the no-horizontal-scroll rule, WRAPPING WINS. So the chips flow onto a second line and
          every manager's name still stays whole.

          `shrink-0` stays on each chip and is not the trap it resembles: a `shrink-0` CHILD of a
          wrapping row wraps to the next line rather than being squeezed, which is what is wanted.
          The inert case AGENTS.md warns about is `shrink-0` on the wrapping element ITSELF. */}
      <div className="flex flex-wrap gap-2 pb-1">
        {managers.map((manager) => {
          const isOpen = selected?.hrId === manager.hrId;
          return (
            <button
              className={`max-w-full rounded-lg border px-3 py-2 text-left transition ${
                isOpen
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-gray-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
              key={manager.hrId}
              onClick={() => void open(manager)}
              type="button"
            >
              <span className="block text-sm font-semibold">
                {teamManagerLabel(manager)}
                {manager.active ? "" : " · left the company"}
              </span>
              <span
                className={`block text-phx-xs ${isOpen ? "text-slate-300" : "text-slate-500"}`}
              >
                {manager.jobTitle?.trim() || "No title recorded"}
                {manager.direct ? "" : " · indirect"} ·{" "}
                {manager.cvCount === 0
                  ? "No CVs"
                  : `${manager.cvCount} ${manager.cvCount === 1 ? "CV" : "CVs"}${
                      manager.awaitingCount > 0 ? `, ${manager.awaitingCount} awaiting` : ""
                    }`}
              </span>
            </button>
          );
        })}
      </div>

      {error ? <p className="text-xs text-rose-600">{error}</p> : null}

      {selected ? (
        <CandidateOpenersProvider openers={openers}>
          <div className="space-y-3">
            {busy ? (
              <p className="text-xs text-slate-400">Loading {teamManagerLabel(selected)}&apos;s candidates…</p>
            ) : candidates && candidates.length === 0 ? (
              <Card className="rounded-lg border border-gray-200 bg-white p-6 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
                <p className="text-sm font-semibold text-slate-700">
                  No CVs have been sent to {teamManagerLabel(selected)}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  This is the real answer, not a filter — the recruitment team has not sent them anyone yet.
                </p>
              </Card>
            ) : (
              (candidates ?? []).map((candidate) => (
                <CandidateReadCard
                  candidate={candidate}
                  claim={callClaims[candidate.id] ?? null}
                  files={files[candidate.id] ?? []}
                  key={candidate.id}
                  viewerHrId={viewerHrId}
                />
              ))
            )}

            {/* His folders, under what was sent to him. The owner, 2026-08-31: "when he choose his
                district manager, he can see their folders and the CV in per folder." Rendered by the
                same component the manager himself sees, so the two never drift into different screens
                of the same thing — only the heading changes, because it is now somebody else's. */}
            {busy ? null : (
              <DistrictFoldersSection
                boards={districtBoards.filter((board) => board.intake !== "district_managers")}
                callClaims={callClaims}
                files={files}
                heading={`${teamManagerLabel(selected)}'s areas`}
                subheading={`Every area ${teamManagerLabel(selected)} holds in the organogram, and the CVs of applicants who asked to work in it.`}
                viewerHrId={viewerHrId}
              />
            )}

            {/* The selected manager's own district-manager applicants, when he is a REGIONAL manager
                with districts under him. Split from his areas above rather than merged, for the same
                reason they are two sections on the viewer's own page: these people applied for a
                different job, and one heading cannot describe both truthfully. Renders nothing when
                the manager picked is a district manager, which is the ordinary case. */}
            {busy ? null : (
              <DistrictFoldersSection
                boards={districtBoards.filter((board) => board.intake === "district_managers")}
                callClaims={callClaims}
                files={files}
                heading={`District manager applicants under ${teamManagerLabel(selected)}`}
                subheading={`People applying to run one of the districts ${teamManagerLabel(selected)} covers, filed by the district they asked for.`}
                viewerHrId={viewerHrId}
              />
            )}
          </div>
        </CandidateOpenersProvider>
      ) : null}
    </section>
  );
}
