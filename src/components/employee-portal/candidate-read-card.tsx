"use client";

import type { ReactNode } from "react";

import { CandidateCommentThread } from "@/components/employee-portal/candidate-comment-thread";
import { CandidateCvActions } from "@/components/employee-portal/candidate-cv-actions";
import { Card } from "@/components/ui/card";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { Candidate, TeamCandidateFile } from "@/lib/recruitment/types";

/**
 * One CV a manager can READ but not answer: everything needed to form an opinion, and nowhere to
 * decide.
 *
 * TWO SCREENS RENDER THIS, and they are two halves of the same idea.
 *
 *   • Your team's candidates — a National Sales Manager reading what sits with the district managers
 *     below him. The owner, 2026-08-30: "see the CVs and candidates in his portal ... and can also
 *     give a comment on him."
 *   • The district folders — the CVs that arrived for one of his own areas, 2026-08-31: "he click
 *     the folder and open he find all CVs."
 *
 * Neither screen carries Interview / Not interested buttons, and the absence is deliberate in both.
 * On the team screen the answer belongs to the manager the CV was pushed to, and pressing it from
 * above would overwrite their decision with no record of whose it was. In a district folder nobody
 * has been asked for an answer yet — the CV is there to be found, and the recruitment team still
 * runs the process. What both readers get is the CV itself and a comment thread, which is what was
 * asked for.
 *
 * The status pill is prominent on purpose: the first thing a manager needs to know about a CV in
 * front of him is whether somebody has already dealt with it.
 */
export function CandidateReadCard({
  candidate,
  files,
  viewerHrId,
  footer,
}: {
  candidate: Candidate;
  files: TeamCandidateFile[];
  viewerHrId: string | null;
  /**
   * An optional action strip below the comment thread. Passed ONLY from the district folders, where
   * a manager may hand a CV back to the administrator; the team screen leaves it empty, because
   * returning is not the reader's to do there. See CandidateReturnControl.
   */
  footer?: ReactNode;
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
        {/* What the applicant ASKED for, which is what put this CV in a district folder at all. Kept
            beside the governorate on purpose — the two disagree often, and a manager comparing them
            is reading the difference between where somebody lives and where they will work. */}
        <Field label="Area they asked for" value={candidate.preferredAreaName} />
        <Field label="Current job title" value={candidate.currentJobTitle} />
        <Field label="Current employer" value={candidate.currentEmployer} />
        <Field
          label="Years of experience"
          value={candidate.yearsExperience === null ? null : String(candidate.yearsExperience)}
        />
        <Field label="CV received" value={cairoDateTime(candidate.createdAt)} />
        <Field
          label="Sent to them"
          value={candidate.managerNotified ? cairoDateTime(candidate.managerNotified.sentAt) : null}
        />
        <Field label="Their answer" value={candidate.statusNote?.trim() ? candidate.statusNote : null} />
      </div>

      <CandidateCvActions candidateId={candidate.id} initialFiles={files} />

      <CandidateCommentThread candidateId={candidate.id} viewerHrId={viewerHrId} />

      {footer ? <div className="border-t border-slate-100 pt-3">{footer}</div> : null}
    </Card>
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
