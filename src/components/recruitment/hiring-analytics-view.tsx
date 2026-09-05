// Recruitment / ATS — hiring analytics, rendered.
//
// Two questions, and nothing else: where do candidates come from and how well does each channel
// do, and where does the pipeline actually stop.
//
// ── WHY THE TILES SAY WHAT THEY SAY ─────────────────────────────────────────────────────────────
//
// The rate this page shows is "decided by a person" — a batch sweep is excluded upstream in
// hiring-analytics.ts. That exclusion is the difference between "email converts at 50%" (the figure
// that reached the plan, which counted one automated pass over 65 candidates as 65 decisions) and
// the truth, 23.8% against WhatsApp's 18.4%.
//
// The SPEED column matters as much as the rate and is the reason it is on the same row: email wins
// on rate by 5.4 points and loses on time-to-answer by a factor of four. A page showing only the
// rate would recommend moving spend to the slower channel.
//
// ── LAYOUT RULES THIS OBEYS ─────────────────────────────────────────────────────────────────────
//
//   - Table on desktop, CARDS on a phone (`hidden md:table` beside `md:hidden`). The owner's rule
//     is that mobile never gets a table.
//   - No `rounded-*` anywhere. The shell's stylesheet forces radius 0 inside .admin-shell, so a
//     rounded class here would be dead weight that reads as intent; the square-edge rule is the
//     intent.
//   - No ellipsis and no `min-width` floor with a scroller over it. The table is `w-full` with a
//     `<colgroup>`, so it fits rather than scrolls.

import type { ChannelEffectiveness, FunnelStep, HiringAnalytics } from "@/lib/recruitment/hiring-analytics";

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      <div className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  );
}

/**
 * A rate, or an honest refusal to print one.
 *
 * `null` means the channel is below the threshold in hiring-analytics.ts — the counts are shown and
 * the percentage is withheld, because 1 of 3 rendered as "33%" reads as a finding and is not one.
 */
function rateText(rate: number | null): string {
  if (rate === null) return "too few to rate";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Hours as something a person reads. Cairo-agnostic: this is a DURATION, not a clock time. */
function durationText(hours: number | null): string {
  if (hours === null) return "no answer yet";
  if (hours < 48) return `${hours.toFixed(0)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function ChannelRows({ channels }: { channels: readonly ChannelEffectiveness[] }) {
  return (
    <>
      {/* Desktop: one table, w-full with a colgroup so it fits the screen rather than scrolling. */}
      <table className="hidden w-full table-fixed md:table">
        <colgroup>
          <col className="w-[26%]" />
          <col className="w-[15%]" />
          <col className="w-[17%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-2">Channel</th>
            <th className="py-2 pr-2">Candidates</th>
            <th className="py-2 pr-2">Decided by a person</th>
            <th className="py-2 pr-2">Rate</th>
            <th className="py-2 pr-2">Typical answer</th>
            <th className="py-2">Average answer</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((channel) => (
            <tr key={channel.channel} className="border-b border-slate-200 align-top text-sm text-slate-700">
              <td className="py-2 pr-2 break-words font-medium text-slate-900">{channel.channel}</td>
              <td className="py-2 pr-2">{channel.candidates}</td>
              <td className="py-2 pr-2">{channel.decidedByAPerson}</td>
              <td className="py-2 pr-2 break-words">{rateText(channel.decidedRate)}</td>
              <td className="py-2 pr-2 break-words">{durationText(channel.medianHoursToFirstDecision)}</td>
              <td className="py-2 break-words">{durationText(channel.meanHoursToFirstDecision)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phone: cards, never a table. */}
      <div className="space-y-3 md:hidden">
        {channels.map((channel) => (
          <div key={channel.channel} className="border border-slate-200 bg-white p-3">
            <div className="text-sm font-semibold text-slate-900">{channel.channel}</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <div>
                <dt className="text-slate-500">Candidates</dt>
                <dd className="font-medium text-slate-900">{channel.candidates}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Decided by a person</dt>
                <dd className="font-medium text-slate-900">{channel.decidedByAPerson}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Rate</dt>
                <dd className="font-medium text-slate-900">{rateText(channel.decidedRate)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Typical answer</dt>
                <dd className="font-medium text-slate-900">
                  {durationText(channel.medianHoursToFirstDecision)}
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The funnel, each step against the one ABOVE it.
 *
 * Against the step above and not against the top, because "1 of 14" says the interview step is
 * where the pipeline stops, while "1 of 745" only says everything is small.
 */
function FunnelRows({ steps }: { steps: readonly FunnelStep[] }) {
  return (
    <div className="space-y-2">
      {steps.map((step, index) => {
        const previousLabel = index === 0 ? "" : steps[index - 1].label.toLowerCase();
        return (
        <div
          key={step.label}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-200 pb-2"
        >
          <span className="text-sm font-medium text-slate-900">{step.label}</span>
          {/*
            The count and the share are separate lines, not neighbours on one.
            "14" beside "1.9%" reads as a single number at a glance - the same adjacency that had
            "1.63 / 6.57" read as "1.63 out of 6.57". The share also says what it is a share OF,
            because a bare percentage next to a count invites the reader to divide the two.
          */}
          <span className="text-right text-sm text-slate-700">
            <span className="block font-semibold text-slate-900">{step.count}</span>
            {step.conversionFromPrevious === null ? null : (
              <span className="block text-xs text-slate-500">
                {(step.conversionFromPrevious * 100).toFixed(1)}% of {previousLabel}
              </span>
            )}
          </span>
        </div>
        );
      })}
    </div>
  );
}

export function HiringAnalyticsView({ report }: { report: HiringAnalytics }) {
  const decided = report.channels.reduce((total, channel) => total + channel.decidedByAPerson, 0);
  const best = [...report.channels]
    .filter((channel) => channel.medianHoursToFirstDecision !== null)
    .sort(
      (left, right) =>
        (left.medianHoursToFirstDecision ?? 0) - (right.medianHoursToFirstDecision ?? 0),
    )[0];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile label="Candidates" value={String(report.totalCandidates)} />
        <Tile
          label="Decided by a person"
          value={String(decided)}
          hint="Automated sweeps are not counted"
        />
        <Tile
          label="Fastest channel to answer"
          value={best ? best.channel : "no answers yet"}
          hint={best ? durationText(best.medianHoursToFirstDecision) : undefined}
        />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Where candidates come from</h2>
        <p className="mb-3 text-xs text-slate-500">
          The rate counts only candidates a person moved. Speed is shown beside it because the two
          disagree: the channel with the better rate can be the slower one to answer.
        </p>
        <ChannelRows channels={report.channels} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Where the pipeline stops</h2>
        <p className="mb-3 text-xs text-slate-500">
          Each step is shown against the step above it, which is what tells you where people are
          lost rather than only that the later steps are small.
        </p>
        <FunnelRows steps={report.funnel} />
      </section>
    </div>
  );
}
