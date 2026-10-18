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
//
// ── THE PREMIUM LOOK (owner, 2026-10-19: the full Recruitment sweep) ────────────────────────────
//
// Built from the module's one kit, `recruitment-premium.tsx`: the headline figures are a
// `RecruitmentKpiStrip`, and each of the three questions is a `RecruitmentPanel` with its dark band.
// The funnel draws a bar per step, sized against the FIRST step, while its words still compare each
// step with the one above it — the bar says how much of the intake is left, the words say where it
// was lost. Every figure on the old tiles is still here.

import { BarChart3, Clock3, Filter, Megaphone, Radio, Trophy, UsersRound, UserRoundCheck } from "lucide-react";

import type { ChannelEffectiveness, FunnelStep, HiringAnalytics } from "@/lib/recruitment/hiring-analytics";
import type { SourceOfHire } from "@/lib/recruitment/source-of-hire";
import { adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  RecruitmentKpiStrip,
  RecruitmentPanel,
  RecruitmentPill,
} from "@/components/recruitment/recruitment-premium";

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

/** A thin measure under a figure. Decorative only — the number beside it is the fact. */
function Meter({ share, tone = "orange" }: { share: number; tone?: "orange" | "slate" }) {
  const width = Math.max(0, Math.min(100, share * 100));
  return (
    <span aria-hidden="true" className={`mt-1.5 block h-1.5 w-full bg-slate-100 ${adminRecessedDepthClassName}`}>
      <span
        className={tone === "orange" ? "block h-full bg-gradient-to-r from-orange-500 to-amber-400" : "block h-full bg-slate-400"}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

const headCellClassName = "px-4 py-2.5 text-left text-phx-2xs font-black uppercase tracking-[0.12em]";
const bodyCellClassName = "px-4 py-3 align-top";

function ChannelRows({ channels }: { channels: readonly ChannelEffectiveness[] }) {
  if (channels.length === 0) {
    return (
      <RecruitmentEmptyState
        icon={<Radio aria-hidden="true" className="h-5 w-5" />}
        message="No candidate has arrived through any channel yet, so there is nothing to compare."
        title="No channels yet"
      />
    );
  }
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
          <tr className="border-b border-slate-300">
            <th className={headCellClassName}>Channel</th>
            <th className={headCellClassName}>Candidates</th>
            <th className={headCellClassName}>Decided by a person</th>
            <th className={headCellClassName}>Rate</th>
            <th className={headCellClassName}>Typical answer</th>
            <th className={headCellClassName}>Average answer</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {channels.map((channel) => (
            <tr key={channel.channel} className="text-sm text-slate-700 transition-colors hover:bg-orange-50/40">
              <td className={`${bodyCellClassName} break-words font-bold text-slate-900`}>{channel.channel}</td>
              <td className={`${bodyCellClassName} tabular-nums`}>{channel.candidates}</td>
              <td className={`${bodyCellClassName} tabular-nums`}>{channel.decidedByAPerson}</td>
              <td className={`${bodyCellClassName} break-words`}>
                <span className="font-black tabular-nums text-slate-900">{rateText(channel.decidedRate)}</span>
                {channel.decidedRate === null ? null : <Meter share={channel.decidedRate} />}
              </td>
              <td className={`${bodyCellClassName} break-words tabular-nums`}>
                {durationText(channel.medianHoursToFirstDecision)}
              </td>
              <td className={`${bodyCellClassName} break-words tabular-nums`}>
                {durationText(channel.meanHoursToFirstDecision)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Phone: cards, never a table. */}
      <div className="p-3 md:hidden">
        <div className="space-y-3 md:hidden">
          {channels.map((channel) => (
            <div key={channel.channel} className={`border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
              <div className="break-words text-sm font-black text-slate-900">{channel.channel}</div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <div>
                  <dt className="text-slate-500">Candidates</dt>
                  <dd className="font-bold tabular-nums text-slate-900">{channel.candidates}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Decided by a person</dt>
                  <dd className="font-bold tabular-nums text-slate-900">{channel.decidedByAPerson}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Rate</dt>
                  <dd className="font-bold tabular-nums text-slate-900">
                    {rateText(channel.decidedRate)}
                    {channel.decidedRate === null ? null : <Meter share={channel.decidedRate} />}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Typical answer</dt>
                  <dd className="font-bold tabular-nums text-slate-900">
                    {durationText(channel.medianHoursToFirstDecision)}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-slate-500">Average answer</dt>
                  <dd className="font-bold tabular-nums text-slate-900">
                    {durationText(channel.meanHoursToFirstDecision)}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * The funnel, each step against the one ABOVE it.
 *
 * Against the step above and not against the top, because "1 of 14" says the interview step is
 * where the pipeline stops, while "1 of 745" only says everything is small. The bar is the one
 * thing measured against the top, and it says nothing in words.
 */
function FunnelRows({ steps }: { steps: readonly FunnelStep[] }) {
  if (steps.length === 0) {
    return (
      <RecruitmentEmptyState
        icon={<Filter aria-hidden="true" className="h-5 w-5" />}
        message="The pipeline has no steps to show yet."
        title="Nothing in the pipeline"
      />
    );
  }
  const top = steps[0]?.count ?? 0;
  return (
    <ol className="divide-y divide-slate-100">
      {steps.map((step, index) => {
        const previousLabel = index === 0 ? "" : steps[index - 1].label.toLowerCase();
        return (
          <li key={step.label} className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
            <span
              className={`flex h-7 w-7 items-center justify-center border border-slate-200 bg-white text-phx-2xs font-black tabular-nums text-slate-500 ${adminSoftDepthClassName}`}
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <span className="block break-words text-sm font-bold text-slate-900">{step.label}</span>
              <Meter share={top > 0 ? step.count / top : 0} tone={index === steps.length - 1 ? "orange" : "slate"} />
            </div>
            {/*
              The count and the share are separate lines, not neighbours on one.
              "14" beside "1.9%" reads as a single number at a glance - the same adjacency that had
              "1.63 / 6.57" read as "1.63 out of 6.57". The share also says what it is a share OF,
              because a bare percentage next to a count invites the reader to divide the two.
            */}
            <span className="text-right text-sm tabular-nums text-slate-700">
              <span className="block font-semibold text-slate-900">{step.count}</span>
              {step.conversionFromPrevious === null ? null : (
                <span className="block text-xs text-slate-500">
                  {(step.conversionFromPrevious * 100).toFixed(1)}% of {previousLabel}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Where hires actually come from — the channel every hire landed in, and the specific advert where
 * one is known.
 *
 * Two levels because their coverage differs and pretending otherwise would be a lie: channel is
 * ~100% (every candidate carries a coarse source), advert is only as good as what survived a
 * forward or what a person tagged. The "known only at the channel level" line says the gap out loud
 * rather than dressing an Unknown bucket up as a finding.
 */
function SourceOfHireSection({ data }: { data: SourceOfHire }) {
  if (data.totalHires === 0) {
    return (
      <RecruitmentPanel icon={<Trophy aria-hidden="true" className="h-4 w-4" />} title="Where hires actually come from">
        <RecruitmentEmptyState
          icon={<Trophy aria-hidden="true" className="h-5 w-5" />}
          message="Nobody has been hired through the pipeline yet, so there is nothing to attribute."
          title="No hires yet"
        />
      </RecruitmentPanel>
    );
  }

  return (
    <RecruitmentPanel
      count={data.totalHires}
      description={
        <>
          {data.attributedToAdvert} of {data.totalHires}{" "}
          {data.totalHires === 1 ? "hire is" : "hires are"} tied to a specific advert
          {data.taggedByAPerson > 0
            ? ` (${data.taggedByAPerson} tagged by a person)`
            : ""}
          . The rest are known only at the channel level — a forwarded WhatsApp CV drops the applicant&apos;s
          own message, which is the only place the tracked code lives, so the advert is unknown until
          someone tags it on the hire.
        </>
      }
      icon={<Trophy aria-hidden="true" className="h-4 w-4" />}
      title="Where hires actually come from"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:divide-x lg:divide-slate-100">
        {/* Channel level — every hire, ~100% coverage. */}
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500 sm:px-5">
            <Radio aria-hidden="true" className="h-3.5 w-3.5 text-orange-500" />
            By channel
          </h3>
          <table className="hidden w-full table-fixed md:table">
            <colgroup>
              <col className="w-[70%]" />
              <col className="w-[30%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-300">
                <th className={headCellClassName}>Channel</th>
                <th className={headCellClassName}>Hires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.channels.map((row) => (
                <tr key={row.channel} className="text-sm text-slate-700">
                  <td className={`${bodyCellClassName} break-words font-bold text-slate-900`}>
                    {row.channel}
                    <Meter share={data.totalHires > 0 ? row.hires / data.totalHires : 0} />
                  </td>
                  <td className={`${bodyCellClassName} font-black tabular-nums text-slate-900`}>{row.hires}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="divide-y divide-slate-100 md:hidden">
            {data.channels.map((row) => (
              <div key={row.channel} className="px-4 py-2.5 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words font-bold text-slate-900">{row.channel}</span>
                  <span className="font-black tabular-nums text-slate-900">{row.hires}</span>
                </div>
                <Meter share={data.totalHires > 0 ? row.hires / data.totalHires : 0} />
              </div>
            ))}
          </div>
        </div>

        {/* Advert level — only where the advert is known, plus one honest Unknown line. */}
        <div className="min-w-0 border-t border-slate-100 lg:border-t-0">
          <h3 className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500 sm:px-5">
            <Megaphone aria-hidden="true" className="h-3.5 w-3.5 text-orange-500" />
            By advert
          </h3>
          {data.adverts.length === 0 ? (
            <p className="px-4 py-4 text-sm text-slate-500 sm:px-5">
              No hire is tied to a specific advert yet. Tag a hire&apos;s source on its application, or wait
              for an applicant who taps a tracked link, and the advert appears here.
            </p>
          ) : (
            <>
              <table className="hidden w-full table-fixed md:table">
                <colgroup>
                  <col className="w-[42%]" />
                  <col className="w-[22%]" />
                  <col className="w-[16%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-300">
                    <th className={headCellClassName}>Advert</th>
                    <th className={headCellClassName}>Channel</th>
                    <th className={headCellClassName}>Hires</th>
                    <th className={headCellClassName}>How</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.adverts.map((row) => (
                    <tr key={row.code} className="text-sm text-slate-700">
                      <td className={`${bodyCellClassName} break-words font-bold text-slate-900`}>{row.name}</td>
                      <td className={`${bodyCellClassName} break-words`}>{row.channel}</td>
                      <td className={`${bodyCellClassName} font-black tabular-nums text-slate-900`}>{row.hires}</td>
                      <td className={`${bodyCellClassName} break-words`}>
                        <RecruitmentPill tone={row.manualHires > 0 ? "sky" : "emerald"}>
                          {advertBasisText(row.manualHires, row.autoHires)}
                        </RecruitmentPill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="space-y-2 p-3 md:hidden">
                {data.adverts.map((row) => (
                  <div key={row.code} className={`border border-slate-200 bg-white p-3 ${adminSoftDepthClassName}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 break-words text-sm font-bold text-slate-900">{row.name}</span>
                      <span className="font-black tabular-nums text-slate-900">{row.hires}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="break-words">{row.channel}</span>
                      <RecruitmentPill tone={row.manualHires > 0 ? "sky" : "emerald"}>
                        {advertBasisText(row.manualHires, row.autoHires)}
                      </RecruitmentPill>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {data.unknownAdvert > 0 ? (
            <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500 sm:px-5">
              {data.unknownAdvert} {data.unknownAdvert === 1 ? "hire has" : "hires have"} no advert yet —
              counted by channel above, and taggable on the application.
            </p>
          ) : null}
        </div>
      </div>
    </RecruitmentPanel>
  );
}

/** How an advert's hires were attributed — tagged by a person, recovered from a tracked link, or both. */
function advertBasisText(manualHires: number, autoHires: number): string {
  if (manualHires > 0 && autoHires > 0) return `${manualHires} tagged · ${autoHires} tracked`;
  if (manualHires > 0) return "tagged by HR";
  return "tracked link";
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
      <RecruitmentKpiStrip
        items={[
          {
            description: "Everyone who has applied, through every channel.",
            icon: <UsersRound aria-hidden="true" className="h-4 w-4" />,
            label: "Candidates",
            tone: "blue",
            value: <span className="tabular-nums">{report.totalCandidates}</span>,
          },
          {
            description: "Automated sweeps are not counted",
            icon: <UserRoundCheck aria-hidden="true" className="h-4 w-4" />,
            label: "Decided by a person",
            tone: "emerald",
            value: <span className="tabular-nums">{decided}</span>,
          },
          {
            description: best
              ? `Typical first answer: ${durationText(best.medianHoursToFirstDecision)}`
              : "No channel has given anyone an answer yet.",
            icon: <Clock3 aria-hidden="true" className="h-4 w-4" />,
            label: "Fastest channel to answer",
            tone: "orange",
            value: <span className="break-words">{best ? best.channel : "no answers yet"}</span>,
          },
          {
            description:
              report.sourceOfHire.totalHires > 0
                ? `${report.sourceOfHire.attributedToAdvert} of them tied to a specific advert.`
                : "Nobody has been hired through the pipeline yet.",
            icon: <Trophy aria-hidden="true" className="h-4 w-4" />,
            label: "Hires",
            tone: "violet",
            value: <span className="tabular-nums">{report.sourceOfHire.totalHires}</span>,
          },
        ]}
      />

      <RecruitmentPanel
        count={report.channels.length}
        description="The rate counts only candidates a person moved. Speed is shown beside it because the two disagree: the channel with the better rate can be the slower one to answer."
        icon={<BarChart3 aria-hidden="true" className="h-4 w-4" />}
        title="Where candidates come from"
      >
        <ChannelRows channels={report.channels} />
      </RecruitmentPanel>

      <SourceOfHireSection data={report.sourceOfHire} />

      <RecruitmentPanel
        description="Each step is shown against the step above it, which is what tells you where people are lost rather than only that the later steps are small."
        icon={<Filter aria-hidden="true" className="h-4 w-4" />}
        title="Where the pipeline stops"
      >
        <FunnelRows steps={report.funnel} />
      </RecruitmentPanel>
    </div>
  );
}
