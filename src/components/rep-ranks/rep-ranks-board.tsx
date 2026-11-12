// Phoenix Ranks — one board, rendered by the portal page and the admin twin alike. Only the shell
// and the `audience` differ: the admin twin passes rows that carry `metrics` and prints them; the
// portal's rows never carry them at all (the server leaves the column out — read.ts).
//
// A server component with no client island: every control is a plain link, so nothing has to cross
// the server/client boundary (the Early Birds table's own lesson, early-birds-rep-table.tsx).
//
// Fits the screen at 375px and on a laptop (the fits-the-screen golden rule): phone cards come
// first and the desktop table is `w-full table-fixed` with a colgroup, the thirteen pillars MERGED
// into one wrapping "Breakdown" cell rather than thirteen columns that would push sideways.

import { Crown, FileDown, Medal, Trophy } from "lucide-react";

import { rankChipClass, SectionHead, SectionMeta } from "@/components/employee-portal/portal-command-center";
import { RankInsigniaBadge, RankInsigniaSprite, RankName, StarRow } from "@/components/rep-ranks/rank-insignia";
import { PHOENIX_CRM_INTEGRITY_LABELS, type PhoenixCrmIntegrityFlag } from "@/lib/phoenix-crm/location-integrity";
import { explainStanding, leverSentence } from "@/lib/rep-ranks/explain";
import { promotionSentence, RANK_LADDER } from "@/lib/rep-ranks/ladder";
import {
  clockOf,
  RANK_PILLARS,
  RANK_START_BONUS_MAX,
  RANK_UNRANKED_REASON_TEXT,
  startBonusPoints,
  type RankPillarScores,
} from "@/lib/rep-ranks/scoring";
import { standingsOf, type RankBoard, type RankBoardRow } from "@/lib/rep-ranks/server/read";
import { RANK_WINDOW_KINDS, RANK_WINDOW_TABS, RANK_WINDOW_TITLES, type RankWindowKind } from "@/lib/rep-ranks/windows";

export type RankLinkContext = {
  basePath: string;
  kind: RankWindowKind;
  windowKey: string | null;
  line: string | null;
};

export function rankHref(context: RankLinkContext, change: Partial<{ kind: RankWindowKind; windowKey: string | null; line: string | null; rep: string | null }>): string {
  const kind = change.kind ?? context.kind;
  const params = new URLSearchParams();
  params.set("window", kind);
  const key = "windowKey" in change ? change.windowKey : change.kind ? null : context.windowKey;
  if (key) params.set("key", key);
  const line = "line" in change ? change.line : context.line;
  if (line) params.set("line", line);
  if (change.rep) params.set("rep", change.rep);
  return `${context.basePath}?${params.toString()}`;
}

function barTone(score: number | null): string {
  if (score === null) return "bg-slate-200";
  if (score >= 90) return "bg-emerald-500";
  if (score >= 70) return "bg-amber-400";
  return "bg-rose-500";
}

/**
 * The thirteen bars, at a size a rep reads without leaning in (owner, 2026-10-05: "the font is very
 * small"). One column on a phone, two once the bars' OWN box is wide enough, three on a laptop's wide
 * card — a container query, never the viewport, because the same bars sit in a 351px phone card and
 * a 900px desktop card.
 */
function PillarBars({ pillars }: { pillars: RankPillarScores }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-x-5 gap-y-3 @sm:grid-cols-2 @3xl:grid-cols-3">
        {RANK_PILLARS.map((pillar) => {
          const score = pillars[pillar.key];
          // The AM start bonus only adds, so it is read in the points it adds and never painted as a failing measure.
          const shown = score === null ? "Not scored" : pillar.bonus ? `+${startBonusPoints(score).toFixed(1)} of ${RANK_START_BONUS_MAX}` : score;
          // The `rkp-*` classes are the same utilities, declared once in app/globals.css — about 960 bars
          // on a full board, each of which used to carry its six strings in full, twice (12 Nov 2026).
          return (
            <div className="rkp" key={pillar.key}>
              <div className="rkp-h">
                <span className={pillar.bonus ? "rkp-lb" : "rkp-l"}>{pillar.label}</span>
                <span className={score === null ? "rkp-vn" : "rkp-v"}>{shown}</span>
              </div>
              <div className="rkp-t">
                <div className={`rkp-f ${pillar.bonus ? "bg-sky-500" : barTone(score)}`} style={{ width: `${score ?? 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The place, as the house medal chip: gold, silver, bronze, then navy. A dash when unranked. */
function PositionChip({ row, lineView, size = "md" }: { row: RankBoardRow; lineView: boolean; size?: "md" | "lg" | "xl" }) {
  const position = lineView ? row.linePosition : row.companyPosition;
  const box = size === "xl" ? "h-12 min-w-12 px-2 text-xl" : size === "lg" ? "h-9 min-w-9 px-1.5 text-base" : "h-7 min-w-7 px-1 text-phx-xs";
  if (!row.ranked || position === null) {
    return (
      <span aria-label="Not ranked" className={`inline-flex shrink-0 items-center justify-center bg-slate-100 font-black text-slate-400 ${box}`}>
        —
      </span>
    );
  }
  return (
    <span aria-label={`Place ${position}`} className={`inline-flex shrink-0 items-center justify-center font-black tabular-nums ${rankChipClass(position - 1)} ${box}`}>
      {position}
    </span>
  );
}

function YouTag() {
  return <span className="shrink-0 bg-[#f47b20] px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-widest text-white">You</span>;
}

function RepName({ row, context, active }: { row: RankBoardRow; context: RankLinkContext; active: boolean }) {
  return (
    <a
      className={`break-words font-bold underline-offset-2 hover:underline ${active ? "text-[#f47b20]" : "text-slate-900"}`}
      dir="auto"
      href={rankHref(context, { rep: row.hrIdKey })}
    >
      {row.repName}
    </a>
  );
}

/** "Mon 5 Oct, 03:10" in Cairo — when the board was last computed. */
function computedLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function AdminMetricsLine({ row }: { row: RankBoardRow }) {
  const metrics = row.metrics;
  if (!metrics) return null;
  const parts = [
    `${metrics.owedDays} working days owed`,
    `AM ${metrics.amVisits} · PM ${metrics.pmVisits} visits`,
    `in the field ${metrics.fieldDays} of ${metrics.owedDays}`,
    metrics.listed === null ? "no list" : `list ${metrics.covered ?? 0} of ${metrics.listed} seen`,
    metrics.frequencyRequired ? `frequency ${metrics.frequencyMet ?? 0} of ${metrics.frequencyRequired} visits due` : "no graded targets",
    metrics.planned > 0 ? `plan ${metrics.kept} of ${metrics.planned}` : "no plan",
    metrics.startDays > 0 ? `started ${clockOf(metrics.medianStartMinutes) ?? "—"} (${metrics.startDays} presses)` : "no start press",
    metrics.located > 0 ? `at the place ${metrics.atPlace} of ${metrics.located}` : "no visit measured against a place",
  ];
  // The deeper measures (scoring version 4); a row from version 3 carries none of them.
  const deeper =
    metrics.fieldSaves === undefined
      ? []
      : [
          metrics.gapPairs
            ? `gap ${metrics.gapMedianMinutes ?? "—"} min median for a ${metrics.gapMedianWalkMinutes ?? "—"} min walk (${metrics.gapPairs} gaps, ${metrics.gapTooFast ?? 0} too fast, ${metrics.gapTooSlow ?? 0} too slow)`
            : "no gap to judge",
          metrics.doctorVisits
            ? `${((metrics.productsDiscussed ?? 0) / metrics.doctorVisits).toFixed(2)} products a visit · notes on ${metrics.withNote ?? 0} of ${metrics.doctorVisits}`
            : "no doctor visit",
          metrics.gpsFixes ? `GPS ${metrics.gpsMedianMeters ?? "—"} m median over ${metrics.gpsFixes} fixes` : "no GPS fix",
        ];
  // Integrity in detail — the admin's alone (owner, 2026-10-05: "admin sees detail").
  const flagged = metrics.flaggedSaves ?? 0;
  // Cases against a PLACE he validated, counted since 2026-10-12. Stated separately and never added
  // into the "of N saves" ratio: a place validation is not a save, so a sum would print a fraction
  // whose two halves count different things.
  const flaggedPlaces = metrics.flaggedPlaces ?? 0;
  const placeDetail = flaggedPlaces > 0 ? ` · ${flaggedPlaces} validated ${flaggedPlaces === 1 ? "place" : "places"} flagged` : "";
  const flagDetail = Object.entries(metrics.integrityFlags ?? {})
    .map(([flag, count]) => `${PHOENIX_CRM_INTEGRITY_LABELS[flag as PhoenixCrmIntegrityFlag] ?? flag} (${count})`)
    .join(" · ");
  return (
    <div className="mt-3 space-y-1 border-t border-slate-100 pt-2">
      <p className="break-words text-phx-sm font-semibold text-slate-500">{parts.join(" · ")}</p>
      {deeper.length > 0 ? <p className="break-words text-phx-sm font-semibold text-slate-500">{deeper.join(" · ")}</p> : null}
      {metrics.fieldSaves !== undefined ? (
        <p className={`break-words text-phx-sm font-bold ${flagged > 0 || flaggedPlaces > 0 ? "text-red-700" : "text-emerald-700"}`}>
          {flagged > 0 || flaggedPlaces > 0
            ? `Integrity: ${flagged} of ${metrics.fieldSaves} saves flagged${placeDetail} — ${flagDetail}`
            : `Integrity: ${metrics.fieldSaves} saves, none flagged`}
        </p>
      ) : null}
    </div>
  );
}

function WindowTabs({ board, context }: { board: RankBoard; context: RankLinkContext }) {
  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap gap-1 p-2">
        {RANK_WINDOW_KINDS.map((kind) => (
          <a
            className={`px-3 py-1.5 text-phx-xs font-black uppercase tracking-wider ${
              kind === board.kind ? "bg-[#0b1f3a] text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
            href={rankHref(context, { kind })}
            key={kind}
          >
            {RANK_WINDOW_TABS[kind]}
          </a>
        ))}
      </div>
      {board.windows.length > 1 ? (
        <div className="flex flex-wrap gap-1 border-t border-slate-100 p-2">
          {board.windows.slice(0, 12).map((option) => (
            <a
              className={`px-2 py-1 text-phx-3xs font-bold ${
                option.key === board.window?.key ? "bg-[#f47b20] text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100"
              }`}
              href={rankHref(context, { windowKey: option.key })}
              key={option.key}
            >
              {option.label}
              {option.closed ? "" : " · so far"}
            </a>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1 border-t border-slate-100 p-2">
        <a
          className={`px-2 py-1 text-phx-3xs font-bold ${!context.line ? "bg-[#0b1f3a] text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}
          href={rankHref(context, { line: null })}
        >
          Whole company
        </a>
        {board.lines.map((line) => (
          <a
            className={`px-2 py-1 text-phx-3xs font-bold ${context.line === line ? "bg-[#0b1f3a] text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}
            href={rankHref(context, { line })}
            key={line}
          >
            {line}
          </a>
        ))}
      </div>
    </div>
  );
}

/** One figure on the standing strip — the KeycardGrid look: a coloured top hairline, a small-caps label, a big number. */
function StatTile({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div className="relative min-w-0 bg-white px-4 py-3">
      <span className={`absolute inset-x-0 top-0 h-[3px] ${accent}`} />
      <p className="break-words text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className="mt-1 break-words text-2xl font-black leading-none tabular-nums text-slate-900">{value}</p>
      <p className="mt-1 break-words text-phx-xs font-medium leading-snug text-slate-500">{sub}</p>
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">{children}</p>;
}

/**
 * The certificate download (owner, 2026-10-05: "any rep who is taking a rank or a title to be able to
 * export a premium polished PDF"). A plain link to a GET — no client island — and the route refuses
 * anyone but the rep themself or the admin twin's audience, whatever this link says.
 */
function certificateHref(board: RankBoard, hrIdKey: string): string {
  const params = new URLSearchParams({ window: board.kind, rep: hrIdKey });
  if (board.window) params.set("key", board.window.key);
  return `/api/rep-ranks/certificate?${params.toString()}`;
}

function CertificateLink({ href, label = "Download certificate (PDF)", tone = "solid" }: { href: string; label?: string; tone?: "solid" | "quiet" }) {
  return (
    <a
      className={
        tone === "solid"
          ? "inline-flex items-center gap-2 bg-[#0b1f3a] px-3.5 py-2 text-phx-sm font-black uppercase tracking-wider text-white hover:bg-[#13315a]"
          : "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1.5 text-phx-xs font-bold uppercase tracking-wider text-slate-700 hover:border-[#0b1f3a] hover:text-[#0b1f3a]"
      }
      download
      href={href}
    >
      <FileDown aria-hidden="true" className="h-4 w-4 shrink-0" />
      {label}
    </a>
  );
}

function YourStanding({ row, board }: { row: RankBoardRow; board: RankBoard }) {
  const explanation = explainStanding(standingsOf([row])[0], standingsOf(board.rows));
  const leader = board.rows.find((other) => other.ranked && other.companyPosition === 1) ?? null;
  const second = board.rows.find((other) => other.ranked && other.companyPosition === 2) ?? null;
  const isFirst = row.ranked && row.companyPosition === 1;
  // The headline and the line position are on the tiles; the sentences below carry the rest.
  const lines = row.ranked ? explanation.lines.filter((line) => !line.startsWith(`#${row.linePosition} of `)) : explanation.lines;
  const gapTile = isFirst
    ? second?.total != null && row.total !== null
      ? { label: "Your lead", value: (row.total - second.total).toFixed(1), sub: `points ahead of ${second.repName}` }
      : { label: "Your lead", value: "—", sub: "nobody else ranked yet" }
    : leader?.total != null && row.total !== null
      ? { label: "To #1", value: (leader.total - row.total).toFixed(1), sub: `points behind ${leader.repName}` }
      : null;

  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Your standing">
      <SectionHead title="Your standing" right={<SectionMeta items={[board.window?.label, board.window && !board.window.closed ? "so far" : null]} />} />

      <div className="flex flex-wrap items-center gap-4 border-b border-slate-100 px-4 py-4 sm:px-5">
        <RankInsigniaBadge rank={row.rank} size={112} />
        <div className="min-w-0 flex-1">
          <p className="break-words text-xl font-black leading-tight text-slate-900">
            <RankName rank={row.rank} />
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StarRow stars={row.stars} />
            <span className="break-words text-phx-sm font-semibold text-slate-500">
              Three-month average{" "}
              <span className="font-black tabular-nums text-slate-900">{row.rollingScore === null ? "not yet earned" : row.rollingScore.toFixed(1)}</span>
              . {promotionSentence(row.rollingScore)}
            </span>
          </div>
        </div>
        {row.ranked ? <CertificateLink href={certificateHref(board, row.hrIdKey)} /> : null}
      </div>

      {row.ranked && row.total !== null ? (
        <div className="@container border-b border-slate-200">
          <div className="grid grid-cols-2 gap-px bg-slate-200 @2xl:grid-cols-4">
            <StatTile accent="bg-[#f47b20]" label="Score" sub={`out of 100 · ${board.window?.label ?? ""}`} value={row.total.toFixed(1)} />
            <StatTile accent="bg-[#0b1f3a]" label="Company" sub={`of ${row.companyCount} ranked reps`} value={`#${row.companyPosition}`} />
            <StatTile
              accent="bg-sky-500"
              label="Line"
              sub={row.linePosition !== null ? `of ${row.lineCount} in ${row.lineName ?? "your line"}` : "no line ranking"}
              value={row.linePosition !== null ? `#${row.linePosition}` : "—"}
            />
            {gapTile ? <StatTile accent={isFirst ? "bg-amber-400" : "bg-slate-300"} label={gapTile.label} sub={gapTile.sub} value={gapTile.value} /> : null}
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-2">
          <SubHeading>Why this place</SubHeading>
          <p className="break-words text-phx-lg font-bold text-slate-900">{explanation.headline}</p>
          <ul className="space-y-1.5">
            {lines.map((line) => (
              <li className="flex gap-2 break-words text-phx-base leading-relaxed text-slate-600" key={line}>
                <span aria-hidden="true" className="mt-[9px] h-1.5 w-1.5 shrink-0 bg-[#f47b20]" />
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <SubHeading>Your twelve measures and the bonus</SubHeading>
            <PillarBars pillars={row.pillars} />
          </div>
          {explanation.levers.length > 0 ? (
            <div className="border border-slate-200 border-l-[3px] border-l-[#f47b20] bg-orange-50/40 p-3">
              <SubHeading>How to climb</SubHeading>
              <ol className="mt-1.5 space-y-1.5">
                {explanation.levers.map((lever, index) => (
                  <li className="flex gap-2 break-words text-phx-base leading-relaxed text-slate-700" key={lever.pillar}>
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center bg-[#0b1f3a] text-phx-3xs font-black text-white">{index + 1}</span>
                    <span className="min-w-0">{leverSentence(lever)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {explanation.strengths.length > 0 ? (
            <p className="break-words border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
              Full marks or close: {explanation.strengths.join(" · ")}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Podium({ rows, context, lineView, viewerKey }: { rows: RankBoardRow[]; context: RankLinkContext; lineView: boolean; viewerKey: string | null }) {
  const top = rows.filter((row) => row.ranked).slice(0, 3);
  if (top.length === 0) return null;
  const icons = [Crown, Trophy, Medal];
  // Gold, silver, bronze — the same three the place chips use (rankChipClass).
  const tones = [
    { card: "border-amber-400 bg-gradient-to-b from-amber-50 to-white", bar: "bg-amber-400", icon: "text-amber-500" },
    { card: "border-slate-300 bg-gradient-to-b from-slate-50 to-white", bar: "bg-slate-300", icon: "text-slate-400" },
    { card: "border-orange-300 bg-gradient-to-b from-orange-50 to-white", bar: "bg-orange-300", icon: "text-orange-400" },
  ];
  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Top three">
      <SectionHead
        title={`${RANK_WINDOW_TITLES[context.kind]}${lineView && context.line ? ` · ${context.line}` : ""}`}
        right={<SectionMeta items={[context.line ?? "Whole company"]} />}
      />
      <div className="@container p-3 sm:p-4">
        <div className="grid gap-3 @2xl:grid-cols-3">
          {top.map((row, index) => {
            const Icon = icons[index];
            const tone = tones[index];
            return (
              <div className={`relative min-w-0 border p-4 ${tone.card}`} key={row.hrIdKey}>
                <span className={`absolute inset-x-0 top-0 h-[3px] ${tone.bar}`} />
                <div className="flex flex-wrap items-center gap-2">
                  <Icon className={`h-5 w-5 shrink-0 ${tone.icon}`} />
                  <span className={`inline-flex h-7 min-w-7 items-center justify-center px-1 text-phx-xs font-black ${rankChipClass(index)}`}>{index + 1}</span>
                  {row.hrIdKey === viewerKey ? <YouTag /> : null}
                  <span className="ml-auto text-2xl font-black leading-none tabular-nums text-slate-900">{row.total?.toFixed(1)}</span>
                </div>
                <p className="mt-2 text-base leading-snug">
                  <RepName active={false} context={context} row={row} />
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <RankInsigniaBadge rank={row.rank} size={60} />
                  <RankName className="text-phx-xs font-bold text-slate-600" rank={row.rank} />
                  <StarRow stars={row.stars} />
                </div>
                <p className="mt-1.5 break-words text-phx-3xs font-semibold uppercase tracking-wide text-slate-400" dir="auto">
                  {[row.lineName, row.areaName].filter(Boolean).join(" · ")}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BoardTable({
  rows,
  context,
  lineView,
  openRepKey,
  viewerKey,
  computedAt,
  board,
  certificatesForAll,
}: {
  board: RankBoard;
  /** The admin twin: every ranked rep's card carries the certificate link. */
  certificatesForAll: boolean;
  rows: RankBoardRow[];
  context: RankLinkContext;
  lineView: boolean;
  openRepKey: string | null;
  viewerKey: string | null;
  /** When the board was last computed, already in Cairo words. */
  computedAt: string | null;
}) {
  const ranked = rows.filter((row) => row.ranked).length;
  const unranked = rows.length - ranked;
  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Every rep">
      <SectionHead
        title="Every rep"
        right={<SectionMeta items={[`${ranked} ranked`, unranked > 0 ? `${unranked} not ranked yet` : null, computedAt ? `Updated ${computedAt}` : null]} />}
      />
      {rows.length === 0 ? (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">Nobody is on this board for the period chosen.</p>
      ) : (
        <div className="grid gap-3 bg-slate-50 p-3 sm:p-4">
          {rows.map((row) => (
            <RepCard
              certificateHref={certificatesForAll && row.ranked ? certificateHref(board, row.hrIdKey) : null}
              context={context}
              key={row.hrIdKey}
              lineView={lineView}
              open={row.hrIdKey === openRepKey}
              row={row}
              viewer={row.hrIdKey === viewerKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const PLACE_ACCENT = ["bg-amber-400", "bg-slate-300", "bg-orange-400"];

/**
 * One rep, one wide card (owner, 2026-10-05: "they are so condensed … I think it needs to be wide
 * cards"). The same card on a phone and a laptop: on a narrow card the identity stacks above the
 * bars; once the card's OWN box is wide it sits beside them. No table, so nothing can push sideways.
 */
function RepCard({
  row,
  context,
  lineView,
  open,
  viewer,
  certificateHref,
}: {
  row: RankBoardRow;
  context: RankLinkContext;
  lineView: boolean;
  open: boolean;
  viewer: boolean;
  /** Set on the admin twin, for a ranked rep: the certificate that rep would print. */
  certificateHref: string | null;
}) {
  const position = lineView ? row.linePosition : row.companyPosition;
  const accent = row.ranked && position !== null && position <= 3 ? PLACE_ACCENT[position - 1] : null;
  return (
    <article
      aria-label={row.repName}
      className={`relative min-w-0 border ${viewer ? "border-[#f47b20] bg-orange-50/40" : "border-slate-200 bg-white"}`}
    >
      {accent ? <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 ${accent}`} /> : null}
      {viewer ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-[#f47b20]" /> : null}
      <div className="@container">
        <div className="grid gap-4 p-4 @3xl:grid-cols-[19rem_minmax(0,1fr)] @3xl:gap-6 @3xl:p-5">
          <div className="min-w-0">
            <div className="flex items-start gap-3">
              <PositionChip lineView={lineView} row={row} size="xl" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-phx-lg leading-snug">
                  <RepName active={open} context={context} row={row} />
                  {viewer ? <YouTag /> : null}
                </p>
                <p className="mt-0.5 break-words text-phx-xs font-semibold uppercase tracking-wide text-slate-500" dir="auto">
                  {[row.lineName, row.areaName].filter(Boolean).join(" · ")}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <RankInsigniaBadge rank={row.rank} size={80} />
              <div className="min-w-0">
                <RankName className="text-phx-base font-bold text-slate-800" rank={row.rank} />
                <div className="mt-0.5">
                  <StarRow stars={row.stars} />
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-end gap-2">
              <span className="text-phx-3xl font-black leading-none tabular-nums text-slate-900">{row.total === null ? "—" : row.total.toFixed(1)}</span>
              {row.total !== null ? <span className="pb-1 text-phx-sm font-bold text-slate-400">of 100</span> : null}
            </div>
            {row.total !== null ? (
              <div className="mt-2 h-2 w-full bg-slate-100">
                <div className="h-full bg-[#0b1f3a]" style={{ width: `${row.total}%` }} />
              </div>
            ) : null}
            {certificateHref ? (
              <div className="mt-3">
                <CertificateLink href={certificateHref} label="Certificate (PDF)" tone="quiet" />
              </div>
            ) : null}
          </div>
          <div className="min-w-0 @3xl:border-l @3xl:border-slate-100 @3xl:pl-6">
            {row.ranked ? (
              <PillarBars pillars={row.pillars} />
            ) : (
              <p className="break-words text-phx-base font-semibold text-amber-700">
                {row.unrankedReason ? RANK_UNRANKED_REASON_TEXT[row.unrankedReason] : ""}
              </p>
            )}
            <AdminMetricsLine row={row} />
          </div>
        </div>
      </div>
    </article>
  );
}

/** How the score works — printed in full, because the owner asked that nothing be a mystery. */
export function RankRules({ currentLevel = null }: { currentLevel?: number | null }) {
  const measures = RANK_PILLARS.filter((pillar) => !pillar.bonus);
  const bonuses = RANK_PILLARS.filter((pillar) => pillar.bonus);
  return (
    <div className="overflow-hidden border border-slate-200 bg-white" role="region" aria-label="How the score works">
      <SectionHead title="How the score works" right={<SectionMeta items={["Phoenix CRM only", "Sales never count"]} />} />
      <div className="space-y-4 p-4 sm:p-5">
        <p className="break-words text-sm leading-relaxed text-slate-700">
          Every rep of every line is scored on the same twelve measures from Phoenix CRM, each out of 100 and each worth exactly
          the same. Each measure is against the rep&apos;s own target, list or plan, or against a fixed standard, so a bigger list
          never wins on size. The score is their average, plus up to {RANK_START_BONUS_MAX} bonus points for pressing I started
          working early; the most anyone can reach is 100. A day without a press costs nothing. A measure with nothing to judge
          in the period (no visit checked against a place, no two visits close enough to time, no GPS reading) is left out, and
          the average is then over the rest.
        </p>
        <div className="@container">
          <ol className="grid gap-px bg-slate-200 @xl:grid-cols-2">
            {measures.map((pillar, index) => (
              <li className="flex min-w-0 gap-3 bg-white p-3" key={pillar.key}>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[#0b1f3a] text-phx-xs font-black text-white">{index + 1}</span>
                <div className="min-w-0">
                  <p className="break-words text-phx-xs font-black text-slate-900">{pillar.label}</p>
                  <p className="mt-0.5 break-words text-phx-xs leading-snug text-slate-600">{pillar.explains}</p>
                </div>
              </li>
            ))}
            {bonuses.map((pillar) => (
              <li className="flex min-w-0 gap-3 bg-sky-50 p-3" key={pillar.key}>
                <span className="flex h-6 shrink-0 items-center justify-center bg-sky-600 px-1.5 text-phx-3xs font-black uppercase tracking-wider text-white">
                  +{RANK_START_BONUS_MAX}
                </span>
                <div className="min-w-0">
                  <p className="break-words text-phx-xs font-black text-sky-800">{pillar.label}</p>
                  <p className="mt-0.5 break-words text-phx-xs leading-snug text-slate-600">{pillar.explains}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-2">
          <SubHeading>The ranks</SubHeading>
          <p className="break-words text-sm leading-relaxed text-slate-700">
            Ranks are earned on the average of the last three months, so one hard day never costs a rank. Stars are titles: one
            for every month, quarter or semester finished at #1 of the company or #1 of the line.
          </p>
          <div className="flex flex-wrap gap-2">
            {RANK_LADDER.map((rank) => {
              const mine = rank.level === currentLevel;
              return (
                <div
                  className={`flex min-w-0 items-center gap-1.5 border px-2 py-1 ${mine ? "border-[#f47b20] bg-orange-50" : "border-slate-200 bg-white"}`}
                  key={rank.level}
                >
                  <RankInsigniaBadge rank={rank} size={56} />
                  <span className="text-phx-3xs font-bold text-slate-700">
                    <RankName rank={rank} /> <span className="tabular-nums text-slate-400">from {rank.minScore}</span>
                  </span>
                  {mine ? <YouTag /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function RepRanksBoard({
  board,
  context,
  viewerKey,
  openRepKey,
  profile,
  certificatesForAll = false,
}: {
  board: RankBoard;
  context: RankLinkContext;
  viewerKey: string | null;
  openRepKey: string | null;
  /** The open rep's profile panel, rendered above the board. */
  profile?: React.ReactNode;
  /** The admin twin: a certificate link on every ranked rep. A rep only ever gets their own. */
  certificatesForAll?: boolean;
}) {
  const lineView = Boolean(context.line);
  const rows = lineView ? board.rows.filter((row) => row.lineName === context.line) : board.rows;
  const viewerRow = viewerKey ? board.rows.find((row) => row.hrIdKey === viewerKey) ?? null : null;

  return (
    <div className="space-y-3">
      {/* Every rank's drawing once, ahead of the first badge; the profile panel above the board uses it too. */}
      <RankInsigniaSprite />
      <WindowTabs board={board} context={context} />
      {!board.window ? (
        <div className="border border-slate-200 bg-white px-5 py-6">
          <p className="text-sm font-bold text-slate-900">The first ranking has not been computed yet.</p>
          <p className="mt-1 text-sm text-slate-500">Phoenix Ranks is computed every night from the day before. Check back tomorrow morning.</p>
        </div>
      ) : (
        <>
          {profile}
          {viewerRow ? <YourStanding board={board} row={viewerRow} /> : null}
          <Podium context={context} lineView={lineView} rows={rows} viewerKey={viewerKey} />
          <BoardTable
            board={board}
            certificatesForAll={certificatesForAll}
            computedAt={computedLabel(board.computedAt)}
            context={context}
            lineView={lineView}
            openRepKey={openRepKey}
            rows={rows}
            viewerKey={viewerKey}
          />
        </>
      )}
      <RankRules currentLevel={viewerRow?.rank.level ?? null} />
    </div>
  );
}
