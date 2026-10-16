"use client";

import type { ReactNode } from "react";

import {
  CandidateCallControl,
  CandidateCallNotice,
  hiddenPhoneText,
  useCandidateCall,
} from "@/components/employee-portal/candidate-call-control";
import { CandidateCommentThread } from "@/components/employee-portal/candidate-comment-thread";
import { CandidateOpenedNotice } from "@/components/employee-portal/candidate-opened-notice";
import { CandidateCvActions } from "@/components/employee-portal/candidate-cv-actions";
import { Card } from "@/components/ui/card";
import { APPLIED_FOR_SOURCE_LABEL, candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import type { CandidateCallClaim } from "@/lib/recruitment/candidate-call-claims";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { Candidate, TeamCandidateFile } from "@/lib/recruitment/types";
import { adminChipDepthClassName } from "@/components/admin/admin-design-tokens";

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
  claim: initialClaim = null,
  canCall = false,
  files,
  onSkipped,
  unrestricted = false,
  viewerHrId,
  footer,
}: {
  candidate: Candidate;
  /**
   * Who has said "I will call" this candidate, loaded with the list.
   *
   * Shown on BOTH screens, and that is the point of the feature: the owner, 2026-09-09 — *"every
   * other manager receiving this CV when open the same CV shows that Ahmed will call this CV"*. The
   * same applicant genuinely sits in three managers' folders and on a National Sales Manager's team
   * view at once, and until now none of those readers could tell that another had taken him.
   */
  claim?: CandidateCallClaim | null;
  /**
   * May this reader take the CV, or only see who has?
   *
   * TRUE only in a manager's OWN area folders. False on the team screen, where a National Sales
   * Manager reads what sits with the managers below him — the 2026-08-30 rule that the answer stays
   * with the manager the CV was sent to, which taking the call from above would break in a new
   * shape. The API enforces the same boundary; this only keeps the screen honest.
   */
  canCall?: boolean;
  files: TeamCandidateFile[];
  /** Called after a Skip, so the folder can drop the card in place. Own folders only. */
  onSkipped?: (candidateId: string) => void;
  /**
   * TRUE on the manager's OWN folders, which hold only CVs a person sent to him: the phone number and
   * the file are his without any reservation (owner, 2026-10-16).
   */
  unrestricted?: boolean;
  viewerHrId: string | null;
  /**
   * An optional action strip below the comment thread. Passed ONLY from the district folders, where
   * a manager may hand a CV back to the administrator; the team screen leaves it empty, because
   * returning is not the reader's to do there. See CandidateReturnControl.
   */
  footer?: ReactNode;
}) {
  const appliedFor = candidateRowAppliedFor(candidate);
  const call = useCandidateCall(candidate, initialClaim, viewerHrId, unrestricted);
  return (
    <Card className="space-y-4 rounded-lg border border-gray-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.08)] sm:p-6" id={`candidate-${candidate.id}`}>
      {/* Who has taken this CV, before anything else on the card. On the team screen this is the ONLY
          part of the feature the reader gets, and it is the part he needs: he can see that a CV
          sitting with one of his managers has been claimed, and by whom. */}
      <CandidateCallNotice claim={call.claim} viewerHrId={viewerHrId} />

      {/* Who ELSE has read this CV, by name, title and time. The district folders are where it
          matters most: one applicant sits in the same area's folder on CNS, Anti-infective and Pedia,
          so three managers are handed one person and none could tell a colleague had already looked. */}
      <CandidateOpenedNotice candidateId={candidate.id} />

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
        <span className={`inline-block whitespace-nowrap rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-phx-xs font-semibold text-slate-600 ${adminChipDepthClassName}`}>
          {candidateStatusLabel(candidate.status)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {/* Hidden unless this reader is the one who took the CV. On the team screen he never can be,
            so it reads a plain "Hidden" rather than pointing at a button that is not there. */}
        <Field label="Phone" value={call.phone ?? (unrestricted ? null : hiddenPhoneText(canCall))} />
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

      <CandidateCvActions
        candidateId={candidate.id}
        candidateName={candidate.fullName}
        initialFiles={files}
        showPhoneNumbers={call.mine}
      />

      {/* The owner's two buttons, on the folder screen where several managers see one CV. `skip`
          here is his OWN pass — it clears the card from his folder and leaves the candidate in front
          of everybody else, exactly as returning it to the administrator does. Nobody asked him for
          an answer on this CV, so there is nothing to answer and no note to require. */}
      <CandidateCallControl
        canAct={canCall}
        candidateId={candidate.id}
        claim={call.claim}
        onChanged={call.apply}
        skip={canCall && onSkipped ? { onSkipped } : undefined}
        viewerHrId={viewerHrId}
      />

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
