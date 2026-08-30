"use client";

import { useState } from "react";

import { CandidateCommentThread } from "@/components/employee-portal/candidate-comment-thread";
import { CandidateCvActions } from "@/components/employee-portal/candidate-cv-actions";
import { Card } from "@/components/ui/card";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
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
 *   • Every manager is listed, including the ones with no CVs at all — 8 of the 12 managers under
 *     the two people holding an NSM seat had none on the morning this was built. A picker that hides
 *     them reads as "my other districts are missing", and the fix for that is a zero, not a gap.
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

function managerLabel(manager: TeamManagerOption): string {
  return manager.fullName?.trim() || manager.hrId;
}

export function TeamCandidatesSection({
  managers,
  viewerHrId,
}: {
  managers: TeamManagerOption[];
  viewerHrId: string | null;
}) {
  const [selected, setSelected] = useState<TeamManagerOption | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [files, setFiles] = useState<Record<string, TeamCandidateFile[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (managers.length === 0) return null;

  const open = async (manager: TeamManagerOption) => {
    // A second press on the same chip closes it. The list of managers stays on screen either way,
    // so there is never a state where the picker has vanished behind what it opened.
    if (selected && selected.hrId === manager.hrId) {
      setSelected(null);
      setCandidates(null);
      setFiles({});
      return;
    }
    setSelected(manager);
    setCandidates(null);
    setFiles({});
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
      // The CV files arrive WITH the list. Every card can then offer View CV / Download the moment
      // it renders, instead of each one asking separately and the control turning up much later.
      setFiles(
        data.files && typeof data.files === "object"
          ? (data.files as Record<string, TeamCandidateFile[]>)
          : {},
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

      {/* Horizontal scroll rather than wrapping: the owner's rule is that text never wraps and is
          never cut with an ellipsis, and a manager's full name plus their title does not fit a chip
          on a phone. The row scrolls; every name stays whole. */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {managers.map((manager) => {
          const isOpen = selected?.hrId === manager.hrId;
          return (
            <button
              className={`shrink-0 whitespace-nowrap rounded-lg border px-3 py-2 text-left transition ${
                isOpen
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-gray-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
              key={manager.hrId}
              onClick={() => void open(manager)}
              type="button"
            >
              <span className="block whitespace-nowrap text-sm font-semibold">
                {managerLabel(manager)}
                {manager.active ? "" : " · left the company"}
              </span>
              <span
                className={`block whitespace-nowrap text-phx-xs ${isOpen ? "text-slate-300" : "text-slate-500"}`}
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
        <div className="space-y-3">
          {busy ? (
            <p className="text-xs text-slate-400">Loading {managerLabel(selected)}&apos;s candidates…</p>
          ) : candidates && candidates.length === 0 ? (
            <Card className="rounded-lg border border-gray-200 bg-white p-6 text-center shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
              <p className="text-sm font-semibold text-slate-700">
                No CVs have been sent to {managerLabel(selected)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                This is the real answer, not a filter — the recruitment team has not sent them anyone yet.
              </p>
            </Card>
          ) : (
            (candidates ?? []).map((candidate) => (
              <TeamCandidateCard
                candidate={candidate}
                files={files[candidate.id] ?? []}
                key={candidate.id}
                viewerHrId={viewerHrId}
              />
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="whitespace-nowrap text-phx-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-sm text-slate-700" dir="auto">
        {value?.trim() ? value : "—"}
      </p>
    </div>
  );
}

/**
 * One CV as the manager above sees it: everything needed to form an opinion, and nowhere to decide.
 *
 * The status pill is what the manager below has already answered, and it is shown prominently on
 * purpose — the first thing a National Sales Manager needs to know about a CV in his district is
 * whether his district manager has dealt with it yet.
 */
function TeamCandidateCard({
  candidate,
  files,
  viewerHrId,
}: {
  candidate: Candidate;
  files: TeamCandidateFile[];
  viewerHrId: string | null;
}) {
  const appliedFor = candidateRowAppliedFor(candidate);
  return (
    <Card className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-slate-900" dir="auto">
            {candidate.fullName}
          </p>
          <p
            className="text-xs text-slate-500"
            title={
              appliedFor.source
                ? `${APPLIED_FOR_SOURCE_LABEL[appliedFor.source]}: ${appliedFor.evidence}`
                : undefined
            }
          >
            {appliedFor.text ? `Applying for ${appliedFor.text}` : "No role stated on the application"}
          </p>
        </div>
        <span className="inline-block whitespace-nowrap rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-phx-xs font-semibold text-slate-600">
          {candidateStatusLabel(candidate.status)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Phone" value={candidate.phone} />
        <Field label="Email" value={candidate.email} />
        <Field label="Governorate" value={candidate.governorate} />
        <Field label="Current job title" value={candidate.currentJobTitle} />
        <Field label="Current employer" value={candidate.currentEmployer} />
        <Field
          label="Years of experience"
          value={candidate.yearsExperience === null ? null : String(candidate.yearsExperience)}
        />
        <Field label="CV received" value={cairoDateTime(candidate.createdAt)} />
        <Field label="Sent to them" value={candidate.managerNotified ? cairoDateTime(candidate.managerNotified.sentAt) : null} />
        <Field
          label="Their answer"
          value={candidate.statusNote?.trim() ? candidate.statusNote : null}
        />
      </div>

      <CandidateCvActions candidateId={candidate.id} initialFiles={files} />

      <CandidateCommentThread candidateId={candidate.id} viewerHrId={viewerHrId} />
    </Card>
  );
}
