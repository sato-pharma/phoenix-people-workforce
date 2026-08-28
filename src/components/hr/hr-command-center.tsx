/**
 * The HR command centre's chrome.
 *
 * DESIGN IDENTITY is the finance command centre's, deliberately (AGENTS.md §4: match the sibling
 * pages, never invent a one-off look). Same centred MetricTile with its 9px uppercase micro-label,
 * same `text-3xl font-black tabular-nums` figure, same orange accent, same four tones. What is new
 * is the GROUPING: finance is one long page of sections, this is a page of FUNCTIONS, because that
 * is what an HR seat is composed of. The group header carries the icon so the tiles underneath can
 * be pure figures — repeating one icon across five tiles is noise, not polish.
 *
 * NO TABLE, AT ANY BREAKPOINT. Every figure here is a link to the page that actions it, so this is
 * a grid of cards on a phone and a grid of cards on a desktop. The `md:` table split exists for
 * genuine tables, and there is not one on this page.
 *
 * TWO COLUMNS ON A PHONE, not one. These are compact figures rather than wide rows, and a single
 * column would make a five-tile group a scroll marathon on a 375px screen. The tile's min height
 * and centred axis are what make the pair read cleanly at that width.
 */

import {
  BriefcaseBusiness,
  Fingerprint,
  FileSpreadsheet,
  HeartPulse,
  Hourglass,
  IdCard,
  Network,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

import { PremiumHero } from "@/components/ui/premium-hero";
import type { HrFunctionKey } from "@/lib/auth/hr-functions";
import type { HrCommandCenterData, HrCommandTile } from "@/lib/hr/command-center";

const GROUP_ICONS: Record<HrFunctionKey, LucideIcon> = {
  engagement_retention: HeartPulse,
  hr_governance: ShieldCheck,
  payroll_inputs: FileSpreadsheet,
  people_records: IdCard,
  performance_probation: Hourglass,
  recruiting: BriefcaseBusiness,
  time_attendance: Fingerprint,
  workforce_insight: Network,
};

/**
 * Tailwind cannot build a class name at runtime — `lg:grid-cols-${n}` is purged and silently
 * renders as one column. So the column counts are literals, looked up by tile count.
 */
const GRID_BY_COUNT: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
};

function MetricTile({ tile }: { tile: HrCommandTile }) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tile.tone];

  return (
    <Link
      className="group/tile min-h-32 border border-slate-200 bg-white px-4 py-4 text-center transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      href={tile.href}
    >
      <div className="text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
        {tile.label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none tabular-nums ${toneClass}`}>
        {tile.value.toLocaleString("en-US")}
      </p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
        {tile.sub}
      </p>
    </Link>
  );
}

/**
 * Named rather than counted. A dashboard quietly short one group reads as "nothing to do today",
 * which is the one wrong answer a queue of people waiting can give.
 */
function UnavailableNotice({ sources }: { sources: string[] }) {
  return (
    <div className="mx-5 mb-5 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
        Some figures could not be loaded and are not shown below:{" "}
        <span className="font-black">{sources.join(", ")}</span>. Everything else on this page is
        current.
      </p>
    </div>
  );
}

export function HrCommandCenter({
  data,
  viewerName,
}: {
  data: HrCommandCenterData;
  viewerName: string;
}) {
  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      <PremiumHero
        kicker={data.seat}
        title={viewerName}
        subtitle="Your day, by the part of the job it belongs to."
      />

      {data.unavailableSources.length > 0 ? (
        <UnavailableNotice sources={data.unavailableSources} />
      ) : null}

      {data.groups.map((group) => {
        const Icon = GROUP_ICONS[group.functionKey];
        const grid = GRID_BY_COUNT[group.tiles.length] ?? "sm:grid-cols-2 lg:grid-cols-4";
        return (
          <section className="border-t border-slate-100" key={group.functionKey}>
            <header className="flex items-start gap-3 px-5 pt-5">
              <span className="mt-0.5 shrink-0 text-orange-600">
                <Icon aria-hidden="true" className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
                  {group.label}
                </h2>
                <p className="mt-1 text-[11px] font-semibold leading-relaxed text-slate-500">
                  {group.summary}
                </p>
              </div>
            </header>
            <div className={`grid grid-cols-2 gap-2 p-5 ${grid}`}>
              {group.tiles.map((tile) => (
                <MetricTile key={tile.key} tile={tile} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
