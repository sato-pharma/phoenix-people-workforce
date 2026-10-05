// Phoenix Ranks — one rep's profile: the rank, the stars, every title won, and the timeline of
// positions in every window. Owner, 2026-10-05: "we can open his timeline and profile, and everyone
// sees he has two or three stars". Open to every viewer of the board (his answer: everything is
// visible to everyone) — and still SCORES ONLY: the profile is read without the metrics column.

import { rankChipClass, SectionHead } from "@/components/employee-portal/portal-command-center";
import { RankInsigniaBadge, RankName, StarRow } from "@/components/rep-ranks/rank-insignia";
import { promotionSentence } from "@/lib/rep-ranks/ladder";
import type { RankProfile, RankTimelineEntry } from "@/lib/rep-ranks/server/read";
import { RANK_WINDOW_TITLES, RANK_WINDOW_TABS, type RankWindowKind } from "@/lib/rep-ranks/windows";

const KINDS: RankWindowKind[] = ["semester", "quarter", "month", "week", "day"];

function positionLabel(entry: RankTimelineEntry): string {
  if (!entry.ranked || entry.companyPosition === null) return "Not ranked";
  const line = entry.linePosition !== null ? ` · line #${entry.linePosition} of ${entry.lineCount}` : "";
  return `#${entry.companyPosition} of ${entry.companyCount}${line}`;
}

function tone(entry: RankTimelineEntry): string {
  if (entry.companyPosition === 1) return "border-amber-400 bg-amber-50";
  if (entry.linePosition === 1) return "border-sky-300 bg-sky-50";
  return "border-slate-200 bg-white";
}

export function RepRanksProfile({ profile, closeHref }: { profile: RankProfile; closeHref: string }) {
  const medals = KINDS.map((kind) => ({
    kind,
    company: profile.titles.filter((title) => title.windowKind === kind && title.scope === "company").length,
    line: profile.titles.filter((title) => title.windowKind === kind && title.scope === "line").length,
  })).filter((medal) => medal.company + medal.line > 0);

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" aria-label={`${profile.repName} profile`} role="region">
      <SectionHead
        title="Profile and timeline"
        right={
          <a className="text-phx-2xs font-bold uppercase tracking-widest text-slate-300 hover:text-white" href={closeHref}>
            Close
          </a>
        }
      />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <RankInsigniaBadge rank={profile.rank} size={112} />
          <div className="min-w-0 flex-1">
            <p className="break-words text-xl font-black leading-tight text-slate-900" dir="auto">
              {profile.repName}
            </p>
            <p className="text-sm font-bold text-slate-700">
              <RankName rank={profile.rank} />
            </p>
            <p className="break-words text-phx-3xs font-semibold uppercase tracking-wide text-slate-400">
              {[profile.lineName, profile.areaName].filter(Boolean).join(" · ")}
            </p>
            <div className="mt-1">
              <StarRow stars={profile.stars} />
            </div>
          </div>
        </div>
        <p className="break-words border-l-2 border-[#f47b20] pl-2 text-xs text-slate-700">
          Three-month average:{" "}
          <span className="font-black tabular-nums">{profile.rollingScore === null ? "not yet earned" : profile.rollingScore.toFixed(1)}</span>.{" "}
          {promotionSentence(profile.rollingScore)}
        </p>

        <div>
          <p className="text-phx-2xs font-black uppercase tracking-widest text-slate-400">Medals</p>
          {medals.length === 0 ? (
            <p className="mt-1 text-xs text-slate-500">No title yet. A title is a period finished at #1 of the company or of the line.</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-2">
              {medals.map((medal) => (
                <div className="min-w-0 border border-amber-300 bg-amber-50 px-2 py-1" key={medal.kind}>
                  <p className="text-phx-3xs font-black uppercase tracking-wider text-amber-800">{RANK_WINDOW_TITLES[medal.kind]}</p>
                  <p className="text-xs font-bold text-slate-800">
                    {medal.company > 0 ? `Company ×${medal.company}` : ""}
                    {medal.company > 0 && medal.line > 0 ? " · " : ""}
                    {medal.line > 0 ? `Line ×${medal.line}` : ""}
                  </p>
                </div>
              ))}
            </div>
          )}
          {profile.titles.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {profile.titles.slice(0, 30).map((title) => (
                <li className="border border-slate-200 px-1.5 py-0.5 text-phx-3xs font-semibold text-slate-600" key={`${title.windowKind}-${title.windowKey}-${title.scope}`}>
                  {title.scope === "company" ? "★ Company #1" : "Line #1"} · {title.windowLabel}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {KINDS.map((kind) => {
          const entries = profile.timeline[kind].slice(0, kind === "day" ? 20 : 12);
          if (entries.length === 0) return null;
          return (
            <div key={kind}>
              <p className="text-phx-2xs font-black uppercase tracking-widest text-slate-400">{RANK_WINDOW_TABS[kind]} by {RANK_WINDOW_TABS[kind].toLowerCase()}</p>
              {/* Columns follow the PANEL's width, never the window's: the panel is full width on the
                  portal and on the admin twin alike, but a container query keeps it honest either way. */}
              <div className="@container mt-1">
                <ul className="grid gap-1.5 @lg:grid-cols-2 @3xl:grid-cols-3">
                  {entries.map((entry) => {
                    const ranked = entry.ranked && entry.companyPosition !== null;
                    return (
                      <li className={`flex min-w-0 items-center gap-2.5 border px-2.5 py-2 ${tone(entry)}`} key={entry.key}>
                        <span
                          className={`inline-flex h-7 min-w-7 shrink-0 items-center justify-center px-1 text-phx-xs font-black tabular-nums ${
                            ranked ? rankChipClass((entry.companyPosition ?? 1) - 1) : "bg-slate-100 text-slate-400"
                          }`}
                        >
                          {ranked ? entry.companyPosition : "—"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-phx-3xs font-black uppercase tracking-wide text-slate-500">
                            {entry.label}
                            {entry.closed ? "" : " · so far"}
                          </p>
                          <p className="break-words text-xs font-bold text-slate-900">{positionLabel(entry)}</p>
                          {entry.total !== null ? (
                            <div className="mt-1 h-1 w-full bg-slate-100">
                              <div className="h-full bg-[#0b1f3a]" style={{ width: `${entry.total}%` }} />
                            </div>
                          ) : null}
                        </div>
                        {entry.total !== null ? (
                          <span className="shrink-0 text-base font-black tabular-nums text-slate-900">{entry.total.toFixed(1)}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
