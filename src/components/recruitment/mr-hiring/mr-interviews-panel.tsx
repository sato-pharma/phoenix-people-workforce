"use client";

// Recruitment / Medical Rep hiring — "My Medical Rep interviews", at the top of a manager's My
// Candidates in the portal. The DSM and the NSM see each Medical Rep interview booked with them: when,
// the Zoom link or the place, and — once it has ended — the form the email makes mandatory (§6: the
// DSM's feedback; §8: the NSM's result and recommendation). The form opens in the hiring journey, beside
// the candidate's CV and application, so nobody evaluates a candidate without them in view (owner,
// 7 Nov 2026). The interview-booked notice links here.
//
// Rendered only for a manager who is on at least one Medical Rep interview, so nobody else sees an
// empty panel. The rows come from the server with the salary already removed for this viewer; `null`
// means the read failed, and the page says so instead of showing no interviews.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Stethoscope } from "lucide-react";

import { RecruitmentPanel, RecruitmentPill } from "@/components/recruitment/recruitment-premium";
import { MrJourneyDrawer } from "@/components/recruitment/mr-hiring/mr-journey-drawer";
import { phxButtonAccentClassName, phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { portalCandidatesHref } from "@/lib/recruitment/candidate-page-link";
import { cairoWhen, mrStageHeadline, mrStageStateLine, mrStageTone } from "@/lib/recruitment/mr-hiring/display";
import type { MrInterviewRow } from "@/lib/recruitment/mr-hiring/rows";
import { MR_ROUND_LABELS } from "@/lib/recruitment/mr-hiring/vocabulary";

/** The journey sheet this manager has open, and the form it opens with beside the CV, if any. */
type Open = { candidateId: string; action: "result" | "recommend" | null } | null;

export function MrInterviewsPanel({ rows }: { rows: MrInterviewRow[] | null }) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  if (rows === null) {
    return (
      <p className="mb-6 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
        Your Medical Rep interviews could not be loaded just now. Refresh the page to try again.
      </p>
    );
  }
  if (rows.length === 0) return null;

  return (
    <div className="mb-6 scroll-mt-24" id="mr-interviews">
      <RecruitmentPanel
        count={rows.length}
        description="Medical Rep interviews booked with you. After each interview, write your feedback here — it is mandatory, and HR decides without it once the interview is over."
        icon={<Stethoscope aria-hidden="true" className="h-4 w-4" />}
        title="My Medical Rep interviews"
      >
        <ul className="divide-y divide-slate-200">
          {rows.map((row) => {
            return (
              <li className="px-4 py-3 sm:px-5" key={row.candidateId}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 grow basis-64">
                    <p className="break-words text-sm font-bold text-slate-900">{row.name}</p>
                    <p className="break-words text-xs text-slate-500">{[row.area, row.governorate].filter(Boolean).join(" · ") || "No area"}</p>
                    <div className="mt-2">
                      <RecruitmentPill tone={mrStageTone(row.stage)}>{mrStageHeadline(row.stage)}</RecruitmentPill>
                    </div>
                    <p className="mt-1 break-words text-xs text-slate-600">{mrStageStateLine(row.stage)}</p>
                    <ul className="mt-2 space-y-1">
                      {row.mine.map((booking) => (
                        <li className="break-words text-xs text-slate-700" key={booking.id}>
                          <span className="font-bold">{booking.round ? MR_ROUND_LABELS[booking.round] : "Interview"}</span> ·{" "}
                          {cairoWhen(booking.startsAt)} Cairo ·{" "}
                          {booking.platform === "zoom" ? (
                            booking.zoomJoinUrl ? (
                              <a className="font-bold text-orange-700 underline" href={booking.zoomJoinUrl} rel="noreferrer" target="_blank">
                                Join on Zoom
                              </a>
                            ) : (
                              "Zoom — the link is on the interview calendar"
                            )
                          ) : (
                            `In person · ${booking.location?.trim() || "Head office"}`
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {row.can.record ? (
                      <button className={phxButtonAccentClassName} onClick={() => setOpen({ action: "result", candidateId: row.candidateId })} type="button">
                        {row.can.record === "dsm" ? "Write your feedback" : row.can.record === "rsm" ? "Write your evaluation" : "Record your result"}
                      </button>
                    ) : null}
                    {row.can.recommend ? (
                      <button className={phxButtonAccentClassName} onClick={() => setOpen({ action: "recommend", candidateId: row.candidateId })} type="button">
                        Write your recommendation
                      </button>
                    ) : null}
                    <button className={phxButtonGhostClassName} onClick={() => setOpen({ action: null, candidateId: row.candidateId })} type="button">
                      CV, application and journey
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </RecruitmentPanel>
      {open ? (
        <MrJourneyDrawer
          candidateHref={portalCandidatesHref(open.candidateId)}
          candidateId={open.candidateId}
          initialAction={open.action}
          key={open.candidateId}
          onChanged={() => router.refresh()}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
