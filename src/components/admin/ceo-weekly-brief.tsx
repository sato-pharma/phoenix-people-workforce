import { AlertCircle, CalendarClock, ChartNoAxesColumnIncreasing, ClipboardCheck, Radar, ScrollText } from "lucide-react";

import { classifySignal, type BriefSignal, type CeoBriefData, type SignalVerdict } from "@/lib/ceo/brief";
import type { CompanyHealth } from "@/lib/ceo/health-score";
import type { RiskRow } from "@/lib/ceo/risk";
import {
  formatBriefValue,
  formatDateShort,
  formatEgp,
  formatNumber,
  formatPercent,
  formatSignedPercent,
  formatTimeShort,
} from "@/lib/ceo/format";

type CeoWeeklyBriefProps = {
  brief: CeoBriefData | null;
  health: CompanyHealth;
  attention: RiskRow[];
};

const VERDICT_STYLE: Record<SignalVerdict, { arrow: string; className: string }> = {
  improved: { arrow: "▲", className: "text-emerald-600" },
  worse: { arrow: "▼", className: "text-rose-600" },
  flat: { arrow: "→", className: "text-slate-500" },
  unavailable: { arrow: "—", className: "text-slate-400" },
};

const SEVERITY_DOT: Record<RiskRow["severity"], string> = {
  critical: "bg-rose-500",
  warning: "bg-amber-500",
  watch: "bg-sky-500",
};

function Block({ icon: Icon, title, children }: { icon: typeof Radar; title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-[16px] border border-[#E5EAF1] bg-[#FCFDFE] p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-slate-400" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function HealthBand({ health }: { health: CompanyHealth }) {
  return (
    <div className="rounded-[16px] border border-[#E5EAF1] bg-[#FCFDFE] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-50 text-slate-500">
            <ClipboardCheck className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Company Health Score</p>
            {health.available ? (
              <p className="text-2xl font-bold text-slate-900">
                {formatNumber(health.overall ?? 0)}
                <span className="text-base font-medium text-slate-400">/100</span>
              </p>
            ) : (
              <p className="text-sm font-medium text-slate-400">Baseline pending — insufficient inputs</p>
            )}
          </div>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500">
          Coverage {formatPercent(health.coveragePct)}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {health.pillars.map((pillar) => (
          <div className="rounded-[12px] border border-slate-100 bg-white px-3 py-2" key={pillar.key}>
            <p className="truncate text-[11px] text-slate-500">{pillar.label}</p>
            <p className={`text-sm font-semibold ${pillar.available ? "text-slate-900" : "text-slate-300"}`}>
              {pillar.available ? formatNumber(pillar.score ?? 0) : "—"}
            </p>
          </div>
        ))}
      </div>
      <details className="mt-3 text-xs text-slate-500">
        <summary className="cursor-pointer font-medium text-slate-600">How this is calculated</summary>
        <ul className="mt-2 space-y-1">
          {health.pillars.map((pillar) => (
            <li key={pillar.key}>
              · {pillar.label} ({formatPercent(pillar.weight * 100)} weight): {pillar.detail}
              {pillar.available ? "" : " — unavailable"}
            </li>
          ))}
          <li className="text-slate-400">
            Overall is the weighted average of available pillars, shown only when coverage ≥ 60%.
          </li>
        </ul>
      </details>
    </div>
  );
}

function SignalRow({ signal }: { signal: BriefSignal }) {
  const verdict = classifySignal(signal);
  const style = VERDICT_STYLE[verdict];
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-700">{signal.label}</p>
        <p className="text-[11px] text-slate-400">
          {verdict === "unavailable"
            ? "Trend baseline pending"
            : `${formatBriefValue(signal.latest, signal.format)} · ${signal.comparisonLabel}`}
        </p>
      </div>
      <span className={`shrink-0 text-sm font-semibold ${style.className}`}>
        {style.arrow}
        {verdict === "unavailable" ? "" : ` ${formatSignedPercent(signal.deltaPct)}`}
      </span>
    </div>
  );
}

export function CeoWeeklyBrief({ brief, health, attention }: CeoWeeklyBriefProps) {
  const improvedCount = brief ? brief.signals.filter((signal) => classifySignal(signal) === "improved").length : 0;
  const worseCount = brief ? brief.signals.filter((signal) => classifySignal(signal) === "worse").length : 0;
  const vacancyPressure =
    brief && brief.workforce.totalStructure > 0
      ? (brief.workforce.vacantPositions / brief.workforce.totalStructure) * 100
      : null;

  return (
    <section className="min-w-0 rounded-[18px] border border-[#D8E0EA] bg-white p-5 shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-50 text-slate-500">
            <Radar className="h-4 w-4" />
          </span>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Command Brief</h2>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-500">
          Direction vs previous month
        </span>
      </header>

      <HealthBand health={health} />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Direction (improved / worse) */}
        <Block icon={ChartNoAxesColumnIncreasing} title="What improved / got worse">
          {brief ? (
            <>
              <p className="mb-2 text-xs text-slate-500">
                <span className="font-semibold text-emerald-600">{improvedCount} improved</span> ·{" "}
                <span className="font-semibold text-rose-600">{worseCount} declined</span>
              </p>
              <div>
                {brief.signals.map((signal) => (
                  <SignalRow key={signal.key} signal={signal} />
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">Direction data is temporarily unavailable.</p>
          )}
        </Block>

        {/* Needs attention + impact */}
        <Block icon={AlertCircle} title="Needs attention · who owns it">
          {attention.length === 0 ? (
            <p className="text-sm text-slate-400">Nothing needs executive attention right now.</p>
          ) : (
            <ul className="space-y-2">
              {attention.map((row) => (
                <li className="flex items-start gap-2" key={row.id}>
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[row.severity]}`} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {row.title}
                      {row.entity ? ` — ${row.entity}` : ""}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {row.owner}
                      {typeof row.days === "number" ? ` · ${formatNumber(row.days)} day(s)` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {brief ? (
            <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              <p className="font-medium text-slate-600">Business impact</p>
              <p className="mt-1">Revenue {formatEgp(brief.impact.revenue)} · People cost {formatEgp(brief.impact.peopleCost)}</p>
              <p>Gross margin {formatPercent(brief.impact.grossMargin)}</p>
              {vacancyPressure !== null ? (
                <p className="mt-1 text-slate-400">
                  Sales at {formatPercent(brief.salesAchievementPct)} with {formatPercent(vacancyPressure)} of positions vacant
                </p>
              ) : null}
            </div>
          ) : null}
        </Block>

        {/* What changed recently + upcoming */}
        <Block icon={ScrollText} title="What changed recently">
          {brief && brief.activity.length > 0 ? (
            <ul className="space-y-2">
              {brief.activity.slice(0, 4).map((event, index) => (
                <li className="min-w-0" key={`${event.module}-${event.timestamp}-${index}`}>
                  <p className="truncate text-sm text-slate-700">{event.description}</p>
                  <p className="text-[11px] text-slate-400">
                    {event.module} · {formatTimeShort(event.timestamp)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No recent activity available.</p>
          )}
          {brief && brief.upcoming.length > 0 ? (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <CalendarClock className="h-3.5 w-3.5" /> Upcoming
              </p>
              <ul className="space-y-1.5">
                {brief.upcoming.slice(0, 4).map((item, index) => (
                  <li className="flex items-center justify-between gap-2 text-xs" key={`${item.type}-${item.date}-${index}`}>
                    <span className="truncate text-slate-600">
                      {item.type === "contract" ? "Contract" : "Probation"} · {item.name}
                    </span>
                    <span className="shrink-0 text-slate-400">{formatDateShort(item.date)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Block>
      </div>

      {/* Honesty: weekly snapshot deltas are not captured yet */}
      <div className="mt-4 flex items-start gap-2 rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <span>
          Direction is month-over-month from real trends. True week-over-week deltas need a weekly snapshot baseline,
          which is not captured yet — weekly deltas are intentionally not shown rather than estimated.
        </span>
      </div>
    </section>
  );
}
