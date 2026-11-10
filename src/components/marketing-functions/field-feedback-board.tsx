import Link from "next/link";

import { phxButtonAccentClassName } from "@/components/ui/form-tokens";
import { shortDateLabel } from "@/lib/marketing-functions/months";
import type { RemarkTrend, RepTrack, TeamGap } from "@/lib/marketing-functions/tracking";
import type { FieldFeedback } from "@/lib/marketing-functions/types";
import {
  CALL_RATING_LABELS,
  CALL_REMARKS,
  FIELD_ACTION_OWNER_LABELS,
  FIELD_ACTION_OWNERS,
  FIELD_FEEDBACK_HELPS,
  FIELD_FEEDBACK_HELPS_INTRO,
  FIELD_FEEDBACK_OBJECTIVE,
  FIELD_FEEDBACK_OVER_TIME,
  FIELD_FEEDBACK_PURPOSE,
  FIELD_VISIT_TYPE_LABELS,
  type CallRating,
  type CallRemarkKey,
} from "@/lib/marketing-functions/vocabulary";
import { cn } from "@/lib/utils";

// The Marketing Field Visit Feedback board: the forms, and the Rep Tracking that turns them into what
// her email asks for — strengths, recurring gaps, and who should work on each.

export type FieldFeedbackTab = "forms" | "tracking";

type Props = {
  tab: FieldFeedbackTab;
  forms: FieldFeedback[];
  tracks: RepTrack[];
  teamGaps: TeamGap[];
  basePath: string;
  canCreate: boolean;
  showAuthor: boolean;
};

const RATING_SWATCH: Record<CallRating, string> = {
  excellent: "bg-slate-900 text-white border-slate-900",
  good: "bg-slate-200 text-slate-900 border-slate-400",
  average: "bg-orange-100 text-orange-900 border-orange-400",
  poor: "bg-rose-100 text-rose-900 border-rose-400",
};

const TREND_LABEL: Record<RemarkTrend, string> = {
  up: "Better than last visit",
  down: "Worse than last visit",
  same: "Same as last visit",
  new: "First rating",
};

const TREND_MARK: Record<RemarkTrend, string> = { up: "▲", down: "▼", same: "=", new: "•" };

function remarkLabel(key: CallRemarkKey): string {
  return CALL_REMARKS.find((remark) => remark.key === key)?.label ?? key;
}

function Tabs({ tab, basePath }: { tab: FieldFeedbackTab; basePath: string }) {
  const entries: { key: FieldFeedbackTab; label: string }[] = [
    { key: "forms", label: "Forms" },
    { key: "tracking", label: "Rep Tracking" },
  ];
  return (
    <nav aria-label="Field visit feedback views" className="flex border-b border-slate-300">
      {entries.map((entry) => (
        <Link
          aria-current={tab === entry.key ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-4 py-2 text-sm font-black",
            tab === entry.key ? "border-orange-600 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-900",
          )}
          href={entry.key === "forms" ? basePath : `${basePath}?tab=${entry.key}`}
          key={entry.key}
        >
          {entry.label}
        </Link>
      ))}
    </nav>
  );
}

function FormsList({ forms, basePath, showAuthor }: { forms: FieldFeedback[]; basePath: string; showAuthor: boolean }) {
  if (forms.length === 0) {
    return <p className="border border-slate-200 bg-white p-6 text-sm text-slate-600">No field visit feedback yet.</p>;
  }
  return (
    <>
      <div className="hidden border border-slate-200 bg-white md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[14%]" />
            <col className={showAuthor ? "w-[30%]" : "w-[40%]"} />
            <col className="w-[12%]" />
            {showAuthor ? <col className="w-[20%]" /> : null}
            <col className={showAuthor ? "w-[24%]" : "w-[34%]"} />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-300 text-left text-phx-xs font-black uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Accompanied person · Area</th>
              <th className="px-3 py-2">Visit</th>
              {showAuthor ? <th className="px-3 py-2">Product Manager</th> : null}
              <th className="px-3 py-2">Signature</th>
            </tr>
          </thead>
          <tbody>
            {forms.map((form) => (
              <tr className="border-b border-slate-200 align-top last:border-b-0 hover:bg-slate-50" key={form.id}>
                <td className="px-3 py-2 tabular-nums">{shortDateLabel(form.visitDate)}</td>
                <td className="px-3 py-2">
                  <Link className="font-black text-slate-900 underline underline-offset-2" href={`${basePath}/${form.id}`}>
                    {form.repName}
                  </Link>
                  <span className="block break-words text-xs text-slate-600">
                    {[form.repJobTitle, form.repArea].filter(Boolean).join(" · ")}
                  </span>
                </td>
                <td className="px-3 py-2">{FIELD_VISIT_TYPE_LABELS[form.visitType]}</td>
                {showAuthor ? <td className="break-words px-3 py-2">{form.authorName}</td> : null}
                <td className="px-3 py-2">{form.signedAt ? <span className="font-bold text-slate-900">Signed</span> : <span className="font-bold text-orange-700">Draft</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {forms.map((form) => (
          <li className="border border-slate-200 bg-white p-3" key={form.id}>
            <Link className="font-black text-slate-900 underline underline-offset-2" href={`${basePath}/${form.id}`}>
              {form.repName}
            </Link>
            <p className="mt-1 text-xs text-slate-600">
              {shortDateLabel(form.visitDate)} · {FIELD_VISIT_TYPE_LABELS[form.visitType]}
              {form.repArea ? ` · ${form.repArea}` : ""}
            </p>
            <p className="mt-1 text-xs font-bold">
              {form.signedAt ? <span className="text-slate-900">Signed</span> : <span className="text-orange-700">Draft</span>}
              {showAuthor ? <span className="font-medium text-slate-600"> · {form.authorName}</span> : null}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function Tracking({ tracks, teamGaps }: { tracks: RepTrack[]; teamGaps: TeamGap[] }) {
  return (
    <div className="space-y-5">
      <section className="border border-slate-200 bg-white p-4 sm:p-5">
        <p className="text-sm leading-relaxed text-slate-700">{FIELD_FEEDBACK_PURPOSE}</p>
        <p className="mt-3 text-sm font-black text-slate-900">{FIELD_FEEDBACK_HELPS_INTRO}</p>
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {FIELD_FEEDBACK_HELPS.map((line) => (
            <li className="border-l-2 border-slate-900 pl-3" key={line}>
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-slate-700">{FIELD_FEEDBACK_OVER_TIME}</p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{FIELD_FEEDBACK_OBJECTIVE}</p>
      </section>

      <section className="border border-slate-200 bg-white p-4">
        <h2 className="text-base font-black text-slate-900">Team view</h2>
        <p className="mt-1 text-sm text-slate-600">Reps whose latest rating on a remark is Average or Poor, grouped by who works on it.</p>
        {teamGaps.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No gaps on the latest visits.</p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
            {FIELD_ACTION_OWNERS.map((owner) => {
              const gaps = teamGaps.filter((gap) => gap.owner === owner);
              return (
                <div className="border border-slate-200" key={owner}>
                  <p className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-900">{FIELD_ACTION_OWNER_LABELS[owner]}</p>
                  {gaps.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-slate-500">None.</p>
                  ) : (
                    <ul className="divide-y divide-slate-200">
                      {gaps.map((gap) => (
                        <li className="flex items-start justify-between gap-3 px-3 py-2 text-sm" key={gap.key}>
                          <span className="min-w-0 font-bold text-slate-900">{remarkLabel(gap.key)}</span>
                          <span className="shrink-0 text-right text-xs text-slate-600">
                            {gap.reps} {gap.reps === 1 ? "rep" : "reps"}
                            {gap.recurring > 0 ? <span className="block font-bold text-rose-700">{gap.recurring} recurring</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {tracks.length === 0 ? (
        <p className="border border-slate-200 bg-white p-6 text-sm text-slate-600">Rep tracking starts with the first signed form.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {tracks.map((track) => (
            <section className="border border-slate-200 bg-white" key={track.repHrId}>
              <header className="border-b border-slate-200 px-3 py-2">
                <p className="font-black text-slate-900">{track.repName}</p>
                <p className="text-xs text-slate-600">
                  {[track.repArea, `${track.visits} ${track.visits === 1 ? "visit" : "visits"}`, `last ${shortDateLabel(track.lastVisitDate)}`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {track.recurringGaps.length > 0 ? (
                  <p className="mt-1 text-xs font-black text-rose-700">Needs a development plan</p>
                ) : null}
              </header>
              <ul className="divide-y divide-slate-100">
                {track.remarks.map((remark) => (
                  <li className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm" key={remark.key}>
                    <span className={cn("min-w-0", remark.recurringGap ? "font-black text-rose-800" : remark.strength ? "font-bold text-slate-900" : "text-slate-700")}>
                      {remarkLabel(remark.key)}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {remark.latest ? (
                        <span className={cn("border px-1.5 py-0.5 text-xs font-bold", RATING_SWATCH[remark.latest])}>{CALL_RATING_LABELS[remark.latest]}</span>
                      ) : (
                        <span className="text-xs text-slate-400">Not rated</span>
                      )}
                      {remark.trend ? (
                        <span aria-label={TREND_LABEL[remark.trend]} className="w-4 text-center text-xs text-slate-600" role="img" title={TREND_LABEL[remark.trend]}>
                          {TREND_MARK[remark.trend]}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <footer className="space-y-1 border-t border-slate-200 px-3 py-2 text-xs">
                <p>
                  <span className="font-black text-slate-900">Key strengths: </span>
                  {track.strengths.length ? track.strengths.map(remarkLabel).join(", ") : "None yet"}
                </p>
                <p>
                  <span className="font-black text-rose-800">Recurring gaps: </span>
                  {track.recurringGaps.length ? track.recurringGaps.map(remarkLabel).join(", ") : "None"}
                </p>
              </footer>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function FieldFeedbackBoard({ tab, forms, tracks, teamGaps, basePath, canCreate, showAuthor }: Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <Tabs basePath={basePath} tab={tab} />
        {canCreate ? (
          <Link className={phxButtonAccentClassName} href={`${basePath}/new`}>
            New field visit feedback
          </Link>
        ) : null}
      </div>
      {tab === "tracking" ? <Tracking teamGaps={teamGaps} tracks={tracks} /> : <FormsList basePath={basePath} forms={forms} showAuthor={showAuthor} />}
    </div>
  );
}
