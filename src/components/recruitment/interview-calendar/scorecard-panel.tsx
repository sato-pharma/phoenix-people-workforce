"use client";

// The panel's scorecards for one interview (owner, 2026-09-26 — Tier 2). Everyone who conducted it
// files their OWN: an overall rating 1-5 and a verdict (Strong yes / Yes / No), plus an optional note.
// They are shown side by side. This records the panel's opinion — it moves nothing in Recruitment;
// the interview OUTCOME above still does that. Only someone on the interview sees or files a scorecard.

import { Loader2, Star } from "lucide-react";
import { useState } from "react";

import { RecruitmentPill, type RecruitmentPillTone } from "@/components/recruitment/recruitment-premium";
import { Action } from "@/components/recruitment/workstation/workstation-look";
import {
  INTERVIEW_VERDICTS,
  INTERVIEW_VERDICT_LABEL,
  type InterviewBooking,
  type InterviewVerdict,
} from "@/lib/recruitment/interview-calendar-types";

import { type CalendarApi, reasonText } from "./calendar-api";
import { ErrorLine, PanelHeading } from "./calendar-dialog";
import { phxLabelTextClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

const VERDICT_TONE: Record<InterviewVerdict, RecruitmentPillTone> = { no: "rose", strong_yes: "emerald", yes: "sky" };

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star className={n <= rating ? "h-3.5 w-3.5 fill-orange-500 text-orange-500" : "h-3.5 w-3.5 text-slate-300"} key={n} />
      ))}
    </span>
  );
}

export function ScorecardPanel({ api, booking, onChanged }: { api: CalendarApi; booking: InterviewBooking; onChanged: (booking: InterviewBooking) => void }) {
  const mine = booking.scorecards.find((scorecard) => scorecard.mine) ?? null;
  const [rating, setRating] = useState<number>(mine?.rating ?? 0);
  const [verdict, setVerdict] = useState<InterviewVerdict | null>(mine?.verdict ?? null);
  const [comment, setComment] = useState(mine?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing to show and nothing to file: draw nothing.
  if (booking.scorecards.length === 0 && !booking.canScoreInterview) return null;

  async function save() {
    if (rating < 1 || !verdict) {
      setError("Give a rating from 1 to 5 and a verdict.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api.post(`/bookings/${encodeURIComponent(booking.id)}/scorecard`, { comment: comment.trim(), rating, verdict });
      onChanged(data.booking as InterviewBooking);
    } catch (reason) {
      setError(reasonText(reason, "The scorecard could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  const others = booking.scorecards.filter((scorecard) => !scorecard.mine);

  return (
    <section aria-label="Scorecards" className="border-t border-slate-200 pt-3">
      <PanelHeading
        aside={
          booking.scorecards.length > 0 ? (
            <span className="text-[11px] font-bold tabular-nums text-slate-500">{booking.scorecards.length} filed</span>
          ) : null
        }
      >
        Scorecards
      </PanelHeading>

      {others.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-2">
          {others.map((scorecard) => (
            <li className={`border border-slate-200 border-l-[3px] border-l-orange-400 bg-white px-3 py-2 ${adminSoftDepthClassName}`} key={scorecard.evaluatorHrId}>
              <p className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[12px]">
                <span className="min-w-0 break-words font-bold text-slate-800">{scorecard.evaluatorName}</span>
                <span className="inline-flex items-center gap-2">
                  <Stars rating={scorecard.rating} />
                  <RecruitmentPill tone={VERDICT_TONE[scorecard.verdict]}>{INTERVIEW_VERDICT_LABEL[scorecard.verdict]}</RecruitmentPill>
                </span>
              </p>
              {scorecard.comment ? <p className="mt-0.5 whitespace-pre-wrap break-words text-[12px] text-slate-600">{scorecard.comment}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {booking.canScoreInterview ? (
        <div className={`border border-slate-200 border-l-[3px] border-l-orange-500 bg-white p-3 ${adminSoftDepthClassName}`}>
          <p className={phxLabelTextClassName}>{mine ? "Your scorecard" : "Add your scorecard"}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <div aria-label="Rating" className="inline-flex items-center gap-1" role="group">
              {[1, 2, 3, 4, 5].map((n) => (
                <button aria-label={`${n} out of 5`} aria-pressed={rating === n} className="p-0.5" key={n} onClick={() => setRating(n)} type="button">
                  <Star className={n <= rating ? "h-5 w-5 fill-orange-500 text-orange-500" : "h-5 w-5 text-slate-300 hover:text-orange-300"} />
                </button>
              ))}
            </div>
            <div aria-label="Verdict" className="flex flex-wrap" role="group">
              {INTERVIEW_VERDICTS.map((option, index) => (
                <button
                  aria-pressed={verdict === option}
                  className={`border px-2.5 py-1.5 text-[12px] font-bold leading-none ${index > 0 ? "-ml-px" : ""} ${verdict === option ? "relative border-slate-900 bg-slate-900 text-white shadow-[inset_0_-2px_0_#f97316]" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                  key={option}
                  onClick={() => setVerdict(option)}
                  type="button"
                >
                  {INTERVIEW_VERDICT_LABEL[option]}
                </button>
              ))}
            </div>
          </div>
          <textarea
            className={`${phxTextareaClassName} mt-2 block`}
            maxLength={2000}
            onChange={(event) => setComment(event.target.value)}
            placeholder="A note on your rating (optional)"
            rows={2}
            value={comment}
          />
          {error ? <div className="mt-1.5"><ErrorLine>{error}</ErrorLine></div> : null}
          <div className="mt-2 flex justify-end">
            <Action disabled={busy} onClick={() => void save()} tone="primary">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}
              {mine ? "Update my scorecard" : "Save my scorecard"}
            </Action>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">Your rating is an opinion — it does not move the candidate; the outcome above does that.</p>
        </div>
      ) : null}
    </section>
  );
}
